import frappe
from frappe.model.document import Document


class Vehicle(Document):
	def validate(self):
		# Normalize so "ka01ab1234", "KA01AB1234 ", "KA01AB1234" are all
		# the same vehicle - this matters because gate security will type
		# it under time pressure and we compare it against this value.
		self.vehicle_number = (self.vehicle_number or "").strip().upper()

	def on_trash(self):
		if frappe.db.exists("Trip", {"vehicle": self.name, "docstatus": 1, "status": ["not in", ["Completed", "Cancelled"]]}):
			frappe.throw("Cannot delete a Vehicle that has an open Trip.")
