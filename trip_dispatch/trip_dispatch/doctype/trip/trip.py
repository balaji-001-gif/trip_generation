import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt

from trip_dispatch.utils import generate_trip_qr


class Trip(Document):
	def validate(self):
		self.validate_invoices()
		self.calculate_totals()

	def validate_invoices(self):
		if not self.invoices:
			frappe.throw(_("Add at least one Sales Invoice to the trip."))

		seen = set()
		for row in self.invoices:
			if row.sales_invoice in seen:
				frappe.throw(
					_("Sales Invoice {0} is added more than once in this trip.").format(row.sales_invoice)
				)
			seen.add(row.sales_invoice)

			# An invoice should only ever be on ONE trip - once it's on
			# any active submitted trip (including Completed), it cannot
			# be added to another. Cancelled trips still release the
			# invoice for re-dispatch.
			clashing = frappe.db.sql(
				"""
				select t.name, t.status
				from `tabTrip` t
				inner join `tabTrip Invoice` ti on ti.parent = t.name
				where ti.sales_invoice = %s
				  and t.name != %s
				  and t.docstatus = 1
				  and t.status != 'Cancelled'
				""",
				(row.sales_invoice, self.name or ""),
				as_dict=True,
			)
			if clashing:
				frappe.throw(
					_("Sales Invoice {0} is already on Trip {1} (Status: {2}).").format(
						row.sales_invoice, clashing[0].name, clashing[0].status
					)
				)

	def calculate_totals(self):
		self.total_invoices = len(self.invoices)
		self.total_amount = sum(flt(row.grand_total) for row in self.invoices)

	def before_submit(self):
		if not self.vehicle:
			frappe.throw(_("Vehicle is mandatory before dispatch."))

		vehicle_status = frappe.db.get_value("Vehicle", self.vehicle, "status")
		if vehicle_status == "On Trip":
			frappe.throw(_("Vehicle {0} is already assigned to an open trip.").format(self.vehicle))

		self.status = "Dispatched"
		# One random token per trip - this, not the trip name, is what the
		# QR encodes and what api.lookup_trip / api.record_gate_scan check.
		self.trip_code = frappe.generate_hash(length=20)

	def on_submit(self):
		frappe.db.set_value("Vehicle", self.vehicle, "status", "On Trip")
		generate_trip_qr(self)

	def on_cancel(self):
		if self.status != "Dispatched":
			frappe.throw(
				_("Trip cannot be cancelled once a gate scan has been recorded ({0}). Resolve it on the Trip instead.")
				.format(self.status)
			)
		frappe.db.set_value("Vehicle", self.vehicle, "status", "Available")
		self.db_set("status", "Cancelled")
