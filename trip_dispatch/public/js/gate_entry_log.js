frappe.ui.form.on("Gate Entry Log", {
	refresh(frm) {
		// Add Scan QR button — Frappe clears custom buttons between
		// onload and refresh, so always add in refresh.
		frm.add_custom_button(__("Scan QR"), () => {
			show_scan_qr_dialog(frm);
		}, __("Gate Scan"));

		// If the trip is already set, show invoices
		if (frm.doc.trip) {
			fetch_and_display_trip_invoices(frm);
		}
	},

	// When the trip field changes (user selects a different trip)
	trip(frm) {
		if (frm.doc.trip) {
			fetch_and_display_trip_invoices(frm);
		} else {
			// Clear the child table when trip is removed
			frm.clear_table("invoices");
			frm.refresh_field("invoices");
		}
	},
});


// ────────────────────────────────────────────
//  QR Scan Dialog — Camera + Manual Fallback
// ────────────────────────────────────────────

let _html5QrLoaded = false;
let _html5QrLoading = false;
const _html5QrCallbacks = [];

function load_html5_qrcode(callback) {
	if (typeof Html5Qrcode !== "undefined") {
		_html5QrLoaded = true;
		callback();
		return;
	}
	_html5QrCallbacks.push(callback);
	if (_html5QrLoading) return;
	_html5QrLoading = true;

	const script = document.createElement("script");
	script.src = "/assets/trip_dispatch/js/lib/html5-qrcode.min.js";
	script.onload = function () {
		_html5QrLoaded = true;
		_html5QrLoading = false;
		_html5QrCallbacks.forEach(function (cb) { cb(); });
		_html5QrCallbacks.length = 0;
	};
	script.onerror = function () {
		_html5QrLoading = false;
		console.error("Failed to load html5-qrcode library");
	};
	document.head.appendChild(script);
}


function show_scan_qr_dialog(frm) {
	let html5QrCode = null;
	let scannerStarted = false;

	const dialog = new frappe.ui.Dialog({
		title: __("Scan QR Code"),
		fields: [
			{
				fieldname: "camera_view",
				fieldtype: "HTML",
				label: __("Camera"),
			},
			{
				fieldname: "manual_input",
				fieldtype: "Data",
				label: __("Or paste gate-scan URL"),
				description: __("Paste the URL from the QR code or dispatch sheet"),
			},
		],
		primary_action_label: __("Look Up"),
		primary_action(values) {
			const input = values.manual_input;
			if (!input) {
				frappe.msgprint(__("Scan a QR code or paste the gate-scan URL."));
				return;
			}
			lookup_trip_from_input(input, frm, dialog);
		},
	});

	// Stop the camera when the dialog is closed
	dialog.on_hide = function () {
		if (html5QrCode) {
			try {
				html5QrCode.stop().catch(function () {});
			} catch (e) {}
			html5QrCode = null;
		}
		scannerStarted = false;
	};

	dialog.show();

	// Render the camera viewfinder placeholder
	const cameraEl = dialog.get_field("camera_view").$wrapper;
	cameraEl.html(
		'<div id="gate-entry-qr-reader" style="width:100%;max-width:360px;margin:0 auto;border-radius:8px;overflow:hidden;"></div>'
	);

	// Dynamically load the html5-qrcode library and start the camera
	setTimeout(function () {
		load_html5_qrcode(function () {
			if (scannerStarted) return;
			const readerElement = document.getElementById("gate-entry-qr-reader");
			if (!readerElement) return;

			try {
				html5QrCode = new Html5Qrcode("gate-entry-qr-reader");
				html5QrCode
					.start(
						{ facingMode: "environment" },
						{ fps: 10, qrbox: 220 },
						function (decodedText) {
							// Auto-detect — look up the trip immediately
							lookup_trip_from_input(decodedText, frm, dialog);
						}
					)
					.then(function () {
						scannerStarted = true;
					})
					.catch(function () {
						cameraEl.html(
							'<div style="padding:12px;text-align:center;color:#888;background:#f9f9f9;border-radius:8px;">' +
								__("Camera not available — use the manual input below.") +
							"</div>"
						);
					});
			} catch (e) {
				cameraEl.html(
					'<div style="padding:12px;text-align:center;color:#888;">' +
						__("Camera not available — use the manual input below.") +
					"</div>"
				);
			}
		});
	}, 500);
}


// ────────────────────────────────────────────
//  Look Up Trip from QR / URL
// ────────────────────────────────────────────

function lookup_trip_from_input(rawText, frm, dialog) {
	const parsed = parse_trip_url(rawText);
	if (!parsed || !parsed.trip || !parsed.code) {
		frappe.msgprint(__("Could not read a trip code from that input. Make sure it's the full gate-scan URL."));
		return;
	}

	frappe.call({
		method: "trip_dispatch.api.lookup_trip",
		args: { trip: parsed.trip, code: parsed.code },
		callback(r) {
			if (r.exc) {
				frappe.msgprint(__("Lookup failed — invalid or expired trip code."));
				return;
			}
			const t = r.message;

			// Auto-populate the Gate Entry Log fields
			frm.set_value("trip", t.name);
			frm.set_value("vehicle_expected", t.vehicle);

			// Auto-select scan type based on trip status
			if (t.status === "In Transit") {
				frm.set_value("scan_type", "Gate In");
			} else if (t.status === "Dispatched") {
				frm.set_value("scan_type", "Gate Out");
			}

			// Display invoices directly from the lookup response
			// (no need for a second API call via fetch_and_display_trip_invoices)
			display_trip_invoices(frm, {
				name: t.name,
				vehicle: t.vehicle,
				trip_type: t.trip_type,
				status: t.status,
				total_invoices: t.total_invoices,
				invoices: t.invoices,
			});

			dialog.hide();

			// Show confirmation
			frappe.show_alert({
				message: __("Trip {0} loaded — Vehicle: {1}, Status: {2}", [t.name, t.vehicle, t.status]),
				indicator: "green",
			});
		},
	});
}


// ────────────────────────────────────────────
//  Trip Invoice Display Section
// ────────────────────────────────────────────

function fetch_and_display_trip_invoices(frm) {
	// Guard: don't re-fetch while a lookup is already in progress
	if (frm._fetching_trip) return;
	frm._fetching_trip = true;

	frappe.call({
		method: "frappe.client.get",
		args: {
			doctype: "Trip",
			name: frm.doc.trip,
		},
		callback(r) {
			frm._fetching_trip = false;
			if (r.exc || !r.message) return;
			const trip = r.message;

			if (trip.vehicle) {
				frm.set_value("vehicle_expected", trip.vehicle);
			}

			display_trip_invoices(frm, {
				name: trip.name,
				vehicle: trip.vehicle,
				trip_type: trip.trip_type,
				status: trip.status,
				total_invoices: trip.total_invoices,
				invoices: trip.invoices || [],
			});
		},
	});
}


function display_trip_invoices(frm, tripData) {
	if (!tripData || !tripData.invoices || tripData.invoices.length === 0) {
		return;
	}

	// Populate the child table instead of a dashboard section
	frm.clear_table("invoices");
	(tripData.invoices || []).forEach(function (inv) {
		var child = frm.add_child("invoices");
		child.sales_invoice = inv.sales_invoice || "";
		child.customer = inv.customer || "";
		child.grand_total = inv.grand_total || 0;
		child.posting_date = inv.posting_date || "";
	});
	frm.refresh_field("invoices");
}


// ────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────

function parse_trip_url(text) {
	try {
		const url = new URL(text);
		return { trip: url.searchParams.get("trip"), code: url.searchParams.get("code") };
	} catch (e) {
		return null;
	}
}
