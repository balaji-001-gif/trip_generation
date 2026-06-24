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
		# so checking docstatus would block submit too. Use
		# _docstatus_before_save instead — it's 0 during submit (was Draft)
		# and 1 when editing an already-submitted record.
		if self._docstatus_before_save == 1:
			frappe.throw(_("Submitted Gate Entry Log records cannot be edited. Create a new entry if a correction is needed."))
