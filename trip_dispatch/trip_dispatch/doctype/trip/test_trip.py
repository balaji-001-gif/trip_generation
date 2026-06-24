import frappe
import unittest


class TestTrip(unittest.TestCase):
	def test_trip_requires_at_least_one_invoice(self):
		trip = frappe.new_doc("Trip")
		trip.trip_date = frappe.utils.today()
		trip.vehicle = None
		with self.assertRaises(frappe.ValidationError):
			trip.insert()
