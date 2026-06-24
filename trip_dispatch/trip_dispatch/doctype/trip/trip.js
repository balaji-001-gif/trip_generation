frappe.ui.form.on("Trip", {
	refresh(frm) {
		// Add a button to view the linked Gate Entry Log
		if (frm.doc.docstatus === 1 && frm.doc.status !== "Cancelled") {
			frm.add_custom_button(__("View Gate Log"), () => {
				frappe.db.get_value(
					"Gate Entry Log",
					{ trip: frm.doc.name },
					"name",
					(r) => {
						if (r && r.name) {
							frappe.set_route("Form", "Gate Entry Log", r.name);
						} else {
							frappe.msgprint(__("No Gate Entry Log found for this Trip yet. Perform a gate scan first."));
						}
					}
				);
			}, __("Gate Scan"));
		}

		if (frm.doc.status === "Flagged") {
			frm.dashboard.set_headline_alert(
				"This trip is FLAGGED for a vehicle mismatch at the gate. Investigate the Gate Entry Log before taking any further action.",
				"red"
			);
		}

		if (frm.doc.qr_code) {
			frm.dashboard.add_section(
				`<div style="text-align:center;padding:12px;">
					<img src="${frm.doc.qr_code}" style="max-height:160px;">
					<p style="color:#888;">Gate-scan QR - print this on the dispatch sheet</p>
				</div>`,
				__("Gate QR")
			);
		}
	},
});
