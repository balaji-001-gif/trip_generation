frappe.ui.form.on("Gate Entry Log", {
	onload: function (frm) {
		// Prevent duplicate event binding
		if (frm.gel_initialized) return;
		frm.gel_initialized = true;

		// --- Scan QR button in the toolbar ---
		frm.add_custom_button(__("Scan QR"), function () {
			show_scan_qr_dialog(frm);
		}, __("Gate Scan"));

		// --- If the trip is already set (e.g. viewing an existing record), show invoices ---
		if (frm.doc.trip) {
			fetch_and_display_trip_invoices(frm);
		}
	},

	// When the trip field changes (user selects a different trip)
	trip: function (frm) {
		if (frm.doc.trip) {
			fetch_and_display_trip_invoices(frm);
		} else {
			clear_trip_invoices_section(frm);
		}
	},

	refresh: function (frm) {
		// Re-add the button on refresh (Frappe may clear custom buttons)
		if (!frm.is_new()) {
			frm.add_custom_button(__("Scan QR"), function () {
				show_scan_qr_dialog(frm);
			}, __("Gate Scan"));
		}
	},
});


// ────────────────────────────────────────────
//  QR / Manual Scan Dialog
// ────────────────────────────────────────────

function show_scan_qr_dialog(frm) {
	const dialog = new frappe.ui.Dialog({
		title: __("Scan QR Code"),
		fields: [
			{
				fieldname: "manual_input",
				fieldtype: "Data",
				label: __("Or paste gate-scan URL"),
				description: __("Paste the full URL from the QR code or dispatch sheet"),
			},
		],
		primary_action_label: __("Look Up"),
		primary_action(values) {
			const input = values.manual_input;
			if (!input) {
				frappe.msgprint(__("Scan a QR or paste the gate-scan URL."));
				return;
			}
			lookup_trip_from_input(input, frm, dialog);
		},
	});

	dialog.show();

	// Focus the manual input field for convenience
	setTimeout(function () {
		dialog.get_field("manual_input").$input.focus();
	}, 300);
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
			// Setting the trip field triggers the `trip` change handler
			// which will auto-fetch and display invoice details.
			frm.set_value("trip", t.name);
			frm.set_value("vehicle_expected", t.vehicle);

			// Auto-select scan type based on trip status
			if (t.status === "In Transit") {
				frm.set_value("scan_type", "Gate In");
			} else if (t.status === "Dispatched") {
				frm.set_value("scan_type", "Gate Out");
			}

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
	frappe.call({
		method: "frappe.client.get",
		args: {
			doctype: "Trip",
			name: frm.doc.trip,
		},
		callback(r) {
			if (r.exc || !r.message) return;
			const trip = r.message;

			if (trip.vehicle) {
				frm.set_value("vehicle_expected", trip.vehicle);
			}

			// Construct display data from the invoices table
			const invoiceData = (trip.invoices || []).map(function (inv) {
				return {
					sales_invoice: inv.sales_invoice,
					customer: inv.customer,
					grand_total: inv.grand_total,
				};
			});

			display_trip_invoices(frm, {
				name: trip.name,
				vehicle: trip.vehicle,
				trip_type: trip.trip_type,
				status: trip.status,
				total_invoices: trip.total_invoices,
				invoices: invoiceData,
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
