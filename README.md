# Trip Dispatch

**Vehicle trip generation, QR-coded gate dispatch, and gate-in/gate-out verification for ERPNext v15+.**

Trip Dispatch bridges the gap between ERPNext Sales Invoices and physical vehicle movement at the gate. It lets desk users batch invoices onto a vehicle trip, prints a QR-coded dispatch sheet, and gives gate security a simple scan page to record gate-out and gate-in — with an append-only audit trail that flags mismatches automatically.

---

## Table of Contents

1. [Features](#features)
2. [Architecture & Working Structure](#architecture--working-structure)
   - [Doctypes Overview](#doctypes-overview)
   - [Data Flow Diagram](#data-flow-diagram)
   - [Trip Lifecycle State Machine](#trip-lifecycle-state-machine)
   - [API Endpoints](#api-endpoints)
   - [Gate Scan Page](#gate-scan-page)
3. [Roles & Permissions](#roles--permissions)
4. [Standard Operating Procedure (SOP)](#standard-operating-procedure-sop)
   - [A. Setup (One-Time)](#a-setup-one-time)
   - [B. Desk Workflow — Trip Manager / Sales User](#b-desk-workflow--trip-manager--sales-user)
   - [C. Gate Workflow — Gate Security](#c-gate-workflow--gate-security)
   - [D. Exception Handling — Flagged Trips](#d-exception-handling--flagged-trips)
5. [Installation](#installation)
6. [Configuration](#configuration)
7. [Design Decisions](#design-decisions)
8. [Known Limitations & Roadmap](#known-limitations--roadmap)

---

## Features

### Core Features

| Feature | Description |
|---|---|
| **Invoice Batching** | Batch multiple submitted Sales Invoices onto a single vehicle trip from a dialog on the Sales Invoice form |
| **QR Code Generation** | On trip submission, a QR code is auto-generated encoding a secure one-time `trip_code` + gate-scan URL |
| **QR Gate Scan Page** | Standalone web page (`/gate-scan`) that works on any device with a camera or manual URL paste |
| **Gate-Out / Gate-In** | Two-phase gate verification: Outward trips close on Gate-Out match; Returnable trips require both Gate-Out and Gate-In |
| **Vehicle Number Verification** | Gate security enters the vehicle number they physically see — compared case-insensitively against the expected vehicle |
| **Mismatch Flagging** | Any vehicle mismatch at the gate sets the Trip to `Flagged` status for manager investigation |
| **Append-Only Audit Trail** | Every scan — match or mismatch — is logged immutably in `Gate Entry Log` (no editing allowed) |
| **Vehicle Status Tracking** | Vehicle status auto-updates: `Available` → `On Trip` → `Available` (on completion) |
| **Trip Cancellation** | Draft and Dispatched trips can be cancelled; trips with gate scans recorded require managerial resolution instead |
| **Extensible Trip Invoice** | Child table supports both Sales Invoice and Delivery Note links — adapt for your dispatch trigger |

### Security Features

- QR encodes a random 20-character `trip_code`, not the vehicle number or trip name — old QR codes are useless once a trip closes
- Gate scan APIs require `Gate Security`, `Trip Manager`, or `System Manager` role
- `Gate Entry Log` is append-only — an `on_update` hook rejects edits
- Duplicate invoice detection prevents an invoice from riding on two open trips simultaneously

---

## Architecture & Working Structure

### Doctypes Overview

```
trip_dispatch/
├── Doctypes/
│   ├── Trip              # Submittable doctype — the core trip record
│   ├── Trip Invoice      # Child table linking Sales Invoices to a Trip
│   ├── Vehicle           # Lightweight vehicle master
│   └── Gate Entry Log    # Immutable audit log for all gate scans
├── API                   # Whitelisted server methods for desk + gate page
├── Page (www)            # /gate-scan standalone gate verification page
└── Client Script         # "Add to Trip" button on Sales Invoice form
```

#### 1. **Trip** (`trip_dispatch.trip_dispatch.doctype.trip.trip`)
The central document. Submittable, meaning it goes through Draft → Submitted flow.

| Field | Type | Purpose |
|---|---|---|
| `trip_date` | Date | Date of dispatch |
| `vehicle` | Link → Vehicle | Assigned vehicle |
| `driver` | Data | Auto-fetched from Vehicle |
| `trip_type` | Select: Outward / Returnable | Determines whether Gate-In is required |
| `status` | Select (read-only) | Lifecycle: Draft → Dispatched → In Transit → Completed / Flagged / Cancelled |
| `trip_code` | Data (hidden) | Random 20-char token set on submit; embedded in QR |
| `invoices` | Table → Trip Invoice | The Sales Invoices on this trip |
| `total_invoices` | Int (read-only) | Auto-calculated |
| `total_amount` | Currency (read-only) | Auto-calculated sum of invoice totals |
| `qr_code` | Attach Image (read-only) | QR image attached on submit |
| `gate_out_time` | Datetime (read-only) | Set by gate-out scan |
| `gate_out_by` | Link → User (read-only) | Set by gate-out scan |
| `gate_in_time` | Datetime (read-only) | Set by gate-in scan |
| `gate_in_by` | Link → User (read-only) | Set by gate-in scan |

**Server-side logic** (`trip.py`):
- `validate()`: Ensures at least one invoice, no duplicates, no double-booking invoices on open trips
- `before_submit()`: Validates vehicle is not already `On Trip`, generates `trip_code`, sets status to `Dispatched`
- `on_submit()`: Sets vehicle status to `On Trip`, generates QR code attachment
- `on_cancel()`: Only allowed if no gate scans recorded yet; releases vehicle back to `Available`

#### 2. **Trip Invoice** Child Table
Links Sales Invoices (and optionally Delivery Notes) to a Trip.

| Field | Type | Purpose |
|---|---|---|
| `sales_invoice` | Link → Sales Invoice | The invoice on this trip |
| `customer` | Link → Customer | Auto-fetched |
| `delivery_note` | Link → Delivery Note | Optional — for dispatch-by-DN workflows |
| `grand_total` | Currency | Auto-fetched |
| `posting_date` | Date | Auto-fetched |

#### 3. **Vehicle** (`trip_dispatch.trip_dispatch.doctype.vehicle.vehicle`)
Lightweight vehicle master. Named by `vehicle_number` (unique, auto-uppercased/trimmed).

| Field | Type | Purpose |
|---|---|---|
| `vehicle_number` | Data (unique, autoname) | License plate — normalized to uppercase |
| `vehicle_type` | Select: Truck / Van / Pickup / Bike / Other | Vehicle category |
| `status` | Select (read-only) | Available / On Trip / Maintenance / Inactive |
| `default_driver` | Data | Default driver name (fetched to Trip) |
| `capacity` | Float | Capacity in tons |

#### 4. **Gate Entry Log** (`trip_dispatch.trip_dispatch.doctype.gate_entry_log.gate_entry_log`)
Immutable audit record. Auto-named with a random hash.

| Field | Type | Purpose |
|---|---|---|
| `trip` | Link → Trip | The trip being scanned |
| `scan_type` | Select: Gate Out / Gate In | Which leg of the journey |
| `vehicle_expected` | Data (read-only) | Vehicle number on the Trip |
| `vehicle_entered` | Data | What security typed in |
| `match_status` | Select: Match / Mismatch (read-only) | Auto-computed |
| `scan_time` | Datetime (read-only) | Timestamp of scan |
| `scanned_by` | Link → User (read-only) | Who scanned |

### Data Flow Diagram

```
                    DESK                           GATE
                    ====                           ====

Sales Invoice        │                              │
  (submitted)        │                              │
       │             │                              │
       ▼             │                              │
  "Add to Trip" ─────┤                              │
  Dialog             │                              │
       │             │                              │
       ▼             │                              │
  Trip (Draft)       │                              │
  + Trip Invoices    │                              │
       │             │                              │
       ▼             │                              │
  Submit Trip ───────┤                              │
  - Vehicle → On Trip│                              │
  - QR generated     │                              │
  - trip_code set    │                              │
       │             │                              │
       ▼             │                              │
  Print QR sheet ────┼──── Driver takes to gate ──►│
                     │                              │
                     │         ┌────────────────────┤
                     │         │  /gate-scan page   │
                     │         │  Scan QR / paste   │
                     │         │  URL               │
                     │         │  Enter vehicle #   │
                     │         │  Select Gate Out   │
                     │         │  Confirm           │
                     │         └─────────┬──────────┘
                     │                   │
                     │                   ▼
                     │         ┌────────────────────┐
                     │         │ Gate Entry Log     │
                     │         │ (Match/Mismatch)   │
                     │         └─────────┬──────────┘
                     │                   │
                     │                   ▼
                     │         ┌────────────────────┐
                     │         │ Match?             │
                     │         │  ├─ Yes ──► Status │
                     │         │  │        updated  │
                     │         │  └─ Vehicle freed  │
                     │         │                    │
                     │         │  └─ No ──►Flagged │
                     │         └────────────────────┘
```

### Trip Lifecycle State Machine

```
                    ┌──────────┐
                    │  Draft   │ ◄── Invoices can be added/removed
                    └────┬─────┘
                         │ Submit
                         ▼
                    ┌──────────┐
               ┌───►│Dispatched│ ◄── QR generated, vehicle = On Trip
               │    └────┬─────┘
               │         │ Gate-Out scan (Match: Outward)
               │         ├──────────────────────────────► ┌───────────┐
               │         │                                  │ Completed │
               │         │ Gate-Out scan (Match: Returnable)│ Vehicle → │
               │         └──────────────────────────────► ┌│ Available │
               │         │                                  └───────────┘
               │         │ Gate-Out scan (Mismatch)
               │         └──────────────────────────────► ┌──────────┐
               │                                            │ Flagged  │
               │         ┌──────────┐                       └──────────┘
               │         │In Transit│ ◄── After Gate-Out match
               │         └────┬─────┘    (Returnable only)
               │              │ Gate-In scan (Match)
               │              └──────────────────────────► ┌───────────┐
               │                                             │ Completed │
               │              Gate-In scan (Mismatch)        │ Vehicle → │
               │              └──────────────────────────► ┌│ Available │
               │                                              └───────────┘
               │         ┌──────────┐
               └─────────┤ Cancelled│ ◄── Only from Draft/Dispatched (no scans)
                         └──────────┘
```

### API Endpoints

All whitelisted methods under `trip_dispatch.api`:

| Method | Endpoint | Purpose | Called From |
|---|---|---|---|
| `get_open_trips` | `/api/method/trip_dispatch.api.get_open_trips` | List draft trips for batching | Sales Invoice client script |
| `add_invoice_to_trip` | `/api/method/trip_dispatch.api.add_invoice_to_trip` | Add invoice to new/existing trip | Sales Invoice client script |
| `lookup_trip` | `/api/method/trip_dispatch.api.lookup_trip` | Validate trip_code and return trip details | Gate scan page |
| `record_gate_scan` | `/api/method/trip_dispatch.api.record_gate_scan` | Record gate-out/gate-in scan with vehicle check | Gate scan page |

### Gate Scan Page

Located at **`/gate-scan`** — a standalone Frappe web page (`www/gate-scan/index.html` + `index.py`).

**Behaviour:**
- Redirects unauthenticated users to login
- Requires `Gate Security`, `Trip Manager`, or `System Manager` role
- Uses `html5-qrcode` library for camera-based QR scanning
- Fallback manual input for pasting the full gate-scan URL
- Displays trip details (expected vehicle, invoice list) after successful lookup
- Auto-selects scan type (`Gate Out` or `Gate In`) based on current trip status
- Requires security to type the observed vehicle number before confirming
- Shows match/mismatch result with colour-coded feedback

---

## Roles & Permissions

Two custom roles are created automatically via `install.py`:

### Trip Manager
- **Full CRUD** on Trip, Vehicle, Gate Entry Log
- Can submit, cancel, amend trips
- Can investigate and resolve flagged trips
- Has desk access

### Gate Security
- **Read-only** access to Trip and Vehicle (can view dispatch info)
- **Create** permission on Gate Entry Log (can record scans)
- Has desk access (needed for login — can be restricted via desk access setting if gate devices only use `/gate-scan`)
- **No write/delete** on any doctype

### System Manager
- Inherits all permissions by default

### Sales User
- Can create and read Trips (to add invoices)
- Cannot delete, cancel, or submit trips

---

## Standard Operating Procedure (SOP)

### A. Setup (One-Time)

#### Step A1 — Install the App
```bash
bench get-app trip_dispatch https://github.com/balaji-001-gif/trip_generation
bench --site your-site.local install-app trip_dispatch
bench --site your-site.local migrate
```

#### Step A2 — Assign Roles
1. Navigate to **Desk > User**
2. For each user who will manage trips: assign **Trip Manager** role
3. For each gate security guard: assign **Gate Security** role
4. For sales staff who need to create trips: assign **Sales User** role (or Trip Manager)

#### Step A3 — Create Vehicle Records
1. Go to **Desk > Trip Dispatch > Vehicle**
2. Click **+ Add Vehicle**
3. Enter the vehicle registration number (e.g., `KA01AB1234`)
4. Select vehicle type (Truck / Van / Pickup / Bike / Other)
5. Optionally set default driver and capacity
6. **Save**
7. Repeat for all vehicles in the fleet

#### Step A4 — Configure Gate Device
1. Open a browser on the gate computer/tablet
2. Navigate to `https://your-site.local/gate-scan`
3. Log in with a user that has the **Gate Security** role
4. Keep the page open and full-screened

> **Tip:** For reliable QR scanning, use a device with a rear-facing camera in good lighting. If the camera isn't available, the page falls back to manual URL paste — scan the QR with any smartphone, copy the URL, and paste it into the gate device.

---

### B. Desk Workflow — Trip Manager / Sales User

#### Step B1 — Create & Batch Invoices to a Trip

1. Open a **submitted** Sales Invoice
2. Click the **Dispatch > Add to Trip** button
3. A dialog appears with two options:
   - **New Trip**: Select a vehicle and trip type (Outward/Returnable)
   - **Existing Open Trip**: Pick from a list of draft trips to add this invoice to
4. Click **Add**
5. The system creates the Trip (or updates the existing one) and shows a confirmation
6. You are redirected to the Trip form

> **Repeat** for each invoice that will ride on the same vehicle. Multiple invoices can be batched onto one trip.

#### Step B2 — Verify Trip Details

1. Open the **Trip** document
2. Review the invoice list — all expected invoices are listed with their totals
3. Verify the vehicle assignment is correct
4. Check the trip type:
   - **Outward**: Closes on Gate-Out match (one-way delivery)
   - **Returnable**: Requires both Gate-Out and Gate-In (e.g., returnable containers, empties)

#### Step B3 — Submit the Trip

1. Click **Submit** on the Trip form
2. The system:
   - Generates a random 20-character `trip_code`
   - Sets vehicle status to **On Trip** (blocks reassignment)
   - Generates and attaches a **QR code** image to the Trip
   - Changes Trip status to **Dispatched**
3. **Print or save** the QR code from the Trip form — this goes on the dispatch sheet that the driver carries to the gate

> ⚠️ **Once submitted, invoices cannot be removed.** If a correction is needed, cancel the trip (if no gate scans have been recorded) and create a new one.

#### Step B4 — Review Trip Progress

- The Trip form shows **Gate Out Time** and **Gate In Time** fields (populated by gate scans)
- Check **Status** field for current state
- View the **Gate Entry Log** report to see all scan activity

---

### C. Gate Workflow — Gate Security

#### Step C1 — Gate-Out Scan (Vehicle Leaving)

1. Driver presents the dispatch sheet with the **QR code**
2. **Scan the QR** using the `/gate-scan` page camera
   - *Alternatively:* copy-paste the URL from the QR into the manual input field
3. The system looks up the trip and displays:
   - Trip name
   - **Expected vehicle number**
   - Trip status
   - List of invoices onboard
4. **Visually verify** the vehicle at the gate
5. Type the **actual vehicle number** seen at the gate into the text field
6. Select **Gate Out** from the scan type dropdown
7. Click **Confirm scan**

**Outcome:**
- ✅ **Match** (numbers match):
  - **Outward trip**: Status → `Completed`, Vehicle → `Available`
  - **Returnable trip**: Status → `In Transit` (waiting for return)
- ❌ **Mismatch** (numbers differ):
  - Status → **Flagged** — vehicle is NOT released
  - Supervisor must investigate

> The scan is logged in **Gate Entry Log** with match/mismatch status regardless of outcome. This record cannot be edited.

#### Step C2 — Gate-In Scan (Vehicle Returning — Returnable Trips Only)

For trips marked as **Returnable**, the vehicle must also be scanned on return:

1. Driver returns with the vehicle
2. **Scan the same QR code** from the original dispatch sheet
3. System displays trip details and current status (`In Transit`)
4. **Visually verify** the returning vehicle number
5. Type the vehicle number and select **Gate In**
6. Click **Confirm scan**

**Outcome:**
- ✅ **Match**: Status → `Completed`, Vehicle → `Available`
- ❌ **Mismatch**: Status → **Flagged**

---

### D. Exception Handling — Flagged Trips

#### When a Mismatch Occurs

If a gate scan produces a mismatch, the Trip is set to **Flagged** status:

1. **Trip Dashboard** shows a red alert: *"This trip is FLAGGED for a vehicle mismatch at the gate."*
2. The vehicle remains **On Trip** status — it is **not** released for reassignment
3. The **Gate Entry Log** contains the evidence: expected vs. entered vehicle, timestamp, and who scanned

#### Investigation Procedure (Trip Manager)

1. Open the flagged **Trip** document
2. Click on the **Gate Entry Log** link to view the mismatch record
3. Review the difference between `vehicle_expected` and `vehicle_entered`
4. Investigate physically at the gate or with the driver
5. **If the mismatch was an error** (security typed wrong vehicle number, or the same vehicle has an alternative registration):
   - Manually correct the Trip's status back to `Dispatched` or `In Transit`
   - Re-scan at the gate with the correct vehicle number
6. **If the wrong vehicle left**:
   - Take appropriate operational action (recovery, documentation)
   - Manually set the Trip status to `Completed` or `Cancelled` after resolution
   - Manually set the Vehicle status back to `Available`

> **Note:** There is currently no automated "Resolve Flag" workflow. A Frappe Workflow can be added if formal approval routing is needed (see [Known Limitations](#known-limitations--roadmap)).

---

## Installation

### Prerequisites
- ERPNext v15+ installed on the site
- Frappe Bench environment

### Install Steps

```bash
# From your bench directory
bench get-app trip_dispatch https://github.com/balaji-001-gif/trip_generation
bench --site your-site.local install-app trip_dispatch
bench --site your-site.local migrate
```

`pyproject.toml` declares `qrcode` and `pillow` as dependencies — `bench get-app` / `install-app` installs them into the bench's virtualenv automatically.

### Post-Install Checklist

| # | Task | Assigned to |
|---|---|---|
| 1 | ✅ Assign **Trip Manager** role to dispatch managers | System Manager |
| 2 | ✅ Assign **Gate Security** role to gate personnel | System Manager |
| 3 | ✅ Create **Vehicle** records for all fleet vehicles | Trip Manager |
| 4 | ✅ Verify `/gate-scan` loads on gate devices | Gate Security |
| 5 | ✅ Test a complete Outward trip (create → submit → scan gate-out) | Trip Manager |
| 6 | ✅ Test a complete Returnable trip (create → gate-out → gate-in) | Trip Manager |

---

## Configuration

### Trip Type

Two trip types determine the gate workflow:

- **Outward** (default): One-way delivery. Trip completes on matching Gate-Out scan.
- **Returnable**: Round trip. Requires both Gate-Out (→ `In Transit`) and matching Gate-In (→ `Completed`) scan. Use for:
  - Returnable containers / pallets / crates
  - Equipment sent on loan
  - Delivery of empties awaiting return
  - Any scenario where the vehicle must come back through the gate

### Client Script Extensibility

The **Delivery Note** field on Trip Invoice allows adapting this app for dispatch-by-Delivery-Note workflows:

1. Create a new client script for **Delivery Note** (based on `public/js/sales_invoice.js`)
2. Call the same `add_invoice_to_trip` API but pass `delivery_note` instead of (or alongside) `sales_invoice`
3. The child table already has the `delivery_note` field ready

### Frappe Workflow (Optional)

For formal approval routing on flagged trips, add a **Frappe Workflow** on the Trip doctype with:
- States: `Flagged` → `Under Investigation` → `Resolved`
- Transitions restricted to **Trip Manager** role only
- Replace the manual free-text status field with a controlled workflow

---

## Design Decisions

| Decision | Rationale |
|---|---|
| **Trip ↔ Sales Invoice is many-to-many** | Modeled as a child table (`Trip Invoice`), not a field on the invoice. One vehicle commonly carries several invoices. |
| **Trip Invoice has an optional Delivery Note link** | Not hard-coded to one trigger — adapt for your dispatch workflow without modifying the core. |
| **Vehicle is a new lightweight doctype** | Plain ERPNext (without HRMS) has no Vehicle master. If you use HRMS, you may swap this for HRMS's `Vehicle`. |
| **QR encodes a random trip_code** | Not the vehicle number or trip name. A photocopy of an old QR is useless once that trip closes. |
| **Gate Entry Log is append-only** | Evidence trail for mismatches. Edits defeat the point. The `on_update` hook rejects changes. |
| **Vehicle number is normalized to uppercase** | "KA01AB1234", "ka01ab1234", "KA01AB1234 " all match — reduces human error at the gate. |
| **Separate "Add to Trip" step from invoice submission** | Trip creation has to be a deliberate batching action, not an automatic side effect that would create one trip per invoice. |

---

## Known Limitations & Roadmap

| Limitation | Workaround / Next Step |
|---|---|
| **No built-in flag resolution workflow** | Trip Manager manually edits status. Add a Frappe Workflow for controlled transitions. |
| **Gate scan page has no offline mode** | Use a PWA with local storage and sync for unreliable connectivity. |
| **No print format for QR / dispatch sheet** | Add a custom Print Format with QR + invoice table. |
| **No partial-trip handling** | Split deliveries within one trip need explicit modeling. |
| **No email/SMS notifications** | Add notification triggers for flagging, completion, etc. |
| **No dashboard / KPIs** | Build a Trip Dispatch Dashboard with pending scans, flag rate, vehicle utilisation. |

---

## License

MIT
