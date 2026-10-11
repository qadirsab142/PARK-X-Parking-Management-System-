# PARK-X-Parking-Management-System-
Correct architecture
Browser UI → server.js → MIPS (MARS) → server.js → Browser UI

public/index.html = public website, layout, animations and user flow.
admin/admin.html + admin/admin.css = admin dashboard layout.
public/index.html JavaScript = browser actions and API calls.
admin/admin.js = admin controls and live rendering.
bridge/server.js = the bridge/API. It starts MARS and keeps the MIPS program running.
Backend/PARK-X_PROPER_MIPS_BACKEND.asm = parking core logic.
data/park-x-state.json = persistent UI/business record mirror.
MIPS handles the core operations
Parking slot allocation
Parking ID generation
Active parking records
Vehicle exit processing
Transaction counter
Revenue counter
System reset
Node.js is not replacing MIPS. It is the communication bridge between the browser and MIPS.

Run
Open a terminal in this folder:

node bridge/server.js
You should see:

PARK-X MIPS core connected.
PARK-X SERVER RUNNING
Public: http://localhost:8090
Admin:  http://localhost:8090/admin
MIPS:   CONNECTED
Open the public site:

http://localhost:8090
Open the admin portal:

http://localhost:8090/admin
Admin login:

Username: admin
Password: admin123
Important: Do not open public/index.html directly with Live Server. Start server.js first so the browser, bridge and MIPS core are connected.

Quick viva flow
User opens PARK-X.
User submits vehicle entry.
Browser sends /api/entry to server.js.
server.js sends ENTRY|... to the running MIPS program.
MIPS finds a free slot and generates the parking ID.
MIPS returns the result to server.js.
server.js returns the result to the browser.
On exit, the browser verifies the session with the bridge.
The bridge calculates the time-based bill, then sends the payment to MIPS.
MIPS closes the active record and updates transaction/revenue counters.
The bridge saves the completed record and sends the updated result back to the UI.
Admin dashboard reads the same server state.
MARS
Backend/mars.jar is already included. Java must be available in PATH.

Do not start the MIPS .asm separately for the web application. server.js starts it automatically.
