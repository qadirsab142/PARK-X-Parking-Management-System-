const API_BASE = "/api";

let adminToken = localStorage.getItem("parkx_admin_token") || "";
let currentState = null;
let activeSection = "dashboard";

async function apiRequest(endpoint, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({
    success: false,
    message: "Invalid server response"
  }));

  if (response.status === 401) {
    adminToken = "";
    localStorage.removeItem("parkx_admin_token");
    showLoginScreen();
  }

  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}

const $ = id => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function formatMoney(value) {
  return `Rs. ${Number(value || 0).toLocaleString()}`;
}

function showToast(message, type = "success") {
  const toast = $("toast");
  if (!toast) return alert(message);

  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.add("show");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function showLoginScreen() {
  let screen = $("parkxLoginScreen");

  if (!screen) {
    screen = document.createElement("div");
    screen.id = "parkxLoginScreen";
    screen.innerHTML = `
      <div style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#f5f7f8">
        <form id="parkxLoginForm" style="width:min(420px,100%);background:#fff;border:1px solid #d9e2e8;padding:34px;box-shadow:0 20px 50px rgba(18,37,63,.12)">
          <div style="font-size:12px;font-weight:800;letter-spacing:.14em;color:#0876c9">PARK-X</div>
          <h1 style="margin:8px 0 6px;color:#12253f;font-size:30px">Admin Control</h1>
          <p style="margin:0 0 24px;color:#657b8e">Sign in to manage the parking system.</p>
          <label style="display:block;font-size:13px;font-weight:700;margin:0 0 7px">Username</label>
          <input id="parkxLoginUser" required value="admin" style="width:100%;height:46px;border:1px solid #cbd7df;padding:0 12px;margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:700;margin:0 0 7px">Password</label>
          <input id="parkxLoginPass" required type="password" style="width:100%;height:46px;border:1px solid #cbd7df;padding:0 12px">
          <button type="submit" style="width:100%;height:46px;margin-top:20px;border:0;background:#0876c9;color:#fff;font-weight:800">Sign in</button>
          <p id="parkxLoginError" style="min-height:20px;margin:12px 0 0;color:#c33b42;font-size:13px"></p>
        </form>
      </div>
    `;
    document.body.appendChild(screen);
    $("parkxLoginForm").addEventListener("submit", login);
  }

  screen.style.display = "block";
  document.querySelector(".app-shell").style.display = "none";
}

function hideLoginScreen() {
  const screen = $("parkxLoginScreen");
  if (screen) screen.style.display = "none";
  document.querySelector(".app-shell").style.display = "";
}

async function login(event) {
  event.preventDefault();

  const username = $("parkxLoginUser")?.value.trim();
  const password = $("parkxLoginPass")?.value || "";
  const error = $("parkxLoginError");

  try {
    const result = await apiRequest("/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    adminToken = result.token;
    localStorage.setItem("parkx_admin_token", adminToken);
    hideLoginScreen();
    await loadState();
    showToast("Admin login successful");
  } catch (e) {
    if (error) error.textContent = e.message;
  }
}

async function logout() {
  try { await apiRequest("/admin/logout", { method: "POST" }); } catch {}
  adminToken = "";
  localStorage.removeItem("parkx_admin_token");
  showLoginScreen();
}

function switchSection(section) {
  activeSection = section;

  document.querySelectorAll(".page-section").forEach(el => {
    el.classList.toggle("active", el.id === section);
  });

  document.querySelectorAll(".nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.section === section);
  });

  const title = {
    dashboard: "Dashboard",
    slots: "Live Slot Map",
    vehicles: "Active Vehicles",
    transactions: "Transactions",
    history: "Parking History",
    gates: "Gate Management",
    system: "System Settings"
  }[section] || "Dashboard";

  $("pageTitle").textContent = title;
}

function renderDashboard(data) {
  const total = Number(data.totalSlots || 0);
  const occupied = Number(data.occupiedSlots || 0);
  const available = Number(data.availableSlots || total);
  const percent = total ? Math.round((occupied / total) * 100) : 0;

  $("availableStat").textContent = available;
  $("capacityStat").textContent = `of ${total} total spaces`;
  $("occupiedStat").textContent = occupied;
  $("occupancyStat").textContent = `${percent}% occupancy`;
  $("activeStat").textContent = Number(data.activeVehicles || 0);
  $("revenueStat").textContent = formatMoney(data.revenue);

  $("occupancyBar").style.width = `${percent}%`;

  const pill = $("modePill");
  pill.textContent = data.emergencyMode ? "● Emergency Mode" : "● Normal Mode";
}

function renderSlots(data) {
  const map = $("slotMap");
  if (!map) return;

  const filter = $("slotFilter")?.value || "all";
  const slots = (data.parkingSlots || []).filter(slot =>
    filter === "all" ? true : slot.status === filter
  );

  map.innerHTML = slots.map(slot => `
    <article class="parking-slot ${slot.status}">
      <strong>Slot ${slot.slot}</strong>
      <span>${slot.status === "occupied" ? "Occupied" : "Available"}</span>
      ${slot.status === "occupied"
        ? `<small>${escapeHtml(slot.vehicle)}<br>${escapeHtml(slot.parkingId)}</small>`
        : `<small>Ready for vehicle</small>`}
    </article>
  `).join("");
}

function renderVehicles(data) {
  const body = $("vehiclesTable");
  if (!body) return;

  const query = ($("vehicleSearch")?.value || "").trim().toLowerCase();
  const rows = (data.activeVehicles || []).filter(v =>
    !query ||
    String(v.vehicle).toLowerCase().includes(query) ||
    String(v.parkingId).toLowerCase().includes(query)
  );

  body.innerHTML = rows.length ? rows.map(v => `
    <tr>
      <td>${escapeHtml(v.parkingId)}</td>
      <td><strong>${escapeHtml(v.vehicle)}</strong><br><small>${escapeHtml(v.type)}</small></td>
      <td>${v.slot}</td>
      <td>${formatDate(v.entryTime)}</td>
      <td>${durationText(v.entryTime)}</td>
      <td><button class="table-action" data-exit="${escapeHtml(v.parkingId)}">Exit</button></td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="empty-row">No active vehicles.</td></tr>`;

  body.querySelectorAll("[data-exit]").forEach(btn => {
    btn.addEventListener("click", () => adminExit(btn.dataset.exit));
  });
}

function durationText(entryTime) {
  if (!entryTime) return "-";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(entryTime)) / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function renderTransactions(data) {
  const body = $("transactionsTable");
  if (!body) return;

  const query = ($("transactionSearch")?.value || "").trim().toLowerCase();
  const rows = (data.transactions || []).filter(t =>
    !query ||
    JSON.stringify(t).toLowerCase().includes(query)
  );

  body.innerHTML = rows.length ? rows.map(t => `
    <tr>
      <td>${escapeHtml(t.transactionId)}</td>
      <td>${escapeHtml(t.parkingId)}</td>
      <td>${escapeHtml(t.vehicle)}</td>
      <td>${formatMoney(t.amount ?? t.fee)}</td>
      <td>${formatMoney(t.payment)}</td>
      <td>${formatDate(t.date)}</td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="empty-row">No transactions.</td></tr>`;
}

function renderHistory(data) {
  const body = $("historyTable");
  if (!body) return;

  body.innerHTML = data.completedVehicles?.length ? data.completedVehicles.map(v => `
    <tr>
      <td>${escapeHtml(v.parkingId)}</td>
      <td>${escapeHtml(v.vehicle)}</td>
      <td>${v.slot}</td>
      <td>${formatDate(v.entryTime)}</td>
      <td>${formatDate(v.exitTime)}</td>
      <td><strong>${formatMoney(v.fee)}</strong></td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="empty-row">No completed parking sessions.</td></tr>`;
}

function renderGates(data) {
  const grid = $("gatesGrid");
  if (!grid) return;

  const entry = Boolean(data.gates?.entry);
  const exit = Boolean(data.gates?.exit);

  grid.innerHTML = `
    <article class="panel gate-card">
      <div><h3>Entry Gate</h3><p>Controls new vehicle entry.</p></div>
      <button class="gate-toggle ${entry ? "on" : "off"}" data-gate="entry">
        ${entry ? "OPEN" : "CLOSED"}
      </button>
    </article>
    <article class="panel gate-card">
      <div><h3>Exit Gate</h3><p>Controls vehicle checkout.</p></div>
      <button class="gate-toggle ${exit ? "on" : "off"}" data-gate="exit">
        ${exit ? "OPEN" : "CLOSED"}
      </button>
    </article>
  `;

  grid.querySelectorAll("[data-gate]").forEach(btn => {
    btn.addEventListener("click", () => toggleGate(btn.dataset.gate));
  });
}

function renderSettings(data) {
  const btn = $("emergencyBtn");
  if (btn) btn.textContent = data.emergencyMode
    ? "Disable Emergency Mode"
    : "Enable Emergency Mode";

  const ev = $("evToggle");
  if (ev) ev.checked = Boolean(data.evCharging);

  const storage = document.querySelector(".storage-key");
  if (storage) storage.textContent = "PARK-X server state";
}

function renderActivity(data) {
  const list = $("activityList");
  if (!list) return;

  const events = [
    ...(data.activeVehicles || []).map(v => ({
      time: v.entryTime, text: `${v.vehicle} entered · Slot ${v.slot}`
    })),
    ...(data.completedVehicles || []).map(v => ({
      time: v.exitTime, text: `${v.vehicle} exited · ${formatMoney(v.fee)}`
    }))
  ].sort((a,b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 6);

  list.innerHTML = events.length
    ? events.map(e => `<div class="activity-item"><strong>${escapeHtml(e.text)}</strong><small>${formatDate(e.time)}</small></div>`).join("")
    : `<div class="empty-state">No activity yet.</div>`;
}

function render(data) {
  currentState = data;
  renderDashboard(data);
  renderSlots(data);
  renderVehicles(data);
  renderTransactions(data);
  renderHistory(data);
  renderGates(data);
  renderSettings(data);
  renderActivity(data);
  $("lastSync").textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
}

async function loadState() {
  try {
    render(await apiRequest("/state"));
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function toggleGate(gate) {
  if (!currentState) return;
  const gates = { ...currentState.gates, [gate]: !currentState.gates[gate] };

  try {
    await apiRequest("/gates", {
      method: "POST",
      body: JSON.stringify(gates)
    });
    await loadState();
    showToast(`${gate === "entry" ? "Entry" : "Exit"} gate updated`);
  } catch (e) { showToast(e.message, "error"); }
}

async function toggleEmergency() {
  const enabled = !Boolean(currentState?.emergencyMode);

  try {
    await apiRequest("/emergency", {
      method: "POST",
      body: JSON.stringify({ enabled })
    });
    await loadState();
    showToast(enabled ? "Emergency mode enabled" : "Emergency mode disabled");
  } catch (e) { showToast(e.message, "error"); }
}

async function toggleEV() {
  const enabled = Boolean($("evToggle")?.checked);

  try {
    await apiRequest("/ev-charging", {
      method: "POST",
      body: JSON.stringify({ enabled })
    });
    await loadState();
    showToast(enabled ? "EV charging enabled" : "EV charging disabled");
  } catch (e) { showToast(e.message, "error"); }
}

async function adminExit(parkingId) {
  const vehicle = currentState?.activeVehicles?.find(v => v.parkingId === parkingId);
  if (!vehicle) return showToast("Vehicle not found", "error");

  const fee = await getQuote(vehicle);
  const paymentText = prompt(
    `Vehicle: ${vehicle.vehicle}\nParking ID: ${vehicle.parkingId}\nCurrent bill: Rs. ${fee}\n\nEnter payment amount:`,
    String(fee)
  );

  if (paymentText === null) return;
  const payment = Number(paymentText);

  if (!Number.isFinite(payment)) return showToast("Enter a valid payment", "error");

  try {
    await apiRequest("/exit", {
      method: "POST",
      body: JSON.stringify({
        parkingId,
        exitPin: vehicle.exitPin,
        phone: vehicle.phone,
        payment
      })
    });
    await loadState();
    showToast("Vehicle exited successfully");
  } catch (e) { showToast(e.message, "error"); }
}

async function getQuote(vehicle) {
  const result = await apiRequest("/verify-exit", {
    method: "POST",
    body: JSON.stringify({
      parkingId: vehicle.parkingId,
      exitPin: vehicle.exitPin,
      phone: vehicle.phone
    })
  });
  return result.fee;
}

async function clearHistory() {
  if (!confirm("Clear all completed parking history?")) return;

  try {
    await apiRequest("/clear-history", { method: "POST" });
    await loadState();
    showToast("History cleared");
  } catch (e) { showToast(e.message, "error"); }
}

async function resetSystem() {
  if (!confirm("Reset PARK-X completely? Active vehicles, history and revenue will be cleared.")) return;

  try {
    await apiRequest("/reset", { method: "POST" });
    await loadState();
    showToast("PARK-X reset successfully");
  } catch (e) { showToast(e.message, "error"); }
}

function exportCSV() {
  const rows = currentState?.transactions || [];
  const header = ["Transaction ID","Parking ID","Vehicle","Type","Slot","Amount","Payment","Change","Date"];
  const csv = [
    header,
    ...rows.map(r => [
      r.transactionId, r.parkingId, r.vehicle, r.type, r.slot,
      r.amount ?? r.fee, r.payment, r.change, r.date
    ])
  ].map(row => row.map(v => `"${String(v ?? "").replaceAll('"','""')}"`).join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `parkx-transactions-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => switchSection(btn.dataset.section));
  });

  document.querySelectorAll("[data-go]").forEach(btn => {
    btn.addEventListener("click", () => switchSection(btn.dataset.go));
  });

  $("refreshBtn")?.addEventListener("click", loadState);
  $("exportBtn")?.addEventListener("click", exportCSV);
  $("clearHistoryBtn")?.addEventListener("click", clearHistory);
  $("emergencyBtn")?.addEventListener("click", toggleEmergency);
  $("evToggle")?.addEventListener("change", toggleEV);

  $("resetBtn")?.addEventListener("click", resetSystem);
  $("slotFilter")?.addEventListener("change", () => currentState && renderSlots(currentState));
  $("vehicleSearch")?.addEventListener("input", () => currentState && renderVehicles(currentState));
  $("transactionSearch")?.addEventListener("input", () => currentState && renderTransactions(currentState));

  // The original HTML has no visible logout button, so add one to the top bar.
  const topActions = document.querySelector(".top-actions");
  if (topActions && !document.querySelector("#logoutBtn")) {
    const btn = document.createElement("button");
    btn.id = "logoutBtn";
    btn.className = "outline-btn";
    btn.textContent = "Sign out";
    btn.addEventListener("click", logout);
    topActions.appendChild(btn);
  }
}

async function initialize() {
  bindEvents();

  if (!adminToken) {
    showLoginScreen();
    return;
  }

  try {
    const me = await apiRequest("/admin/me");
    if (!me.loggedIn) {
      showLoginScreen();
      return;
    }

    hideLoginScreen();
    await loadState();
    setInterval(() => {
      if (adminToken) loadState();
    }, 3000);
  } catch {
    showLoginScreen();
  }
}

document.addEventListener("DOMContentLoaded", initialize);
