// ── Version ───────────────────────────────────────────────────────────────────
const VERSION = '1.2.9';

// ── Config ────────────────────────────────────────────────────────────────────
// Set this to the ID of the public GitHub Gist created by the Route Management
// Tools "Send to Field" feature.  The PWA only reads (no token needed).
// Example: 'aa005d9b6708553fc37317c35900aefb'
const GIST_ID = '9e9ce2eefb05972d8a02972093b43c9d';
const GIST_URL = `https://api.github.com/gists/${GIST_ID}`;

// Email address corrections are sent to this dispatcher address
const DISPATCHER_EMAIL = 'michaelborneman@gmail.com';

// ── State ─────────────────────────────────────────────────────────────────────
let db = null;
let map = null;
let routes = [];        // Array<{routeNum, office, stops[]}>
let activeRoute = null;
let markers = [];        // L.Marker[] for current route
let locationMarker = null;
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
    if (!incoming.length) {
      showStatus('No routes in Gist yet.', 'warning');
      return;
    }

    // Replace stored routes with incoming (dispatcher controls what field sees)
    await idbClear('routes');
    for (const route of incoming) await idbPut('routes', route);
    await idbPut('meta', new Date().toISOString(), 'lastSync');

    routes = incoming;
    showStatus(`Synced — ${routes.length} route(s) loaded.`, 'success');
    renderRouteList();
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

  if (!routes.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const route of routes) {
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
  activeRoute = route;

  document.getElementById('screen-routes').classList.add('hidden');
  document.getElementById('screen-route').classList.remove('hidden');
  document.getElementById('btn-back').classList.remove('hidden');
  document.getElementById('header-title').textContent = route.office;

  initMap();
  renderRoute(route);
  startLocationWatch();
}

function closeRoute() {
  hideStopDetail();
  stopLocationWatch();
  clearMarkers();
  selectedStop = null;
  activeRoute = null;

  document.getElementById('screen-route').classList.add('hidden');
  document.getElementById('screen-routes').classList.remove('hidden');
  document.getElementById('btn-back').classList.add('hidden');
  document.getElementById('header-title').textContent = 'MET Routes';

  // Reset split
  setMapMode(false);
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
    return L.divIcon({ className: cls, html: '', iconSize: [12, 12], iconAnchor: [6, 6] });
  }

  // Multi-meter: render as SVG image via data URI — text is guaranteed to paint
  const sz    = 28;
  const cx    = sz / 2;
  const r     = cx - 1;
  const bg    = done     ? '#27ae60' : '#c0392b';
  const stroke = selected ? '#1a3a5c' : 'white';
  const label  = done ? '✓' : String(count);

  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${sz}' height='${sz}'>` +
    `<circle cx='${cx}' cy='${cx}' r='${r}' fill='${bg}' stroke='${stroke}' stroke-width='2'/>` +
    `<text x='${cx}' y='${cx}' text-anchor='middle' dy='0.35em'` +
    ` font-size='12' font-weight='bold' font-family='Arial,sans-serif' fill='white'>${label}</text>` +
    `</svg>`;

  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return L.icon({ iconUrl: url, iconSize: [sz, sz], iconAnchor: [cx, cx] });
}

// ── Stop List ────────────────────────────────────────────────────────────────
function renderStopList(sorted, done) {
  const list = document.getElementById('stop-list');
  list.innerHTML = '';

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
  document.getElementById('detail-name').textContent = stop.locCode ? `Meter: ${stop.locCode}` : 'No meter code';
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
    .map(s => `<div class="meter-row">Stop ${s.readOrder} &nbsp;·&nbsp; Meter: ${s.locCode ?? '—'}</div>`)
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

  // Save correction record for later batch email
  await saveCorrection({
    routeNum: activeRoute?.routeNum ?? '',
    office: activeRoute?.office ?? '',
    address: stopsToPin[0].address,
    city: stopsToPin[0].city,
    stops: stopsToPin.map(s => ({ readOrder: s.readOrder, locCode: s.locCode ?? null })),
    oldLat: oldLat ?? null,
    oldLon: oldLon ?? null,
    newLat,
    newLon,
    accuracy: acc,
    timestamp: new Date().toISOString(),
  });

  renderRoute(activeRoute);

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

// ── View Toggle (Map / List) ──────────────────────────────────────────────────
function setMapMode(expanded) {
  mapExpanded = expanded;
  const mapEl = document.getElementById('map');
  const panel = document.getElementById('stop-panel');
  const toggle = document.getElementById('view-toggle');
  const btnMap = document.getElementById('btn-map-view');
  const btnList = document.getElementById('btn-list-view');

  if (expanded) {
    // Full map, minimal panel
    mapEl.style.flex = '1';
    panel.style.height = '0';
    toggle.style.bottom = '10px';
  } else {
    // Split
    mapEl.style.flex = '1';
    panel.style.height = 'var(--panel-h)';
    toggle.style.bottom = 'calc(var(--panel-h) + 10px)';
  }

  btnMap.classList.toggle('active', expanded || true); // map always "active" in split
  btnList.classList.toggle('active', false);

  if (expanded) {
    btnMap.classList.add('active');
    btnList.classList.remove('active');
  }

  setTimeout(() => map?.invalidateSize(), 260);
}

function initViewToggle() {
  document.getElementById('btn-map-view').addEventListener('click', () => {
    const mapEl = document.getElementById('map');
    const panel = document.getElementById('stop-panel');
    const toggle = document.getElementById('view-toggle');
    mapEl.style.flex = '1';
    panel.style.height = '0';
    toggle.style.bottom = '10px';
    document.getElementById('btn-map-view').classList.add('active');
    document.getElementById('btn-list-view').classList.remove('active');
    setTimeout(() => map?.invalidateSize(), 260);
  });

  document.getElementById('btn-list-view').addEventListener('click', () => {
    const mapEl = document.getElementById('map');
    const panel = document.getElementById('stop-panel');
    const toggle = document.getElementById('view-toggle');
    mapEl.style.flex = '0';
    panel.style.height = '100%';
    toggle.style.bottom = 'auto';
    toggle.style.top = '10px';
    document.getElementById('btn-list-view').classList.add('active');
    document.getElementById('btn-map-view').classList.remove('active');
    setTimeout(() => map?.invalidateSize(), 260);
  });
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
  document.getElementById('version-num').textContent = `v${VERSION}`;

  db = await openDb();
  await loadProgress();
  await loadCorrections();
  await loadCachedRoutes();

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

  initViewToggle();

  // Auto-sync on load if online and Gist is configured
  if (navigator.onLine && GIST_ID !== 'YOUR_GIST_ID_HERE') {
    syncRoutes();
  }
}

document.addEventListener('DOMContentLoaded', init);
