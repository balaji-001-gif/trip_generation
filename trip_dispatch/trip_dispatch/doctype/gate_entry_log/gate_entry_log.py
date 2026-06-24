import frappe
from frappe import _
from frappe.model.document import Document


class GateEntryLog(Document):
	def validate(self):
		# This is the audit trail security and management rely on when a
		# mismatch happens. If it can be silently edited after submission,
		# it stops being evidence. Allow draft edits and submission.
		#
		# During submit, Frappe sets docstatus=1 before validate() runs,
		# so checking docstatus would block submit too. Instead, query
		# the database for the original docstatus of the existing record.
		if self.is_new():
			return

		original_docstatus = frappe.db.get_value(
			self.doctype, self.name, "docstatus"
		)

		if original_docstatus == 1:
			frappe.throw(_(
				"Submitted Gate Entry Log records cannot be edited. "
				"Create a new entry if a correction is needed."
			))
