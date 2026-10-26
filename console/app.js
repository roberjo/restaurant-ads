// Role-based console for platform admins, operators, venue managers and advertisers.
// Plain JS, hash routing, no build step.
'use strict';

const S = {
  token: localStorage.getItem('token'),
  me: null,
  opCtx: JSON.parse(sessionStorage.getItem('opCtx') || 'null'), // platform admin acting on an operator
};

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n) => Math.round(Number(n || 0)).toLocaleString();
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';
const role = () => S.me?.user.role;
const isAdmin = () => role() === 'platform_admin';
const label = (s) => String(s).replace(/_/g, ' ');

const STATUS_BADGE = {
  active: 'ok', online: 'ok', paid: 'ok', ok: 'ok', completed: 'info', invoiced: 'info',
  pending_review: 'warn', unpaid: 'warn', paused: 'warn', unpaired: 'warn', draft: '',
  rejected: 'bad', offline: 'bad', failed: 'bad', awaiting_account: 'warn', below_minimum: '', pending: 'warn',
  eligible: 'ok', not_eligible: 'warn', allow: 'ok', deny: 'bad', budget_runs_out: 'warn', private: 'info', open: '',
  trialing: 'ok', comped: 'info', past_due: 'warn', incomplete: 'warn', canceled: 'bad', unpaid: 'bad',
};
const badge = (s) => `<span class="badge ${STATUS_BADGE[s] ?? ''}">${esc(label(s))}</span>`;

const OPERATOR_SCOPED_EXEMPT = /^\/api\/(admin|auth|me|public|campaigns\/[^/]+)/;

async function api(method, path, body) {
  let url = path;
  if (isAdmin() && S.opCtx && !OPERATOR_SCOPED_EXEMPT.test(path)) {
    url += (url.includes('?') ? '&' : '?') + 'operatorId=' + encodeURIComponent(S.opCtx.id);
  }
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token && !path.startsWith('/api/auth')) { logout(); throw new Error('Session expired'); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b ?? {});
const PUT = (p, b) => api('PUT', p, b);
const DEL = (p) => api('DELETE', p);

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

/** Wrap an async handler: disable the button, toast errors. */
function act(fn) {
  return async (e) => {
    e?.preventDefault?.();
    const btn = e?.submitter || (e?.currentTarget instanceof HTMLButtonElement ? e.currentTarget : null);
    if (btn) btn.disabled = true;
    try { await fn(e); } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  };
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());
const fileToDataUrl = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
const videoDuration = (f) => new Promise((res) => {
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); res(Math.round(v.duration)); };
  v.onerror = () => res(null);
  v.src = URL.createObjectURL(f);
});

function haversineMiles(aLat, aLng, bLat, bLng) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** Leaflet map with a draggable center (click to move) and optional radius circle. Degrades to nothing offline. */
function mapPicker(el, { lat, lng, radiusMiles, markers = [], onPick }) {
  if (!window.L) { el.innerHTML = '<div class="empty small">Map unavailable. Enter coordinates manually.</div>'; return { setRadius() {}, setCenter() {} }; }
  const map = L.map(el).setView([lat, lng], radiusMiles ? 12 : 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
  const center = L.marker([lat, lng]).addTo(map);
  const circle = radiusMiles ? L.circle([lat, lng], { radius: radiusMiles * 1609.34, color: brand, weight: 2, fillOpacity: 0.08 }).addTo(map) : null;
  for (const m of markers) L.circleMarker([m.lat, m.lng], { radius: 6, color: brand, fillOpacity: 0.9 }).bindTooltip(m.label).addTo(map);
  map.on('click', (e) => { center.setLatLng(e.latlng); circle?.setLatLng(e.latlng); onPick?.(e.latlng.lat, e.latlng.lng); });
  return {
    setRadius(r) { circle?.setRadius(r * 1609.34); },
    setCenter(a, b) { center.setLatLng([a, b]); circle?.setLatLng([a, b]); map.panTo([a, b]); },
  };
}

function setBrand(color) {
  if (color) document.documentElement.style.setProperty('--brand', color);
}

// ---------- shared components ----------
const DAY_LABELS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

/** Live-preview ad designer. onSave(body) receives the template fields (plus photoBase64 when chosen). */
function templateDesigner(el, { onSave, defaults = {}, saveLabel = 'Save ad', withDuration = true }) {
  el.innerHTML = `
    <div class="grid cols-2">
      <form class="tpl">
        <div class="form-grid">
          <div class="field"><label>Layout</label><select name="template"><option value="bold">Bold: big headline</option><option value="split">Split: text and photo</option><option value="photo">Photo: full-bleed photo</option></select></div>
          <div class="field"><label>Business name</label><input name="businessName" maxlength="40" value="${esc(defaults.businessName ?? '')}"></div>
        </div>
        <div class="field"><label>Headline (max 60)</label><input name="headline" maxlength="60" required value="${esc(defaults.headline ?? '')}"></div>
        <div class="field"><label>Supporting line (max 120)</label><input name="subline" maxlength="120"></div>
        <div class="form-grid">
          <div class="field"><label>Call to action</label><input name="cta" maxlength="40" placeholder="e.g. Book at brightsmile.com"></div>
          <div class="field"><label>Photo (split/photo layouts)</label><input name="photo" type="file" accept="image/png,image/jpeg,image/webp"></div>
          <div class="field"><label>Background</label><input name="bgColor" type="color" value="${esc(defaults.bgColor ?? '#0f766e')}"></div>
          <div class="field"><label>Accent</label><input name="accentColor" type="color" value="#facc15"></div>
          ${withDuration ? '<div class="field"><label>Seconds on screen</label><input name="durationSec" type="number" min="5" max="30" value="10"></div>' : ''}
        </div>
        <button class="primary" type="submit">${esc(saveLabel)}</button>
      </form>
      <div><label>Preview</label><img class="tpl-preview" alt="Ad preview" style="width:100%;aspect-ratio:16/9;border-radius:8px;border:1px solid var(--border);background:var(--surface-2)">
        <div class="small muted tpl-msg"></div></div>
    </div>`;
  const form = $('form.tpl', el);
  const img = $('.tpl-preview', el);
  const msg = $('.tpl-msg', el);
  let photo = null;
  let timer;
  const body = () => {
    const d = formData(form);
    const b = { template: d.template, headline: d.headline, subline: d.subline, cta: d.cta, businessName: d.businessName, bgColor: d.bgColor, accentColor: d.accentColor };
    if (photo) b.photoBase64 = photo;
    if (d.durationSec) b.durationSec = Number(d.durationSec);
    return b;
  };
  async function preview() {
    if (!form.headline.value.trim()) { msg.textContent = 'Type a headline to see a preview.'; return; }
    try {
      const r = await POST('/api/templates/preview', body());
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg);
      msg.textContent = '';
    } catch (e) { msg.textContent = e.message; }
  }
  form.oninput = () => { clearTimeout(timer); timer = setTimeout(preview, 300); };
  form.photo.onchange = async () => { photo = form.photo.files[0] ? await fileToDataUrl(form.photo.files[0]) : null; preview(); };
  form.onsubmit = act(async () => { await onSave(body()); });
  preview();
}

function hoursEditor(el, hours, onSave) {
  const always = hours === null || hours === undefined;
  el.innerHTML = `
    <form class="hours">
      <div class="checks" style="margin-bottom:10px"><label><input type="checkbox" name="always" ${always ? 'checked' : ''}> Hours unknown / always open</label></div>
      <table class="hrs" ${always ? 'hidden' : ''}>${DAY_LABELS.map(([k, n]) => {
        const r = (hours?.[k] ?? [])[0];
        return `<tr><td>${n}</td><td><label class="small" style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" data-closed="${k}" ${r ? '' : 'checked'}> closed</label></td>
          <td><input type="time" data-open="${k}" value="${r?.[0] ?? '11:00'}" style="width:auto"></td><td>to</td>
          <td><input type="time" data-close="${k}" value="${r?.[1] ?? '22:00'}" style="width:auto"></td></tr>`;
      }).join('')}</table>
      <p class="small muted">Closing after midnight is fine (e.g. 16:00 to 02:00). Screens turn on 15 minutes before opening and off 15 minutes after closing (Raspberry Pi players), and offline alerts are only sent while you're open.</p>
      <button class="primary" type="submit">Save hours</button>
    </form>`;
  const form = $('form.hours', el);
  form.always.onchange = () => { $('.hrs', el).hidden = form.always.checked; };
  form.onsubmit = act(async () => {
    let out = null;
    if (!form.always.checked) {
      out = {};
      for (const [k] of DAY_LABELS) {
        if ($(`[data-closed="${k}"]`, el).checked) continue;
        out[k] = [[$(`[data-open="${k}"]`, el).value, $(`[data-close="${k}"]`, el).value]];
      }
    }
    await onSave(out);
    toast('Hours saved');
  });
}

/** Stripe Connect payout status + onboarding button. */
async function payoutSetup(el, statusPath, onboardPath, who) {
  try {
    const st = await GET(statusPath);
    el.innerHTML = st.payoutsEnabled
      ? `<p>${badge('active')} Payouts are enabled. Earnings from card-paid campaigns are transferred to ${esc(who)}'s bank account.</p>`
      : `<p class="muted">${st.connected ? 'Stripe setup is incomplete.' : `Connect a bank account to receive ${esc(who)}'s earnings automatically.`} Stripe handles identity checks and tax forms.</p>
         <button class="primary" id="onboard">${st.connected ? 'Finish Stripe setup' : 'Set up payouts'}</button>`;
    const b = $('#onboard', el);
    if (b) b.onclick = act(async () => { const r = await POST(onboardPath); location.href = r.url; });
  } catch (e) {
    el.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
  }
}

function payoutsTable(rows) {
  if (!rows.length) return '<div class="empty">No payouts yet.</div>';
  return `<table><tr><th>Date</th><th>Recipient</th><th>Period end</th><th class="num">Amount</th><th>Status</th></tr>
    ${rows.map((p) => `<tr><td class="small">${new Date(p.createdAt).toLocaleDateString()}</td><td>${esc(p.recipientName ?? p.recipientId)} <span class="small muted">${esc(p.recipientType)}</span></td>
      <td>${esc(p.periodEnd)}</td><td class="num">${usd(p.amountCents / 100)}</td>
      <td>${badge(p.status)}${p.error ? `<div class="small muted">${esc(p.error)}</div>` : ''}</td></tr>`).join('')}</table>`;
}

const BILLING_TEXT = {
  not_configured: 'Billing is not enabled on this server.',
  comped: 'Your screens are free during the design-partner period.',
  none: 'Pair up to FREE screens at no cost. Subscribe to add more.',
  trialing: 'Free trial: billing starts automatically when the trial ends.',
  active: 'Subscription active.',
  past_due: "Your last payment failed and Stripe is retrying. Screens keep playing; update your card to avoid interruption.",
  unpaid: "Payment failed. Screens keep playing, but you can't add new ones until billing is updated.",
  canceled: "Subscription canceled. Screens keep playing, but you can't add new ones until you subscribe again.",
  incomplete: 'The first payment has not completed yet.',
};

/** Operator SaaS billing: plan state, estimate and Stripe Checkout / customer portal buttons. */
async function billingCard(el) {
  const b = await GET('/api/operator/billing');
  const note = (BILLING_TEXT[b.state] ?? '').replace('FREE', b.freeScreens);
  const show = b.state !== 'not_configured' && b.state !== 'comped';
  el.innerHTML = `
    <div class="row between"><div>${badge(b.state === 'none' ? 'free plan' : b.state)} <span class="muted">${esc(note)}</span></div></div>
    <div class="grid cols-4" style="margin-top:12px">
      <div class="stat"><div class="label">Paired screens</div><div class="value">${b.pairedScreens}</div></div>
      <div class="stat"><div class="label">Price per screen</div><div class="value">${usd(b.unitPriceCents / 100)}<span class="small muted">/mo</span></div></div>
      <div class="stat"><div class="label">${b.hasSubscription || b.state === 'comped' ? 'Estimated monthly' : 'Monthly if you subscribe'}</div><div class="value">${usd(b.monthlyEstimateCents / 100)}</div></div>
      <div class="stat"><div class="label">${b.state === 'comped' ? 'Free until' : 'Current period ends'}</div><div class="value small">${
        b.state === 'comped' ? esc(b.freeUntil) : b.periodEnd ? new Date(b.periodEnd).toLocaleDateString() : '—'}</div></div>
    </div>
    ${show ? `<div class="row" style="margin-top:12px">
      ${b.hasSubscription ? '' : `<button class="primary" id="subscribe">${b.trialDays ? `Start ${b.trialDays}-day free trial` : 'Subscribe'}</button>`}
      ${b.canManage ? '<button id="portal">Manage billing &amp; invoices</button>' : ''}</div>
      <p class="small muted">Billed monthly per paired screen and prorated when you add or remove screens. Payments are handled by Stripe.</p>` : ''}`;
  const sub = $('#subscribe', el);
  if (sub) sub.onclick = act(async () => { location.href = (await POST('/api/operator/billing/checkout')).url; });
  const portal = $('#portal', el);
  if (portal) portal.onclick = act(async () => { location.href = (await POST('/api/operator/billing/portal')).url; });
}

// ---------- auth ----------
function logout() {
  if (S.token) fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${S.token}` } }).catch(() => {});
  S.token = null; S.me = null; S.opCtx = null;
  localStorage.removeItem('token');
  sessionStorage.removeItem('opCtx');
  location.hash = '#/login';
  route();
}

async function loadMe() {
  S.me = await GET('/api/me');
  setBrand(S.me.operator?.brandColor || S.opCtx?.brandColor);
}

function loginView() {
  $('#app').innerHTML = `
    <div class="auth card">
      <h1>Sign in</h1>
      <form id="f">
        <div class="field"><label>Email</label><input name="email" type="email" autocomplete="username" required></div>
        <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
        <button class="primary" type="submit">Sign in</button>
      </form>
    </div>`;
  $('#f').onsubmit = act(async (e) => {
    const r = await POST('/api/auth/login', formData(e.target));
    S.token = r.token;
    localStorage.setItem('token', r.token);
    await loadMe();
    const home = homeRoute();
    if (location.hash === home) route(); else location.hash = home;
  });
}

async function signupView(slug) {
  let op;
  try { op = await GET(`/api/public/operators/${encodeURIComponent(slug)}`); } catch { $('#app').innerHTML = '<div class="auth card empty">Unknown network.</div>'; return; }
  setBrand(op.brandColor);
  $('#app').innerHTML = `
    <div class="auth card">
      <div class="brand"><span class="dot"></span>${esc(op.name)}</div>
      <h1>Advertise on local screens</h1>
      <p class="muted">Put your business on TVs in restaurants near you. Campaigns start at ${usd(op.minBudgetCents / 100)}; rate ${usd(op.defaultCpmCents / 100)} per 1,000 impressions.</p>
      <form id="f">
        <div class="field"><label>Business name</label><input name="businessName" required></div>
        <div class="field"><label>Your name</label><input name="name" required></div>
        <div class="field"><label>Email</label><input name="email" type="email" required></div>
        <div class="field"><label>Password (8+ characters)</label><input name="password" type="password" minlength="8" required></div>
        <button class="primary" type="submit">Create account</button>
        <p class="small muted">Already have an account? <a href="#/login">Sign in</a></p>
      </form>
    </div>`;
  $('#f').onsubmit = act(async (e) => {
    const r = await POST(`/api/public/operators/${encodeURIComponent(slug)}/advertisers`, formData(e.target));
    S.token = r.token;
    localStorage.setItem('token', r.token);
    await loadMe();
    location.hash = '#/campaigns/new';
  });
}

// ---------- shell ----------
function navItems() {
  const r = role();
  if (r === 'advertiser') return [['#/campaigns', 'My campaigns'], ['#/campaigns/new', 'New campaign']];
  if (r === 'venue_manager') return [[`#/venues/${S.me.user.venueId}`, 'My venue'], [`#/venues/${S.me.user.venueId}/menu`, 'Menu board'], ['#/screens', 'Screens']];
  const op = [['#/dashboard', 'Dashboard'], ['#/venues', 'Venues'], ['#/screens', 'Screens'], ['#/campaigns', 'Campaigns'],
    ['#/advertisers', 'Advertisers'], ['#/reports', 'Reports'], ['#/payouts', 'Payouts'], ['#/audit', 'Audit log'], ['#/settings', 'Settings']];
  if (r === 'operator_admin') return op;
  const admin = [['#/admin/operators', 'Operators'], ['#/admin/network', 'Network campaigns'], ['#/admin/reports', 'Platform report'],
    ['#/admin/network-quality', 'Pooled network'], ['#/admin/programmatic', 'Programmatic'], ['#/admin/billing', 'Billing'], ['#/admin/payouts', 'Payouts'], ['#/admin/audit', 'Audit log'], ['#/admin/settings', 'Platform settings']];
  return S.opCtx ? [...admin, ['', `Operator: ${S.opCtx.name}`], ...op] : admin;
}

function homeRoute() {
  const r = role();
  if (r === 'advertiser') return '#/campaigns';
  if (r === 'venue_manager') return `#/venues/${S.me.user.venueId}`;
  if (r === 'platform_admin') return S.opCtx ? '#/dashboard' : '#/admin/operators';
  return '#/dashboard';
}

function renderShell() {
  const brandName = S.me.operator?.name || (S.opCtx ? S.opCtx.name : 'Platform');
  const items = navItems().map(([href, text]) => href
    ? `<a class="nav" href="${href}">${esc(text)}</a>`
    : `<div class="small muted" style="padding:12px 10px 4px">${esc(text)} <a href="#" id="exitOp">×</a></div>`).join('');
  $('#app').innerHTML = `
    <div class="shell">
      <nav class="side">
        <div class="brand"><span class="dot"></span>${esc(brandName)}</div>
        ${items}
        <div class="spacer"></div>
        <div class="who">${esc(S.me.user.name)}<br>${esc(label(role()))}</div>
        <a class="nav" href="#" id="logout">Sign out</a>
      </nav>
      <main id="main"></main>
    </div>`;
  $('#logout').onclick = (e) => { e.preventDefault(); logout(); };
  const exit = $('#exitOp');
  if (exit) exit.onclick = (e) => { e.preventDefault(); S.opCtx = null; sessionStorage.removeItem('opCtx'); location.hash = '#/admin/operators'; renderShell(); route(); };
}

function highlightNav() {
  for (const a of $$('.side a.nav')) a.classList.toggle('active', a.getAttribute('href') === location.hash);
}

const main = (html) => { $('#main').innerHTML = html; };

// ---------- operator: dashboard ----------
async function dashboardView() {
  const [fleet, rep, pending, quality, forecast] = await Promise.all([
    GET('/api/fleet'), GET(`/api/reports/operator?from=${monthStart()}&to=${today()}`), GET('/api/campaigns?status=pending_review'),
    GET('/api/quality'), GET('/api/forecast?days=7'),
  ]);
  const s = fleet.summary;
  main(`
    <h1>Dashboard</h1>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Screens online</div><div class="value">${s.online} / ${s.total}</div></div>
      <div class="card stat"><div class="label">Ad plays this month</div><div class="value">${int(rep.totals.plays)}</div></div>
      <div class="card stat"><div class="label">Gross ad revenue (MTD)</div><div class="value">${usd(rep.totals.gross)}</div></div>
      <div class="card stat"><div class="label">Your earnings (MTD)</div><div class="value">${usd(rep.totals.operator)}</div></div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Needs review (${pending.length})</h2>
        ${pending.length ? `<table>${pending.map((c) => `<tr><td><a href="#/campaigns/${c.id}">${esc(c.name)}</a><div class="small muted">${esc(c.advertiserName ?? '')}</div></td>
          <td>${badge(c.paymentStatus)}</td><td class="num">${usd(c.budgetCents / 100)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing waiting.</div>'}
      </div>
      <div class="card">
        <h2>Fleet alerts (${fleet.alerts.length})</h2>
        ${fleet.alerts.length ? `<table>${fleet.alerts.map((a) => `<tr><td>${badge(a.severity === 'high' ? 'offline' : 'unpaired')}</td><td>${esc(a.message)}</td></tr>`).join('')}</table>` : '<div class="empty">All screens online.</div>'}
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card">${qualityCard(quality)}</div>
      <div class="card">
        <h2>Ad capacity, next 7 days</h2>
        <div class="row" style="gap:24px;margin-bottom:8px">
          <div class="stat"><div class="label">Ad slots (10 s)</div><div class="value">${int(forecast.totals.adSlots)}</div></div>
          <div class="stat"><div class="label">Sold</div><div class="value">${pct(forecast.totals.sellThroughPct)}</div></div>
          <div class="stat"><div class="label">Available slots</div><div class="value">${int(forecast.totals.availableSlots)}</div></div>
        </div>
        ${forecast.byDaypart.length ? capacityTable(forecast.byDaypart, 'daypart', 'Daypart') : '<div class="empty">Pair screens to see capacity.</div>'}
        <p class="small muted">Capacity from venue hours and each screen's ad share, minus what active campaigns will play. Unsold time goes to network and programmatic demand.</p>
      </div>
    </div>
    ${forecast.byCampaign.length ? `<div class="card table-wrap"><h2>Campaign delivery, next 7 days</h2>${deliveryTable(forecast.byCampaign)}
      <p class="small muted">"Budget runs out" means the campaign will spend its budget within the week at the current schedule.</p></div>` : ''}`);
}

const pct = (n) => (n === null || n === undefined ? '—' : `${n}%`);
/** Capacity rows (from /api/forecast) as ad slots: total, already sold to campaigns, still available. */
const capacityTable = (rows, key, heading) => `<table><tr><th>${heading}</th><th class="num">Ad slots</th><th class="num">Sold</th><th class="num">Available slots</th><th class="num">Available impressions</th></tr>
  ${rows.map((r) => `<tr><td>${esc(r[key])}</td><td class="num">${int(r.adSeconds / 10)}</td><td class="num">${pct(r.sellThroughPct)}</td>
    <td class="num">${int(r.availableSeconds / 10)}</td><td class="num">${int(r.availableImpressions)}</td></tr>`).join('')}</table>`;
const deliveryTable = (rows) => `<table><tr><th>Campaign</th><th>Ends</th><th class="num">Forecast impressions</th><th class="num">Budget left (impressions)</th><th></th></tr>
  ${rows.map((c) => `<tr><td>${esc(c.name)}${c.network ? ' <span class="small muted">(network)</span>' : ''}</td><td>${esc(c.endDate)}</td>
    <td class="num">${int(c.forecastImpressions)}</td><td class="num">${int(c.remainingBudgetImpressions)}</td>
    <td>${c.budgetLimited ? badge('budget_runs_out') : ''}</td></tr>`).join('')}</table>`;
function qualityCard(q) {
  return `<h2>Programmatic readiness</h2>
    <div class="row" style="gap:24px;margin-bottom:8px">
      <div class="stat"><div class="label">Quality score</div><div class="value">${q.score ?? '—'}<span class="small muted"> / 100</span></div></div>
      <div>${badge(q.eligible ? 'eligible' : 'not_eligible')}<div class="small muted">${esc(q.reason)}</div></div>
    </div>
    <table>
      <tr><td>Uptime during open hours (60%)</td><td class="num">${pct(q.uptimePct)}</td></tr>
      <tr><td>Venue and screen details complete (20%)</td><td class="num">${pct(q.metadataPct)}</td></tr>
      <tr><td>Plays passing verification (20%)</td><td class="num">${pct(q.compliancePct)}</td></tr>
    </table>
    <p class="small muted">Last 7 days. A score of ${q.minScore}+ unlocks national programmatic demand on your unsold ad time. Set venue hours, venue type and screen sizes to raise it.</p>`;
}

// ---------- venues ----------
const venueCategoryOptions = (sel) => S.me.venueCategories.map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${label(c)}</option>`).join('');

async function venuesView() {
  const venues = await GET('/api/venues');
  const center = venues[0] ? [venues[0].lat, venues[0].lng] : [30.2672, -97.7431];
  main(`
    <div class="row between"><h1>Venues</h1></div>
    <div class="card table-wrap">
      ${venues.length ? `<table><tr><th>Name</th><th>Category</th><th class="num">Screens</th><th class="num">Rev share</th><th class="num">Audience ×</th></tr>
      ${venues.map((v) => `<tr><td><a href="#/venues/${v.id}">${esc(v.name)}</a><div class="small muted">${esc(v.address)}</div></td>
        <td>${esc(label(v.category))}</td><td class="num">${v.screenCount}</td><td class="num">${v.revSharePct}%</td><td class="num">${v.audienceMultiplier}</td></tr>`).join('')}</table>`
        : '<div class="empty">No venues yet. Add your first restaurant below.</div>'}
    </div>
    <div class="card">
      <h2>Add venue</h2>
      <form id="f">
        <div class="form-grid">
          <div class="field"><label>Name</label><input name="name" required></div>
          <div class="field"><label>Address</label><input name="address"></div>
          <div class="field"><label>Category</label><select name="category">${venueCategoryOptions('qsr')}</select></div>
          <div class="field"><label>Timezone</label><input name="timezone" value="${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}"></div>
          <div class="field"><label>Revenue share to venue (%)</label><input name="revSharePct" type="number" min="0" max="100" step="0.5" value="20"></div>
          <div class="field"><label>Audience multiplier (viewers per play)</label><input name="audienceMultiplier" type="number" min="0" step="0.1" value="2"></div>
          <div class="field"><label>Latitude</label><input name="lat" type="number" step="any" value="${center[0]}" required></div>
          <div class="field"><label>Longitude</label><input name="lng" type="number" step="any" value="${center[1]}" required></div>
        </div>
        <div class="field"><label>Location (click the map)</label><div class="map" id="map"></div></div>
        <button class="primary" type="submit">Add venue</button>
      </form>
    </div>`);
  const f = $('#f');
  mapPicker($('#map'), { lat: center[0], lng: center[1], markers: venues.map((v) => ({ lat: v.lat, lng: v.lng, label: v.name })),
    onPick: (a, b) => { f.lat.value = a.toFixed(6); f.lng.value = b.toFixed(6); } });
  f.onsubmit = act(async () => {
    const v = await POST('/api/venues', formData(f));
    toast('Venue added');
    location.hash = `#/venues/${v.id}`;
  });
}

async function venueView(id) {
  const isOp = role() !== 'venue_manager';
  const from = monthStart();
  const [v, stmt] = await Promise.all([GET(`/api/venues/${id}`), GET(`/api/reports/venue/${id}?from=${from}&to=${today()}`)]);
  const cats = S.me.adCategories.map((c) => `<label><input type="checkbox" name="blocked" value="${c}" ${v.blockedAdCategories.includes(c) ? 'checked' : ''}> ${label(c)}</label>`).join('');
  main(`
    <h1>${esc(v.name)}</h1>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Venue earnings (MTD)</div><div class="value">${usd(stmt.totals.venueEarnings)}</div></div>
      <div class="card stat"><div class="label">Ad plays (MTD)</div><div class="value">${int(stmt.totals.plays)}</div></div>
      <div class="card stat"><div class="label">Est. impressions (MTD)</div><div class="value">${int(stmt.totals.impressions)}</div></div>
      <div class="card stat"><div class="label">Revenue share</div><div class="value">${v.revSharePct}%</div></div>
    </div>
    <div class="row" style="margin-bottom:16px"><a class="btn" href="#/venues/${v.id}/menu">Edit menu board →</a></div>
    ${isOp ? `<div class="card"><h2>Details</h2>
      <form id="details"><div class="form-grid">
        <div class="field"><label>Name</label><input name="name" value="${esc(v.name)}" required></div>
        <div class="field"><label>Address</label><input name="address" value="${esc(v.address)}"></div>
        <div class="field"><label>Category</label><select name="category">${venueCategoryOptions(v.category)}</select></div>
        <div class="field"><label>Venue type (OpenOOH, for programmatic buyers)</label><input name="venueType" list="venueTypes" value="${esc(v.venueType ?? '')}" placeholder="e.g. entertainment.bars">
          <datalist id="venueTypes">${['entertainment.qsr', 'entertainment.casual_dining', 'entertainment.bars', 'health_and_beauty.gyms', 'health_and_beauty.salons', 'retail.laundromats', 'retail']
            .map((t) => `<option value="${t}">`).join('')}</datalist></div>
        <div class="field"><label>Timezone</label><input name="timezone" value="${esc(v.timezone)}"></div>
        <div class="field"><label>Revenue share to venue (%)</label><input name="revSharePct" type="number" min="0" max="100" step="0.5" value="${v.revSharePct}"></div>
        <div class="field"><label>Audience multiplier</label><input name="audienceMultiplier" type="number" min="0" step="0.1" value="${v.audienceMultiplier}"></div>
        <div class="field"><label>Latitude</label><input name="lat" type="number" step="any" value="${v.lat}"></div>
        <div class="field"><label>Longitude</label><input name="lng" type="number" step="any" value="${v.lng}"></div>
      </div><button class="primary" type="submit">Save</button></form></div>` : ''}
    <div class="card"><h2>Blocked ad categories</h2>
      <p class="muted small">Ads in these categories never play at this venue.</p>
      <form id="blocks"><div class="checks">${cats}</div><div style="margin-top:12px"><button class="primary" type="submit">Save blocklist</button></div></form>
    </div>
    <div class="card"><h2>Venue promos (house content)</h2>
      <p class="muted small">Your own slides, shown between ads. PNG, JPEG, WebP, MP4 or WebM at 1920×1080.</p>
      <div class="thumbs">${v.houseCreatives.map((h) => `<div class="thumb">${h.type === 'video' ? `<video src="${esc(h.url)}" muted></video>` : `<img src="${esc(h.url)}" alt="">`}
        <div class="row between small"><span>${h.durationSec}s</span><button class="sm danger" data-del="${esc(h.id)}">Remove</button></div></div>`).join('') || '<div class="muted">None yet.</div>'}</div>
      <form id="house" class="row" style="margin-top:12px"><input type="file" name="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" required style="max-width:320px">
        <input type="number" name="durationSec" value="10" min="3" max="120" style="width:90px" title="seconds"> <button type="submit">Upload</button></form>
      <h3>Or design a promo</h3><div id="houseTpl"></div>
    </div>
    <div class="card"><h2>Open hours</h2><div id="hours"></div></div>
    <div class="card"><h2>Square POS</h2><div id="square" class="muted small">Loading…</div></div>
    <div class="card"><h2>Payouts</h2><div id="payoutSetup" class="small muted">Loading…</div><div id="venuePayouts" class="table-wrap"></div></div>
    <div class="card"><h2>Statement: ${esc(stmt.from)} to ${esc(stmt.to)}</h2>
      ${stmt.byAdvertiser.length ? `<table><tr><th>Advertiser</th><th class="num">Plays</th><th class="num">Impressions</th><th class="num">Your earnings</th></tr>
        ${stmt.byAdvertiser.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${int(r.plays)}</td><td class="num">${int(r.impressions)}</td><td class="num">${usd(r.venueEarnings)}</td></tr>`).join('')}</table>`
        : '<div class="empty">No paid ad plays yet this month.</div>'}
    </div>
    ${isOp ? `<div class="card"><h2>Add venue manager login</h2>
      <form id="vu" class="form-grid">
        <div class="field"><label>Name</label><input name="name" required></div>
        <div class="field"><label>Email</label><input name="email" type="email" required></div>
        <div class="field"><label>Temporary password</label><input name="password" type="text" minlength="8" required></div>
        <div class="field" style="align-self:end"><button type="submit">Create login</button></div>
      </form></div>` : ''}`);

  if (isOp) {
    $('#details').onsubmit = act(async (e) => { await PUT(`/api/venues/${id}`, formData(e.target)); toast('Saved'); });
    $('#vu').onsubmit = act(async (e) => { await POST(`/api/venues/${id}/users`, formData(e.target)); toast('Login created'); e.target.reset(); });
  }
  $('#blocks').onsubmit = act(async (e) => {
    await PUT(`/api/venues/${id}`, { blockedAdCategories: $$('input[name=blocked]:checked', e.target).map((i) => i.value) });
    toast('Blocklist saved');
  });
  $('#house').onsubmit = act(async (e) => {
    const file = e.target.file.files[0];
    const dur = file.type.startsWith('video/') ? await videoDuration(file) : null;
    await POST(`/api/venues/${id}/house-creatives`, { dataBase64: await fileToDataUrl(file), durationSec: dur || Number(e.target.durationSec.value) });
    toast('Uploaded');
    venueView(id);
  });
  for (const b of $$('[data-del]')) b.onclick = act(async () => { await DEL(`/api/venues/${id}/house-creatives/${b.dataset.del}`); venueView(id); });
  templateDesigner($('#houseTpl'), {
    defaults: { businessName: v.name, headline: '' }, saveLabel: 'Add promo', withDuration: true,
    onSave: async (body) => { await POST(`/api/venues/${id}/house-creatives/template`, body); toast('Promo added'); venueView(id); },
  });
  hoursEditor($('#hours'), v.openHours, (openHours) => PUT(`/api/venues/${id}`, { openHours }));
  squareCard($('#square'), id);
  payoutSetup($('#payoutSetup'), `/api/venues/${id}/stripe/status`, `/api/venues/${id}/stripe/onboard`, v.name);
  GET('/api/payouts').then((rows) => { $('#venuePayouts').innerHTML = payoutsTable(rows.filter((p) => p.recipientType === 'venue' && p.recipientId === id)); }).catch(() => {});
}

async function squareCard(el, venueId) {
  const st = await GET(`/api/venues/${venueId}/square`).catch((e) => ({ error: e.message }));
  if (st.error) { el.textContent = st.error; return; }
  if (!st.configured) { el.innerHTML = 'Square menu sync is not enabled on this server.'; return; }
  el.classList.remove('muted', 'small');
  el.innerHTML = st.connected
    ? `<p>${badge('active')} Connected to Square (merchant ${esc(st.merchantId ?? '')}). Prices and sold-out items sync automatically.</p>
       <p class="small muted">Last sync: ${st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : 'never'}${st.lastError ? ` · <span style="color:var(--bad)">${esc(st.lastError)}</span>` : ''}</p>
       <div class="row"><button id="sqSync">Sync now</button><button class="danger" id="sqOff">Disconnect</button></div>`
    : `<p class="muted">Connect Square so menu-board prices and sold-out items update on their own.</p><button class="primary" id="sqOn">Connect Square</button>`;
  const on = $('#sqOn', el), sync = $('#sqSync', el), off = $('#sqOff', el);
  if (on) on.onclick = act(async () => { location.href = (await POST(`/api/venues/${venueId}/square/connect`)).url; });
  if (sync) sync.onclick = act(async () => { const r = await POST(`/api/venues/${venueId}/square/sync`); toast(`Synced ${r.items} items`); squareCard(el, venueId); });
  if (off) off.onclick = act(async () => { await DEL(`/api/venues/${venueId}/square`); squareCard(el, venueId); });
}

async function menuView(venueId) {
  const [v, m, sq] = await Promise.all([GET(`/api/venues/${venueId}`), GET(`/api/venues/${venueId}/menu`), GET(`/api/venues/${venueId}/square`).catch(() => ({}))]);
  const sqResult = (location.hash.match(/square=([a-z_]+)/) || [])[1];
  if (sqResult) toast(sqResult === 'connected' ? 'Square connected and menu synced' : `Square: ${label(sqResult)}`, sqResult !== 'connected');
  const state = { title: m.title, theme: m.theme, sections: m.sections.length ? m.sections : [{ name: 'Menu', items: [] }] };

  function draw() {
    main(`
      <div class="row between"><h1>Menu board: ${esc(v.name)}</h1><a href="#/venues/${venueId}">← Venue</a></div>
      <div class="card">
        <div class="form-grid">
          <div class="field"><label>Title</label><input id="title" value="${esc(state.title)}"></div>
          <div class="field"><label>Theme</label><select id="theme">${['dark', 'light', 'brand'].map((t) => `<option ${t === state.theme ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        </div>
        <p class="small muted">Tick <b>sold out</b> to strike an item through on screen. Changes reach screens within 5 minutes.</p>
        ${sq.connected ? '<p class="small"><b>Synced from Square:</b> items are replaced on the next sync, so edit them in Square. Title and theme are kept.</p>' : ''}
      </div>
      ${state.sections.map((s, si) => `
        <div class="card">
          <div class="row between"><input data-sec="${si}" value="${esc(s.name)}" style="max-width:320px;font-weight:600">
            <button class="sm danger" data-delsec="${si}">Remove section</button></div>
          <div style="margin-top:12px">
            ${s.items.map((it, ii) => `
              <div class="menu-item">
                <input placeholder="Item" data-f="name" data-s="${si}" data-i="${ii}" value="${esc(it.name)}">
                <input placeholder="Price" data-f="price" data-s="${si}" data-i="${ii}" value="${esc(it.price)}">
                <input placeholder="Description" data-f="description" data-s="${si}" data-i="${ii}" value="${esc(it.description)}">
                <label class="small" style="margin:0;display:flex;align-items:center"><input type="checkbox" data-f="soldOut" data-s="${si}" data-i="${ii}" ${it.soldOut ? 'checked' : ''}> sold out</label>
                <button class="sm" data-delitem="${si}:${ii}" title="Remove">✕</button>
              </div>`).join('')}
            <button class="sm" data-additem="${si}">+ Add item</button>
          </div>
        </div>`).join('')}
      <div class="row"><button id="addsec">+ Add section</button><button class="primary" id="save">Save menu</button></div>`);

    $('#title').oninput = (e) => { state.title = e.target.value; };
    $('#theme').onchange = (e) => { state.theme = e.target.value; };
    for (const el of $$('[data-sec]')) el.oninput = () => { state.sections[el.dataset.sec].name = el.value; };
    for (const el of $$('[data-f]')) {
      const handler = () => { state.sections[el.dataset.s].items[el.dataset.i][el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; };
      el.oninput = handler; el.onchange = handler;
    }
    for (const b of $$('[data-additem]')) b.onclick = () => { state.sections[b.dataset.additem].items.push({ name: '', price: '', description: '', soldOut: false }); draw(); };
    for (const b of $$('[data-delitem]')) b.onclick = () => { const [s, i] = b.dataset.delitem.split(':'); state.sections[s].items.splice(i, 1); draw(); };
    for (const b of $$('[data-delsec]')) b.onclick = () => { state.sections.splice(b.dataset.delsec, 1); draw(); };
    $('#addsec').onclick = () => { state.sections.push({ name: 'New section', items: [] }); draw(); };
    $('#save').onclick = act(async () => {
      const clean = { ...state, sections: state.sections.map((s) => ({ ...s, items: s.items.filter((i) => i.name.trim()) })) };
      await PUT(`/api/venues/${venueId}/menu`, clean);
      toast('Menu saved');
    });
  }
  draw();
}

// ---------- screens ----------
async function screensView() {
  const isOp = role() !== 'venue_manager';
  const [screens, venues] = await Promise.all([GET('/api/screens'), isOp ? GET('/api/venues') : Promise.resolve([])]);
  main(`
    <h1>Screens</h1>
    <div class="card table-wrap">
      ${screens.length ? `<table><tr><th>Screen</th><th>Venue</th><th>Mode</th><th class="num">Ad share</th>${isOp ? '<th>Size</th>' : ''}<th>Status</th><th>Last seen</th>${isOp ? '<th></th>' : ''}</tr>
      ${screens.map((s) => `<tr>
        <td>${esc(s.name)}<div class="small muted">${esc(s.id)}</div></td><td>${esc(s.venueName)}</td>
        <td>${isOp ? `<select data-mode="${s.id}">${['menu', 'idle', 'signage'].map((m) => `<option ${m === s.mode ? 'selected' : ''}>${m}</option>`).join('')}</select>` : esc(s.mode)}</td>
        <td class="num">${isOp ? `<input type="number" min="0" max="100" value="${s.adSharePct}" data-share="${s.id}" style="width:72px">%` : s.adSharePct + '%'}</td>
        ${isOp ? `<td class="row" style="flex-wrap:nowrap"><input type="number" min="10" max="400" placeholder="in" title="Diagonal (inches)" value="${s.diagonalIn ?? ''}" data-diag="${s.id}" style="width:64px">
          <select data-res="${s.id}" title="Resolution">${[[1920, 1080], [1080, 1920], [3840, 2160], [2160, 3840], [1280, 720]]
            .map(([w, h]) => `<option value="${w}x${h}" ${w === s.widthPx && h === s.heightPx ? 'selected' : ''}>${w}×${h}</option>`).join('')}</select></td>` : ''}
        <td>${badge(s.status)}</td><td class="small muted">${s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}</td>
        ${isOp ? `<td class="row">${s.deviceId ? `<button class="sm" data-cmd="identify" data-screen="${s.id}" title="Show this screen's name on the TV">Identify</button>
          <button class="sm" data-cmd="reload" data-screen="${s.id}">Reload</button><button class="sm" data-unpair="${s.id}">Unpair</button>` : ''}
          <input placeholder="Code" maxlength="8" data-code="${s.id}" style="width:96px;text-transform:uppercase"><button class="sm primary" data-pair="${s.id}">Pair</button></td>` : ''}
      </tr>`).join('')}</table>` : '<div class="empty">No screens yet.</div>'}
    </div>
    ${isOp ? `<div class="card"><h2>Add screen</h2>
      ${venues.length ? `<form id="f" class="form-grid">
        <div class="field"><label>Venue</label><select name="venueId">${venues.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Screen name</label><input name="name" placeholder="e.g. Menu board, over the bar" required></div>
        <div class="field"><label>Mode</label><select name="mode">
          <option value="menu">menu: full-time menu board with ads mixed in</option>
          <option value="idle" selected>idle: ads and promos while the TV isn’t showing a game</option>
          <option value="signage">signage: venue promos and ads only</option></select></div>
        <div class="field" style="align-self:end"><button class="primary" type="submit">Add screen</button></div>
      </form>` : '<div class="muted">Add a venue first.</div>'}
      <h3>Install</h3>
      <ol class="small muted">
        <li>Plug the player stick into a spare HDMI port and power it from the TV's USB port.</li>
        <li>Open <code class="copy">${esc(location.origin)}/player/</code> on the device, or use the Raspberry Pi kit (<code>scripts/pi</code>) for kiosk mode and automatic TV on/off.</li>
        <li>A 6-character code appears. Enter it above next to the screen and press <b>Pair</b>.</li>
      </ol></div>` : ''}`);
  if (!isOp) return;
  const f = $('#f');
  if (f) f.onsubmit = act(async () => { await POST('/api/screens', formData(f)); toast('Screen added'); screensView(); });
  for (const b of $$('[data-pair]')) b.onclick = act(async () => {
    const code = $(`[data-code="${b.dataset.pair}"]`).value;
    await POST(`/api/screens/${b.dataset.pair}/pair`, { code });
    toast('Paired');
    screensView();
  });
  for (const b of $$('[data-unpair]')) b.onclick = act(async () => { await POST(`/api/screens/${b.dataset.unpair}/unpair`); screensView(); });
  for (const b of $$('[data-cmd]')) b.onclick = act(async () => {
    await POST(`/api/screens/${b.dataset.screen}/commands`, { type: b.dataset.cmd });
    toast(`${label(b.dataset.cmd)} sent: the screen picks it up within a minute`);
  });
  for (const s of $$('[data-mode]')) s.onchange = act(async () => {
    const r = await PUT(`/api/screens/${s.dataset.mode}`, { mode: s.value, adSharePct: s.value === 'menu' ? 20 : 40 });
    $(`[data-share="${r.id}"]`).value = r.adSharePct;
    toast('Mode updated');
  });
  for (const i of $$('[data-diag]')) i.onchange = act(async () => { await PUT(`/api/screens/${i.dataset.diag}`, { diagonalIn: i.value === '' ? null : Number(i.value) }); toast('Screen size saved'); });
  for (const sel of $$('[data-res]')) sel.onchange = act(async () => {
    const [widthPx, heightPx] = sel.value.split('x').map(Number);
    await PUT(`/api/screens/${sel.dataset.res}`, { widthPx, heightPx });
    toast('Resolution saved');
  });
  for (const i of $$('[data-share]')) i.onchange = act(async () => { await PUT(`/api/screens/${i.dataset.share}`, { adSharePct: Number(i.value) }); toast('Ad share updated'); });
}

// ---------- campaigns ----------
async function campaignsView(network = false) {
  const list = await GET(network ? '/api/campaigns?network=1' : '/api/campaigns');
  const canCreate = role() !== 'platform_admin' || network || S.opCtx;
  main(`
    <div class="row between"><h1>${network ? 'Network campaigns' : role() === 'advertiser' ? 'My campaigns' : 'Campaigns'}</h1>
      ${canCreate ? `<a class="btn" href="${network ? '#/admin/network/new' : '#/campaigns/new'}">+ New campaign</a>` : ''}</div>
    <div class="card table-wrap">
      ${list.length ? `<table><tr><th>Campaign</th><th>Status</th><th>Payment</th><th>Flight</th><th class="num">Plays</th><th class="num">Spent / budget</th></tr>
      ${list.map((c) => `<tr><td><a href="#/campaigns/${c.id}">${esc(c.name)}</a><div class="small muted">${esc(c.advertiserName ?? (c.network ? 'Network' : ''))} · ${esc(c.tier)}</div></td>
        <td>${badge(c.status)}</td><td>${badge(c.paymentStatus)}</td><td class="small">${c.startDate} → ${c.endDate}</td>
        <td class="num">${int(c.delivery.plays)}</td><td class="num">${usd(c.delivery.spentUsd)} / ${usd(c.delivery.budgetUsd)}</td></tr>`).join('')}</table>`
        : `<div class="empty">No campaigns yet.</div>`}
    </div>`);
}

async function campaignNewView(network = false) {
  const isAdv = role() === 'advertiser';
  const [inv, advertisers] = await Promise.all([
    network ? Promise.resolve({ venues: [] }) : GET('/api/inventory'),
    !isAdv && !network ? GET('/api/advertisers') : Promise.resolve([]),
  ]);
  const op = S.me.operator;
  const cpm = op?.defaultCpmCents ?? 1200;
  const minBudget = op?.minBudgetCents ?? 2500;
  const center = inv.venues[0] ? [inv.venues[0].lat, inv.venues[0].lng] : [30.2672, -97.7431];
  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  main(`
    <h1>New ${network ? 'network ' : ''}campaign</h1>
    <form id="f">
      <div class="card"><h2>Basics</h2><div class="form-grid">
        <div class="field"><label>Campaign name</label><input name="name" required></div>
        ${!isAdv && !network ? `<div class="field"><label>Advertiser</label><select name="advertiserId" required>${advertisers.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
          ${advertisers.length ? '' : '<div class="small muted">Add an advertiser first.</div>'}</div>` : ''}
        ${network ? `<div class="field"><label>Tier</label><select name="tier"><option>programmatic</option><option>direct</option></select></div>` : ''}
        ${!isAdv && !network ? `<div class="field"><label>Tier</label><select name="tier"><option>local</option><option>direct</option><option>sponsorship</option></select></div>` : ''}
        <div class="field"><label>Category</label><select name="adCategory">${S.me.adCategories.map((c) => `<option value="${c}" ${c === 'other' ? 'selected' : ''}>${label(c)}</option>`).join('')}</select></div>
        <div class="field"><label>Start date</label><input name="startDate" type="date" value="${today()}" required></div>
        <div class="field"><label>End date</label><input name="endDate" type="date" value="${nextMonth}" required></div>
        <div class="field"><label>Budget (USD)</label><input name="budget" type="number" min="${minBudget / 100}" step="1" value="${Math.max(100, minBudget / 100)}" required></div>
        ${!isAdv ? `<div class="field"><label>CPM (USD per 1,000 impressions)</label><input name="cpm" type="number" min="0.5" step="0.01" value="${(cpm / 100).toFixed(2)}"></div>` : `<div class="field"><label>Rate</label><div>${usd(cpm / 100)} per 1,000 impressions</div></div>`}
      </div></div>
      ${network ? '' : `<div class="card"><h2>Where</h2>
        <div class="form-grid">
          <div class="field"><label>Radius (miles)</label><input name="radiusMiles" type="number" min="0.25" max="200" step="0.25" value="3"></div>
          <div class="field"><label>Reach estimate</label><div id="reach" class="small"></div></div>
        </div>
        <input type="hidden" name="lat" value="${center[0]}"><input type="hidden" name="lng" value="${center[1]}">
        <div class="map" id="map"></div><p class="small muted">Click the map to set the center. Dots are venues with screens.</p>
      </div>`}
      <div class="card"><h2>When (optional)</h2>
        <div class="checks">${[['Breakfast', 6, 11], ['Lunch', 11, 14], ['Afternoon', 14, 17], ['Dinner', 17, 21], ['Late night', 21, 2]]
          .map(([n, a, b]) => `<label><input type="checkbox" name="dp" value="${a}-${b}"> ${n} (${a}:00–${b}:00)</label>`).join('')}</div>
        <p class="small muted">Leave unchecked to run all day.</p>
      </div>
      <button class="primary" type="submit">Create campaign</button>
    </form>`);
  const f = $('#f');

  function updateReach() {
    if (network) return;
    const lat = Number(f.lat.value), lng = Number(f.lng.value), r = Number(f.radiusMiles.value);
    const inside = inv.venues.filter((v) => haversineMiles(lat, lng, v.lat, v.lng) <= r);
    const daily = inside.reduce((a, v) => a + v.estDailyImpressions, 0);
    const budget = Number(f.budget.value) || 0;
    const rate = f.cpm ? Number(f.cpm.value) : cpm / 100;
    const buys = rate > 0 ? Math.round((budget / rate) * 1000) : 0;
    $('#reach').innerHTML = `<b>${inside.length}</b> venues · <b>${inside.reduce((a, v) => a + v.screens, 0)}</b> screens · up to ~${int(daily)} impressions/day<br>
      Your budget buys ~${int(buys)} impressions${daily ? ` (~${Math.max(1, Math.ceil(buys / daily))} days at full delivery)` : ''}.`;
  }
  if (!network) {
    const picker = mapPicker($('#map'), {
      lat: center[0], lng: center[1], radiusMiles: 3,
      markers: inv.venues.map((v) => ({ lat: v.lat, lng: v.lng, label: `${v.name} (${v.screens} screen${v.screens > 1 ? 's' : ''})` })),
      onPick: (a, b) => { f.lat.value = a; f.lng.value = b; updateReach(); },
    });
    f.radiusMiles.oninput = () => { picker.setRadius(Number(f.radiusMiles.value) || 0); updateReach(); };
    f.budget.oninput = updateReach;
    if (f.cpm) f.cpm.oninput = updateReach;
    updateReach();
  }

  f.onsubmit = act(async () => {
    const d = formData(f);
    const body = {
      name: d.name, adCategory: d.adCategory, startDate: d.startDate, endDate: d.endDate,
      budgetCents: Math.round(Number(d.budget) * 100),
      dayparts: $$('input[name=dp]:checked', f).map((i) => { const [a, b] = i.value.split('-').map(Number); return { startHour: a, endHour: b }; }),
    };
    if (d.cpm) body.cpmCents = Math.round(Number(d.cpm) * 100);
    if (d.advertiserId) body.advertiserId = d.advertiserId;
    if (d.tier) body.tier = d.tier;
    if (network) body.network = true;
    else body.geo = { lat: Number(d.lat), lng: Number(d.lng), radiusMiles: Number(d.radiusMiles) };
    const c = await POST('/api/campaigns', body);
    toast('Campaign created. Now add your ad.');
    location.hash = `#/campaigns/${c.id}`;
  });
}

async function campaignView(id) {
  const [rep] = await Promise.all([GET(`/api/campaigns/${id}/report`)]);
  const c = rep.campaign;
  const isReviewer = role() === 'platform_admin' || (role() === 'operator_admin' && !c.network);
  const editable = ['draft', 'rejected', 'pending_review'].includes(c.status) || isReviewer;
  const paidParam = location.hash.includes('paid=1');
  const actions = [];
  if (['draft', 'rejected'].includes(c.status)) actions.push(['submit', 'Submit for review', 'primary']);
  if (c.paymentStatus === 'unpaid' && S.me.stripeEnabled && c.advertiserId) actions.push(['checkout', `Pay ${usd(c.budgetCents / 100)}`, 'primary']);
  if (isReviewer && c.status === 'pending_review') actions.push(['approve', 'Approve', 'primary']);
  if (isReviewer && c.paymentStatus === 'unpaid') actions.push(['mark-invoiced', 'Mark invoiced (collect offline)', '']);
  if (c.status === 'active') actions.push(['pause', 'Pause', '']);
  if (c.status === 'paused') actions.push(['resume', 'Resume', '']);
  if (isReviewer && ['pending_review', 'active', 'paused'].includes(c.status)) actions.push(['reject', 'Reject…', 'danger']);
  const where = c.geo ? `${c.geo.radiusMiles} mi around ${c.geo.lat.toFixed(4)}, ${c.geo.lng.toFixed(4)}` : 'Entire network';
  const when = c.dayparts?.length ? c.dayparts.map((d) => `${d.startHour}:00–${d.endHour}:00`).join(', ') : 'All day';

  main(`
    <div class="row between"><h1>${esc(c.name)}</h1><div>${badge(c.status)} ${badge(c.paymentStatus)}</div></div>
    ${paidParam && c.paymentStatus !== 'paid' ? '<div class="card small">Payment received by Stripe. It may take a few seconds to confirm. Refresh shortly.</div>' : ''}
    ${c.status === 'rejected' && c.reviewNote ? `<div class="card"><b>Changes requested:</b> ${esc(c.reviewNote)}</div>` : ''}
    ${c.status === 'draft' ? '<div class="card small">Next: upload your ad below, then <b>Submit for review</b>. Your operator approves ads before they play.</div>' : ''}
    ${c.paymentStatus === 'unpaid' && !S.me.stripeEnabled && role() === 'advertiser' ? '<div class="card small">Your network operator will send you an invoice for this campaign.</div>' : ''}
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Plays</div><div class="value">${int(c.delivery.plays)}</div></div>
      <div class="card stat"><div class="label">Est. impressions</div><div class="value">${int(c.delivery.impressions)}</div></div>
      <div class="card stat"><div class="label">Spent</div><div class="value">${usd(c.delivery.spentUsd)}</div></div>
      <div class="card stat"><div class="label">Remaining</div><div class="value">${usd(rep.remainingUsd)}</div></div>
    </div>
    <div class="card">
      <div class="row">${actions.map(([a, t, cls]) => `<button class="${cls}" data-act="${a}">${t}</button>`).join('') || '<span class="muted">No actions available.</span>'}</div>
      <table style="margin-top:12px">
        <tr><th>Advertiser</th><td>${esc(c.advertiserName ?? 'Network')}</td><th>Tier</th><td>${esc(c.tier)}</td></tr>
        <tr><th>Flight</th><td>${c.startDate} → ${c.endDate}</td><th>Rate</th><td>${usd(c.cpmCents / 100)} CPM</td></tr>
        <tr><th>Where</th><td>${esc(where)}</td><th>When</th><td>${esc(when)}</td></tr>
        <tr><th>Category</th><td>${esc(label(c.adCategory))}</td><th>Budget</th><td>${usd(c.budgetCents / 100)}</td></tr>
      </table>
    </div>
    <div class="card"><h2>Ads</h2>
      <p class="small muted">Full-screen 1920×1080 image (PNG, JPEG, WebP) or video (MP4/WebM, 5–30s, no sound). Keep text large: viewers are 10–20 feet away.</p>
      <div class="thumbs">${c.creatives.map((cr) => `<div class="thumb">${cr.type === 'video' ? `<video src="${esc(cr.url)}" muted controls></video>` : `<img src="${esc(cr.url)}" alt="">`}
        <div class="row between small"><span>${cr.durationSec}s</span>${editable ? `<button class="sm danger" data-delcr="${cr.id}">Remove</button>` : ''}</div></div>`).join('') || '<div class="muted">No ads uploaded yet.</div>'}</div>
      ${editable ? `<form id="up" class="row" style="margin-top:12px"><input type="file" name="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" required style="max-width:320px">
        <input type="number" name="durationSec" value="10" min="5" max="30" style="width:90px" title="seconds"><button type="submit">Upload ad</button></form>
        <h3>No artwork? Design one</h3><div id="designer"></div>` : ''}
    </div>
    <div class="grid cols-2">
      <div class="card"><h2>Delivery by venue</h2>${rep.byVenue.length ? `<table><tr><th>Venue</th><th class="num">Plays</th><th class="num">Impr.</th><th class="num">Spend</th></tr>
        ${rep.byVenue.map((r) => `<tr><td>${esc(r.venue)}</td><td class="num">${int(r.plays)}</td><td class="num">${int(r.impressions)}</td><td class="num">${usd(r.spendUsd)}</td></tr>`).join('')}</table>` : '<div class="empty">No plays yet.</div>'}</div>
      <div class="card"><h2>Delivery by day</h2>${rep.byDay.length ? `<table><tr><th>Day</th><th class="num">Plays</th><th class="num">Impr.</th><th class="num">Spend</th></tr>
        ${rep.byDay.map((r) => `<tr><td>${esc(r.day)}</td><td class="num">${int(r.plays)}</td><td class="num">${int(r.impressions)}</td><td class="num">${usd(r.spendUsd)}</td></tr>`).join('')}</table>` : '<div class="empty">No plays yet.</div>'}</div>
    </div>`);

  for (const b of $$('[data-act]')) b.onclick = act(async () => {
    const a = b.dataset.act;
    if (a === 'checkout') { const r = await POST(`/api/campaigns/${id}/checkout`); location.href = r.url; return; }
    if (a === 'reject') {
      const note = window.prompt('What should the advertiser change?');
      if (!note) return;
      await POST(`/api/campaigns/${id}/reject`, { note });
    } else {
      await POST(`/api/campaigns/${id}/${a}`);
    }
    toast('Updated');
    campaignView(id);
  });
  const up = $('#up');
  if (up) up.onsubmit = act(async () => {
    const file = up.file.files[0];
    const dur = file.type.startsWith('video/') ? await videoDuration(file) : null;
    await POST(`/api/campaigns/${id}/creatives`, { dataBase64: await fileToDataUrl(file), durationSec: Math.min(30, Math.max(5, dur || Number(up.durationSec.value))) });
    toast('Ad uploaded');
    campaignView(id);
  });
  for (const b of $$('[data-delcr]')) b.onclick = act(async () => { await DEL(`/api/campaigns/${id}/creatives/${b.dataset.delcr}`); campaignView(id); });
  const designer = $('#designer');
  if (designer) templateDesigner(designer, {
    defaults: { businessName: c.advertiserName ?? '' },
    onSave: async (body) => { await POST(`/api/campaigns/${id}/creatives/template`, body); toast('Ad created'); campaignView(id); },
  });
}

// ---------- advertisers ----------
async function advertisersView() {
  const list = await GET('/api/advertisers');
  const slug = S.me.operator?.slug || S.opCtx?.slug;
  main(`
    <h1>Advertisers</h1>
    ${slug ? `<div class="card small">Self-serve signup link for local businesses: <code class="copy">${esc(location.origin)}/console/#/signup/${esc(slug)}</code></div>` : ''}
    <div class="card table-wrap">${list.length ? `<table><tr><th>Name</th><th>Contact</th><th class="num">Campaigns</th></tr>
      ${list.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.contactEmail ?? '')}</td><td class="num">${a.campaignCount}</td></tr>`).join('')}</table>` : '<div class="empty">No advertisers yet.</div>'}</div>
    <div class="card"><h2>Add advertiser</h2>
      <form id="f" class="form-grid">
        <div class="field"><label>Business name</label><input name="name" required></div>
        <div class="field"><label>Contact email</label><input name="contactEmail" type="email"></div>
        <div class="field"><label>Self-serve password (optional)</label><input name="password" type="text" minlength="8" placeholder="Leave blank for no login"></div>
        <div class="field" style="align-self:end"><button class="primary" type="submit">Add</button></div>
      </form></div>`);
  $('#f').onsubmit = act(async (e) => {
    const d = formData(e.target);
    if (!d.password) delete d.password;
    if (!d.contactEmail) delete d.contactEmail;
    await POST('/api/advertisers', d);
    toast('Advertiser added');
    advertisersView();
  });
}

// ---------- reports ----------
function moneyTable(rows, nameKey, cols) {
  if (!rows.length) return '<div class="empty">No data for this period.</div>';
  return `<table><tr><th>${esc(cols[0])}</th><th class="num">Plays</th><th class="num">Impr.</th><th class="num">Gross</th><th class="num">Platform</th><th class="num">Venue</th><th class="num">Operator</th></tr>
    ${rows.map((r) => `<tr><td>${esc(r[nameKey])}</td><td class="num">${int(r.plays)}</td><td class="num">${int(r.impressions)}</td><td class="num">${usd(r.gross)}</td>
      <td class="num">${usd(r.platform)}</td><td class="num">${usd(r.venue)}</td><td class="num">${usd(r.operator)}</td></tr>`).join('')}</table>`;
}

async function reportsView(from = monthStart(), to = today()) {
  const r = await GET(`/api/reports/operator?from=${from}&to=${to}`);
  main(`
    <h1>Reports</h1>
    <form id="range" class="row card"><label style="margin:0">From</label><input type="date" name="from" value="${from}" style="width:auto">
      <label style="margin:0">To</label><input type="date" name="to" value="${to}" style="width:auto"><button type="submit">Update</button></form>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Gross</div><div class="value">${usd(r.totals.gross)}</div></div>
      <div class="card stat"><div class="label">Venue payouts owed</div><div class="value">${usd(r.totals.venue)}</div></div>
      <div class="card stat"><div class="label">Platform fees</div><div class="value">${usd(r.totals.platform)}</div></div>
      <div class="card stat"><div class="label">Your net</div><div class="value">${usd(r.totals.operator)}</div></div>
    </div>
    ${r.invoicedPlatformFeesOwed ? `<div class="card small">Platform fees owed on campaigns you invoiced directly: <b>${usd(r.invoicedPlatformFeesOwed)}</b></div>` : ''}
    <div class="card table-wrap"><h2>By venue (revenue-share statements)</h2>${moneyTable(r.byVenue, 'name', ['Venue'])}</div>
    <div class="card table-wrap"><h2>By campaign</h2>${moneyTable([
      ...r.byCampaign.map((c) => ({ ...c, name: c.name + (c.network ? ' (network)' : '') })),
      ...(r.programmatic?.plays ? [{ ...r.programmatic, name: 'Programmatic (national buyers via SSPs)' }] : []),
    ], 'name', ['Campaign'])}
      ${r.programmatic?.plays ? '<p class="small muted">Programmatic earnings are paid out once the SSPs have paid the platform, typically 30–60 days after the month ends.</p>' : ''}</div>
    <div class="card table-wrap"><h2>By day</h2>${moneyTable(r.byDay, 'day', ['Day'])}</div>`);
  $('#range').onsubmit = act(async (e) => { const d = formData(e.target); await reportsView(d.from, d.to); });
}

// ---------- operator settings ----------
async function settingsView() {
  const o = await GET('/api/operator');
  main(`
    <h1>Settings</h1>
    <form id="f" class="card">
      <h2>Branding (white-label)</h2>
      <div class="form-grid">
        <div class="field"><label>Network name</label><input name="name" value="${esc(o.name)}" required></div>
        <div class="field"><label>Brand color</label><input name="brandColor" type="color" value="${esc(o.brandColor)}"></div>
        <div class="field"><label>Logo URL</label><input name="logoUrl" value="${esc(o.logoUrl ?? '')}"></div>
        <div class="field"><label>Signup link</label><code class="copy">${esc(location.origin)}/console/#/signup/${esc(o.slug)}</code></div>
      </div>
      <h2>Rate card</h2>
      <div class="form-grid">
        <div class="field"><label>Default CPM (USD)</label><input name="cpm" type="number" step="0.01" min="1" value="${(o.defaultCpmCents / 100).toFixed(2)}"></div>
        <div class="field"><label>Minimum campaign budget (USD)</label><input name="minBudget" type="number" step="1" min="1" value="${o.minBudgetCents / 100}"></div>
        <div class="field"><label>Platform fee on local ads</label><div>${o.platformFeePct}%</div></div>
      </div>
      <h2>Network demand</h2>
      <div class="checks"><label><input type="checkbox" name="networkOptIn" ${o.networkOptIn ? 'checked' : ''}> Fill unsold time with network and programmatic campaigns</label></div>
      <div style="margin-top:16px"><button class="primary" type="submit">Save settings</button></div>
    </form>
    <div class="card"><h2>Billing</h2><div id="billing" class="small muted">Loading…</div></div>
    <div class="card"><h2>Payouts</h2><div id="payoutSetup" class="small muted">Loading…</div></div>`);
  if (location.hash.includes('billing=success')) toast('Subscription started. It can take a few seconds to show here.');
  billingCard($('#billing')).catch((e) => { $('#billing').innerHTML = `<p class="muted small">${esc(e.message)}</p>`; });
  payoutSetup($('#payoutSetup'), '/api/operator/stripe/status', '/api/operator/stripe/onboard', o.name);
  $('#f').onsubmit = act(async (e) => {
    const d = formData(e.target);
    const o2 = await PUT('/api/operator', {
      name: d.name, brandColor: d.brandColor, logoUrl: d.logoUrl,
      defaultCpmCents: Math.round(Number(d.cpm) * 100), minBudgetCents: Math.round(Number(d.minBudget) * 100), networkOptIn: !!d.networkOptIn,
    });
    setBrand(o2.brandColor);
    if (S.me.operator) S.me.operator = o2;
    toast('Settings saved');
  });
}

// ---------- platform admin ----------
async function adminOperatorsView() {
  const ops = await GET('/api/admin/operators');
  main(`
    <h1>Operators</h1>
    <div class="card table-wrap">${ops.length ? `<table><tr><th>Operator</th><th>Slug</th><th class="num">Venues</th><th class="num">Screens</th><th class="num">Fee</th><th>Network</th><th></th></tr>
      ${ops.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.slug)}</td><td class="num">${o.venueCount}</td><td class="num">${o.screenCount}</td>
        <td class="num">${o.platformFeePct}%</td><td>${o.networkOptIn ? badge('active') : badge('paused')}</td>
        <td><button class="sm" data-open='${esc(JSON.stringify({ id: o.id, name: o.name, slug: o.slug, brandColor: o.brandColor }))}'>Open</button></td></tr>`).join('')}</table>` : '<div class="empty">No operators yet.</div>'}</div>
    <div class="card"><h2>Onboard operator</h2>
      <form id="f" class="form-grid">
        <div class="field"><label>Operator name</label><input name="name" required></div>
        <div class="field"><label>Slug (signup URL)</label><input name="slug" pattern="[a-z0-9-]+" required></div>
        <div class="field"><label>Admin name</label><input name="adminName" required></div>
        <div class="field"><label>Admin email</label><input name="adminEmail" type="email" required></div>
        <div class="field"><label>Temporary password</label><input name="adminPassword" type="text" minlength="8" required></div>
        <div class="field" style="align-self:end"><button class="primary" type="submit">Create operator</button></div>
      </form></div>`);
  for (const b of $$('[data-open]')) b.onclick = () => {
    S.opCtx = JSON.parse(b.dataset.open);
    sessionStorage.setItem('opCtx', JSON.stringify(S.opCtx));
    setBrand(S.opCtx.brandColor);
    renderShell();
    location.hash = '#/dashboard';
  };
  $('#f').onsubmit = act(async (e) => { await POST('/api/admin/operators', formData(e.target)); toast('Operator created'); adminOperatorsView(); });
}

async function adminSettingsView() {
  const s = await GET('/api/admin/settings');
  main(`
    <h1>Platform settings</h1>
    <form id="f" class="card">
      <div class="field" style="max-width:320px"><label>Network/programmatic take rate (%)</label><input name="networkTakePct" type="number" min="0" max="100" step="0.5" value="${s.networkTakePct}"></div>
      <p class="small muted">Applied to network campaigns before the venue's revenue share. Local-ad platform fees are set per operator.</p>
      <h2>Operator SaaS plan</h2>
      <div class="form-grid">
        <div class="field"><label>Price per paired screen per month (USD)</label><input name="price" type="number" min="0" step="0.01" value="${(s.priceCents / 100).toFixed(2)}"></div>
        <div class="field"><label>Free trial (days)</label><input name="trialDays" type="number" min="0" max="365" value="${s.trialDays}"></div>
        <div class="field"><label>Free screens without a subscription</label><input name="freeScreens" type="number" min="0" value="${s.freeScreens}"></div>
      </div>
      <p class="small muted">Price changes apply to new subscriptions. Existing subscribers keep their price.</p>
      <button class="primary" type="submit">Save</button>
    </form>`);
  $('#f').onsubmit = act(async (e) => {
    const d = formData(e.target);
    await PUT('/api/admin/settings', {
      networkTakePct: Number(d.networkTakePct), priceCents: Math.round(Number(d.price) * 100), trialDays: Number(d.trialDays), freeScreens: Number(d.freeScreens),
    });
    toast('Saved');
  });
}

async function adminReportsView() {
  const r = await GET(`/api/reports/platform?from=${monthStart()}&to=${today()}`);
  main(`
    <h1>Platform report (month to date)</h1>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Network gross</div><div class="value">${usd(r.totals.gross)}</div></div>
      <div class="card stat"><div class="label">Platform revenue</div><div class="value">${usd(r.totals.platform)}</div></div>
      <div class="card stat"><div class="label">Operator earnings</div><div class="value">${usd(r.totals.operator)}</div></div>
      <div class="card stat"><div class="label">Venue earnings</div><div class="value">${usd(r.totals.venue)}</div></div>
    </div>
    <div class="card table-wrap"><h2>By operator</h2>${moneyTable(r.byOperator, 'name', ['Operator'])}</div>`);
}

async function adminNetworkQualityView() {
  const [ops, net] = await Promise.all([GET('/api/admin/quality'), GET('/api/forecast?days=7')]);
  main(`
    <h1>Pooled network</h1>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Eligible operators</div><div class="value">${net.operators} / ${ops.length}</div></div>
      <div class="card stat"><div class="label">Eligible screens</div><div class="value">${int(net.screens)}</div></div>
      <div class="card stat"><div class="label">Available slots, next 7 days</div><div class="value">${int(net.totals.availableSlots)}</div><div class="small muted">of ${int(net.totals.adSlots)} (${pct(net.totals.sellThroughPct)} sold)</div></div>
      <div class="card stat"><div class="label">Available impressions, next 7 days</div><div class="value">${int(net.totals.availableImpressions)}</div></div>
    </div>
    <div class="card table-wrap"><h2>Operator quality (last 7 days)</h2>
      <table><tr><th>Operator</th><th class="num">Screens</th><th class="num">Uptime</th><th class="num">Details</th><th class="num">Verified plays</th><th class="num">Score</th><th>Programmatic</th><th>Override</th></tr>
      ${ops.map((o) => `<tr><td>${esc(o.name)}${o.networkOptIn ? '' : ' <span class="small muted">(opted out)</span>'}</td><td class="num">${o.pairedScreens}</td>
        <td class="num">${pct(o.uptimePct)}</td><td class="num">${pct(o.metadataPct)}</td><td class="num">${pct(o.compliancePct)}</td><td class="num">${o.score ?? '—'}</td>
        <td>${badge(o.eligible ? 'eligible' : 'not_eligible')}<div class="small muted">${esc(o.reason)}</div></td>
        <td><select data-override="${esc(o.operatorId)}">${[['', 'Automatic'], ['allow', 'Always allow'], ['deny', 'Pause']]
          .map(([v, l]) => `<option value="${v}" ${(o.override ?? '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('')}</table></div>
    <div class="grid cols-2">
      <div class="card table-wrap"><h2>Capacity by venue type</h2>${net.byVenueType.length ? capacityTable(net.byVenueType, 'venueType', 'Venue type') : '<div class="empty">No eligible screens yet.</div>'}</div>
      <div class="card table-wrap"><h2>Capacity by daypart</h2>${net.byDaypart.length ? capacityTable(net.byDaypart, 'daypart', 'Daypart') : '<div class="empty">No eligible screens yet.</div>'}</div>
    </div>
    ${net.byCampaign.some((c) => c.network) ? `<div class="card table-wrap"><h2>Network campaign delivery, next 7 days</h2>${deliveryTable(net.byCampaign.filter((c) => c.network))}</div>` : ''}`);
  for (const s of $$('[data-override]')) s.onchange = act(async () => {
    await PUT(`/api/admin/operators/${s.dataset.override}/programmatic`, { override: s.value || null });
    toast('Saved');
    adminNetworkQualityView();
  });
}

async function adminProgrammaticView() {
  const [ssps, st, deals] = await Promise.all([GET('/api/admin/ssps'), GET('/api/admin/rtb?days=7'), GET('/api/admin/deals')]);
  const sspName = (id) => ssps.find((s) => s.id === id)?.name ?? id;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  main(`
    <h1>Programmatic (OpenRTB)</h1>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Auctions (7 days)</div><div class="value">${int(st.auctions)}</div></div>
      <div class="card stat"><div class="label">Fill rate</div><div class="value">${st.fillRatePct}%</div></div>
      <div class="card stat"><div class="label">Wins / bids</div><div class="value">${int(st.wins)} / ${int(st.bids)}</div></div>
      <div class="card stat"><div class="label">SSP errors</div><div class="value">${int(st.errors)}</div></div>
    </div>
    <div class="card table-wrap"><h2>SSPs</h2>
      ${ssps.length ? `<table><tr><th>Name</th><th>Endpoint</th><th class="num">Floor CPM</th><th class="num">Timeout</th><th>Auth</th><th class="num">Wins</th><th class="num">Played</th><th class="num">Gross (7d)</th><th></th></tr>
      ${ssps.map((s) => { const x = st.bySsp.find((b) => b.id === s.id) ?? {}; return `<tr><td>${esc(s.name)}</td><td class="small"><code class="copy">${esc(s.endpointUrl)}</code></td>
        <td class="num">${usd(s.floorCpmCents / 100)}</td><td class="num">${s.timeoutMs} ms</td><td>${s.hasAuth ? badge('ok') : '—'}</td>
        <td class="num">${int(x.wins)}</td><td class="num">${int(x.played)}</td><td class="num">${usd(x.grossUsd)}</td>
        <td><button class="sm" data-toggle="${esc(s.id)}" data-on="${s.enabled ? 0 : 1}">${s.enabled ? 'Disable' : 'Enable'}</button></td></tr>`; }).join('')}</table>`
        : '<div class="empty">No SSPs connected. Programmatic fill starts when one is added.</div>'}</div>
    <div class="card"><h2>Connect an SSP</h2>
      <form id="f" class="form-grid">
        <div class="field"><label>Name</label><input name="name" required placeholder="e.g. Vistar Media"></div>
        <div class="field"><label>OpenRTB 2.6 endpoint (https)</label><input name="endpointUrl" type="url" pattern="https://.*" required></div>
        <div class="field"><label>Authorization header value (stored encrypted)</label><input name="authHeader" type="password" autocomplete="off" placeholder="optional"></div>
        <div class="field"><label>Floor CPM (USD)</label><input name="floor" type="number" min="0" step="0.01" value="3.00"></div>
        <div class="field"><label>Timeout (ms)</label><input name="timeoutMs" type="number" min="50" max="2000" value="300"></div>
        <div class="field" style="align-self:end"><button class="primary" type="submit">Add SSP</button></div>
      </form></div>
    <div class="card table-wrap"><h2>Private marketplace deals</h2>
      <p class="small muted">Sell the pooled network to a specific buyer: create the deal ID with the SSP, then add it here. Matching screens offer it on every auction.</p>
      ${deals.length ? `<table><tr><th>Deal</th><th>SSP</th><th>Buyer</th><th class="num">Floor CPM</th><th>Type</th><th>Targeting</th><th>Dates</th><th class="num">Played</th><th class="num">Gross</th><th></th></tr>
      ${deals.map((d) => `<tr><td>${esc(d.name)}<div class="small"><code class="copy">${esc(d.dealId)}</code></div></td><td>${esc(sspName(d.sspId))}</td><td>${esc(d.buyer ?? '—')}${d.wseats ? `<div class="small muted">seats: ${esc(d.wseats.join(', '))}</div>` : ''}</td>
        <td class="num">${usd(d.floorCpmCents / 100)}${d.auctionType === 3 ? ' fixed' : ''}</td><td>${badge(d.privateAuction ? 'private' : 'open')}</td>
        <td class="small">${esc(d.venueTypes?.join(', ') ?? 'all venue types')}${d.operatorIds ? `<div class="muted">${d.operatorIds.length} operator(s)</div>` : ''}</td>
        <td class="small">${d.startDate || d.endDate ? `${esc(d.startDate ?? 'now')} → ${esc(d.endDate ?? 'open')}` : 'any dates'}</td><td class="num">${int(d.played)}</td><td class="num">${usd(d.grossUsd)}</td>
        <td class="row" style="gap:4px"><button class="sm" data-avails="${esc(d.id)}">Avails</button>
          <button class="sm" data-deal="${esc(d.id)}" data-on="${d.enabled ? 0 : 1}">${d.enabled ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</table>`
        : '<div class="empty">No deals yet.</div>'}
      <div id="avails"></div>
      ${ssps.length ? `<h3>Add a deal</h3><form id="deal" class="form-grid">
        <div class="field"><label>Name</label><input name="name" required placeholder="e.g. QSR lunch — Agency X"></div>
        <div class="field"><label>SSP</label><select name="sspId">${ssps.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Deal ID (from the SSP)</label><input name="dealId" required></div>
        <div class="field"><label>Buyer</label><input name="buyer" placeholder="optional"></div>
        <div class="field"><label>Floor CPM (USD)</label><input name="floor" type="number" min="0" step="0.01" value="8.00" required></div>
        <div class="field"><label>Pricing</label><select name="auctionType"><option value="1">First price (floor)</option><option value="3">Fixed price</option></select></div>
        <div class="field"><label>Buyer seats (comma-separated)</label><input name="wseats" placeholder="optional"></div>
        <div class="field"><label>Venue types (comma-separated)</label><input name="venueTypes" placeholder="all, or e.g. entertainment.qsr, entertainment.bars"></div>
        <div class="field"><label>Start</label><input name="startDate" type="date"></div>
        <div class="field"><label>End</label><input name="endDate" type="date"></div>
        <div class="field"><label><input type="checkbox" name="privateAuction"> Private (only this buyer may bid)</label></div>
        <div class="field" style="align-self:end"><button class="primary" type="submit">Add deal</button></div>
      </form>` : ''}</div>
    <div class="card"><h2>Settlement</h2>
      <p class="small muted">SSPs pay the platform after the month closes. Programmatic plays are included in payout runs only up to the date you've been paid through.</p>
      <form id="settled" class="row"><label style="margin:0">SSPs have paid through</label><input type="date" name="settledThrough" value="${esc(st.settledThrough ?? '')}" max="${yesterday}" style="width:auto">
        <button type="submit">Save</button></form>
      <p class="small muted">Notices (7 days): ${Object.entries(st.notices).map(([k, n]) => `${esc(k)} ${int(n)}`).join(' · ') || 'none'}</p></div>`);
  $('#f').onsubmit = act(async (e) => {
    const d = formData(e.target);
    await POST('/api/admin/ssps', { name: d.name, endpointUrl: d.endpointUrl, authHeader: d.authHeader || null, floorCpmCents: Math.round(Number(d.floor) * 100), timeoutMs: Number(d.timeoutMs) });
    toast('SSP added');
    adminProgrammaticView();
  });
  for (const b of $$('[data-toggle]')) b.onclick = act(async () => { await PUT(`/api/admin/ssps/${b.dataset.toggle}`, { enabled: b.dataset.on === '1' }); adminProgrammaticView(); });
  const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : null);
  if ($('#deal')) $('#deal').onsubmit = act(async (e) => {
    const d = formData(e.target);
    await POST('/api/admin/deals', {
      name: d.name, sspId: d.sspId, dealId: d.dealId, buyer: d.buyer || null, floorCpmCents: Math.round(Number(d.floor) * 100),
      auctionType: Number(d.auctionType), wseats: list(d.wseats), venueTypes: list(d.venueTypes),
      startDate: d.startDate || null, endDate: d.endDate || null, privateAuction: !!d.privateAuction,
    });
    toast('Deal added');
    adminProgrammaticView();
  });
  for (const b of $$('[data-deal]')) b.onclick = act(async () => { await PUT(`/api/admin/deals/${b.dataset.deal}`, { enabled: b.dataset.on === '1' }); adminProgrammaticView(); });
  for (const b of $$('[data-avails]')) b.onclick = act(async () => {
    const f = await GET(`/api/admin/deals/${b.dataset.avails}/forecast?days=7`);
    $('#avails').innerHTML = `<h3>Avails for ${esc(deals.find((d) => d.id === b.dataset.avails).name)}, next 7 days</h3>
      <p class="small muted">${f.operators} eligible operator(s), ${int(f.screens)} screen(s): ${int(f.totals.availableSlots)} unsold ad slots, ~${int(f.totals.availableImpressions)} impressions.</p>
      ${f.byDaypart.length ? capacityTable(f.byDaypart, 'daypart', 'Daypart') : ''}`;
  });
  $('#settled').onsubmit = act(async (e) => { await PUT('/api/admin/rtb/settled', { settledThrough: formData(e.target).settledThrough || null }); toast('Saved'); });
}

async function adminBillingView() {
  const r = await GET('/api/admin/billing');
  main(`
    <h1>Operator billing</h1>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">SaaS MRR</div><div class="value">${usd(r.totals.mrrCents / 100)}</div></div>
      <div class="card stat"><div class="label">Paying operators</div><div class="value">${r.totals.payingOperators}</div></div>
      <div class="card stat"><div class="label">In trial</div><div class="value">${r.totals.trialing}</div></div>
      <div class="card stat"><div class="label">Billed screens</div><div class="value">${int(r.totals.billedScreens)}</div></div>
    </div>
    <div class="card table-wrap"><table><tr><th>Operator</th><th>Status</th><th class="num">Paired</th><th class="num">Billed</th><th class="num">Per screen</th><th>Free until (design partner)</th></tr>
      ${r.operators.map((o) => `<tr><td>${esc(o.name)}</td><td>${badge(o.state === 'none' ? 'free plan' : o.state)}</td><td class="num">${o.pairedScreens}</td><td class="num">${o.billedScreens}</td>
        <td class="num">${usd(o.unitPriceCents / 100)}</td>
        <td class="row"><input type="date" value="${esc(o.freeUntil ?? '')}" data-comp="${esc(o.operatorId)}" style="width:auto"><button class="sm" data-save="${esc(o.operatorId)}">Save</button></td></tr>`).join('')}
    </table></div>
    <p class="small muted">Plan: ${usd(r.settings.priceCents / 100)} per paired screen per month, ${r.settings.trialDays}-day trial, ${r.settings.freeScreens} free screens. Change it in Platform settings.</p>`);
  for (const b of $$('[data-save]')) b.onclick = act(async () => {
    await PUT(`/api/admin/operators/${b.dataset.save}/billing`, { freeUntil: $(`[data-comp="${b.dataset.save}"]`).value || null });
    toast('Saved');
    adminBillingView();
  });
}

// ---------- payouts and audit ----------
async function payoutsView(admin = false) {
  const rows = await GET('/api/payouts');
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  main(`
    <h1>Payouts</h1>
    ${admin ? `<div class="card"><h2>Run payouts</h2>
      <form id="run" class="row"><label style="margin:0">Pay earnings through</label><input type="date" name="periodEnd" value="${yesterday}" max="${yesterday}" style="width:auto">
        <button class="primary" type="submit">Run payouts</button><button type="button" id="retry">Retry failed / waiting</button></form>
      <p class="small muted">Transfers each operator's and venue's share of card-paid campaigns via Stripe Connect. Amounts under $1.00 and sub-cent remainders carry forward. Re-running never pays a play twice.</p></div>`
      : '<div class="card small muted">Payouts cover campaigns paid by card. For campaigns you invoice yourself, you collect the money and pay your venues directly; see Reports for amounts owed.</div>'}
    <div class="card table-wrap">${payoutsTable(rows)}</div>`);
  if (admin) {
    $('#run').onsubmit = act(async (e) => {
      const r = await POST('/api/admin/payouts/run', formData(e.target));
      toast(`Created ${r.created} payouts: ${r.paid} paid, ${r.awaiting_account} awaiting bank details, ${r.failed} failed`);
      payoutsView(true);
    });
    $('#retry').onclick = act(async () => { const r = await POST('/api/admin/payouts/retry'); toast(`${r.paid} paid, ${r.failed} failed`); payoutsView(true); });
  }
}

async function auditView() {
  const rows = await GET('/api/audit');
  main(`
    <h1>Audit log</h1>
    <div class="card table-wrap">${rows.length ? `<table><tr><th>When</th><th>Who</th><th>Action</th><th>Result</th></tr>
      ${rows.map((a) => `<tr><td class="small">${new Date(a.at).toLocaleString()}</td><td>${esc(a.email ?? a.userId)}</td>
        <td><code class="copy">${esc(a.method)} ${esc(a.path)}</code></td><td>${a.status < 400 ? badge('ok') : `<span class="badge bad">${a.status}</span>`}</td></tr>`).join('')}</table>`
      : '<div class="empty">No changes recorded yet.</div>'}</div>`);
}

// ---------- router ----------
const ROUTES = [
  [/^#\/dashboard$/, () => dashboardView()],
  [/^#\/venues$/, () => venuesView()],
  [/^#\/venues\/([^/]+)\/menu/, (id) => menuView(id)],
  [/^#\/venues\/([^/]+)$/, (id) => venueView(id)],
  [/^#\/screens$/, () => screensView()],
  [/^#\/campaigns$/, () => campaignsView()],
  [/^#\/campaigns\/new$/, () => campaignNewView()],
  [/^#\/campaigns\/([^/?]+)/, (id) => campaignView(id)],
  [/^#\/advertisers$/, () => advertisersView()],
  [/^#\/reports$/, () => reportsView()],
  [/^#\/settings/, () => settingsView()],
  [/^#\/admin\/billing$/, () => adminBillingView()],
  [/^#\/admin\/network-quality$/, () => adminNetworkQualityView()],
  [/^#\/admin\/programmatic$/, () => adminProgrammaticView()],
  [/^#\/payouts$/, () => payoutsView()],
  [/^#\/audit$/, () => auditView()],
  [/^#\/admin\/payouts$/, () => payoutsView(true)],
  [/^#\/admin\/audit$/, () => auditView()],
  [/^#\/admin\/operators$/, () => adminOperatorsView()],
  [/^#\/admin\/network$/, () => campaignsView(true)],
  [/^#\/admin\/network\/new$/, () => campaignNewView(true)],
  [/^#\/admin\/settings$/, () => adminSettingsView()],
  [/^#\/admin\/reports$/, () => adminReportsView()],
];

async function route() {
  const hash = location.hash || '#/';
  const signup = hash.match(/^#\/signup\/([^/?]+)/);
  if (signup) return signupView(decodeURIComponent(signup[1]));
  if (!S.token) return loginView();
  try {
    if (!S.me) { await loadMe(); renderShell(); }
    if (!$('#main')) renderShell();
  } catch (e) {
    return; // logout() already redirected
  }
  if (hash === '#/' || hash === '#/login') { location.hash = homeRoute(); return; }
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      highlightNav();
      main('<div class="empty">Loading…</div>');
      try { await fn(...m.slice(1).map(decodeURIComponent)); } catch (e) { main(`<div class="card empty">${esc(e.message)}</div>`); }
      return;
    }
  }
  main('<div class="card empty">Page not found.</div>');
}

window.addEventListener('hashchange', route);
route();
