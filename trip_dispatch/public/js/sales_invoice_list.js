frappe.listview_settings["Sales Invoice"].onload = function (listview) {
	if (listview.si_bulk_trip_added) return;
	listview.si_bulk_trip_added = true;

	listview.page.add_inner_button(__("Add to Trip"), function () {
		const selected = listview.get_checked_items();
		if (!selected || selected.length === 0) {
			frappe.msgprint(__("Select one or more submitted Sales Invoices from the list first."));
			return;
		}

		const invoice_names = selected.map((row) => row.name);

		// Filter out unsubmitted invoices on the client for a faster check
		const unsubmitted = selected.filter((row) => row.docstatus !== 1);
		if (unsubmitted.length > 0) {
			frappe.msgprint(
				__("The following invoices are not yet submitted and cannot be added to a trip: {0}", [
					unsubmitted.map((r) => r.name).join(", "),
				])
			);
			return;
		}

		show_bulk_trip_dialog(invoice_names, listview);
	}, __("Dispatch"));
};

function show_bulk_trip_dialog(invoice_names, listview) {
	frappe.call({
		method: "trip_dispatch.api.get_open_trips",
		callback(r) {
			const open_trips = r.message || [];
			const trip_options = open_trips.map(
				(t) => `${t.name} (${t.vehicle}, ${t.total_invoices} invoice(s) so far)`
			);

			const dialog = new frappe.ui.Dialog({
				title: __("Add {0} Invoice(s) to Trip", [invoice_names.length]),
				fields: [
					{
						fieldname: "invoices_display",
						fieldtype: "HTML",
						label: __("Selected Invoices"),
					},
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
						description: __(
							"Returnable trips require a Gate-In scan (e.g. returnable delivery, empties) before they close."
						),
					},
				],
				primary_action_label: __("Add to Trip"),
				primary_action(values) {
					const trip_name =
						values.mode === "Existing Open Trip" && values.existing_trip
							? values.existing_trip.split(" ")[0]
							: null;

					frappe.call({
						method: "trip_dispatch.api.add_invoices_to_trip",
						args: {
							sales_invoices: invoice_names,
							trip: trip_name,
							vehicle: values.vehicle,
							trip_type: values.trip_type,
						},
						callback(res) {
							dialog.hide();
							const r = res.message;
							let msg = __("Added {0} invoice(s) to Trip {1}", [
								r.added_count,
								r.trip_name,
							]);
							if (r.skipped_count > 0) {
								msg += __(" ({0} already on trip, skipped)", [r.skipped_count]);
							}
							frappe.show_alert({ message: msg, indicator: "green" });
							frappe.set_route("Form", "Trip", r.trip_name);
						},
					});
				},
			});

			// Populate the invoice list display
			const displayEl = dialog.get_field("invoices_display").$wrapper;
			const list = invoice_names
				.map((name) => `<li style="padding:2px 0;">${frappe.utils.escape_html(name)}</li>`)
				.join("");
			displayEl.html(`
				<div style="margin-bottom:8px;padding:8px;background:#f9f9f9;border-radius:4px;border:1px solid #eee;">
					<strong>${__("Selected Invoices ({0})", [invoice_names.length])}</strong>
					<ul style="margin:4px 0 0 0;padding-left:18px;max-height:120px;overflow-y:auto;font-size:12px;">
						${list}
					</ul>
				</div>
			`);

			dialog.show();
		},
	});
}
