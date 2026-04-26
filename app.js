// ── Version ───────────────────────────────────────────────────────────────────
const VERSION = '1.0.0';

// ── Config ────────────────────────────────────────────────────────────────────
// Set this to the ID of the public GitHub Gist created by the Route Management
// Tools "Send to Field" feature.  The PWA only reads (no token needed).
// Example: 'aa005d9b6708553fc37317c35900aefb'
const GIST_ID = '9e9ce2eefb05972d8a02972093b43c9d';
const GIST_URL = `https://api.github.com/gists/${GIST_ID}`;

// ── State ─────────────────────────────────────────────────────────────────────
let db            = null;
let map           = null;
let routes        = [];        // Array<{routeNum, office, stops[]}>
let activeRoute   = null;
let markers       = [];        // L.Marker[] for current route
let locationMarker = null;
let watchId       = null;
let selectedStop  = null;
let completedStops = {};       // {routeNum: Set<readOrder>}
let mapExpanded   = false;

// ── IndexedDB ─────────────────────────────────────────────────────────────────
const DB_NAME    = 'met-route-pwa';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('routes'))   d.createObjectStore('routes',   { keyPath: 'routeNum' });
      if (!d.objectStoreNames.contains('progress')) d.createObjectStore('progress', { keyPath: 'routeNum' });
      if (!d.objectStoreNames.contains('meta'))     d.createObjectStore('meta');
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

function idbPut(store, value, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = key !== undefined
      ? tx.objectStore(store).put(value, key)
      : tx.objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result ?? []);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbClear(store) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Status Bar ────────────────────────────────────────────────────────────────
let statusTimer = null;

function showStatus(msg, type = 'info', autoDismiss = 3500) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className   = type;
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
    const file  = gist.files['routes.json'];
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
  const list  = document.getElementById('route-list');
  const empty = document.getElementById('no-routes');

  list.innerHTML = '';

  if (!routes.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const route of routes) {
    const done  = (completedStops[route.routeNum] ?? new Set()).size;
    const total = route.stops.length;
    const pct   = total ? (done / total) * 100 : 0;

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
  selectedStop  = null;
  activeRoute   = null;

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
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
}

// ── Render Route on Map + List ────────────────────────────────────────────────
function renderRoute(route) {
  clearMarkers();

  const done   = completedStops[route.routeNum] ?? new Set();
  const valid  = route.stops.filter(s => s.lat != null && s.lon != null);
  const sorted = [...route.stops].sort((a, b) => a.readOrder - b.readOrder);

  for (const stop of valid) {
    const isDone = done.has(stop.readOrder);
    const isSel  = selectedStop?.readOrder === stop.readOrder;
    const icon   = makeMarkerIcon(stop.readOrder, isDone, isSel);
    const m = L.marker([stop.lat, stop.lon], { icon });
    m.on('click', () => selectStop(stop));
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

function makeMarkerIcon(order, done, selected) {
  const cls = ['stop-marker', done && 'done', selected && 'selected'].filter(Boolean).join(' ');
  const label = done ? '&#10003;' : order;
  return L.divIcon({
    className: '',
    html: `<div class="${cls}">${label}</div>`,
    iconSize:   [30, 30],
    iconAnchor: [15, 15],
  });
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
        <div class="stop-name">${esc(titleCase(stop.name))}</div>
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
  const done = completedStops[activeRoute?.routeNum]?.has(stop.readOrder) ?? false;
  document.getElementById('detail-order').textContent   = `Stop ${stop.readOrder}`;
  document.getElementById('detail-name').textContent    = titleCase(stop.name);
  document.getElementById('detail-address').textContent = `${stop.address}, ${stop.city}`;
  document.getElementById('detail-meta').textContent    = stop.locCode ? `Meter code: ${stop.locCode}` : '';

  const doneBtn = document.getElementById('btn-mark-done');
  doneBtn.textContent = done ? 'Undo Done' : 'Mark Done';
  doneBtn.className   = done ? 'btn-done undone' : 'btn-done';

  document.getElementById('stop-detail').classList.remove('hidden');
}

function hideStopDetail() {
  document.getElementById('stop-detail').classList.add('hidden');
  document.querySelectorAll('.stop-item').forEach(el => el.classList.remove('selected'));
  selectedStop = null;
}

// ── Toggle Done ───────────────────────────────────────────────────────────────
async function toggleDone(stop) {
  const rn = activeRoute.routeNum;
  if (!completedStops[rn]) completedStops[rn] = new Set();
  const set = completedStops[rn];
  if (set.has(stop.readOrder)) set.delete(stop.readOrder); else set.add(stop.readOrder);
  await saveProgress(rn);
  renderRoute(activeRoute);
  if (selectedStop?.readOrder === stop.readOrder) showStopDetail(stop);
}

// ── View Toggle (Map / List) ──────────────────────────────────────────────────
function setMapMode(expanded) {
  mapExpanded = expanded;
  const mapEl   = document.getElementById('map');
  const panel   = document.getElementById('stop-panel');
  const toggle  = document.getElementById('view-toggle');
  const btnMap  = document.getElementById('btn-map-view');
  const btnList = document.getElementById('btn-list-view');

  if (expanded) {
    // Full map, minimal panel
    mapEl.style.flex   = '1';
    panel.style.height = '0';
    toggle.style.bottom = '10px';
  } else {
    // Split
    mapEl.style.flex   = '1';
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
    const mapEl  = document.getElementById('map');
    const panel  = document.getElementById('stop-panel');
    const toggle = document.getElementById('view-toggle');
    mapEl.style.flex   = '1';
    panel.style.height = '0';
    toggle.style.bottom = '10px';
    document.getElementById('btn-map-view').classList.add('active');
    document.getElementById('btn-list-view').classList.remove('active');
    setTimeout(() => map?.invalidateSize(), 260);
  });

  document.getElementById('btn-list-view').addEventListener('click', () => {
    const mapEl  = document.getElementById('map');
    const panel  = document.getElementById('stop-panel');
    const toggle = document.getElementById('view-toggle');
    mapEl.style.flex   = '0';
    panel.style.height = '100%';
    toggle.style.bottom = 'auto';
    toggle.style.top    = '10px';
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
    () => {},
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
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── App Init ──────────────────────────────────────────────────────────────────
async function init() {
  document.getElementById('version-num').textContent = `v${VERSION}`;

  db = await openDb();
  await loadProgress();
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

  // Stop detail buttons
  document.getElementById('btn-close-detail').addEventListener('click', hideStopDetail);
  document.getElementById('btn-navigate').addEventListener('click', () => {
    if (selectedStop) navigateToStop(selectedStop);
  });
  document.getElementById('btn-mark-done').addEventListener('click', () => {
    if (selectedStop) toggleDone(selectedStop);
    hideStopDetail();
  });

  initViewToggle();

  // Auto-sync on load if online and Gist is configured
  if (navigator.onLine && GIST_ID !== 'YOUR_GIST_ID_HERE') {
    syncRoutes();
  }
}

document.addEventListener('DOMContentLoaded', init);
