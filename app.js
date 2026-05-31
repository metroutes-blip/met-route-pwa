// ── Version ───────────────────────────────────────────────────────────────────
const VERSION = '1.7.1';

// ── Config ────────────────────────────────────────────────────────────────────
// Set this to the ID of the public GitHub Gist created by the Route Management
// Tools "Send to Field" feature.  The PWA only reads (no token needed).
// Example: 'aa005d9b6708553fc37317c35900aefb'
const GIST_ID = '9e9ce2eefb05972d8a02972093b43c9d';
const GIST_URL = `https://api.github.com/gists/${GIST_ID}`;

// Email address corrections are sent to this dispatcher address
const DISPATCHER_EMAIL = 'michaelborneman@gmail.com';

// ── State ─────────────────────────────────────────────────────────────────────
let gistToken = null;    // worker-entered GitHub token (gist scope), stored in IDB on this device only
let db = null;
let map = null;
let routes = [];        // Array<{routeNum, office, stops[]}>
let activeRoute = null;
let markers = [];        // L.Marker[] for current route
let locationMarker = null;
let lastKnownPos = null;   // {lat, lon} of most recent GPS fix
let watchId = null;
let selectedStop = null;
let selectedStopGroup = null;  // Array<stop> when a multi-meter marker is tapped
let completedStops = {};    // {routeNum: Set<readOrder>}
let mapExpanded = false;
let pendingCorrections = [];   // Array of correction records, persisted to IDB

// ── IndexedDB ─────────────────────────────────────────────────────────────────
const DB_NAME = 'met-route-pwa';
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('routes')) d.createObjectStore('routes', { keyPath: 'routeNum' });
      if (!d.objectStoreNames.contains('progress')) d.createObjectStore('progress', { keyPath: 'routeNum' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (!d.objectStoreNames.contains('corrections')) d.createObjectStore('corrections', { autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror = e => reject(e.target.error);
  });
}

function idbPut(store, value, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = key !== undefined
      ? tx.objectStore(store).put(value, key)
      : tx.objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result ?? []);
    req.onerror = e => reject(e.target.error);
  });
}

async function idbClear(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

// ── Corrections Persistence ───────────────────────────────────────────────────
async function loadCorrections() {
  pendingCorrections = await idbGetAll('corrections');
  updateCorrectionsBadge();
}

async function saveCorrection(record) {
  await idbPut('corrections', record);
  pendingCorrections = await idbGetAll('corrections');
  updateCorrectionsBadge();
}

async function clearCorrections() {
  await idbClear('corrections');
  pendingCorrections = [];
  updateCorrectionsBadge();
}

function updateCorrectionsBadge() {
  const bar = document.getElementById('corrections-bar');
  const lbl = document.getElementById('corrections-count');
  const n = pendingCorrections.length;
  if (n === 0) {
    bar.classList.add('hidden');
  } else {
    lbl.textContent = `${n} location correction${n > 1 ? 's' : ''} pending`;
    bar.classList.remove('hidden');
  }
}

// ── Worker Name Selection ─────────────────────────────────────────────────────
let selectedWorkerName = null;

async function loadWorkerName() {
  selectedWorkerName = await idbGet('meta', 'workerName');
}

async function saveWorkerName(name) {
  selectedWorkerName = name;
  await idbPut('meta', name, 'workerName');
}

async function clearWorkerName() {
  selectedWorkerName = null;
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete('workerName');
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
}

function showNameScreen() {
  const names = [...new Set(
    routes.filter(r => r.workerName).map(r => r.workerName)
  )].sort();

  const listEl = document.getElementById('name-list');
  listEl.innerHTML = '';

  if (!names.length) {
    listEl.innerHTML = '<p class="name-empty">No routes available.<br>Ask your dispatcher to send routes, then tap Sync.</p>';
  } else {
    for (const name of names) {
      const btn = document.createElement('button');
      btn.className = 'name-btn';
      btn.textContent = name;
      btn.addEventListener('click', () => selectWorker(name));
      listEl.appendChild(btn);
    }
  }

  document.getElementById('screen-name').classList.remove('hidden');
  document.getElementById('screen-routes').classList.add('hidden');
  document.getElementById('btn-back').classList.add('hidden');
  document.getElementById('btn-logout').classList.add('hidden');
  document.getElementById('header-title').textContent = 'MET Routes';
}

async function selectWorker(name) {
  await saveWorkerName(name);
  unlockedRoutes.clear();
  document.getElementById('screen-name').classList.add('hidden');
  document.getElementById('screen-routes').classList.remove('hidden');
  document.getElementById('btn-logout').classList.remove('hidden');
  document.getElementById('header-title').textContent = name;
  renderRouteList();
}

// ── PIN overlay (per-route unlock) ────────────────────────────────────────────
let pendingRoute   = null;   // route waiting to be unlocked
let unlockedRoutes = new Set(); // routeNums unlocked this session
let pinEntry       = '';

function showPinOverlay(route) {
  pendingRoute = route;
  pinEntry     = '';
  updatePinDots();
  document.getElementById('pin-error').classList.add('hidden');
  document.getElementById('pin-route-label').textContent =
    `${route.workerName ? route.workerName + ' · ' : ''}${route.office}`;
  document.getElementById('pin-overlay').classList.remove('hidden');
}

function hidePinOverlay() {
  document.getElementById('pin-overlay').classList.add('hidden');
  pendingRoute = null;
  pinEntry     = '';
  updatePinDots();
}

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    document.getElementById(`pin-dot-${i}`).classList.toggle('filled', i < pinEntry.length);
  }
}

function onPinKey(val) {
  if (pinEntry.length >= 4) return;
  pinEntry += val;
  updatePinDots();
  if (pinEntry.length === 4) setTimeout(submitPin, 120);
}

function onPinDelete() {
  pinEntry = pinEntry.slice(0, -1);
  updatePinDots();
  document.getElementById('pin-error').classList.add('hidden');
}

function submitPin() {
  if (!pendingRoute) return;
  if (String(pendingRoute.pin) !== pinEntry) {
    document.getElementById('pin-error').classList.remove('hidden');
    const dotsEl = document.getElementById('pin-dots');
    dotsEl.classList.add('shake');
    setTimeout(() => dotsEl.classList.remove('shake'), 500);
    pinEntry = '';
    updatePinDots();
    return;
  }
  unlockedRoutes.add(pendingRoute.routeNum);
  const route = pendingRoute;
  hidePinOverlay();
  openRoute(route);
}

function initPinKeypad() {
  document.querySelectorAll('.pin-key[data-val]').forEach(btn => {
    btn.addEventListener('click', () => onPinKey(btn.dataset.val));
  });
  document.getElementById('pin-del').addEventListener('click', onPinDelete);
  document.getElementById('pin-cancel').addEventListener('click', hidePinOverlay);
}

// ── Status Bar ────────────────────────────────────────────────────────────────
let statusTimer = null;

function showStatus(msg, type = 'info', autoDismiss = 3500) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className = type;
  bar.classList.remove('hidden');
  clearTimeout(statusTimer);
  if (autoDismiss > 0) {
    statusTimer = setTimeout(() => bar.classList.add('hidden'), autoDismiss);
  }
}

// ── Sync from Gist ────────────────────────────────────────────────────────────
async function syncRoutes() {
  if (GIST_ID === 'YOUR_GIST_ID_HERE') {
    showStatus('Gist ID not configured — contact your dispatcher.', 'error', 6000);
    return;
  }

  showStatus('Syncing routes…', 'info', 0);

  try {
    const res = await fetch(GIST_URL, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`GitHub API: ${res.status}`);

    const gist = await res.json();
    const file = gist.files['routes.json'];
    if (!file) throw new Error('Gist has no routes.json file.');

    const payload = JSON.parse(file.content);
    // Accept both bare array and {routes:[...]} envelope
    const incoming = Array.isArray(payload) ? payload : (payload.routes ?? []);

    // Always replace stored routes — even if empty (dispatcher may have cleared them)
    await idbClear('routes');
    for (const route of incoming) await idbPut('routes', route);
    await idbPut('meta', new Date().toISOString(), 'lastSync');
    routes = incoming;
    showStatus(routes.length
      ? `Synced — ${routes.length} route(s) loaded.`
      : 'No routes available — contact your dispatcher.', routes.length ? 'success' : 'warning');

    // If saved worker no longer has routes, reset
    if (selectedWorkerName && !routes.some(r => r.workerName === selectedWorkerName)) {
      await clearWorkerName();
    }

    if (!selectedWorkerName && routes.length) {
      showNameScreen();
    } else {
      document.getElementById('screen-name').classList.add('hidden');
      document.getElementById('screen-routes').classList.remove('hidden');
      document.getElementById('header-title').textContent = selectedWorkerName || 'MET Routes';
      if (selectedWorkerName) document.getElementById('btn-logout').classList.remove('hidden');
      renderRouteList();
    }
  } catch (err) {
    const offline = !navigator.onLine || err.message.includes('Failed to fetch');
    if (offline) {
      showStatus('Offline — showing cached data.', 'warning');
    } else {
      showStatus(`Sync error: ${err.message}`, 'error', 6000);
    }
  }
}

async function loadCachedRoutes() {
  routes = await idbGetAll('routes');

  if (!selectedWorkerName && routes.length) {
    showNameScreen();
    return;
  }

  document.getElementById('screen-name').classList.add('hidden');
  document.getElementById('screen-routes').classList.remove('hidden');
  document.getElementById('header-title').textContent = selectedWorkerName || 'MET Routes';
  if (selectedWorkerName) document.getElementById('btn-logout').classList.remove('hidden');
  renderRouteList();

  if (routes.length) {
    const ts = await idbGet('meta', 'lastSync');
    if (ts) {
      const d = new Date(ts);
      showStatus(`Cached · synced ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`, 'info', 4000);
    }
  }
}

// ── Progress Persistence ──────────────────────────────────────────────────────
async function loadProgress() {
  const rows = await idbGetAll('progress');
  completedStops = {};
  for (const row of rows) completedStops[row.routeNum] = new Set(row.completed);
}

async function saveProgress(routeNum) {
  const arr = [...(completedStops[routeNum] ?? new Set())];
  await idbPut('progress', { routeNum, completed: arr });
}

// ── Route List Screen ─────────────────────────────────────────────────────────
function renderRouteList() {
  const list = document.getElementById('route-list');
  const empty = document.getElementById('no-routes');

  list.innerHTML = '';

  const visible = selectedWorkerName
    ? routes.filter(r => r.workerName === selectedWorkerName)
    : routes;

  if (!visible.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const route of visible) {
    const done = (completedStops[route.routeNum] ?? new Set()).size;
    const total = route.stops.length;
    const pct = total ? (done / total) * 100 : 0;

    const card = document.createElement('div');
    card.className = 'route-card';
    card.innerHTML = `
      <div class="route-card-num">Route ${route.routeNum}</div>
      <div class="route-card-office">${esc(route.office)}</div>
      <div class="route-card-stats">
        <span>&#128205; ${total} stops</span>
        <span>&#10003; ${done} done</span>
      </div>
      <div class="route-card-progress">
        <div class="route-card-progress-fill" style="width:${pct}%"></div>
      </div>`;
    card.addEventListener('click', () => openRoute(route));
    list.appendChild(card);
  }
}

// ── Open / Close Route ────────────────────────────────────────────────────────
function openRoute(route) {
  if (route.pin && !unlockedRoutes.has(route.routeNum)) {
    showPinOverlay(route);
    return;
  }
  activeRoute = route;

  document.getElementById('screen-routes').classList.add('hidden');
  document.getElementById('screen-route').classList.remove('hidden');
  document.getElementById('btn-back').classList.remove('hidden');
  document.getElementById('header-title').textContent = route.office;

  initMap();
  renderRoute(route);
  if (watchId == null) startLocationWatch(); // start once, never stop mid-session
  // Force Leaflet to re-measure after the screen is visible; double-fire for slow devices
  setTimeout(() => map?.invalidateSize(), 50);
  setTimeout(() => map?.invalidateSize(), 300);
}

function closeRoute() {
  hideStopDetail();
  clearMarkers();
  selectedStop = null;
  activeRoute = null;

  document.getElementById('screen-route').classList.add('hidden');
  document.getElementById('screen-routes').classList.remove('hidden');
  document.getElementById('btn-back').classList.add('hidden');
  document.getElementById('header-title').textContent = selectedWorkerName || 'MET Routes';

  // Reset list panel to expanded for next time
  setPanelCollapsed(false);
  renderRouteList();
}

// ── Map Init ─────────────────────────────────────────────────────────────────
function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
}

// ── Render Route on Map + List ────────────────────────────────────────────────
function renderRoute(route) {
  clearMarkers();

  const done = completedStops[route.routeNum] ?? new Set();
  const valid = route.stops.filter(s => s.lat != null && s.lon != null);
  const sorted = [...route.stops].sort((a, b) => a.readOrder - b.readOrder);

  // Group stops by coordinates — all meters at the same building share the same
  // geocoded lat/lon regardless of unit/apt differences in the address string.
  const groups = new Map(); // "lat|lon" -> [stop, ...]
  for (const stop of valid) {
    const key = `${stop.lat.toFixed(5)}|${stop.lon.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(stop);
  }

  for (const group of groups.values()) {
    const count = group.length;
    const allDone = group.every(s => done.has(s.readOrder));
    const isSel = group.some(s => selectedStop?.readOrder === s.readOrder);
    const icon = makeMarkerIcon(count, allDone, isSel);
    const m = L.marker([group[0].lat, group[0].lon], { icon });
    m.on('click', () => count === 1 ? selectStop(group[0]) : selectGroup(group));
    m.addTo(map);
    markers.push(m);
  }

  if (valid.length) {
    const bounds = L.latLngBounds(valid.map(s => [s.lat, s.lon]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  renderStopList(sorted, done);
}

function clearMarkers() {
  markers.forEach(m => map?.removeLayer(m));
  markers = [];
}

function makeMarkerIcon(count, done, selected) {
  const isMulti = count > 1;

  if (!isMulti) {
    const cls = 'met-dot' + (done ? ' met-done' : '') + (selected ? ' met-selected' : '');
    return L.divIcon({ className: cls, html: '', iconSize: [10, 10], iconAnchor: [5, 5] });
  }

  // Multi-meter: render as SVG image via data URI — text is guaranteed to paint
  const sz    = 24;
  const cx    = sz / 2;
  const r     = cx - 1;
  const bg    = done     ? '#27ae60' : '#c0392b';
  const stroke = selected ? '#1a3a5c' : 'white';
  const label  = done ? '✓' : String(count);

  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${sz}' height='${sz}'>` +
    `<circle cx='${cx}' cy='${cx}' r='${r}' fill='${bg}' stroke='${stroke}' stroke-width='2'/>` +
    `<text x='${cx}' y='${cx}' text-anchor='middle' dy='0.35em'` +
    ` font-size='10' font-weight='bold' font-family='Arial,sans-serif' fill='white'>${label}</text>` +
    `</svg>`;

  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return L.icon({ iconUrl: url, iconSize: [sz, sz], iconAnchor: [cx, cx] });
}

// ── Stop List ────────────────────────────────────────────────────────────────
function renderStopList(sorted, done) {
  const list = document.getElementById('stop-list');
  list.innerHTML = '';

  const doneCount = sorted.filter(s => done.has(s.readOrder)).length;
  document.getElementById('stop-panel-title').textContent =
    `Stops · ${doneCount}/${sorted.length} done`;

  for (const stop of sorted) {
    const isDone = done.has(stop.readOrder);
    const item = document.createElement('div');
    item.className = `stop-item${isDone ? ' done' : ''}`;
    item.dataset.order = stop.readOrder;

    item.innerHTML = `
      <div class="stop-badge">${isDone ? '&#10003;' : stop.readOrder}</div>
      <div class="stop-text">
        <div class="stop-addr">${esc(stop.address)}, ${esc(stop.city)}</div>
      </div>
      <button class="stop-check" data-order="${stop.readOrder}" aria-label="Toggle done">
        ${isDone ? '&#10003;' : '&#9675;'}
      </button>`;

    item.querySelector('.stop-check').addEventListener('click', e => {
      e.stopPropagation();
      toggleDone(stop);
    });
    item.addEventListener('click', () => selectStop(stop));
    list.appendChild(item);
  }
}

// ── Select Stop ───────────────────────────────────────────────────────────────
function selectStop(stop) {
  selectedStop = stop;

  // Pan map to stop
  if (map && stop.lat != null) map.panTo([stop.lat, stop.lon]);

  // Highlight list item
  document.querySelectorAll('.stop-item').forEach(el => el.classList.remove('selected'));
  const el = document.querySelector(`.stop-item[data-order="${stop.readOrder}"]`);
  if (el) { el.classList.add('selected'); el.scrollIntoView({ block: 'nearest' }); }

  // Re-draw markers so selected one pops
  renderRoute(activeRoute);

  showStopDetail(stop);
}

// ── Stop Detail Sheet ─────────────────────────────────────────────────────────
function showStopDetail(stop) {
  selectedStopGroup = null;
  document.getElementById('detail-order').textContent = `Stop ${stop.readOrder}`;
  document.getElementById('detail-name').textContent = stop.locCode ? `Location code: ${stop.locCode}` : 'No location code';
  document.getElementById('detail-address').textContent = `${stop.address}, ${stop.city}`;
  document.getElementById('detail-meta').textContent = '';
  document.getElementById('detail-meter-list').innerHTML = '';

  const pinBtn = document.getElementById('btn-pin-location');
  pinBtn.textContent = 'Pin Location';
  pinBtn.disabled = false;

  document.getElementById('stop-detail').classList.remove('hidden');
}

function showGroupDetail(stops) {
  selectedStop = stops[0];
  selectedStopGroup = stops;

  document.getElementById('detail-order').textContent = `${stops.length} Meters`;
  document.getElementById('detail-name').textContent = '';
  document.getElementById('detail-address').textContent = `${stops[0].address}, ${stops[0].city}`;
  document.getElementById('detail-meta').textContent = '';

  const meterList = document.getElementById('detail-meter-list');
  meterList.innerHTML = stops
    .map(s => `<div class="meter-row">Stop ${s.readOrder} &nbsp;·&nbsp; Loc: ${s.locCode ?? '—'}</div>`)
    .join('') +
    `<div class="meter-hint">To pin a single meter, tap it in the list below.</div>`;

  const pinBtn = document.getElementById('btn-pin-location');
  pinBtn.textContent = 'Pin Location';
  pinBtn.disabled = false;

  document.getElementById('stop-detail').classList.remove('hidden');
}

function hideStopDetail() {
  document.getElementById('stop-detail').classList.add('hidden');
  document.querySelectorAll('.stop-item').forEach(el => el.classList.remove('selected'));
  selectedStop = null;
  selectedStopGroup = null;
}

// ── Select Group (multi-meter marker) ────────────────────────────────────────
function selectGroup(stops) {
  selectedStop = stops[0];

  if (map) map.panTo([stops[0].lat, stops[0].lon]);

  document.querySelectorAll('.stop-item').forEach(el => el.classList.remove('selected'));
  stops.forEach(s => {
    const el = document.querySelector(`.stop-item[data-order="${s.readOrder}"]`);
    if (el) { el.classList.add('selected'); }
  });
  stops[0] && document.querySelector(`.stop-item[data-order="${stops[0].readOrder}"]`)
    ?.scrollIntoView({ block: 'nearest' });

  renderRoute(activeRoute);
  showGroupDetail(stops);
}

// ── Toggle Done (list only) ───────────────────────────────────────────────────
async function toggleDone(stop) {
  const rn = activeRoute.routeNum;
  if (!completedStops[rn]) completedStops[rn] = new Set();
  const set = completedStops[rn];
  if (set.has(stop.readOrder)) set.delete(stop.readOrder); else set.add(stop.readOrder);
  await saveProgress(rn);
  renderRoute(activeRoute);
}

// ── Gist Sync Token ───────────────────────────────────────────────────────────
async function loadGistToken() {
  gistToken = await idbGet('meta', 'gistToken');
}

async function saveGistToken(t) {
  gistToken = t || null;
  if (t) await idbPut('meta', t, 'gistToken');
}

async function clearGistToken() {
  gistToken = null;
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete('gistToken');
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
}

// Push a pinned location straight into the Gist's routes.json, and log it to
// corrections.json (an inbox the dispatcher tool imports from).
// GETs the latest copy first and edits only the affected stops (by readOrder),
// so simultaneous pins from other workers/routes aren't clobbered.
async function pushPinToGist(routeNum, updatedStops, correctionRecord) {
  if (!gistToken) throw new Error('no-token');

  const getRes = await fetch(GIST_URL, {
    headers: { 'Authorization': `Bearer ${gistToken}`, 'Accept': 'application/vnd.github.v3+json' },
    cache: 'no-store',
  });
  if (!getRes.ok) throw new Error(getRes.status === 401 ? 'bad-token' : `GET ${getRes.status}`);

  const gist = await getRes.json();
  const file = gist.files['routes.json'];
  if (!file) throw new Error('no-file');

  const parsed  = JSON.parse(file.content);
  const isArray = Array.isArray(parsed);
  const list    = isArray ? parsed : (parsed.routes ?? []);
  const route   = list.find(r => r.routeNum === routeNum);
  if (!route) throw new Error('route-missing');

  for (const u of updatedStops) {
    const rs = route.stops.find(s => s.readOrder === u.readOrder);
    if (rs) { rs.lat = u.lat; rs.lon = u.lon; }
  }

  const content = isArray
    ? JSON.stringify(list)
    : JSON.stringify({ ...parsed, routes: list, lastUpdated: new Date().toISOString() });

  // Append this pin to the corrections inbox (create the file if absent).
  let corrections = [];
  const corrFile = gist.files['corrections.json'];
  if (corrFile?.content) {
    try { const p = JSON.parse(corrFile.content); if (Array.isArray(p)) corrections = p; }
    catch { corrections = []; }
  }
  if (correctionRecord) corrections.push(correctionRecord);

  const patchRes = await fetch(GIST_URL, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${gistToken}`,
               'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: {
      'routes.json':      { content },
      'corrections.json': { content: JSON.stringify(corrections) },
    } }),
  });
  if (patchRes.status === 401 || patchRes.status === 403) throw new Error('bad-token');
  if (!patchRes.ok) throw new Error(`PATCH ${patchRes.status}`);
}

// Verify a token can both READ and WRITE the Gist. The write check is a no-op
// PATCH (re-saving the file's current content) — this confirms the token carries
// the "gist" scope, which a plain GET can't tell us.
async function testGistSync(token) {
  const getRes = await fetch(GIST_URL, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' },
    cache: 'no-store',
  });
  if (!getRes.ok) throw new Error(getRes.status === 401 ? 'bad-token' : `GET ${getRes.status}`);

  const gist = await getRes.json();
  const file = gist.files['routes.json'];
  if (!file) throw new Error('no-file');

  const patchRes = await fetch(GIST_URL, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`,
               'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { 'routes.json': { content: file.content } } }),
  });
  if ([401, 403, 404].includes(patchRes.status)) throw new Error('no-write');
  if (!patchRes.ok) throw new Error(`PATCH ${patchRes.status}`);
}

// ── Sync Settings Sheet ───────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-token').value = gistToken || '';
  document.getElementById('settings-status').textContent = gistToken ? 'Auto-sync is on.' : '';
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

function initSettings() {
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);

  document.getElementById('settings-save').addEventListener('click', async () => {
    const t = document.getElementById('settings-token').value.trim();
    const statusEl = document.getElementById('settings-status');
    if (!t) { statusEl.textContent = 'Enter a token, or tap Remove.'; return; }

    statusEl.textContent = 'Verifying token…';
    try {
      const res = await fetch(GIST_URL, {
        headers: { 'Authorization': `Bearer ${t}`, 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(res.status === 401 ? 'invalid' : String(res.status));
      await saveGistToken(t);
      statusEl.textContent = '✓ Saved — pinned locations now sync automatically.';
      setTimeout(closeSettings, 1300);
    } catch (err) {
      statusEl.textContent = err.message === 'invalid'
        ? 'Token rejected by GitHub — check and retry.'
        : `Could not verify (${err.message}). Check your connection.`;
    }
  });

  document.getElementById('settings-test').addEventListener('click', async () => {
    const statusEl = document.getElementById('settings-status');
    const t = document.getElementById('settings-token').value.trim() || gistToken;
    if (!t) { statusEl.textContent = 'Enter a token first.'; return; }

    statusEl.textContent = 'Testing read + write…';
    try {
      await testGistSync(t);
      statusEl.textContent = '✓ Success — this token can read and write routes.';
    } catch (err) {
      const reasons = {
        'bad-token': 'Token rejected by GitHub — wrong or expired.',
        'no-write':  'Token is valid but can\'t write (missing “gist” scope).',
        'no-file':   'Gist has no routes.json yet — ask your dispatcher to send routes.',
      };
      statusEl.textContent = reasons[err.message] || `Test failed (${err.message}).`;
    }
  });

  document.getElementById('settings-clear').addEventListener('click', async () => {
    await clearGistToken();
    document.getElementById('settings-token').value = '';
    document.getElementById('settings-status').textContent = 'Removed — pins will save offline for batch send.';
  });
}

// ── Pin Location ──────────────────────────────────────────────────────────────
async function pinLocation(stop) {
  if (!navigator.geolocation) {
    showStatus('GPS not available on this device.', 'error');
    return;
  }

  const btn = document.getElementById('btn-pin-location');
  btn.textContent = 'Getting GPS…';
  btn.disabled = true;

  let pos;
  try {
    pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0,
      })
    );
  } catch (err) {
    btn.textContent = 'GPS failed — Retry';
    btn.disabled = false;
    showStatus('Could not get GPS fix. Try again outdoors.', 'error', 5000);
    return;
  }

  const newLat = pos.coords.latitude;
  const newLon = pos.coords.longitude;
  const acc = Math.round(pos.coords.accuracy);
  const stopsToPin = selectedStopGroup ?? [stop];
  const oldLat = stopsToPin[0].lat;
  const oldLon = stopsToPin[0].lon;

  // Update stop coordinates locally
  stopsToPin.forEach(s => { s.lat = newLat; s.lon = newLon; });

  // Persist updated route to IDB
  const route = routes.find(r => r.routeNum === activeRoute?.routeNum);
  if (route) {
    stopsToPin.forEach(s => {
      const rs = route.stops.find(rs => rs.readOrder === s.readOrder);
      if (rs) { rs.lat = newLat; rs.lon = newLon; }
    });
    await idbPut('routes', route);
  }

  renderRoute(activeRoute);

  const correctionRecord = {
    id: `${Date.now()}-${activeRoute?.routeNum ?? ''}-${stopsToPin[0].readOrder}`,
    routeNum: activeRoute?.routeNum ?? '',
    office: activeRoute?.office ?? '',
    workerName: selectedWorkerName || '',
    address: stopsToPin[0].address,
    city: stopsToPin[0].city,
    stops: stopsToPin.map(s => ({ readOrder: s.readOrder, locCode: s.locCode ?? null })),
    oldLat: oldLat ?? null,
    oldLon: oldLon ?? null,
    newLat,
    newLon,
    accuracy: acc,
    timestamp: new Date().toISOString(),
  };

  // If a sync token is configured, push the correction straight to the Gist.
  if (gistToken) {
    btn.textContent = 'Syncing…';
    try {
      await pushPinToGist(
        activeRoute?.routeNum ?? '',
        stopsToPin.map(s => ({ readOrder: s.readOrder, lat: newLat, lon: newLon })),
        correctionRecord
      );
      btn.textContent = `Synced ±${acc}m`;
      btn.disabled = false;
      showStatus(`Location synced to dispatcher (±${acc} m).`, 'success', 3000);
      return;
    } catch (err) {
      // Push failed — keep the pin as a correction so it's never lost
      await saveCorrection(correctionRecord);
      btn.textContent = `Saved ±${acc}m`;
      btn.disabled = false;
      const msg = err.message === 'bad-token'
        ? 'Sync token rejected — check Settings (⚙).'
        : 'Offline — saved to sync later.';
      showStatus(`${msg} ${pendingCorrections.length} pending.`, 'warning', 4500);
      return;
    }
  }

  // No token configured — keep the existing batch-email correction flow
  await saveCorrection(correctionRecord);
  btn.textContent = `Saved ±${acc}m`;
  btn.disabled = false;
  showStatus(`Correction saved. ${pendingCorrections.length} pending.`, 'success', 3000);
}

// ── Send All Corrections ──────────────────────────────────────────────────────
function sendAllCorrections() {
  if (!pendingCorrections.length) return;

  const date = new Date().toLocaleDateString();
  const total = pendingCorrections.length;

  const sections = pendingCorrections.map((c, i) => {
    const oldCoords = (c.oldLat != null && c.oldLon != null)
      ? `${c.oldLat.toFixed(6)}, ${c.oldLon.toFixed(6)}`
      : 'None on file';
    const metersLine = c.stops
      .map(s => `Stop ${s.readOrder}${s.locCode ? ` (Code: ${s.locCode})` : ''}`)
      .join(', ');
    return (
      `CORRECTION ${i + 1} of ${total}\n` +
      `Route:    ${c.routeNum} (${c.office})\n` +
      `Address:  ${c.address}, ${c.city}\n` +
      `Meters:   ${metersLine}\n` +
      `Old:      ${oldCoords}\n` +
      `New:      ${c.newLat.toFixed(6)}, ${c.newLon.toFixed(6)}  (±${c.accuracy} m)\n` +
      `Time:     ${new Date(c.timestamp).toLocaleString()}\n` +
      `Maps:     https://maps.google.com/maps?q=${c.newLat},${c.newLon}`
    );
  });

  const subject = encodeURIComponent(`MET Route Corrections — ${date} (${total})`);
  const body = encodeURIComponent(
    `MET Route Location Corrections — ${date}\n` +
    `${'─'.repeat(40)}\n\n` +
    sections.join('\n\n' + '─'.repeat(40) + '\n\n')
  );

  window.location.href = `mailto:${DISPATCHER_EMAIL}?subject=${subject}&body=${body}`;

  // Clear after opening email client
  setTimeout(clearCorrections, 1000);
}

// ── List Panel Minimize / Expand ──────────────────────────────────────────────
function setPanelCollapsed(collapsed) {
  const screen = document.getElementById('screen-route');
  screen.classList.toggle('panel-collapsed', collapsed);
  mapExpanded = collapsed;
  setTimeout(() => map?.invalidateSize(), 260);
}

function togglePanel() {
  const screen = document.getElementById('screen-route');
  setPanelCollapsed(!screen.classList.contains('panel-collapsed'));
}

function initRouteControls() {
  document.getElementById('stop-panel-header').addEventListener('click', togglePanel);
  document.getElementById('btn-locate').addEventListener('click', locateUser);
}

// ── GPS Location ──────────────────────────────────────────────────────────────
function startLocationWatch() {
  if (!navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    pos => updateLocation(pos.coords.latitude, pos.coords.longitude),
    () => { },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

function stopLocationWatch() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (locationMarker) { map?.removeLayer(locationMarker); locationMarker = null; }
}

function updateLocation(lat, lon) {
  lastKnownPos = { lat, lon };
  if (!map) return;
  const icon = L.divIcon({
    className: '',
    html: '<div class="loc-dot"></div>',
    iconSize: [14, 14], iconAnchor: [7, 7],
  });
  if (!locationMarker) {
    locationMarker = L.marker([lat, lon], { icon, zIndexOffset: 2000 }).addTo(map);
  } else {
    locationMarker.setLatLng([lat, lon]);
  }
}

// Center the map on the worker's location; request a fresh fix if we have none yet.
function locateUser() {
  if (lastKnownPos) {
    updateLocation(lastKnownPos.lat, lastKnownPos.lon);
    map.setView([lastKnownPos.lat, lastKnownPos.lon], Math.max(map.getZoom(), 16));
    return;
  }
  if (!navigator.geolocation) {
    showStatus('GPS not available on this device.', 'error');
    return;
  }
  const btn = document.getElementById('btn-locate');
  btn.classList.add('locating');
  showStatus('Finding your location…', 'info', 0);
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.classList.remove('locating');
      document.getElementById('status-bar').classList.add('hidden');
      updateLocation(pos.coords.latitude, pos.coords.longitude);
      map.setView([pos.coords.latitude, pos.coords.longitude], 16);
      if (watchId == null) startLocationWatch();
    },
    () => {
      btn.classList.remove('locating');
      showStatus('Could not get a GPS fix. Try again outdoors.', 'error', 5000);
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigateToStop(stop) {
  const dest = (stop.lat != null && stop.lon != null)
    ? `${stop.lat},${stop.lon}`
    : encodeURIComponent(`${stop.address}, ${stop.city}, Ontario, Canada`);

  // iOS: use Apple Maps if available, else Google
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const url = isIOS
    ? `http://maps.apple.com/?daddr=${dest}`
    : `https://maps.google.com/maps?daddr=${dest}`;
  window.open(url, '_blank');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function titleCase(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── App Init ──────────────────────────────────────────────────────────────────
async function init() {
  document.querySelectorAll('.version-num').forEach(el => { el.textContent = `v${VERSION}`; });

  db = await openDb();
  await loadProgress();
  await loadCorrections();
  await loadWorkerName();
  await loadGistToken();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }

  // Header buttons
  document.getElementById('btn-sync').addEventListener('click', syncRoutes);
  document.getElementById('btn-back').addEventListener('click', closeRoute);

  // Sync empty button
  document.getElementById('btn-sync-empty').addEventListener('click', syncRoutes);

  // Corrections bar
  document.getElementById('btn-send-corrections').addEventListener('click', sendAllCorrections);

  // Stop detail buttons
  document.getElementById('btn-close-detail').addEventListener('click', hideStopDetail);
  document.getElementById('btn-navigate').addEventListener('click', () => {
    if (selectedStop) navigateToStop(selectedStop);
  });
  document.getElementById('btn-pin-location').addEventListener('click', () => {
    if (selectedStop) pinLocation(selectedStop);
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await clearWorkerName();
    unlockedRoutes.clear();
    document.getElementById('btn-logout').classList.add('hidden');
    showNameScreen();
  });

  initRouteControls();
  initPinKeypad();
  initSettings();

  // Auto-sync on load if online and Gist is configured
  if (navigator.onLine && GIST_ID !== 'YOUR_GIST_ID_HERE') {
    await syncRoutes();
  } else {
    await loadCachedRoutes();
  }
}

document.addEventListener('DOMContentLoaded', init);
