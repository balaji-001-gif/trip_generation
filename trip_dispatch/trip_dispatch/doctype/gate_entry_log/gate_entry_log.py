import frappe
from frappe import _
from frappe.model.document import Document


class GateEntryLog(Document):
	def on_update(self):
		# This is the audit trail security and management rely on when a
		# mismatch happens. If it can be silently edited after creation,
		# it stops being evidence. Allow creation only.
		if not self.is_new():
			frappe.throw(_("Gate Entry Log records cannot be edited. Create a new entry if a correction is needed."))
