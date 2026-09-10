/* Shared utilities: mobile nav, toast, cart, and a localStorage-backed
   grower registry with an event log (registration, spawn/media issued,
   buyback, deposit return) that QR check-ins write into. In production
   this layer gets swapped for calls to a Cloudflare Worker + D1 API —
   function names are written to make that swap a drop-in. */

// ---------- Mobile nav ----------
function initNav() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
  }
}

// ---------- Toast ----------
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Data layer (localStorage demo store) ----------
const STORE_KEY = 'ml_growers_v2';
const CART_KEY = 'ml_cart_v1';
const QR_PREFIX = 'GROWBACK-GROWER:';

function getGrowers() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function saveGrowers(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}
function addGrower(record) {
  const list = getGrowers();
  record.id = 'GR-' + (1000 + list.length + 1);
  record.createdAt = new Date().toISOString();
  record.depositReturned = false;
  record.events = [{ type: 'registered', date: record.createdAt }];
  list.push(record);
  saveGrowers(list);
  return record;
}
function findGrower(id) {
  return getGrowers().find(g => g.id === (id || '').trim().toUpperCase());
}

// Generic event log — every QR check-in and manual dashboard action goes
// through this, so the community growth stats always reflect real activity.
function makeEventId() {
  return 'EV-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
function logEvent(id, type, meta) {
  const list = getGrowers();
  const g = list.find(x => x.id === id);
  if (!g) return null;
  const event = Object.assign({ id: makeEventId(), type, date: new Date().toISOString() }, meta || {});
  g.events.push(event);
  if (type === 'deposit_returned') g.depositReturned = true;
  saveGrowers(list);
  queuePendingSync({ growerId: id, eventId: event.id, type });
  return g;
}
function logBuyback(id, kg, notes) {
  return logEvent(id, 'buyback', { kg: Number(kg), notes: notes || '', paid: false });
}
function markBuybackPaid(growerId, eventId, method) {
  const list = getGrowers();
  const g = list.find(x => x.id === growerId);
  if (!g) return null;
  const ev = g.events.find(e => e.id === eventId);
  if (ev) { ev.paid = true; ev.paymentMethod = method || 'Cash'; }
  saveGrowers(list);
  return g;
}
function nextUnitId(prefix) {
  const key = 'ml_unit_counter_' + prefix;
  const n = Number(localStorage.getItem(key) || '1000') + 1;
  localStorage.setItem(key, String(n));
  return prefix + '-' + n;
}
function logIssuance(id, kind) {
  // kind: 'spawn' or 'media' — every unit issued gets its own traceable ID
  const unitId = kind === 'spawn' ? nextUnitId('SPN') : nextUnitId('MED');
  const type = kind === 'spawn' ? 'spawn_issued' : 'media_issued';
  logEvent(id, type, { unitId: unitId });
  return unitId;
}
function logIssue(id, description) {
  return logEvent(id, 'issue_reported', { description: description, status: 'open' });
}
function resolveIssue(growerId, eventId) {
  const list = getGrowers();
  const g = list.find(x => x.id === growerId);
  if (!g) return null;
  const ev = g.events.find(e => e.id === eventId);
  if (ev) ev.status = 'resolved';
  saveGrowers(list);
  return g;
}
function getBuybacks(g) {
  return g.events.filter(e => e.type === 'buyback');
}
function totalKgFor(g) {
  return getBuybacks(g).reduce((s, b) => s + (b.kg || 0), 0);
}

// ---------- QR helpers ----------
function qrPayload(id) { return QR_PREFIX + id; }
function idFromQrPayload(text) {
  if (!text) return null;
  const t = text.trim();
  return t.startsWith(QR_PREFIX) ? t.slice(QR_PREFIX.length) : null;
}
// Renders a QR code into the given element using the QRCode library
// (loaded via CDN on pages that need it). Safe no-op if library absent.
function renderQr(elementId, id) {
  const el = document.getElementById(elementId);
  if (!el || typeof QRCode === 'undefined') return;
  el.innerHTML = '';
  new QRCode(el, {
    text: qrPayload(id),
    width: 148,
    height: 148,
    colorDark: '#241D15',
    colorLight: '#FBF7EC',
  });
}

// ---------- Community growth stats ----------
function getCommunityStats() {
  const growers = getGrowers();
  const tierA = growers.filter(g => g.tier === 'A').length;
  const tierB = growers.filter(g => g.tier === 'B').length;
  const totalKg = growers.reduce((s, g) => s + totalKgFor(g), 0);
  const depositsHeld = growers.filter(g => g.tier === 'B' && !g.depositReturned).length;
  const openIssues = growers.reduce((s, g) => s + g.events.filter(e => e.type === 'issue_reported' && e.status === 'open').length, 0);
  const spawnUnitsIssued = growers.reduce((s, g) => s + g.events.filter(e => e.type === 'spawn_issued').length, 0);
  return { totalGrowers: growers.length, tierA: tierA, tierB: tierB, totalKg: totalKg, depositsHeld: depositsHeld, openIssues: openIssues, spawnUnitsIssued: spawnUnitsIssued };
}

// ---------- Pending sync queue ----------
// Every logged event is queued here too. There's no live backend yet
// (this whole demo runs on localStorage), so nothing actually syncs —
// this is scaffolding so a real API integration later has a queue to
// drain instead of needing one built from scratch.
const SYNC_QUEUE_KEY = 'ml_pending_sync_v1';
function queuePendingSync(entry) {
  const q = JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]');
  q.push(Object.assign({ queuedAt: new Date().toISOString() }, entry));
  localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(q));
}
function getPendingSyncCount() {
  return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]').length;
}

// ---------- Admin helpers ----------
function getAllOpenIssues() {
  const out = [];
  getGrowers().forEach(g => {
    g.events.filter(e => e.type === 'issue_reported' && e.status === 'open')
      .forEach(e => out.push(Object.assign({ growerId: g.id, growerName: g.name }, e)));
  });
  return out.sort((a, b) => new Date(b.date) - new Date(a.date));
}
function getAllUnpaidBuybacks() {
  const out = [];
  getGrowers().forEach(g => {
    g.events.filter(e => e.type === 'buyback' && !e.paid)
      .forEach(e => out.push(Object.assign({ growerId: g.id, growerName: g.name }, e)));
  });
  return out.sort((a, b) => new Date(b.date) - new Date(a.date));
}
function lastActivityFor(g) {
  if (!g.events.length) return null;
  return g.events.reduce((latest, e) => new Date(e.date) > new Date(latest.date) ? e : latest, g.events[0]).date;
}
function exportGrowersCSV() {
  const rows = [['Grower ID', 'Name', 'Phone', 'District', 'Address', 'Tier', 'Media', 'Deposit Returned', 'Total Kg', 'Open Issues', 'Last Activity']];
  getGrowers().forEach(g => {
    const openIssues = g.events.filter(e => e.type === 'issue_reported' && e.status === 'open').length;
    const last = lastActivityFor(g);
    rows.push([g.id, g.name, g.phone, g.district || '', g.address, g.tier, g.mediaType || '', g.depositReturned ? 'Yes' : 'No', totalKgFor(g), openIssues, last ? new Date(last).toLocaleDateString() : '']);
  });
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}
function downloadCSV(filename, csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Cart ----------
function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
  catch { return []; }
}
function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartCount();
}
function addToCart(item) {
  const cart = getCart();
  const existing = cart.find(c => c.sku === item.sku);
  if (existing) existing.qty += item.qty;
  else cart.push(item);
  saveCart(cart);
  showToast(item.name + ' added to cart');
}
function removeFromCart(sku) {
  saveCart(getCart().filter(c => c.sku !== sku));
  renderCart();
}
function cartTotal() {
  return getCart().reduce((sum, c) => sum + c.qty * c.price, 0);
}
function updateCartCount() {
  const el = document.querySelector('#cartCount');
  if (el) {
    const n = getCart().reduce((s, c) => s + c.qty, 0);
    el.textContent = n;
    el.style.display = n > 0 ? 'inline-flex' : 'none';
  }
}
function renderCart() {
  const list = document.querySelector('#cartItems');
  const totalEl = document.querySelector('#cartTotal');
  if (!list) return;
  const cart = getCart();
  list.innerHTML = cart.length
    ? cart.map(c => `
        <div class="cart-item">
          <span>${c.name} × ${c.qty}</span>
          <span>Rs ${(c.qty * c.price).toLocaleString()}
            <a href="#" data-sku="${c.sku}" class="cart-remove" style="margin-left:8px;color:var(--rust);">remove</a>
          </span>
        </div>`).join('')
    : '<p style="color:var(--ink-soft);font-size:0.92rem;">Your cart is empty.</p>';
  if (totalEl) totalEl.textContent = 'Rs ' + cartTotal().toLocaleString();
  list.querySelectorAll('.cart-remove').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); removeFromCart(a.dataset.sku); });
  });
}
function toggleCart(open) {
  const drawer = document.querySelector('.cart-drawer');
  const overlay = document.querySelector('.cart-overlay');
  if (!drawer) return;
  const willOpen = (typeof open === 'boolean') ? open : !drawer.classList.contains('open');
  drawer.classList.toggle('open', willOpen);
  overlay.classList.toggle('open', willOpen);
  if (willOpen) renderCart();
}

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  updateCartCount();
  const fab = document.querySelector('.cart-fab');
  if (fab) fab.addEventListener('click', () => toggleCart(true));
  const overlay = document.querySelector('.cart-overlay');
  if (overlay) overlay.addEventListener('click', () => toggleCart(false));
  const closeBtn = document.querySelector('.cart-close');
  if (closeBtn) closeBtn.addEventListener('click', () => toggleCart(false));
});
