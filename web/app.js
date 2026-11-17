/* Ghostpin — UI */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------ constants */
const PROFILES = { walk: 5, run: 10, bike: 18, car: 50, highway: 110 };
const OSRM = { walk: 'foot', run: 'foot', bike: 'bike', car: 'car', highway: 'car' };
const PRESETS = [
  { group: 'Riyadh', items: [
    ['Riyadh City Centre', 24.7136, 46.6753], ['Kingdom Centre', 24.7114, 46.6744], ['Al Faisaliah Tower', 24.6905, 46.6853],
    ['KAFD', 24.7633, 46.6407], ['Boulevard City', 24.7685, 46.6075], ['Riyadh Park Mall', 24.7552, 46.6293],
    ['Diriyah — At-Turaif', 24.7334, 46.5755], ['King Khalid Airport', 24.9578, 46.6988], ['Masmak Fortress', 24.6312, 46.7134] ]},
  { group: 'Saudi Arabia', items: [
    ['Jeddah Corniche', 21.5433, 39.1728], ['Makkah — Masjid al-Haram', 21.4225, 39.8262], ['Madinah — Prophet\'s Mosque', 24.4672, 39.6111],
    ['Dammam', 26.4207, 50.0888], ['AlUla', 26.6085, 37.9232] ]},
  { group: 'Egypt', items: [
    ['Cairo — Tahrir Square', 30.0444, 31.2357], ['Giza Pyramids', 29.9792, 31.1342], ['New Cairo — Fifth Settlement', 30.0074, 31.4913],
    ['Alexandria', 31.2001, 29.9187], ['Sharm El Sheikh', 27.9158, 34.3299] ]},
  { group: 'World', items: [
    ['Dubai — Burj Khalifa', 25.1972, 55.2744], ['London', 51.5074, -0.1278], ['Paris — Eiffel Tower', 48.8584, 2.2945],
    ['New York — Times Square', 40.758, -73.9855], ['Tokyo — Shibuya', 35.6595, 139.7005], ['Los Angeles', 34.0522, -118.2437] ]},
];
const QUICK = ['Riyadh City Centre', 'Kingdom Centre', 'Boulevard City', 'Jeddah Corniche', 'Cairo — Tahrir Square', 'Dubai — Burj Khalifa'];
const TILES = {
  dark:  { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© OpenStreetMap contributors', max: 19 },
  light: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© OpenStreetMap contributors', max: 19 },
  sat:   { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Imagery © Esri, Maxar, Earthstar Geographics', max: 19 },
  labels:{ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', attr: '© Esri', max: 19 },
  roads: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', attr: '© Esri', max: 19 },
};
const ICONS = {
  ok: '<svg class="ic" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  err: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  warn: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/></svg>',
  pin: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  star: '<svg class="ic" viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
  clock: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  x: '<svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  phone: '<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
  route: '<svg class="ic" viewBox="0 0 24 24"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h8"/></svg>',
};

/* ------------------------------------------------------------ state */
const S = {
  tab: 'teleport', pin: null, pinAddr: '', stops: [], routes: [], routeIdx: 0, routeType: 'road',
  profile: 'car', speed: 50, loop: 'off', realistic: true, variance: 8, joyProfile: 'walk',
  motion: {}, device: { connected: false, state: 'disconnected' }, sentCount: 0,
  store: { favorites: [], history: [], settings: {} },
  settings: { units: 'km', interval: 1, follow: true, confirmFar: true, restoreOnExit: false, mapStyle: 'dark', engine: 'classic' },
  selectedUdid: null, display: null, displayHeading: 0,
};

/* ------------------------------------------------------------ backend bridge (+ browser mock) */
let API = null;
function api() { return API; }

function makeMock() {
  // Lets the UI run in a normal browser: simulates the motion engine locally.
  const m = { pos: null, mode: 'idle', paused: false, speed: 50, route: [], cum: [], d: 0, dir: 1, loop: 'off', v: 0, heading: 0, joy: [0, 0], odo: 0, interval: 1 };
  const emit = (k, p) => setTimeout(() => window.GS.onEvents([[k, p]]), 0);
  const state = () => {
    const s = { mode: m.mode, paused: m.paused, heading: m.heading, speed: m.v * 3.6, targetSpeed: m.speed, odometer: m.odo, loop: m.loop, interval: m.interval };
    if (m.pos) [s.lat, s.lon] = m.pos;
    if (m.cum.length) { const t = m.cum.at(-1); const rem = m.dir > 0 ? t - m.d : m.d; Object.assign(s, { total: t, done: m.d, progress: m.d / t, remaining: rem, eta: rem / Math.max(.5, m.speed / 3.6) }); }
    return s;
  };
  const at = d => { let i = m.cum.findIndex(c => c >= d); if (i <= 0) i = 1; const a = m.route[i - 1], b = m.route[i]; const seg = m.cum[i] - m.cum[i - 1] || 1; const t = (d - m.cum[i - 1]) / seg; return [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], m.dir > 0 ? brg(a, b) : brg(b, a)]; };
  setInterval(() => {
    if (m.mode === 'idle' || m.paused || !m.pos) return;
    const target = m.speed / 3.6; m.v = Math.min(target, m.v + 2.8 * m.interval);
    const step = m.v * m.interval;
    if (m.mode === 'route') {
      m.d += step * m.dir; m.odo += step; const t = m.cum.at(-1);
      if (m.d >= t || m.d <= 0) { if (m.loop === 'loop') { m.d = 0; } else if (m.loop === 'pingpong') { m.dir *= -1; m.d = clamp(m.d, 0, t); } else { m.d = clamp(m.d, 0, t); [m.pos, m.heading] = at(m.d); m.mode = 'idle'; m.v = 0; emit('arrived', {}); emit('motion', state()); return; } }
      [m.pos, m.heading] = at(m.d);
    } else if (m.mode === 'joystick') {
      const [dx, dy] = m.joy; const mag = Math.min(1, Math.hypot(dx, dy)); if (mag < .05) { m.v = 0; return; }
      m.heading = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; m.pos = dest(m.pos, m.heading, step * mag); m.odo += step * mag;
    }
    emit('motion', state());
  }, 1000);
  const store = () => { try { return JSON.parse(localStorage.getItem('ghostpin-store') || '{}'); } catch { return {}; } };
  return {
    mock: true,
    app_info: async () => ({ name: 'Ghostpin', version: '2.0.0 (browser preview)' }),
    load_store: async () => store(), save_store: async d => { try { localStorage.setItem('ghostpin-store', JSON.stringify(d)); } catch {} return true; },
    list_devices: async () => ({ ok: true, devices: [] }),
    connect: async () => { emit('device', { state: 'error', message: 'Browser preview — run Ghostpin.exe to connect an iPhone.', info: {}, connected: false }); },
    disconnect: async () => true, restore_real_gps: async () => true, device_state: async () => ({ connected: false, info: {} }),
    start_admin_tunnel: async () => ({ ok: false, error: 'Only available in the Windows app' }),
    teleport: async (la, lo) => { m.mode = 'idle'; m.pos = [la, lo]; m.v = 0; emit('motion', state()); },
    start_route: async (pts, sp, loop) => { m.route = pts; m.cum = [0]; for (let i = 1; i < pts.length; i++) m.cum.push(m.cum[i - 1] + hav(pts[i - 1], pts[i])); m.d = 0; m.dir = 1; m.mode = 'route'; m.paused = false; m.speed = sp; m.loop = loop; m.pos = pts[0]; m.v = 0; m.heading = brg(pts[0], pts[1]); emit('motion', state()); return { ok: true, length: m.cum.at(-1) }; },
    pause: async v => { m.paused = v; emit('motion', state()); }, stop_motion: async () => { m.mode = 'idle'; m.v = 0; emit('motion', state()); },
    seek: async f => { if (m.cum.length) { m.d = f * m.cum.at(-1); [m.pos, m.heading] = at(m.d); emit('motion', state()); } },
    joystick: async (dx, dy) => { m.joy = [dx, dy]; if ((dx || dy) && m.pos) m.mode = 'joystick'; },
    configure: async c => { if (c.speed_kmh != null) m.speed = c.speed_kmh; if (c.loop_mode) m.loop = c.loop_mode; return state(); },
    motion_state: async () => state(),
    import_gpx: async () => { toast('GPX import works in the Windows app', 'warn'); return null; },
    export_gpx: async pts => { const xml = gpxString(pts); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' })); a.download = 'route.gpx'; a.click(); return { ok: true, path: 'route.gpx' }; },
    open_url: async u => window.open(u),
  };
}

/* ------------------------------------------------------------ geo helpers */
const R = 6371008.8, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function hav(a, b) { const dl = rad(b[0] - a[0]), dn = rad(b[1] - a[1]); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); }
function brg(a, b) { const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0])); const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1])); return (deg(Math.atan2(y, x)) + 360) % 360; }
function dest(p, b, d) { const la = rad(p[0]), lo = rad(p[1]), t = rad(b), dr = d / R; const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(t)); const lo2 = lo + Math.atan2(Math.sin(t) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2)); return [deg(la2), ((deg(lo2) + 540) % 360) - 180]; }
function pathLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += hav(pts[i - 1], pts[i]); return s; }
function fmtDist(m) { if (S.settings.units === 'mi') { const mi = m / 1609.344; return mi < .1 ? `${Math.round(m * 3.281)} ft` : `${mi < 10 ? mi.toFixed(2) : mi.toFixed(1)} mi`; } return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`; }
function fmtSpeed(kmh) { return S.settings.units === 'mi' ? Math.round(kmh / 1.609) : Math.round(kmh); }
function unitSpeed() { return S.settings.units === 'mi' ? 'mph' : 'km/h'; }
function fmtTime(s) { if (!isFinite(s)) return '–'; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : m ? `${m} min` : `${s % 60} s`; }
function fmtCoord(p) { return `${p[0].toFixed(6)}, ${p[1].toFixed(6)}`; }
function compass(h) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(h / 45) % 8]; }
function gpxString(pts) { return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Ghostpin" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Ghostpin route</name><trkseg>\n${pts.map(p => `<trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}"/>`).join('\n')}\n</trkseg></trk></gpx>`; }
function parseCoords(text) {
  const t = text.trim();
  let m = t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || t.match(/[?&](?:q|ll|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/) || t.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const la = parseFloat(m[1]), lo = parseFloat(m[2]);
  return (la >= -90 && la <= 90 && lo >= -180 && lo <= 180) ? [la, lo] : null;
}

/* ------------------------------------------------------------ map */
let map, baseLayer, labelLayer, pinMarker, meMarker, routeLayers = [], stopMarkers = [], trailLine;
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true, zoomSnap: .5, preferCanvas: false }).setView([24.7136, 46.6753], 12);
  setMapStyle(S.settings.mapStyle);
  map.on('click', e => onMapClick([e.latlng.lat, e.latlng.lng]));
  map.on('mousemove', e => { $('#sbCursor').textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`; });
  map.on('dragstart', () => { if (S.motion.mode && S.motion.mode !== 'idle' && S.settings.follow) setFollow(false, true); });
  trailLine = L.polyline([], { color: '#4FA3FF', weight: 3, opacity: .55, dashArray: '2 7', lineCap: 'round' }).addTo(map);
}
function setMapStyle(style) {
  S.settings.mapStyle = style;
  if (baseLayer) map.removeLayer(baseLayer); if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
  const t = TILES[style === 'hybrid' ? 'sat' : style];
  baseLayer = L.tileLayer(t.url, { attribution: t.attr, maxZoom: 20, maxNativeZoom: t.max }).addTo(map);
  if (style === 'hybrid') labelLayer = L.layerGroup([L.tileLayer(TILES.roads.url, { maxZoom: 20, maxNativeZoom: 19, opacity: .8 }), L.tileLayer(TILES.labels.url, { maxZoom: 20, maxNativeZoom: 19 })]).addTo(map);
  document.body.classList.toggle('map-dark', style === 'dark');
  $$('#layerMenu button').forEach(b => b.classList.toggle('on', b.dataset.style === style));
  persist();
}
const PIN_SVG = '<div class="pin"><svg viewBox="0 0 34 44"><path d="M17 43s14-13.2 14-25A14 14 0 0 0 3 18c0 11.8 14 25 14 25z"/><circle cx="17" cy="17.5" r="5"/></svg></div>';
const ME_SVG = '<div class="me"><svg viewBox="0 0 24 24"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg></div>';

function setPin(p, { fly = false, addr = true } = {}) {
  S.pin = p;
  if (!pinMarker) { pinMarker = L.marker(p, { icon: L.divIcon({ html: PIN_SVG, className: '', iconSize: [34, 44], iconAnchor: [17, 43] }), draggable: true, zIndexOffset: 500 }).addTo(map); pinMarker.on('dragend', () => { const ll = pinMarker.getLatLng(); setPin([ll.lat, ll.lng]); }); }
  else { pinMarker.setLatLng(p); const el = pinMarker.getElement()?.querySelector('svg'); if (el) { el.style.animation = 'none'; el.offsetWidth; el.style.animation = ''; } }
  $('#inLat').value = p[0].toFixed(6); $('#inLon').value = p[1].toFixed(6);
  if (fly) map.flyTo(p, Math.max(map.getZoom(), 15), { duration: 1.1 });
  updateFavBtn();
  if (addr) reverseGeocode(p);
}

function ensureMe() {
  if (!meMarker) meMarker = L.marker([0, 0], { icon: L.divIcon({ html: ME_SVG, className: '', iconSize: [40, 40], iconAnchor: [20, 20] }), interactive: false, zIndexOffset: 1000 });
  if (!map.hasLayer(meMarker)) meMarker.addTo(map);
  return meMarker;
}

/* map centre that puts p in the middle of the visible area (right of the panel) */
function viewCenter(p, z = map.getZoom()) {
  const off = (($('#panel').offsetWidth || 0) + 12) / 2;
  return map.unproject(map.project(L.latLng(p), z).subtract([off, 0]), z);
}
/* smooth marker interpolation between backend ticks */
let anim = null;
function animateMe(to, heading, ms) {
  ensureMe();
  const from = S.display || to;
  const h0 = S.displayHeading, dh = ((heading - h0 + 540) % 360) - 180;
  const t0 = performance.now();
  cancelAnimationFrame(anim);
  const step = now => {
    const t = clamp((now - t0) / ms, 0, 1);
    const p = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    S.display = p; S.displayHeading = (h0 + dh * Math.min(1, t * 2.2) + 360) % 360;
    meMarker.setLatLng(p);
    const svg = meMarker.getElement()?.querySelector('svg'); if (svg) svg.style.transform = `rotate(${S.displayHeading}deg)`;
    if (S.settings.follow && S.motion.mode && S.motion.mode !== 'idle') map.setView(viewCenter(p), map.getZoom(), { animate: false });
    if (t < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

/* ------------------------------------------------------------ geocoding */
let revTimer, revSeq = 0;
function reverseGeocode(p) {
  clearTimeout(revTimer); const seq = ++revSeq;
  const el = $('#pinAddress'); el.classList.add('loading');
  revTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p[0]}&lon=${p[1]}&zoom=17&accept-language=en`);
      const j = await r.json(); if (seq !== revSeq) return;
      const a = j.address || {};
      const name = j.name || a.road || a.neighbourhood || a.suburb || '';
      const area = a.suburb || a.city_district || a.city || a.town || a.village || a.state || '';
      S.pinAddr = [name, area !== name ? area : '', a.country].filter(Boolean).slice(0, 3).join(', ') || j.display_name || 'Unnamed location';
    } catch { if (seq !== revSeq) return; S.pinAddr = 'Dropped pin'; }
    el.textContent = S.pinAddr; el.classList.remove('loading');
  }, 350);
}
let searchTimer, searchSeq = 0, kbIndex = -1;
async function doSearch(q) {
  const box = $('#searchResults'); const seq = ++searchSeq;
  const coords = parseCoords(q);
  if (coords) { renderResults([{ name: 'Go to coordinates', sub: fmtCoord(coords), p: coords }]); return; }
  if (q.trim().length < 3) { box.classList.remove('open'); return; }
  box.innerHTML = '<div class="sr-empty">Searching…</div>'; box.classList.add('open');
  try {
    const c = map.getCenter();
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=7&accept-language=en&q=${encodeURIComponent(q)}&viewbox=${c.lng - 2},${c.lat + 2},${c.lng + 2},${c.lat - 2}`);
    const j = await r.json(); if (seq !== searchSeq) return;
    const seen = new Set();
    renderResults(j.map(x => ({ name: x.name || x.display_name.split(',')[0], sub: x.display_name, p: [+x.lat, +x.lon] }))
      .filter(r => { const k = r.name + '|' + r.p[0].toFixed(3) + ',' + r.p[1].toFixed(3); if (seen.has(k)) return false; seen.add(k); return true; }));
  } catch { if (seq === searchSeq) box.innerHTML = '<div class="sr-empty">Search needs an internet connection</div>'; }
}
function renderResults(list) {
  const box = $('#searchResults'); kbIndex = -1;
  box.innerHTML = list.length ? '' : '<div class="sr-empty">No places found</div>';
  list.forEach((r, i) => {
    const el = document.createElement('div'); el.className = 'sr-item'; el.style.animationDelay = `${i * 25}ms`;
    el.innerHTML = `${ICONS.pin}<div><b></b><span></span></div><button class="sr-add">+ Stop</button>`;
    el.querySelector('b').textContent = r.name; el.querySelector('span').textContent = r.sub;
    el.addEventListener('click', e => {
      if (e.target.closest('.sr-add')) { addStop(r.p, r.name); switchTab('drive'); } else { pickPlace(r.p, r.name); }
      box.classList.remove('open'); $('#searchInput').blur();
    });
    box.appendChild(el);
  });
  box.classList.add('open');
}
function pickPlace(p, name) {
  if (S.tab === 'drive') { addStop(p, name); map.flyTo(p, Math.max(map.getZoom(), 14), { duration: .9 }); return; }
  if (S.tab !== 'teleport') switchTab('teleport');
  setPin(p, { fly: true, addr: !name });
  if (name) { S.pinAddr = name; $('#pinAddress').textContent = name; $('#pinAddress').classList.remove('loading'); }
}

/* ------------------------------------------------------------ teleport */
async function teleport(p = S.pin) {
  if (!p) return toast('Pick a location on the map first', 'warn');
  const last = S.motion.lat != null ? [S.motion.lat, S.motion.lon] : null;
  if (S.device.connected && S.settings.confirmFar && last && hav(last, p) > 50000) {
    const ok = await confirmDialog('Big jump', `This moves your iPhone ${fmtDist(hav(last, p))} instantly. Continue?`);
    if (!ok) return;
  }
  if (S.motion.mode && S.motion.mode !== 'idle') await api().stop_motion();
  S.display = null;
  await api().teleport(p[0], p[1]);
  ripple($('#btnTeleport'));
  addHistory(p, S.pinAddr || fmtCoord(p));
  toast(S.device.connected ? `iPhone moved to ${S.pinAddr || fmtCoord(p)}` : 'Preview: location set on map (connect an iPhone to send it)', S.device.connected ? 'ok' : 'warn');
}

/* ------------------------------------------------------------ drive: stops & routing */
function addStop(p, name) {
  S.stops.push({ p, name: name || null });
  if (!name) labelStop(S.stops.at(-1));
  renderStops(); computeRoute();
}
async function labelStop(stop) {
  try { const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${stop.p[0]}&lon=${stop.p[1]}&zoom=16&accept-language=en`); const j = await r.json(); const a = j.address || {}; stop.name = j.name || a.road || a.suburb || a.city || 'Dropped pin'; renderStops(false); } catch { stop.name = 'Dropped pin'; renderStops(false); }
}
function renderStops(redrawMarkers = true) {
  const box = $('#stops'); box.innerHTML = '';
  if (!S.stops.length) box.innerHTML = '<div class="stops-empty">No stops yet — click the map to set a start point</div>';
  S.stops.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'stop' + (i === 0 ? ' first' : '') + (i === S.stops.length - 1 && i > 0 ? ' last' : '');
    const label = i === 0 ? 'Start' : i === S.stops.length - 1 ? 'Destination' : `Stop ${i}`;
    el.innerHTML = `<span class="badge">${i === 0 ? 'A' : i === S.stops.length - 1 ? 'B' : i}</span><div><b></b><span>${label} · ${fmtCoord(s.p)}</span></div><button class="ghost-ic" title="Remove">${ICONS.x}</button>`;
    el.querySelector('b').textContent = s.name || 'Locating…';
    el.querySelector('button').onclick = () => { S.stops.splice(i, 1); renderStops(); computeRoute(); };
    el.querySelector('div').onclick = () => map.flyTo(s.p, Math.max(map.getZoom(), 15), { duration: .8 });
    box.appendChild(el);
  });
  $('#stopHint').textContent = S.stops.length === 0 ? 'Click the map to add a start point.' : S.stops.length === 1 ? 'Now click where you want to go. Add more clicks for stops on the way.' : 'Drag pins to adjust. Click the map to add more stops.';
  if (!redrawMarkers) return;
  stopMarkers.forEach(m => map.removeLayer(m)); stopMarkers = [];
  S.stops.forEach((s, i) => {
    const lbl = i === 0 ? 'A' : (i === S.stops.length - 1 ? 'B' : i);
    const m = L.marker(s.p, { draggable: true, zIndexOffset: 600, icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="stop-pin ${i === 0 ? 'first' : ''}"><svg viewBox="0 0 26 26"><path d="M13 2a11 11 0 1 1 0 22 11 11 0 0 1 0-22z"/></svg><span>${lbl}</span></div>` }) }).addTo(map);
    m.on('dragend', () => { const ll = m.getLatLng(); s.p = [ll.lat, ll.lng]; s.name = null; labelStop(s); renderStops(); computeRoute(); });
    stopMarkers.push(m);
  });
}
let routeSeq = 0;
async function computeRoute() {
  const seq = ++routeSeq;
  routeLayers.forEach(l => map.removeLayer(l)); routeLayers = []; S.routes = []; S.routeIdx = 0;
  $('#routeSummary').hidden = S.stops.length < 2;
  if (S.stops.length < 2) { updateDriveBtn(); return; }
  const pts = S.stops.map(s => s.p);
  if (S.routeType === 'line') {
    S.routes = [{ coords: pts, distance: pathLen(pts) }];
  } else {
    $('#rsDist').textContent = '…'; $('#rsTime').textContent = '…';
    try {
      const prof = OSRM[S.profile];
      const coords = pts.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';');
      const r = await fetch(`https://routing.openstreetmap.de/routed-${prof}/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=${pts.length === 2 ? 'true' : 'false'}&continue_straight=false`);
      const j = await r.json(); if (seq !== routeSeq) return;
      if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || 'no route');
      S.routes = j.routes.map(rt => ({ coords: rt.geometry.coordinates.map(c => [c[1], c[0]]), distance: rt.distance }));
    } catch (e) {
      if (seq !== routeSeq) return;
      toast('Road routing unavailable here — using straight lines', 'warn');
      S.routes = [{ coords: pts, distance: pathLen(pts) }];
    }
  }
  drawRoutes(true);
}
function drawRoutes(fit) {
  routeLayers.forEach(l => map.removeLayer(l)); routeLayers = [];
  S.routes.forEach((r, i) => {
    if (i === S.routeIdx) return;
    const alt = L.polyline(r.coords, { color: '#8B93A7', weight: 5, opacity: .45, className: 'alt' }).addTo(map);
    alt.on('click', ev => { L.DomEvent.stopPropagation(ev); S.routeIdx = i; drawRoutes(false); });
    routeLayers.push(alt);
  });
  const r = S.routes[S.routeIdx]; if (!r) return;
  const casing = L.polyline(r.coords, { color: '#062018', weight: 9, opacity: .7, lineCap: 'round', lineJoin: 'round' }).addTo(map);
  const line = L.polyline(r.coords, { color: '#3EE0A8', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round', className: 'route-line' }).addTo(map);
  routeLayers.push(casing, line);
  requestAnimationFrame(() => { const el = line.getElement(); if (el) { const len = el.getTotalLength ? el.getTotalLength() : 4000; el.style.setProperty('--len', len + 1); } });
  stopMarkers.forEach(m => m.bringToFront?.());
  if (fit) map.flyToBounds(L.latLngBounds(r.coords).pad(.25), { duration: .9, paddingTopLeft: [380, 80] });
  $('#rsDist').textContent = fmtDist(r.distance);
  $('#rsTime').textContent = fmtTime(r.distance / (S.speed / 3.6));
  $('#rsAlt').textContent = `${S.routeIdx + 1} of ${S.routes.length}`;
  $('#rsAltBox').hidden = S.routes.length < 2; $('#routeSummary').classList.toggle('two', S.routes.length < 2);
  updateDriveBtn();
}
function updateDriveBtn() {
  const moving = S.motion.mode === 'route';
  const b = $('#btnDrive');
  b.classList.toggle('stopmode', moving);
  b.querySelector('span').textContent = moving ? 'Stop driving' : 'Start driving';
  b.querySelector('svg').innerHTML = moving ? '<rect x="6" y="6" width="12" height="12" rx="1.5"/>' : '<path d="M7 4v16l13-8z"/>';
  b.disabled = !moving && !S.routes[S.routeIdx];
}
async function startDrive() {
  if (S.motion.mode === 'route') { await api().stop_motion(); return; }
  const r = S.routes[S.routeIdx]; if (!r) return toast('Add a start and destination first', 'warn');
  await api().configure({ speed_kmh: S.speed, loop_mode: S.loop, realistic: S.realistic, variance: S.variance / 100, interval: S.settings.interval });
  S.display = null; trailLine.setLatLngs([]);
  const res = await api().start_route(r.coords, S.speed, S.loop);
  if (!res?.ok) return toast(res?.error || 'Could not start', 'err');
  setFollow(true);
  const z = Math.max(map.getZoom(), 16); map.setView(viewCenter(r.coords[0], z), z, { animate: true });
  toast(S.device.connected ? `Driving ${fmtDist(r.distance)} at ${fmtSpeed(S.speed)} ${unitSpeed()}` : 'Preview drive started (not sent — no iPhone connected)', S.device.connected ? 'ok' : 'warn');
}

/* ------------------------------------------------------------ motion events */
function onMotion(m) {
  const prevMode = S.motion.mode; S.motion = m;
  $('#liveCoord').textContent = m.lat != null ? `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}` : 'Not set';
  if (m.lat != null) {
    const p = [m.lat, m.lon];
    const ms = (m.mode === 'idle' && prevMode === 'idle') || !S.display ? 500 : (m.interval || 1) * 1000 + 80;
    if (!S.display || hav(S.display, p) > 5000) S.display = p;
    animateMe(p, m.heading || 0, ms);
    meMarker.getElement()?.querySelector('.me')?.classList.toggle('idle', m.mode === 'idle');
    if (m.mode !== 'idle') { const ll = trailLine.getLatLngs(); ll.push(L.latLng(p)); if (ll.length > 3000) ll.shift(); trailLine.setLatLngs(ll); }
  }
  const hud = $('#hud'); const showHud = m.mode === 'route';
  hud.classList.toggle('show', showHud); hud.classList.toggle('paused', !!m.paused);
  if (showHud) {
    tweenNumber($('#hudSpeed'), fmtSpeed(m.speed || 0));
    $('#hudUnit').textContent = unitSpeed();
    $('#hudState').textContent = m.paused ? 'Paused' : (S.device.connected ? 'Driving · live on iPhone' : 'Driving · preview');
    $('#hudRemain').textContent = fmtDist(m.remaining || 0); $('#hudEta').textContent = fmtTime(m.eta);
    const pct = clamp((m.progress || 0) * 100, 0, 100);
    if (!scrubbing) { $('#progressFill').style.width = pct + '%'; $('#progressKnob').style.left = pct + '%'; }
    $('#hudPause').innerHTML = m.paused ? '<svg class="ic" viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>' : '<svg class="ic" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>';
  }
  $('#joySpeed').textContent = fmtSpeed(m.mode === 'joystick' ? m.speed || 0 : 0);
  $('#joyHeading').textContent = m.heading != null && m.mode === 'joystick' ? `${Math.round(m.heading)}° ${compass(m.heading)}` : '–';
  $('#joyOdo').textContent = fmtDist(m.odometer || 0);
  if (prevMode !== m.mode) updateDriveBtn();
}
function tweenNumber(el, to) {
  const from = +el.textContent || 0; if (from === to) return;
  const t0 = performance.now();
  const f = now => { const t = clamp((now - t0) / 600, 0, 1); el.textContent = Math.round(from + (to - from) * (1 - (1 - t) ** 3)); if (t < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}

/* ------------------------------------------------------------ device */
function onDevice(d) {
  S.device = { ...S.device, ...d };
  const pill = $('#devicePill'); pill.className = 'device-pill ' + d.state;
  const info = d.info || {};
  $('#deviceLabel').textContent = d.state === 'connected' ? `${info.name || 'iPhone'} · iOS ${info.version}` : d.state === 'connecting' ? 'Connecting…' : d.state === 'error' ? 'Connection problem' : 'No iPhone';
  const st = $('#devStatus'); st.className = 'dev-status ' + d.state;
  $('#devName').textContent = d.state === 'connected' ? (info.name || 'iPhone') : d.state === 'connecting' ? 'Connecting…' : d.state === 'error' ? 'Couldn\'t connect' : 'Not connected';
  $('#devMsg').textContent = d.state === 'connected' ? `iOS ${info.version} · ${info.model || ''} · ${d.mode || ''}` : (d.message || 'Plug in your iPhone with a USB data cable.');
  $('#btnConnect').disabled = d.state === 'connecting';
  $('#btnConnect span').textContent = d.state === 'connected' ? 'Reconnect' : 'Connect';
  $('#btnDisconnect').hidden = d.state !== 'connected';
  const sb = $('.statusbar'); sb.classList.toggle('live', d.state === 'connected');
  $('#sbMode').textContent = d.state === 'connected' ? `Live on ${info.name || 'your iPhone'}` : 'Preview mode · not sent to an iPhone';
  if (d.state === 'connected') toast(`Connected to ${info.name || 'iPhone'}`, 'ok');
  if (d.state === 'error' && d.message) { toast(d.message, 'err', 6000); addLog('error', d.message); }
  if (d.state === 'connecting' && d.message) addLog('info', d.message);
}
async function scanDevices() {
  const box = $('#devList'); box.innerHTML = '<div class="hint small">Scanning USB…</div>';
  const r = await api().list_devices();
  box.innerHTML = '';
  if (!r.ok) { box.innerHTML = `<div class="hint small"></div>`; box.firstChild.textContent = r.error; return; }
  if (!r.devices.length) { box.innerHTML = '<div class="hint small">No iPhone detected. Check the cable, unlock the phone and tap Trust.</div>'; return; }
  if (!S.selectedUdid || !r.devices.some(d => d.udid === S.selectedUdid)) S.selectedUdid = r.devices[0].udid;
  r.devices.forEach(d => {
    const el = document.createElement('div'); el.className = 'dev-item' + (d.udid === S.selectedUdid ? ' sel' : '');
    el.innerHTML = `${ICONS.phone}<div><b></b><span></span></div>`;
    el.querySelector('b').textContent = d.name || 'iPhone (locked or not trusted)';
    el.querySelector('span').textContent = d.error ? d.error : `iOS ${d.version} · ${d.model} · ${d.connection}`;
    el.onclick = () => { S.selectedUdid = d.udid; $$('.dev-item').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); };
    box.appendChild(el);
  });
}

/* ------------------------------------------------------------ places */
function persist() {
  clearTimeout(persist.t);
  persist.t = setTimeout(() => api() && api().save_store({ ...S.store, settings: S.settings }), 300);
}
function addHistory(p, name) {
  S.store.history = [{ p, name, t: Date.now() }, ...S.store.history.filter(h => hav(h.p, p) > 15)].slice(0, 30);
  persist(); if (S.tab === 'saved') renderPlaces();
}
function isFav(p) { return p && S.store.favorites.some(f => hav(f.p, p) < 15); }
function updateFavBtn() { $('#btnFav').classList.toggle('on', isFav(S.pin)); }
function toggleFav() {
  if (!S.pin) return toast('Pick a location first', 'warn');
  if (isFav(S.pin)) { S.store.favorites = S.store.favorites.filter(f => hav(f.p, S.pin) >= 15); toast('Removed from saved places', 'ok'); }
  else { S.store.favorites.unshift({ p: S.pin, name: S.pinAddr || fmtCoord(S.pin) }); toast('Saved to Places', 'ok'); }
  updateFavBtn(); persist(); if (S.tab === 'saved') renderPlaces();
}
let savedView = 'fav';
function renderPlaces() {
  const box = $('#placeList'); box.innerHTML = '';
  const row = (item, icon, removable, idx) => {
    const el = document.createElement('div'); el.className = 'place'; el.style.animationDelay = `${Math.min(idx, 12) * 22}ms`;
    el.innerHTML = `${icon}<div><b></b><span>${fmtCoord(item.p)}</span></div>` +
      `<button class="ghost-ic" data-a="tp" title="Teleport now"><svg class="ic" viewBox="0 0 24 24"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg></button>` +
      `<button class="ghost-ic" data-a="stop" title="Add as route stop">${ICONS.route}</button>` +
      (removable ? `<button class="ghost-ic" data-a="rm" title="Remove">${ICONS.x}</button>` : '');
    el.querySelector('b').textContent = item.name;
    el.onclick = e => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'rm') { const arr = savedView === 'fav' ? S.store.favorites : S.store.history; arr.splice(arr.indexOf(item), 1); persist(); renderPlaces(); return; }
      if (a === 'stop') { addStop(item.p, item.name); switchTab('drive'); return; }
      switchTab('teleport'); setPin(item.p, { fly: true, addr: false }); S.pinAddr = item.name; $('#pinAddress').textContent = item.name; $('#pinAddress').classList.remove('loading');
      if (a === 'tp') teleport(item.p);
    };
    box.appendChild(el);
  };
  if (savedView === 'fav') {
    if (!S.store.favorites.length) box.innerHTML = '<div class="list-empty">No saved places yet.<br>Select a location and tap the star to save it.</div>';
    S.store.favorites.forEach((f, i) => row(f, ICONS.star, true, i));
  } else if (savedView === 'history') {
    if (!S.store.history.length) box.innerHTML = '<div class="list-empty">Places you teleport to will appear here.</div>';
    S.store.history.forEach((h, i) => row(h, ICONS.clock, true, i));
  } else {
    let i = 0;
    PRESETS.forEach(g => { const t = document.createElement('div'); t.className = 'group-title'; t.textContent = g.group; box.appendChild(t); g.items.forEach(([n, la, lo]) => row({ name: n, p: [la, lo] }, ICONS.pin, false, i++)); });
  }
}

/* ------------------------------------------------------------ joystick */
const keys = new Set(); let joyDrag = null, joySent = [0, 0];
function sendJoy(dx, dy) {
  if (Math.abs(dx - joySent[0]) < .02 && Math.abs(dy - joySent[1]) < .02) return;
  joySent = [dx, dy];
  if ((dx || dy) && S.motion.lat == null) { const c = S.pin || [map.getCenter().lat, map.getCenter().lng]; api().teleport(c[0], c[1]); }
  api().joystick(dx, dy);
}
function joyFromKeys() {
  if (joyDrag) return;
  let dx = 0, dy = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) dy += 1; if (keys.has('KeyS') || keys.has('ArrowDown')) dy -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1; if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= 1;
  const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
  $('#joyKnob').style.transform = `translate(${dx * 60}px,${-dy * 60}px)`;
  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
  api().configure({ speed_kmh: PROFILES[S.joyProfile] * (boost ? 2 : 1), realistic: true, interval: S.settings.interval });
  sendJoy(dx, dy);
  if (dx || dy) setFollow(true);
}
function initJoystick() {
  const pad = $('#joy'), knob = $('#joyKnob');
  const move = e => {
    const r = pad.getBoundingClientRect(); let x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    const max = 68, d = Math.hypot(x, y); if (d > max) { x = x / d * max; y = y / d * max; }
    knob.style.transform = `translate(${x}px,${y}px)`;
    sendJoy(x / max, -y / max);
  };
  pad.addEventListener('pointerdown', e => { joyDrag = true; knob.classList.add('drag'); pad.setPointerCapture(e.pointerId); api().configure({ speed_kmh: PROFILES[S.joyProfile], realistic: true, interval: S.settings.interval }); setFollow(true); move(e); });
  pad.addEventListener('pointermove', e => joyDrag && move(e));
  const end = () => { if (!joyDrag) return; joyDrag = null; knob.classList.remove('drag'); knob.style.transform = ''; sendJoy(0, 0); };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
}

/* ------------------------------------------------------------ UI helpers */
function switchTab(tab) {
  if (S.tab === tab) return;
  const order = ['teleport', 'drive', 'joystick', 'saved'];
  const dir = order.indexOf(tab) > order.indexOf(S.tab);
  $$('.pane').forEach(p => {
    p.classList.remove('left');
    if (p.dataset.pane === S.tab) { p.classList.remove('active'); if (dir) p.classList.add('left'); }
    if (p.dataset.pane === tab) { p.classList.add('active'); }
  });
  S.tab = tab;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  moveInk();
  if (tab === 'saved') renderPlaces();
  if (pinMarker) pinMarker.setOpacity(tab === 'drive' ? .35 : 1);
}
function moveInk() { const b = $(`#tabs button[data-tab="${S.tab}"]`); const ink = $('#tabInk'); ink.style.left = (b.offsetLeft + b.offsetWidth * .25) + 'px'; ink.style.width = (b.offsetWidth * .5) + 'px'; }
function onMapClick(p) {
  if ($('#searchResults').classList.contains('open')) { $('#searchResults').classList.remove('open'); return; }
  if (S.tab === 'drive') { if (S.motion.mode === 'route') return; addStop(p); }
  else if (S.tab === 'joystick') { api().teleport(p[0], p[1]); S.display = null; }
  else { if (S.tab !== 'teleport') switchTab('teleport'); setPin(p); }
}
function toast(text, kind = 'ok', ms = 2800) {
  const el = document.createElement('div'); el.className = 'toast ' + kind;
  el.innerHTML = (ICONS[kind] || ICONS.ok) + '<span></span>'; el.querySelector('span').textContent = text;
  const box = $('#toasts'); box.appendChild(el); while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}
function addLog(level, text) {
  const el = document.createElement('p'); el.className = level;
  const t = document.createElement('time'); t.textContent = new Date().toLocaleTimeString();
  el.append(t, document.createTextNode(text));
  const log = $('#log'); log.appendChild(el); while (log.children.length > 400) log.firstChild.remove(); log.scrollTop = log.scrollHeight;
}
function ripple(btn) { btn.classList.remove('ripple'); void btn.offsetWidth; btn.classList.add('ripple'); setTimeout(() => btn.classList.remove('ripple'), 30); }
function confirmDialog(title, text) {
  return new Promise(res => {
    $('#dlgTitle').textContent = title; $('#dlgText').textContent = text;
    const d = $('#dialog'), sc = $('#scrim'); d.classList.add('open'); sc.classList.add('open');
    const done = v => { d.classList.remove('open'); sc.classList.remove('open'); $('#dlgYes').onclick = $('#dlgNo').onclick = null; res(v); };
    $('#dlgYes').onclick = () => done(true); $('#dlgNo').onclick = () => done(false);
  });
}
function openSheet(id) { closeSheets(); $(id).classList.add('open'); $('#scrim').classList.add('open'); }
function closeSheets() { $$('.sheet').forEach(s => s.classList.remove('open')); $('#scrim').classList.remove('open'); $('#dialog').classList.remove('open'); }
function setFollow(v, quiet) { S.settings.follow = v; $('#btnFollow').classList.toggle('on', v); $('#setFollow').checked = v; if (!quiet) persist(); }
function rangeFill(el) { const p = (el.value - el.min) / (el.max - el.min) * 100; el.style.setProperty('--p', p + '%'); }
function seg(id, value, cb) {
  const root = $(id);
  const set = v => $$('button', root).forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
  set(value);
  root.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; set(b.dataset.v); cb(b.dataset.v); });
  return set;
}
function setSpeed(v, fromProfile) {
  S.speed = clamp(Math.round(v), 1, 250);
  const sl = $('#speed'); sl.value = S.speed; rangeFill(sl);
  $('#speedOut').textContent = `${fmtSpeed(S.speed)} ${unitSpeed()}`;
  if (!fromProfile) $$('#profiles button').forEach(b => b.classList.toggle('on', PROFILES[b.dataset.p] === S.speed));
  if (S.routes[S.routeIdx]) $('#rsTime').textContent = fmtTime(S.routes[S.routeIdx].distance / (S.speed / 3.6));
  api() && api().configure({ speed_kmh: S.speed });
}

/* ------------------------------------------------------------ wire up */
let scrubbing = false;
function bind() {
  $$('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  window.addEventListener('resize', moveInk);

  // search
  const si = $('#searchInput');
  si.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(si.value), 420); });
  si.addEventListener('keydown', e => {
    const items = $$('.sr-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); kbIndex = clamp(kbIndex + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1); items.forEach((x, i) => x.classList.toggle('kb', i === kbIndex)); }
    if (e.key === 'Enter') { clearTimeout(searchTimer); if (kbIndex >= 0 && items[kbIndex]) items[kbIndex].click(); else { const c = parseCoords(si.value); if (c) { pickPlace(c); $('#searchResults').classList.remove('open'); } else doSearch(si.value); } }
    if (e.key === 'Escape') { $('#searchResults').classList.remove('open'); si.blur(); }
  });
  si.addEventListener('focus', () => si.value.trim().length > 2 && $('#searchResults').children.length && $('#searchResults').classList.add('open'));
  si.addEventListener('paste', () => setTimeout(() => { const c = parseCoords(si.value); if (c) doSearch(si.value); }, 0));

  // teleport pane
  $('#btnTeleport').onclick = () => teleport();
  $('#btnFav').onclick = toggleFav;
  $('#btnCopyCoords').onclick = () => { if (!S.pin) return; navigator.clipboard?.writeText(fmtCoord(S.pin)); toast('Coordinates copied', 'ok'); };
  const coordInput = () => { const la = parseFloat($('#inLat').value), lo = parseFloat($('#inLon').value); if (la >= -90 && la <= 90 && lo >= -180 && lo <= 180) setPin([la, lo], { fly: true }); };
  ['#inLat', '#inLon'].forEach(s => { $(s).addEventListener('change', coordInput); $(s).addEventListener('keydown', e => e.key === 'Enter' && coordInput()); $(s).addEventListener('paste', e => { const c = parseCoords(e.clipboardData.getData('text')); if (c) { e.preventDefault(); setPin(c, { fly: true }); } }); });
  $('#btnLocateMe').onclick = () => { if (S.motion.lat != null) map.flyTo(viewCenter([S.motion.lat, S.motion.lon], 16), 16, { duration: 1 }); else toast('No simulated location yet', 'warn'); };
  $('#btnRestore').onclick = async () => {
    if (!S.device.connected) { await api().stop_motion(); if (meMarker) map.removeLayer(meMarker); S.motion = {}; S.display = null; trailLine.setLatLngs([]); $('#liveCoord').textContent = 'Not set'; toast('Preview cleared', 'ok'); return; }
    const ok = await confirmDialog('Restore real GPS?', 'Stops the simulation and gives your iPhone its real location back.');
    if (ok) { await api().restore_real_gps(); if (meMarker) map.removeLayer(meMarker); S.display = null; S.motion = {}; trailLine.setLatLngs([]); $('#liveCoord').textContent = 'Not set'; }
  };
  const q = $('#quickPresets');
  PRESETS.flatMap(g => g.items).filter(i => QUICK.includes(i[0])).forEach(([n, la, lo]) => { const c = document.createElement('button'); c.className = 'chip'; c.textContent = n.split(' — ')[0]; c.onclick = () => pickPlace([la, lo], n); q.appendChild(c); });

  // drive pane
  seg('#routeType', S.routeType, v => { S.routeType = v; computeRoute(); });
  seg('#loopMode', S.loop, v => { S.loop = v; api().configure({ loop_mode: v }); });
  $$('#profiles button').forEach(b => b.onclick = () => { $$('#profiles button').forEach(x => x.classList.toggle('on', x === b)); const old = OSRM[S.profile]; S.profile = b.dataset.p; setSpeed(PROFILES[S.profile], true); if (OSRM[S.profile] !== old && S.routeType === 'road') computeRoute(); });
  $('#speed').addEventListener('input', e => setSpeed(+e.target.value));
  $('#optRealistic').onchange = e => { S.realistic = e.target.checked; api().configure({ realistic: S.realistic }); };
  $('#variance').addEventListener('input', e => { S.variance = +e.target.value; rangeFill(e.target); $('#varianceOut').textContent = `±${S.variance}%`; api().configure({ variance: S.variance / 100 }); });
  $('#btnDrive').onclick = e => { ripple(e.currentTarget); startDrive(); };
  $('#btnStopFromPos').onclick = () => { const p = S.motion.lat != null ? [S.motion.lat, S.motion.lon] : S.pin; if (!p) return toast('No current location yet', 'warn'); S.stops.unshift({ p, name: 'Current location' }); renderStops(); computeRoute(); };
  $('#btnReverse').onclick = () => { S.stops.reverse(); renderStops(); computeRoute(); };
  $('#btnClearStops').onclick = () => { S.stops = []; renderStops(); computeRoute(); };
  $('#btnImportGpx').onclick = async () => { const r = await api().import_gpx(); if (!r) return; if (!r.ok) return toast(r.error, 'err'); S.routeType = 'line'; seg('#routeType', 'line', () => {}); S.stops = [{ p: r.points[0], name: r.name + ' (start)' }, { p: r.points.at(-1), name: r.name + ' (end)' }]; renderStops(); S.routes = [{ coords: r.points, distance: pathLen(r.points) }]; S.routeIdx = 0; $('#routeSummary').hidden = false; drawRoutes(true); toast(`Imported ${r.points.length} points from ${r.name}`, 'ok'); };
  $('#btnExportGpx').onclick = async () => { const r = S.routes[S.routeIdx]; if (!r) return toast('Plan a route first', 'warn'); const res = await api().export_gpx(r.coords, 'Ghostpin route', S.speed); if (res?.ok) toast('Route saved as GPX', 'ok'); };

  // HUD
  $('#hudPause').onclick = () => api().pause(!S.motion.paused);
  $('#hudStop').onclick = () => api().stop_motion();
  const prog = $('#progress');
  const scrub = e => { const r = prog.getBoundingClientRect(); const f = clamp((e.clientX - r.left) / r.width, 0, 1); $('#progressFill').style.width = f * 100 + '%'; $('#progressKnob').style.left = f * 100 + '%'; return f; };
  prog.addEventListener('pointerdown', e => { scrubbing = true; prog.setPointerCapture(e.pointerId); scrub(e); });
  prog.addEventListener('pointermove', e => scrubbing && scrub(e));
  prog.addEventListener('pointerup', e => { if (!scrubbing) return; scrubbing = false; S.display = null; api().seek(scrub(e)); });

  // joystick
  initJoystick();
  $$('#joyProfiles button').forEach(b => b.onclick = () => { $$('#joyProfiles button').forEach(x => x.classList.toggle('on', x === b)); S.joyProfile = b.dataset.p; api().configure({ speed_kmh: PROFILES[S.joyProfile] }); });

  // saved
  seg('#savedSeg', 'fav', v => { savedView = v; renderPlaces(); });

  // map controls
  $('#btnZoomIn').onclick = () => map.zoomIn(); $('#btnZoomOut').onclick = () => map.zoomOut();
  $('#btnLayers').onclick = e => { e.stopPropagation(); $('#layerMenu').classList.toggle('open'); };
  $$('#layerMenu button').forEach(b => b.onclick = () => { setMapStyle(b.dataset.style); $('#layerMenu').classList.remove('open'); });
  document.addEventListener('click', e => { if (!e.target.closest('.map-ctrl')) $('#layerMenu').classList.remove('open'); if (!e.target.closest('.search')) $('#searchResults').classList.remove('open'); });
  $('#btnFollow').onclick = () => { setFollow(!S.settings.follow); if (S.settings.follow && S.display) map.panTo(viewCenter(S.display)); };

  // device sheet
  $('#devicePill').onclick = () => { openSheet('#deviceSheet'); scanDevices(); };
  $('#btnScan').onclick = scanDevices;
  $('#btnConnect').onclick = () => api().connect(S.selectedUdid, $('#optTunneld').checked, S.settings.engine);
  seg('#setEngine', S.settings.engine, v => { S.settings.engine = v; persist();
    $('#engineHint').textContent = v === 'classic' ? 'Classic = same method as Ghostpin v1 (most compatible)' : 'Fast = one live connection, smoother joystick (beta)';
    if (S.device.connected) toast('Click Reconnect to switch engine', 'warn'); });
  $('#btnDisconnect').onclick = () => api().disconnect();
  $('#btnTunnel').onclick = async () => { const r = await api().start_admin_tunnel(); if (r.ok) { $('#optTunneld').checked = true; toast('Admin tunnel starting — keep its window open, then Connect', 'ok', 4500); } else toast(r.error, 'err'); };
  $('#scrim').onclick = closeSheets; $$('[data-close]').forEach(b => b.onclick = closeSheets);

  // settings
  $('#btnSettings').onclick = () => openSheet('#settingsSheet');
  seg('#setUnits', S.settings.units, v => { S.settings.units = v; persist(); setSpeed(S.speed, true); renderStops(false); if (S.routes.length) drawRoutes(false); onMotion(S.motion); });
  seg('#setInterval', String(S.settings.interval), v => { S.settings.interval = +v; persist(); api().configure({ interval: +v }); });
  $('#setFollow').onchange = e => setFollow(e.target.checked);
  $('#setConfirm').onchange = e => { S.settings.confirmFar = e.target.checked; persist(); };
  $('#setRestoreExit').onchange = e => { S.settings.restoreOnExit = e.target.checked; persist(); };

  // logs
  $('#btnLog').onclick = () => $('#logDrawer').classList.toggle('open');
  $('#btnLogClose').onclick = () => $('#logDrawer').classList.remove('open');

  // keyboard
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); si.focus(); si.select(); return; }
    if (typing) return;
    if (e.key === 'Escape') { if ($('.sheet.open,.dialog.open')) closeSheets(); else if (S.motion.mode && S.motion.mode !== 'idle') api().stop_motion(); return; }
    if (e.code === 'Space' && S.motion.mode === 'route') { e.preventDefault(); api().pause(!S.motion.paused); return; }
    if (['1', '2', '3', '4'].includes(e.key)) { switchTab(['teleport', 'drive', 'joystick', 'saved'][+e.key - 1]); return; }
    if (e.key.toLowerCase() === 't' && S.tab === 'teleport') { teleport(); return; }
    if (S.tab === 'joystick' && /^(Key[WASD]|Arrow\w+|Shift\w+)$/.test(e.code)) { e.preventDefault(); if (!keys.has(e.code)) { keys.add(e.code); joyFromKeys(); } }
  });
  document.addEventListener('keyup', e => { if (keys.delete(e.code)) joyFromKeys(); });
  window.addEventListener('blur', () => { if (keys.size) { keys.clear(); joyFromKeys(); } });
}

/* ------------------------------------------------------------ events from Python */
window.GS = {
  onEvents(batch) {
    for (const [kind, p] of batch) {
      if (kind === 'motion') onMotion(p);
      else if (kind === 'device') onDevice(p);
      else if (kind === 'sent') { S.sentCount++; }
      else if (kind === 'log') addLog(p.level, p.text);
      else if (kind === 'toast') toast(p.text, p.kind);
      else if (kind === 'arrived') { toast('Arrived at destination', 'ok'); addLog('ok', 'Route finished'); }
    }
  },
};

/* ------------------------------------------------------------ boot */
async function boot() {
  API = window.pywebview?.api || makeMock();
  const store = await API.load_store().catch(() => ({})) || {};
  S.store = { favorites: store.favorites || [], history: store.history || [] };
  Object.assign(S.settings, store.settings || {});
  initMap(); bind();
  setFollow(S.settings.follow, true);
  $('#setConfirm').checked = S.settings.confirmFar; $('#setRestoreExit').checked = S.settings.restoreOnExit;
  setSpeed(S.speed, true); rangeFill($('#variance')); renderStops(); updateDriveBtn();
  const info = await API.app_info().catch(() => ({ name: 'Ghostpin', version: '' })); $('#aboutLine').textContent = `${info.name} ${info.version}`;
  addLog('info', `${info.name} ${info.version} ready${API.mock ? ' (browser preview)' : ''}`);
  const ms = await API.motion_state().catch(() => null); if (ms && ms.lat != null) onMotion(ms);
  const ds = await API.device_state().catch(() => null); if (ds?.connected) onDevice({ state: 'connected', info: ds.info, mode: ds.mode, connected: true });
  requestAnimationFrame(() => { moveInk(); document.getElementById('app').classList.remove('booting'); });
}
let booted = false;
const apiReady = () => window.pywebview && window.pywebview.api && typeof window.pywebview.api.load_store === 'function';
const go = async () => {
  if (booted) return; booted = true;
  try { await boot(); }
  catch (e) {
    console.error(e);
    document.getElementById('app').classList.remove('booting');
    try { toast('Startup problem: ' + (e && e.message || e), 'err', 10000); addLog('error', String(e && e.stack || e)); } catch {}
  }
};
window.addEventListener('pywebviewready', () => apiReady() && go());
// Poll as well: the ready event can fire before this script runs.
(function wait(t0) {
  if (booted) return;
  if (apiReady()) return go();
  const inApp = !!window.pywebview || /pywebview/i.test(navigator.userAgent);
  if (!inApp && performance.now() - t0 > 400) return go();       // plain browser -> preview mock
  if (performance.now() - t0 > 12000) return go();                // never hang on the splash
  setTimeout(() => wait(t0), 100);
})(performance.now());
})();
