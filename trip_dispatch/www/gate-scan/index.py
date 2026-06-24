import frappe

GATE_ROLES = {"Gate Security", "Trip Manager", "System Manager"}


def get_context(context):
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/gate-scan"
		raise frappe.Redirect

	if not (GATE_ROLES & set(frappe.get_roles())):
		frappe.throw("You are not permitted to use the gate scan screen.", frappe.PermissionError)

	context.no_cache = 1
	context.csrf_token = frappe.sessions.get_csrf_token()
	return context
