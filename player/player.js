// Single web player for Tizen/webOS signage browsers, Android/Fire TV kiosk WebViews and desktop browsers.
// Query params: api=<server base url> (default: same origin), debug=1
const params = new URLSearchParams(location.search);
const API = params.get('api') || '';
const stage = document.getElementById('stage');
const debug = document.getElementById('debug');
debug.hidden = !params.get('debug');

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A local agent (e.g. the Raspberry Pi installer) can hand over credentials once via #device=<id>.<secret>.
const handoff = new URLSearchParams(location.hash.slice(1)).get('device');
if (handoff && handoff.includes('.')) {
  const [id, secret] = [handoff.slice(0, handoff.indexOf('.')), handoff.slice(handoff.indexOf('.') + 1)];
  if (store.get('device', null)?.id !== id) { store.del('playlist'); store.del('menu'); }
  store.set('device', { id, secret });
  history.replaceState(null, '', location.pathname + location.search);
}

let device = store.get('device', null);
let playlist = store.get('playlist', null);
let menu = store.get('menu', null);
let lastFetch = 0;
let played = 0;
let paired = !!playlist;

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Device ${device.id}.${device.secret}`, ...(opts.headers || {}) },
  });
  if (r.status === 401) { store.del('device'); device = null; throw new Error('unauthorized'); }
  if (r.status === 409) { paired = false; throw new Error('unpaired'); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function ensureDevice() {
  while (!device) {
    try {
      const r = await fetch(`${API}/api/device/register`, { method: 'POST' });
      if (!r.ok) throw new Error(r.status);
      const b = await r.json();
      device = { id: b.deviceId, secret: b.deviceSecret };
      store.set('device', device);
    } catch { await sleep(10_000); }
  }
}

function applyBrand(brand) {
  if (brand?.color) document.documentElement.style.setProperty('--brand', brand.color);
}

// Show the pairing code until an operator claims this device in the console.
async function pairingLoop() {
  for (;;) {
    await ensureDevice();
    try {
      const s = await api('/api/device/state');
      if (s.paired) { applyBrand(s.brand); paired = true; return; }
      stage.innerHTML = `<div class="pair"><h1>Pair this screen</h1><div class="code">${esc(s.pairingCode)}</div>
        <p>In your operator console, open <b>Screens → Pair</b> and enter this code.</p></div>`;
    } catch (e) {
      if (!device) continue;
      stage.innerHTML = `<div class="pair"><h1>Connecting…</h1><p>${esc(e.message)}</p></div>`;
    }
    await sleep(5_000);
  }
}

async function refreshPlaylist() {
  try {
    playlist = await api('/api/device/playlist');
    lastFetch = Date.now();
    store.set('playlist', playlist);
    prefetch(playlist.slots);
    if (playlist.slots.some((s) => s.type === 'menu')) {
      menu = await api('/api/device/menu');
      store.set('menu', menu);
    }
  } catch (e) {
    if (!paired || !device) { store.del('playlist'); playlist = null; return; }
    console.warn('playlist fetch failed, using cached', e);
    lastFetch = Date.now() - ((playlist?.ttlSec ?? 300) - 30) * 1000; // retry in ~30s
  }
}

// Warm the Cache API / HTTP cache so playback survives network drops.
async function prefetch(slots) {
  const urls = [...new Set(slots.filter((s) => s.type !== 'menu').map((s) => mediaUrl(s.url)))];
  if ('caches' in window) {
    try { await (await caches.open('creatives')).addAll(urls); return; } catch {}
  }
  urls.forEach((u) => fetch(u).catch(() => {}));
}

// SSP creatives are absolute URLs; our own are relative to the API.
const mediaUrl = (u) => (/^https?:\/\//.test(u) ? u : API + u);
const playedOnce = new Set();

function logPlay(slot, startedAt) {
  if (slot.once) playedOnce.add(slot.creativeId);
  const q = store.get('popQueue', []);
  q.push({
    id: `${startedAt}-${slot.creativeId}`,
    creativeId: slot.creativeId,
    campaignId: slot.campaignId,
    playedAt: new Date(startedAt).toISOString(),
    durationSec: Math.round((Date.now() - startedAt) / 100) / 10,
  });
  store.set('popQueue', q.slice(-5000));
  played++;
}

async function flushPop() {
  if (!device || !paired) return;
  const q = store.get('popQueue', []);
  if (!q.length) return;
  const batch = q.slice(0, 500);
  try {
    await api('/api/device/pop', { method: 'POST', body: JSON.stringify({ events: batch }) });
    store.set('popQueue', store.get('popQueue', []).slice(batch.length));
  } catch {}
}

async function heartbeat() {
  if (!device) return;
  try {
    const r = await api('/api/device/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ ua: navigator.userAgent, played, queued: store.get('popQueue', []).length, w: innerWidth, h: innerHeight }),
    });
    for (const cmd of r.commands ?? []) await runCommand(cmd);
  } catch {}
}

// Remote commands queued by the operator console. Acknowledge first so a reload doesn't repeat forever.
async function runCommand(cmd) {
  try { await api(`/api/device/commands/${encodeURIComponent(cmd.id)}/ack`, { method: 'POST' }); } catch { return; }
  if (cmd.type === 'reload') location.reload();
  else if (cmd.type === 'refresh_playlist') lastFetch = 0;
  else if (cmd.type === 'clear_cache') {
    try { if ('caches' in window) await caches.delete('creatives'); } catch {}
    store.del('playlist'); store.del('menu');
    location.reload();
  } else if (cmd.type === 'identify') identify();
}

async function identify() {
  let label = playlist?.screenId ?? 'This screen';
  try {
    const st = await api('/api/device/state');
    if (st.screen) label = `${st.screen.venueName} · ${st.screen.name}`;
  } catch {}
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,.85);color:#fff;z-index:10;font-size:4vw;font-weight:700;text-align:center';
  el.innerHTML = `<div>${esc(label)}</div><div style="font-size:1.6vw;font-weight:400;margin-top:1vw;color:#bbb">Identified from the operator console</div>`;
  document.body.append(el);
  setTimeout(() => el.remove(), 15_000);
}

function renderMenu(m) {
  const sections = m?.sections ?? [];
  if (m?.brandColor) document.documentElement.style.setProperty('--brand', m.brandColor);
  const cols = Math.min(3, Math.max(1, sections.length));
  return `<div class="menu ${esc(m?.theme || 'dark')}" style="--cols:${cols}">
    <h1>${esc(m?.title)}</h1>
    <div class="cols">${sections.map((s) => `<div><h2>${esc(s.name)}</h2>${s.items.map((it) => `
      <div class="item ${it.soldOut ? 'sold' : ''}">
        <div><div class="name">${esc(it.name)}${it.soldOut ? '<span class="badge">SOLD OUT</span>' : ''}</div>
        ${it.description ? `<div class="desc">${esc(it.description)}</div>` : ''}</div>
        <div class="price">${it.price ? '$' + esc(it.price) : ''}</div>
      </div>`).join('')}</div>`).join('')}</div></div>`;
}

function show(slot) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timer;
    const done = (ok) => { clearTimeout(timer); if (ok) logPlay(slot, startedAt); resolve(); };
    if (slot.type === 'menu') {
      stage.innerHTML = renderMenu(menu);
      timer = setTimeout(() => done(true), slot.durationSec * 1000);
    } else if (slot.type === 'video') {
      const el = document.createElement('video');
      Object.assign(el, { src: mediaUrl(slot.url), muted: true, autoplay: true, playsInline: true });
      el.onended = () => done(true);
      el.onerror = () => done(false);
      timer = setTimeout(() => done(true), (slot.durationSec + 2) * 1000);
      stage.replaceChildren(el);
    } else {
      const el = new Image();
      el.src = mediaUrl(slot.url);
      el.onerror = () => { clearTimeout(timer); setTimeout(() => done(false), 1000); };
      timer = setTimeout(() => done(true), slot.durationSec * 1000);
      stage.replaceChildren(el);
    }
    debug.textContent = `${playlist?.screenId} · ${slot.campaignId ?? 'house'} · ${slot.creativeId} · played ${played}`;
  });
}

async function main() {
  setInterval(flushPop, 30_000);
  setInterval(heartbeat, 60_000);
  for (;;) {
    if (!paired || !device) await pairingLoop();
    heartbeat();
    if (!playlist || Date.now() - lastFetch > (playlist.ttlSec ?? 300) * 1000) await refreshPlaylist();
    const slots = playlist?.slots ?? [];
    if (!slots.length) {
      stage.innerHTML = '';
      await sleep(10_000);
      continue;
    }
    for (const slot of slots) {
      if (slot.once && playedOnce.has(slot.creativeId)) continue; // programmatic wins are bought per play
      await show(slot);
      if (!paired || !device) break;
    }
  }
}

main();
