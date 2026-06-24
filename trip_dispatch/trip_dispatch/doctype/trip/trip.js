frappe.ui.form.on("Trip", {
	refresh(frm) {
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
