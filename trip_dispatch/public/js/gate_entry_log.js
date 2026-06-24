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

			// Close the scan dialog and open the confirmation dialog
			dialog.hide();
			show_scan_confirmation(frm, t, parsed.code);
		},
	});
}


// ────────────────────────────────────────────
//  Scan Confirmation Dialog
// ────────────────────────────────────────────

function show_scan_confirmation(frm, tripData, tripCode) {
	const defaultScanType = tripData.status === "In Transit" ? "Gate In" : "Gate Out";

	const dialog = new frappe.ui.Dialog({
		title: __("Confirm Gate Scan"),
		fields: [
			{
				fieldname: "trip_info",
				fieldtype: "HTML",
				label: __("Trip Details"),
			},
			{
				fieldname: "vehicle_entered",
				fieldtype: "Data",
				label: __("Vehicle Entered"),
				reqd: 1,
				description: __("Enter the vehicle number seen at the gate"),
			},
			{
				fieldname: "scan_type",
				fieldtype: "Select",
				label: __("Scan Type"),
				options: "Gate Out\nGate In",
				default: defaultScanType,
				reqd: 1,
			},
		],
		primary_action_label: __("Confirm Scan"),
		primary_action(values) {
			const vehicleEntered = (values.vehicle_entered || "").trim().toUpperCase();
			if (!vehicleEntered) {
				frappe.msgprint(__("Enter the vehicle number seen at the gate."));
				return;
			}

			dialog.set_primary_action(__("Recording..."), null);

			frappe.call({
				method: "trip_dispatch.api.record_gate_scan",
				args: {
					trip: tripData.name,
					code: tripCode,
					scan_type: values.scan_type,
					vehicle_entered: vehicleEntered,
				},
				callback(r) {
					if (r.exc) {
						dialog.set_primary_action(__("Confirm Scan"), dialog.primary_action);
						return;
					}
					const result = r.message;

					dialog.hide();

					if (result.match) {
						frappe.show_alert({
							message: __("✓ MATCH — {0} recorded. Trip status: {1}", [values.scan_type, result.status]),
							indicator: "green",
						});
					} else {
						frappe.show_alert({
							message: __("✗ MISMATCH — Expected {0}, got {1}. Trip flagged.", [result.expected, result.entered]),
							indicator: "red",
						});
					}

					// Refresh the form so the Gate Entry Log field shows new data
					frm.refresh();
				},
			});
		},
	});

	// Render trip info in the HTML field
	dialog.once("shown", function () {
		const infoEl = dialog.get_field("trip_info").$wrapper;

		const invoiceRows = (tripData.invoices || [])
			.map(function (inv, i) {
				const formatted = frappe.format(inv.grand_total, { fieldtype: "Currency" });
				return `<tr>
					<td style="padding:3px 6px;font-size:9pt;">${i + 1}</td>
					<td style="padding:3px 6px;font-size:9pt;">${frappe.utils.escape_html(inv.sales_invoice)}</td>
					<td style="padding:3px 6px;font-size:9pt;">${frappe.utils.escape_html(inv.customer || "-")}</td>
					<td style="padding:3px 6px;font-size:9pt;text-align:right;">${formatted}</td>
				</tr>`;
			})
			.join("");

		infoEl.html(`
			<div style="margin-bottom:8px;">
				<table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:6px;">
					<tr>
						<td style="padding:4px 8px;font-size:8pt;color:#666;width:30%;">${__("Trip")}</td>
						<td style="padding:4px 8px;font-size:9pt;font-weight:600;">${frappe.utils.escape_html(tripData.name)}</td>
					</tr>
					<tr>
						<td style="padding:4px 8px;font-size:8pt;color:#666;">${__("Vehicle")}</td>
						<td style="padding:4px 8px;font-size:9pt;font-weight:600;">${frappe.utils.escape_html(tripData.vehicle)}</td>
					</tr>
					<tr>
						<td style="padding:4px 8px;font-size:8pt;color:#666;">${__("Status")}</td>
						<td style="padding:4px 8px;font-size:9pt;">${frappe.utils.escape_html(tripData.status)}</td>
					</tr>
					<tr>
						<td style="padding:4px 8px;font-size:8pt;color:#666;">${__("Trip Type")}</td>
						<td style="padding:4px 8px;font-size:9pt;">${frappe.utils.escape_html(tripData.trip_type)}</td>
					</tr>
					<tr>
						<td style="padding:4px 8px;font-size:8pt;color:#666;">${__("Invoice Count")}</td>
						<td style="padding:4px 8px;font-size:9pt;">${tripData.total_invoices || 0}</td>
					</tr>
				</table>
			</div>
			<div style="font-size:8pt;color:#888;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">
				${__("Invoices on this Trip")}
			</div>
			<table style="width:100%;border-collapse:collapse;">
				<thead>
					<tr style="background:#f3f4f6;">
						<th style="padding:3px 6px;font-size:7.5pt;text-transform:uppercase;color:#666;text-align:left;">#</th>
						<th style="padding:3px 6px;font-size:7.5pt;text-transform:uppercase;color:#666;text-align:left;">${__("Invoice")}</th>
						<th style="padding:3px 6px;font-size:7.5pt;text-transform:uppercase;color:#666;text-align:left;">${__("Customer")}</th>
						<th style="padding:3px 6px;font-size:7.5pt;text-transform:uppercase;color:#666;text-align:right;">${__("Amount")}</th>
					</tr>
				</thead>
				<tbody>${invoiceRows}</tbody>
			</table>
		`);
	});

	dialog.show();

	// Focus the vehicle entered field
	setTimeout(function () {
		const vehicleField = dialog.get_field("vehicle_entered");
		if (vehicleField && vehicleField.$input) {
			vehicleField.$input.focus();
		}
	}, 300);
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
