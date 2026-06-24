frappe.ui.form.on("Sales Invoice", {
	refresh(frm) {
		if (frm.doc.docstatus !== 1) {
			// Trips are built from submitted invoices only - a draft
			// invoice's totals/customer aren't final yet.
			return;
		}
		frm.add_custom_button(__("Add to Trip"), () => {
			open_trip_dialog(frm);
		}, __("Dispatch"));
	},
});

function open_trip_dialog(frm) {
	frappe.call({
		method: "trip_dispatch.api.get_open_trips",
		callback(r) {
			const open_trips = r.message || [];
			const trip_options = open_trips.map(
				t => `${t.name} (${t.vehicle}, ${t.total_invoices} invoice(s) so far)`
			);

			const dialog = new frappe.ui.Dialog({
				title: __("Add Invoice to Trip"),
				fields: [
					{
						fieldname: "mode",
						fieldtype: "Select",
						label: __("Trip"),
						options: ["New Trip", "Existing Open Trip"],
						default: open_trips.length ? "Existing Open Trip" : "New Trip",
						reqd: 1,
					},
					{
						fieldname: "existing_trip",
						fieldtype: "Select",
						label: __("Open Trip"),
						options: trip_options,
						depends_on: "eval:doc.mode=='Existing Open Trip'",
					},
					{
						fieldname: "vehicle",
						fieldtype: "Link",
						label: __("Vehicle"),
						options: "Vehicle",
						depends_on: "eval:doc.mode=='New Trip'",
					},
					{
						fieldname: "trip_type",
						fieldtype: "Select",
						label: __("Trip Type"),
						options: "Outward\nReturnable",
						default: "Outward",
						depends_on: "eval:doc.mode=='New Trip'",
						description: __("Returnable trips require a Gate-In scan (e.g. returnable delivery, empties) before they close."),
					},
				],
				primary_action_label: __("Add"),
				primary_action(values) {
					const trip_name = (values.mode === "Existing Open Trip" && values.existing_trip)
						? values.existing_trip.split(" ")[0]
						: null;

					frappe.call({
						method: "trip_dispatch.api.add_invoice_to_trip",
						args: {
							sales_invoice: frm.doc.name,
							trip: trip_name,
							vehicle: values.vehicle,
							trip_type: values.trip_type,
						},
						callback(res) {
							dialog.hide();
							frappe.show_alert({
								message: __("Added to Trip {0}", [res.message]),
								indicator: "green",
							});
							frappe.set_route("Form", "Trip", res.message);
						},
					});
				},
			});
			dialog.show();
		},
	});
}
