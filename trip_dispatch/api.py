import frappe
from frappe import _
from frappe.utils import now_datetime

GATE_ROLES = {"Gate Security", "Trip Manager", "System Manager"}


def _ensure_gate_role():
	if not (GATE_ROLES & set(frappe.get_roles())):
		frappe.throw(_("Not permitted to perform gate scans."), frappe.PermissionError)


@frappe.whitelist()
def get_open_trips(vehicle=None):
	"""Used by the Sales Invoice 'Add to Trip' dialog to list draft trips
	that more invoices can still be batched onto."""
	filters = {"docstatus": 0}
	if vehicle:
		filters["vehicle"] = vehicle
	return frappe.get_all(
		"Trip",
		filters=filters,
		fields=["name", "vehicle", "trip_date", "total_invoices"],
		order_by="creation desc",
		limit_page_length=20,
	)


@frappe.whitelist()
def add_invoice_to_trip(sales_invoice, trip=None, vehicle=None, trip_type="Outward"):
	"""Append a Sales Invoice to an existing draft Trip, or start a new one.

	This is intentionally a separate step from Sales Invoice submission -
	one vehicle usually carries several invoices, so trip creation has to
	be a deliberate batching action, not an automatic on_submit side
	effect that would create one trip per invoice.
	"""
	si = frappe.get_doc("Sales Invoice", sales_invoice)
	if si.docstatus != 1:
		frappe.throw(_("Only submitted Sales Invoices can be added to a trip."))

	if trip:
		trip_doc = frappe.get_doc("Trip", trip)
		if trip_doc.docstatus != 0:
			frappe.throw(_("Can only add invoices to a Trip that is still in Draft."))
	else:
		if not vehicle:
			frappe.throw(_("Select a vehicle to start a new trip."))
		trip_doc = frappe.new_doc("Trip")
		trip_doc.vehicle = vehicle
		trip_doc.trip_type = trip_type
		trip_doc.trip_date = frappe.utils.today()

	trip_doc.append("invoices", {
		"sales_invoice": si.name,
		"customer": si.customer,
		"grand_total": si.grand_total,
		"posting_date": si.posting_date,
	})
	trip_doc.save()
	return trip_doc.name


@frappe.whitelist()
def add_invoices_to_trip(sales_invoices, trip=None, vehicle=None, trip_type="Outward"):
	"""Batch-add multiple Sales Invoices to a single trip in one call.

	Used by the Sales Invoice list-view bulk action. Accepts a JSON list
	of invoice names, validates all are submitted, and appends them to
	an existing draft Trip or creates a new one.
	"""
	import json

	if isinstance(sales_invoices, str):
		sales_invoices = json.loads(sales_invoices)

	if not sales_invoices or not isinstance(sales_invoices, list):
		frappe.throw(_("Provide a list of Sales Invoices to add."))

	# Resolve the trip doc once, upfront
	if trip:
		trip_doc = frappe.get_doc("Trip", trip)
		if trip_doc.docstatus != 0:
			frappe.throw(_("Can only add invoices to a Trip that is still in Draft."))
	else:
		if not vehicle:
			frappe.throw(_("Select a vehicle to start a new trip."))
		trip_doc = frappe.new_doc("Trip")
		trip_doc.vehicle = vehicle
		trip_doc.trip_type = trip_type
		trip_doc.trip_date = frappe.utils.today()

	# Track already-seen invoices on this trip to avoid client-side duplicates
	seen_invoices = {row.sales_invoice for row in trip_doc.get("invoices", [])}
	skipped = []
	added_count = 0

	for inv_name in sales_invoices:
		inv_name = inv_name.strip()
		if not inv_name:
			continue

		if inv_name in seen_invoices:
			skipped.append(inv_name)
			continue

		si = frappe.get_doc("Sales Invoice", inv_name)
		if si.docstatus != 1:
			frappe.throw(
				_("Sales Invoice {0} is not submitted. Only submitted invoices can be added to a trip.").format(inv_name)
			)

		trip_doc.append("invoices", {
			"sales_invoice": si.name,
			"customer": si.customer,
			"grand_total": si.grand_total,
			"posting_date": si.posting_date,
		})
		seen_invoices.add(inv_name)
		added_count += 1

	if added_count == 0:
		frappe.throw(_("All selected invoices are already on this trip. No new invoices were added."))

	trip_doc.save()

	return {
		"trip_name": trip_doc.name,
		"added_count": added_count,
		"skipped_count": len(skipped),
	}


@frappe.whitelist()
def lookup_trip(trip, code):
	"""Called from the /gate-scan page after a QR is scanned (or a code is
	pasted in manually). Requires a gate role - this is desk-adjacent data
	(vehicle assignment, customer, invoice totals), not public information.
	"""
	_ensure_gate_role()
	trip_doc = frappe.get_doc("Trip", trip)
	if trip_doc.trip_code != code:
		frappe.throw(_("Invalid or expired trip code."), frappe.PermissionError)

	vehicle_status = frappe.db.get_value("Vehicle", trip_doc.vehicle, "status") or ""

	return {
		"name": trip_doc.name,
		"vehicle": trip_doc.vehicle,
		"vehicle_status": vehicle_status,
		"trip_type": trip_doc.trip_type,
		"status": trip_doc.status,
		"total_invoices": trip_doc.total_invoices,
		"invoices": [
			{
				"sales_invoice": row.sales_invoice,
				"customer": row.customer,
				"grand_total": row.grand_total,
				"posting_date": row.posting_date,
			}
			for row in trip_doc.invoices
		],
	}


@frappe.whitelist()
def record_gate_scan(trip, code, scan_type, vehicle_entered):
	"""The actual gate check. Validates the trip_code, enforces the state
	machine (Dispatched -> Gate Out -> In Transit -> Gate In -> Completed,
	with Flagged as the terminal error state), logs every attempt - match
	or mismatch - to Gate Entry Log, and only releases the vehicle back to
	Available once the return (Gate In) is confirmed.

	Key design: A single Gate Entry Log records both scans.
	- Gate Out: Creates the log as Draft with gate_out_datetime
	- Gate In:  Finds the existing Draft log and updates it with
	            gate_in_datetime, then submits it.
	"""
	_ensure_gate_role()
	trip_doc = frappe.get_doc("Trip", trip)

	if trip_doc.trip_code != code:
		frappe.throw(_("Invalid or expired trip code."), frappe.PermissionError)

	if trip_doc.docstatus != 1:
		frappe.throw(_("Trip is not dispatched yet."))

	vehicle_entered = (vehicle_entered or "").strip().upper()
	expected = (trip_doc.vehicle or "").strip().upper()
	is_match = vehicle_entered == expected
	now = now_datetime()

	if scan_type == "Gate Out":
		if trip_doc.status != "Dispatched":
			frappe.throw(
				_("Gate-out already recorded, or trip is not in a dispatchable state. Current status: {0}")
				.format(trip_doc.status)
			)

		vehicle_status = frappe.db.get_value("Vehicle", trip_doc.vehicle, "status") or ""

		log = frappe.new_doc("Gate Entry Log")
		log.trip = trip_doc.name
		log.scan_type = "Gate Out"
		log.trip_status = trip_doc.status
		log.vehicle_expected = expected
		log.vehicle_entered = vehicle_entered
		log.vehicle_status = vehicle_status
		log.match_status = "Match" if is_match else "Mismatch"
		log.scanned_by = frappe.session.user
		log.gate_out_datetime = now
		log.insert(ignore_permissions=True)

		# Keep as Draft — Gate In will update and submit it
		trip_doc.db_set("gate_out_time", now)
		trip_doc.db_set("gate_out_by", frappe.session.user)
		if not is_match:
			trip_doc.db_set("status", "Flagged")
		else:
			trip_doc.db_set("status", "In Transit")

		return {
			"match": is_match,
			"expected": expected,
			"entered": vehicle_entered,
			"status": trip_doc.status,
			"gate_entry_log_name": log.name,
			"scan_type": "Gate Out",
		}

	elif scan_type == "Gate In":
		if trip_doc.status != "In Transit":
			frappe.throw(
				_("Trip must clear Gate Out before Gate In can be recorded. Current status: {0}")
				.format(trip_doc.status)
			)

		# Find the existing Draft Gate Out log for this trip
		log_name = frappe.db.get_value(
			"Gate Entry Log",
			{"trip": trip_doc.name, "scan_type": "Gate Out", "docstatus": 0},
			"name",
		)
		if not log_name:
			frappe.throw(_("No pending Gate Out record found for this trip. Scan Gate Out first."))

		log = frappe.get_doc("Gate Entry Log", log_name)
		log.gate_in_datetime = now
		log.vehicle_entered = vehicle_entered
		log.match_status = "Match" if is_match else "Mismatch"
		log.scanned_by = frappe.session.user
		log.vehicle_status = frappe.db.get_value("Vehicle", trip_doc.vehicle, "status") or ""
		log.trip_status = trip_doc.status
		log.save(ignore_permissions=True)

		# Submit the log now that both scans are recorded
		frappe.flags.ignore_permissions = True
		log.submit()

		trip_doc.db_set("gate_in_time", now)
		trip_doc.db_set("gate_in_by", frappe.session.user)
		if is_match:
			trip_doc.db_set("status", "Completed")
			frappe.db.set_value("Vehicle", trip_doc.vehicle, "status", "Available")
		else:
			trip_doc.db_set("status", "Flagged")

		return {
			"match": is_match,
			"expected": expected,
			"entered": vehicle_entered,
			"status": trip_doc.status,
			"gate_entry_log_name": log.name,
			"scan_type": "Gate In",
		}

	else:
		frappe.throw(_("Unknown scan type: {0}").format(scan_type))
