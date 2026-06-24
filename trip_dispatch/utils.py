import io

import frappe
import qrcode
from frappe.utils.file_manager import save_file


def generate_trip_qr(trip):
	"""Generate a QR code for a submitted Trip and attach it to qr_code.

	The QR encodes the gate-scan URL plus a random trip_code, never the
	vehicle number or trip name alone. That matters operationally: the
	trip_code is the only thing that makes the printed QR sheet useless
	once the trip is Completed/Cancelled/Flagged - the API checks it on
	every scan (see api.lookup_trip / api.record_gate_scan), so a
	photocopied QR from a past trip can't be reused to wave a different
	vehicle through the gate.
	"""
	url = frappe.utils.get_url(
		f"/gate-scan?trip={trip.name}&code={trip.trip_code}"
	)

	qr = qrcode.QRCode(version=1, box_size=8, border=2)
	qr.add_data(url)
	qr.make(fit=True)
	img = qr.make_image(fill_color="black", back_color="white")

	buffer = io.BytesIO()
	img.save(buffer, format="PNG")
	buffer.seek(0)

	file_doc = save_file(
		f"{trip.name}-QR.png",
		buffer.getvalue(),
		"Trip",
		trip.name,
		is_private=0,
	)
	trip.db_set("qr_code", file_doc.file_url)
