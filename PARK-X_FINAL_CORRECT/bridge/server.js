const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { spawn } = require("child_process");
const readline = require("readline");

const PORT = 8090;
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const ADMIN_DIR = path.join(ROOT, "admin");
const BACKEND_DIR = path.join(ROOT, "Backend");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "park-x-state.json");

const TOTAL_SLOTS = 30;
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin123";

const sessions = new Map();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultState() {
  return {
    totalSlots: TOTAL_SLOTS,
    parkingSlots: Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
      slot: i + 1,
      status: "available",
      parkingId: null,
      vehicle: null,
      type: null,
      category: null,
      phone: null,
      name: null,
      gate: null,
      entryTime: null,
      exitTime: null,
      fee: 0
    })),
    activeVehicles: [],
    completedVehicles: [],
    transactions: [],
    revenue: 0,
    nextParkingId: 1001,
    gates: { entry: true, exit: true },
    emergencyMode: false,
    evCharging: true,
    updatedAt: new Date().toISOString()
  };
}

function normalizeState(saved) {
  const fresh = defaultState();
  const state = { ...fresh, ...(saved || {}) };

  state.parkingSlots =
    Array.isArray(saved?.parkingSlots) && saved.parkingSlots.length
      ? saved.parkingSlots
      : fresh.parkingSlots;

  state.activeVehicles = Array.isArray(saved?.activeVehicles)
    ? saved.activeVehicles : [];
  state.completedVehicles = Array.isArray(saved?.completedVehicles)
    ? saved.completedVehicles : [];
  state.transactions = Array.isArray(saved?.transactions)
    ? saved.transactions : [];

  state.gates = {
    entry: saved?.gates?.entry ?? true,
    exit: saved?.gates?.exit ?? true
  };

  state.evCharging = saved?.evCharging ?? true;
  return state;
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const fresh = defaultState();
      fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
      return fresh;
    }
    return normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch {
    return defaultState();
  }
}

let state = loadState();

function saveState() {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function text(res, status, data, type = "text/plain") {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => raw += chunk.toString());
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function tokenFromRequest(req) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

function adminLoggedIn(req) {
  const token = tokenFromRequest(req);
  return Boolean(token && sessions.has(token));
}

function adminRequired(req, res) {
  if (!adminLoggedIn(req)) {
    json(res, 401, { success: false, message: "Admin login required" });
    return false;
  }
  return true;
}

function normalizeVehicle(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function numericParkingId(value) {
  return Number(String(value || "").replace(/^PX-/i, ""));
}

function parkingId(value) {
  return `PX-${value}`;
}

function calculateFee(entryTime, type) {
  const start = new Date(entryTime).getTime();
  const minutes = Math.max(1, Math.ceil((Date.now() - start) / 60000));
  const hours = Math.max(1, Math.ceil(minutes / 60));
  return hours * (type === "EV" ? 80 : 100);
}

function buildDashboard() {
  const occupied = state.activeVehicles.length;
  return {
    totalSlots: state.totalSlots,
    availableSlots: state.totalSlots - occupied,
    occupiedSlots: occupied,
    activeVehicles: occupied,
    completedVehicles: state.completedVehicles.length,
    transactions: state.transactions.length,
    revenue: state.revenue,
    gates: state.gates,
    emergencyMode: state.emergencyMode,
    evCharging: state.evCharging,
    updatedAt: state.updatedAt
  };
}

/*
  MIPS is the parking core:
  - slot allocation
  - parking ID generation
  - active record management
  - exit processing
  - transaction count
  - revenue counter

  Node/HTML is the bridge/presentation layer:
  - HTTP
  - names/phones/PINs/timestamps
  - UI
  - JSON persistence
  - fee calculation based on real time
*/
class MipsBridge {
  constructor() {
    this.child = null;
    this.readline = null;
    this.ready = null;
    this.queue = Promise.resolve();
    this.idMap = new Map();
  }

  start() {
    this.ready = new Promise((resolve, reject) => {
      const jar = path.join(BACKEND_DIR, "mars.jar");
      const asm = path.join(BACKEND_DIR, "PARK-X_PROPER_MIPS_BACKEND.asm");

      this.child = spawn("java", [
        "-Djava.awt.headless=true",
        "-jar", jar,
        "nc",
        asm
      ], {
        cwd: ROOT,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });

      this.readline = readline.createInterface({ input: this.child.stdout });

      const onLine = line => {
        const value = line.trim();
        if (value === "READY") {
          this.readline.removeListener("line", onLine);
          resolve();
        }
      };

      this.readline.on("line", onLine);

      this.child.stderr.on("data", data => {
        const msg = data.toString().trim();
        if (msg) console.error("[MIPS]", msg);
      });

      this.child.on("error", error => {
        console.error("MIPS process error:", error);
        reject(error);
      });

      this.child.on("exit", (code, signal) => {
        if (code !== 0 && code !== null) {
          console.error(`MIPS process exited with code ${code}${signal ? ` (${signal})` : ""}`);
        }
      });
    });

    return this.ready;
  }

  execute(command, matcher) {
    const job = this.queue.then(() => this._execute(command, matcher));
    this.queue = job.catch(() => {});
    return job;
  }

  _execute(command, matcher) {
    return this.ready.then(() => new Promise((resolve, reject) => {
      const onLine = line => {
        const value = line.trim();
        if (!matcher(value)) return;
        this.readline.removeListener("line", onLine);
        resolve(value);
      };

      this.readline.on("line", onLine);

      try {
        this.child.stdin.write(command + "\n");
      } catch (error) {
        this.readline.removeListener("line", onLine);
        reject(error);
      }
    }));
  }

  async syncFromState() {
    await this.execute("SYNC|"
      + Number(state.nextParkingId || 1001) + "|"
      + Number(state.revenue || 0) + "|"
      + Number(state.completedVehicles?.length || 0) + "|"
      + Number(state.transactions?.length || 0),
      line => line === "SYNC_OK"
    );

    // Rebuild active MIPS records after a server restart.
    this.idMap.clear();
    const active = [...state.activeVehicles].sort(
      (a, b) => new Date(a.entryTime) - new Date(b.entryTime)
    );

    for (const vehicle of active) {
      const result = await this.execute(
        `ENTRY|${vehicle.vehicle}|${vehicle.type === "EV" ? "EV" : "Normal"}`,
        line => line.startsWith("ENTRY_OK|") || line.startsWith("ERROR|")
      );

      if (!result.startsWith("ENTRY_OK|")) {
        throw new Error(`MIPS active-state restore failed: ${result}`);
      }

      const parts = result.split("|");
      this.idMap.set(String(vehicle.parkingId), Number(parts[1]));
    }
  }

  async entry(vehicle, type) {
    const result = await this.execute(
      `ENTRY|${vehicle}|${type === "EV" ? "EV" : "Normal"}`,
      line => line.startsWith("ENTRY_OK|") || line.startsWith("ERROR|")
    );

    if (!result.startsWith("ENTRY_OK|")) {
      throw new Error(this.mipsError(result));
    }

    const parts = result.split("|");
    return {
      numericId: Number(parts[1]),
      slot: Number(parts[2])
    };
  }

  async exit(originalParkingId, payment) {
    const original = numericParkingId(originalParkingId);
    const mipsId = this.idMap.get(String(originalParkingId)) ?? original;

    const result = await this.execute(
      `EXIT|${mipsId}|${Math.max(0, Math.round(payment))}`,
      line => line.startsWith("EXIT_OK|") || line.startsWith("ERROR|")
    );

    if (!result.startsWith("EXIT_OK|")) {
      throw new Error(this.mipsError(result));
    }

    this.idMap.delete(String(originalParkingId));
    const parts = result.split("|");

    return {
      numericId: Number(parts[1]),
      slot: Number(parts[2]),
      payment: Number(parts[3])
    };
  }

  async reset() {
    const result = await this.execute(
      "RESET",
      line => line === "RESET_OK" || line.startsWith("ERROR|")
    );
    if (result !== "RESET_OK") throw new Error(this.mipsError(result));
    this.idMap.clear();
  }

  mipsError(line) {
    if (line.includes("PARKING_FULL")) return "Parking is full";
    if (line.includes("VEHICLE_NOT_FOUND")) return "Vehicle not found";
    if (line.includes("INVALID_PARKING_ID")) return "Invalid parking ID";
    if (line.includes("INVALID_PAYMENT")) return "Invalid payment";
    return line.replace(/^ERROR\|/, "MIPS error: ");
  }

  stop() {
    try {
      if (this.child && !this.child.killed) {
        this.child.stdin.write("QUIT\n");
        setTimeout(() => this.child.kill(), 500);
      }
    } catch {}
  }
}

const mips = new MipsBridge();

async function initializeMips() {
  await mips.start();
  await mips.syncFromState();
  console.log("PARK-X MIPS core connected.");
}

function serveFile(res, pathname) {
  let filePath;

  if (pathname === "/" || pathname === "/index.html") {
    filePath = path.join(PUBLIC_DIR, "index.html");
  } else if (pathname === "/admin" || pathname === "/admin/") {
    filePath = path.join(ADMIN_DIR, "admin.html");
  } else if (pathname.startsWith("/admin/")) {
    filePath = path.join(ADMIN_DIR, pathname.replace("/admin/", ""));
  } else {
    filePath = path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ""));
  }

  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR) && !filePath.startsWith(ADMIN_DIR)) {
    text(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) return text(res, 404, "File not found");

    const types = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };

    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath).toLowerCase()]
        || "application/octet-stream"
    });
    res.end(data);
  });
}

async function api(req, res, pathname) {
  if (req.method === "OPTIONS") return json(res, 200, { success: true });

  if (pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      success: true,
      server: "PARK-X bridge",
      mips: Boolean(mips.child && !mips.child.killed),
      port: PORT
    });
  }

  if (pathname === "/api/state" && req.method === "GET") {
    return json(res, 200, state);
  }

  if (pathname === "/api/dashboard" && req.method === "GET") {
    return json(res, 200, buildDashboard());
  }

  if (pathname === "/api/admin/me" && req.method === "GET") {
    return json(res, 200, { success: true, loggedIn: adminLoggedIn(req) });
  }

  if (pathname === "/api/admin/login" && req.method === "POST") {
    const data = await readBody(req);
    if (data.username !== ADMIN_USERNAME || data.password !== ADMIN_PASSWORD) {
      return json(res, 401, {
        success: false,
        message: "Invalid username or password"
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { username: ADMIN_USERNAME, loginTime: Date.now() });

    return json(res, 200, {
      success: true,
      token,
      username: ADMIN_USERNAME
    });
  }

  if (pathname === "/api/admin/logout" && req.method === "POST") {
    const token = tokenFromRequest(req);
    if (token) sessions.delete(token);
    return json(res, 200, { success: true });
  }

  if (pathname === "/api/entry" && req.method === "POST") {
    const data = await readBody(req);

    if (!state.gates.entry) {
      return json(res, 403, { success: false, message: "Entry gate is closed" });
    }
    if (state.emergencyMode) {
      return json(res, 403, { success: false, message: "Emergency mode is active" });
    }

    const vehicle = normalizeVehicle(data.vehicle);
    const type = data.ev ? "EV" : (data.type === "EV" ? "EV" : "Normal");
    const category = String(data.category || "Normal").trim();
    const phone = String(data.phone || "").trim();
    const name = String(data.name || "").trim();
    const gate = String(data.gate || "Any Gate").trim();

    if (!vehicle) return json(res, 400, {
      success: false, message: "Vehicle number is required"
    });

    if (!name) return json(res, 400, {
      success: false, message: "Full name is required"
    });

    if (!phone) return json(res, 400, {
      success: false, message: "Phone number is required"
    });

    if (type === "EV" && !state.evCharging) {
      return json(res, 403, {
        success: false, message: "EV charging is currently disabled"
      });
    }

    if (state.activeVehicles.some(v => v.vehicle === vehicle)) {
      return json(res, 409, {
        success: false, message: "Vehicle is already inside"
      });
    }

    let core;
    try {
      core = await mips.entry(vehicle, type);
    } catch (error) {
      return json(res, 409, { success: false, message: error.message });
    }

    const now = new Date().toISOString();
    const id = parkingId(core.numericId);
    const exitPin = String(Math.floor(1000 + Math.random() * 9000));

    const record = {
      parkingId: id,
      exitPin,
      vehicle,
      type,
      category,
      phone,
      name,
      gate,
      slot: core.slot,
      entryTime: now,
      exitTime: null,
      fee: 0,
      status: "active"
    };

    state.activeVehicles.push(record);

    const slot = state.parkingSlots.find(s => s.slot === core.slot);
    if (slot) {
      Object.assign(slot, {
        status: "occupied",
        parkingId: id,
        vehicle,
        type,
        category,
        phone,
        name,
        gate,
        entryTime: now,
        exitTime: null,
        fee: 0
      });
    }

    state.nextParkingId = Math.max(state.nextParkingId, core.numericId + 1);
    saveState();

    return json(res, 200, {
      success: true,
      message: "Vehicle entered successfully",
      parkingId: id,
      exitPin,
      vehicle,
      type,
      category,
      phone,
      name,
      slot: core.slot,
      gate,
      entryTime: now
    });
  }

  if (pathname === "/api/lookup" && req.method === "POST") {
    const data = await readBody(req);
    const phone = String(data.phone || "").trim();

    if (!phone) return json(res, 400, {
      success: false, message: "Phone number is required"
    });

    const matches = state.activeVehicles
      .filter(v => v.phone === phone)
      .map(v => ({
        parkingId: v.parkingId,
        vehicle: v.vehicle,
        type: v.type,
        slot: v.slot,
        entryTime: v.entryTime
      }));

    if (!matches.length) return json(res, 404, {
      success: false, message: "No active parking session found for this phone number"
    });

    return json(res, 200, { success: true, sessions: matches });
  }

  if (pathname === "/api/verify-exit" && req.method === "POST") {
    const data = await readBody(req);
    const id = String(data.parkingId || "").trim();
    const pin = String(data.exitPin || "").trim();
    const phone = String(data.phone || "").trim();

    const record = state.activeVehicles.find(v => v.parkingId === id);

    if (!record) return json(res, 404, {
      success: false, message: "Parking record not found"
    });

    if (record.exitPin !== pin) return json(res, 401, {
      success: false, message: "Invalid exit PIN"
    });

    if (record.phone !== phone) return json(res, 401, {
      success: false, message: "Phone number does not match"
    });

    const fee = calculateFee(record.entryTime, record.type);

    return json(res, 200, {
      success: true,
      parkingId: record.parkingId,
      vehicle: record.vehicle,
      type: record.type,
      slot: record.slot,
      entryTime: record.entryTime,
      fee
    });
  }

  if (pathname === "/api/exit" && req.method === "POST") {
    const data = await readBody(req);

    if (!state.gates.exit) {
      return json(res, 403, { success: false, message: "Exit gate is closed" });
    }

    const id = String(data.parkingId || "").trim();
    const pin = String(data.exitPin || "").trim();
    const phone = String(data.phone || "").trim();
    const payment = Number(data.payment);

    const index = state.activeVehicles.findIndex(v => v.parkingId === id);
    if (index < 0) return json(res, 404, {
      success: false, message: "Parking record not found"
    });

    const record = state.activeVehicles[index];

    if (record.exitPin !== pin) return json(res, 401, {
      success: false, message: "Invalid exit PIN"
    });

    if (record.phone !== phone) return json(res, 401, {
      success: false, message: "Phone number does not match"
    });

    const fee = calculateFee(record.entryTime, record.type);

    if (!Number.isFinite(payment) || payment < fee) {
      return json(res, 400, {
        success: false,
        message: `Minimum payment is Rs. ${fee}`,
        fee
      });
    }

    let core;
    try {
      core = await mips.exit(id, payment);
    } catch (error) {
      return json(res, 409, { success: false, message: error.message });
    }

    const exitTime = new Date().toISOString();
    const durationMinutes = Math.max(
      1,
      Math.ceil((Date.parse(exitTime) - Date.parse(record.entryTime)) / 60000)
    );

    const completed = {
      ...record,
      exitTime,
      durationMinutes,
      fee,
      payment,
      change: payment - fee,
      status: "completed"
    };

    state.activeVehicles.splice(index, 1);
    state.completedVehicles.unshift(completed);

    state.transactions.unshift({
      transactionId: `TX-${Date.now()}`,
      parkingId: id,
      vehicle: record.vehicle,
      type: record.type,
      slot: record.slot,
      durationMinutes,
      amount: fee,
      payment,
      change: payment - fee,
      date: exitTime,
      status: "paid"
    });

    state.revenue += payment;

    const slot = state.parkingSlots.find(s => s.slot === record.slot);
    if (slot) {
      Object.assign(slot, {
        status: "available",
        parkingId: null,
        vehicle: null,
        type: null,
        category: null,
        phone: null,
        name: null,
        gate: null,
        entryTime: null,
        exitTime,
        fee
      });
    }

    saveState();

    return json(res, 200, {
      success: true,
      message: "Vehicle exited successfully",
      parkingId: id,
      vehicle: record.vehicle,
      type: record.type,
      slot: record.slot,
      entryTime: record.entryTime,
      exitTime,
      durationMinutes,
      fee,
      payment: core.payment,
      change: payment - fee
    });
  }

  if (pathname === "/api/admin/active-vehicles" && req.method === "GET") {
    if (!adminRequired(req, res)) return;
    return json(res, 200, { success: true, vehicles: state.activeVehicles });
  }

  if (pathname === "/api/admin/completed-vehicles" && req.method === "GET") {
    if (!adminRequired(req, res)) return;
    return json(res, 200, { success: true, vehicles: state.completedVehicles });
  }

  if (pathname === "/api/admin/transactions" && req.method === "GET") {
    if (!adminRequired(req, res)) return;
    return json(res, 200, {
      success: true,
      transactions: state.transactions,
      revenue: state.revenue
    });
  }

  if (pathname === "/api/gates" && req.method === "POST") {
    if (!adminRequired(req, res)) return;
    const data = await readBody(req);

    if (typeof data.entry === "boolean") state.gates.entry = data.entry;
    if (typeof data.exit === "boolean") state.gates.exit = data.exit;

    saveState();
    return json(res, 200, { success: true, gates: state.gates });
  }

  if (pathname === "/api/emergency" && req.method === "POST") {
    if (!adminRequired(req, res)) return;
    const data = await readBody(req);
    state.emergencyMode = Boolean(data.enabled);
    saveState();
    return json(res, 200, {
      success: true, emergencyMode: state.emergencyMode
    });
  }

  if (pathname === "/api/ev-charging" && req.method === "POST") {
    if (!adminRequired(req, res)) return;
    const data = await readBody(req);
    state.evCharging = Boolean(data.enabled);
    saveState();
    return json(res, 200, {
      success: true, evCharging: state.evCharging
    });
  }

  if (pathname === "/api/clear-history" && req.method === "POST") {
    if (!adminRequired(req, res)) return;
    state.completedVehicles = [];
    state.transactions = [];
    saveState();
    return json(res, 200, { success: true, message: "History cleared" });
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    if (!adminRequired(req, res)) return;

    try {
      await mips.reset();
      state = defaultState();
      saveState();
      return json(res, 200, {
        success: true,
        message: "System reset successfully",
        state
      });
    } catch (error) {
      return json(res, 500, { success: false, message: error.message });
    }
  }

  if (pathname === "/api/mips" && req.method === "GET") {
    return json(res, 200, {
      success: true,
      connected: Boolean(mips.child && !mips.child.killed),
      message: "PARK-X MIPS core bridge available"
    });
  }

  return json(res, 404, { success: false, message: "API route not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    if (requestUrl.pathname.startsWith("/api/")) {
      await api(req, res, requestUrl.pathname);
    } else {
      serveFile(res, requestUrl.pathname);
    }
  } catch (error) {
    console.error(error);
    json(res, 500, { success: false, message: "Internal server error" });
  }
});

async function start() {
  try {
    await initializeMips();
    server.listen(PORT, "127.0.0.1", () => {
      console.log("");
      console.log("================================");
      console.log("       PARK-X SERVER RUNNING");
      console.log("================================");
      console.log(`Public: http://localhost:${PORT}`);
      console.log(`Admin:  http://localhost:${PORT}/admin`);
      console.log(`Health: http://localhost:${PORT}/api/health`);
      console.log("MIPS:   CONNECTED");
      console.log("================================");
      console.log("");
    });
  } catch (error) {
    console.error("Could not start PARK-X:", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  mips.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  mips.stop();
  process.exit(0);
});

start();
