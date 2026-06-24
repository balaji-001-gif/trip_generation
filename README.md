# Trip Dispatch

Vehicle trip generation, QR-coded gate dispatch, and gate-in/gate-out
verification for ERPNext v15+.

## What this actually does

1. From a submitted **Sales Invoice**, click **Dispatch > Add to Trip**.
   You either start a new **Trip** (pick a Vehicle) or add the invoice to
   an existing **Draft** trip - this is how several invoices get batched
   onto one vehicle.
2. Submitting the Trip locks the invoice list, assigns the vehicle
   (status -> `On Trip`), and generates a QR code. The QR encodes a
   random one-time `trip_code`, not the vehicle number or the trip name -
   a photocopy of an old QR is useless once that trip closes.
3. Security opens `/gate-scan` on any device, logs in, and scans the QR
   (or pastes the URL manually - the page works without a camera too).
   The page shows the expected vehicle and the invoice list, security
   types in the vehicle they actually see, and submits.
4. Every scan - match or mismatch - is written to **Gate Entry Log**,
   which cannot be edited afterwards. A mismatch sets the Trip to
   `Flagged` and does **not** auto-release the vehicle; someone with the
   Trip Manager role has to investigate.
5. **Outward** trips close on a matching Gate-Out scan. **Returnable**
   trips (use this for returnable delivery notes / empties) stay
   `In Transit` until a matching Gate-In scan is also recorded.

## Install

```bash
# from your bench directory
bench get-app trip_dispatch /path/to/this/folder   # or a git remote
bench --site your-site.local install-app trip_dispatch
bench --site your-site.local migrate
```

`pyproject.toml` declares `qrcode` and `pillow` as dependencies - `bench
get-app` / `install-app` installs them into the bench's virtualenv
automatically.

After install:
- Two roles are created automatically (`install.py`'s `after_install`
  hook): **Trip Manager** and **Gate Security**. Assign them to real
  users from Desk > User - nobody has them by default.
- Create your **Vehicle** records (just a vehicle number is required).
- Give the gate device(s) a logged-in browser session pointed at
  `/gate-scan`, with a user that has the Gate Security role.

## Design decisions worth knowing about

- **Trip ↔ Sales Invoice is many-to-many**, modeled as a child table
  (`Trip Invoice`), not a field on the invoice. This is required because
  one vehicle commonly carries several invoices.
- **`Trip Invoice` also has an optional Delivery Note link.** If your
  actual dispatch trigger is the Delivery Note rather than the Sales
  Invoice (very common when goods leave before billing), add the same
  "Add to Trip" button to Delivery Note's client script
  (`public/js/sales_invoice.js` is the template to copy) and pass
  `delivery_note` instead of/alongside `sales_invoice` when appending
  rows in `api.add_invoice_to_trip`. This wasn't hard-coded to one
  trigger so you aren't locked in.
- **Vehicle is a new lightweight doctype in this app**, not reused from
  HRMS, because plain ERPNext (without the separate HRMS app) has no
  Vehicle master at all. If you do run HRMS, you may prefer to swap this
  doctype for HRMS's `Vehicle` and adjust the `Link` options on `Trip`
  and `Vehicle` accordingly.
- **`Gate Entry Log` is append-only.** It's the evidence trail for
  mismatches; letting it be edited after the fact defeats the point.

## Known limitations / next steps

- **Flagged trips have no built-in recovery workflow.** Right now a
  Trip Manager has to manually edit the Trip's status in Desk after
  investigating a mismatch. If this matters operationally, add a Frappe
  Workflow on Trip with an explicit "Resolve Flag" transition restricted
  to Trip Manager, instead of a free-text status field.
- **The gate-scan page has no offline mode.** If gate connectivity is
  unreliable, you'll want a queued/offline-first version (e.g. a small
  PWA with local storage that syncs scans when back online) rather than
  this synchronous fetch-based page.
- **No print format is included for the QR / dispatch sheet** - the QR
  image is just an attached file on the Trip. Add a custom Print Format
  if you want a formatted dispatch slip with the QR and invoice table.
- **No partial-trip handling.** If a customer's invoice is removed from
  a trip after dispatch (goods left behind), there's currently no
  "partial gate-out" concept - the whole trip is one match/mismatch unit
  against one vehicle number. If split deliveries within one trip happen
  in your operation, that needs explicit modeling before go-live.
