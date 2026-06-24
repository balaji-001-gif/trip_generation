app_name = "trip_dispatch"
app_title = "Trip Dispatch"
app_publisher = "Your Company"
app_description = "Vehicle trip generation, QR dispatch and gate verification for ERPNext"
app_email = "you@example.com"
app_license = "MIT"

# This app reads/writes Sales Invoice, Delivery Note and Customer, all of
# which are defined in ERPNext, not core Frappe. Without this, bench will
# happily install the app on a site that doesn't have ERPNext and every
# Trip will fail at runtime instead of at install time.
required_apps = ["erpnext"]

# Adds the "Add to Trip" button to submitted Sales Invoices.
doctype_js = {
	"Sales Invoice": "public/js/sales_invoice.js"
}

after_install = "trip_dispatch.install.after_install"
