import frappe
from frappe import _
from frappe.model.document import Document


class GateEntryLog(Document):
	def validate(self):
		# This is the audit trail security and management rely on when a
		# mismatch happens. If it can be silently edited after submission,
		# it stops being evidence. Allow draft edits and submission.
		if self.docstatus == 1 and not self.is_new():
			frappe.throw(_("Submitted Gate Entry Log records cannot be edited. Create a new entry if a correction is needed."))
