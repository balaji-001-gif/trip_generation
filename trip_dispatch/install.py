import frappe


def after_install():
	"""Doctype permission rows reference 'Trip Manager' and 'Gate Security'.
	Frappe does NOT auto-create roles just because a DocPerm row mentions
	them, so without this step the first `bench migrate` after install
	throws a LinkValidationError on the Trip / Vehicle / Gate Entry Log
	doctypes. Create them explicitly, then assign roles to users manually
	from Desk > User.
	"""
	create_roles()


def create_roles():
	roles = [
		("Trip Manager", "Can create/submit trips, assign vehicles, review flagged trips."),
		("Gate Security", "Can use the /gate-scan screen to record gate-out and gate-in scans."),
	]
	for role_name, description in roles:
		if frappe.db.exists("Role", role_name):
			continue
		frappe.get_doc({
			"doctype": "Role",
			"role_name": role_name,
			"desk_access": 1,
		}).insert(ignore_permissions=True)
