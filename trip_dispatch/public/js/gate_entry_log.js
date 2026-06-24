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
			clear_trip_invoices_section(frm);
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
	// Remove any existing invoice display section
	clear_trip_invoices_section(frm);

	if (!tripData || !tripData.invoices || tripData.invoices.length === 0) {
		return;
	}

	const rows = tripData.invoices
		.map(function (inv, i) {
			const formatted = frappe.format(inv.grand_total, { fieldtype: "Currency" });
			return `<tr>
				<td style="padding:4px 6px;border-bottom:1px solid #f0f0f0;">${i + 1}</td>
				<td style="padding:4px 6px;border-bottom:1px solid #f0f0f0;"><b>${frappe.utils.escape_html(inv.sales_invoice)}</b></td>
				<td style="padding:4px 6px;border-bottom:1px solid #f0f0f0;">${frappe.utils.escape_html(inv.customer || "-")}</td>
				<td style="padding:4px 6px;border-bottom:1px solid #f0f0f0;text-align:right;">${formatted}</td>
			</tr>`;
		})
		.join("");

	const totalFormatted = frappe.format(tripData.total_invoices, { fieldtype: "Int" });

	const html = `<div class="frappe-control" style="margin-top:8px;">
		<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
			<span style="font-size:8pt;color:#888;text-transform:uppercase;letter-spacing:0.04em;">
				${__("Trip Invoices")}
			</span>
			<span style="font-size:8pt;color:#666;">
				${__("Vehicle")}: <b>${frappe.utils.escape_html(tripData.vehicle)}</b>
			</span>
			<span style="font-size:8pt;color:#666;">
				${__("Status")}: <b>${frappe.utils.escape_html(tripData.status)}</b>
			</span>
			<span style="font-size:8pt;color:#666;">
				${__("Type")}: <b>${frappe.utils.escape_html(tripData.trip_type)}</b>
			</span>
		</div>
		<table style="width:100%;border-collapse:collapse;font-size:9pt;">
			<thead>
				<tr style="background:#f9fafb;">
					<th style="padding:4px 6px;border-bottom:2px solid #e5e7eb;text-align:left;font-size:7.5pt;text-transform:uppercase;color:#666;">#</th>
					<th style="padding:4px 6px;border-bottom:2px solid #e5e7eb;text-align:left;font-size:7.5pt;text-transform:uppercase;color:#666;">${__("Invoice")}</th>
					<th style="padding:4px 6px;border-bottom:2px solid #e5e7eb;text-align:left;font-size:7.5pt;text-transform:uppercase;color:#666;">${__("Customer")}</th>
					<th style="padding:4px 6px;border-bottom:2px solid #e5e7eb;text-align:right;font-size:7.5pt;text-transform:uppercase;color:#666;">${__("Amount")}</th>
				</tr>
			</thead>
			<tbody>${rows}</tbody>
			<tfoot>
				<tr>
					<td colspan="3" style="padding:4px 6px;border-top:2px solid #1a1a1a;font-weight:700;">
						${__("Total ({0} invoices)", [totalFormatted])}
					</td>
					<td style="padding:4px 6px;border-top:2px solid #1a1a1a;font-weight:700;text-align:right;">
						${frappe.format(tripData.invoices.reduce(function (sum, inv) { return sum + flt(inv.grand_total); }, 0), { fieldtype: "Currency" })}
					</td>
				</tr>
			</tfoot>
		</table>
	</div>`;

	frm.dashboard.add_section(html, __("Trip Invoices"));
}


function clear_trip_invoices_section(frm) {
	// Remove previously added invoice sections from the dashboard
	frm.dashboard.sections = (frm.dashboard.sections || []).filter(function (s) {
		return s.label !== __("Trip Invoices");
	});
	// Re-render the dashboard
	if (frm.dashboard.sections.length === 0) {
		frm.dashboard.hide();
	} else {
		frm.dashboard.show();
	}
	frm.dashboard.render();
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
