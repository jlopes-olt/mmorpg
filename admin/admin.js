'use strict';

/* ============================================================
 * admin.js — backoffice FERALIA Online (page /admin autonome).
 * Vanille JS, sans dépendance : parle en HTTP à /admin/api/*,
 * authentifié par jeton (Authorization: Bearer <token>).
 * ============================================================ */

const TOKEN_KEY = 'feralia_admin_token';
let token = localStorage.getItem(TOKEN_KEY) || '';
let players = [];
let stats = null;
let selectedUsername = null;
let refreshTimer = null;

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(text, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2400);
  setTimeout(() => el.remove(), 2900);
}

async function api(method, path, body) {
  const res = await fetch('/admin/api' + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch (e) { data = { ok: false, error: 'Réponse invalide du serveur.' }; }
  if (res.status === 401 || res.status === 403) {
    if (path !== '/login') logout(false);
  }
  return data;
}

/* ---------- Connexion / session ---------- */

function showLogin(errorText) {
  $('dashboard').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
  const err = $('loginError');
  if (errorText) { err.textContent = errorText; err.classList.remove('hidden'); }
  else { err.classList.add('hidden'); }
}

function showDashboard() {
  $('loginScreen').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
}

function logout(callApi) {
  if (callApi !== false) api('POST', '/logout');
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  closePlayerPanel();
  showLogin();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;
  const r = await api('POST', '/login', { username, password });
  if (!r.ok) { showLogin(r.error || 'Connexion refusée.'); return; }
  token = r.token;
  localStorage.setItem(TOKEN_KEY, token);
  $('whoami').textContent = 'Connecté en tant que ' + r.username;
  showDashboard();
  startSession();
});

$('logoutBtn').addEventListener('click', () => logout());
$('refreshBtn').addEventListener('click', () => loadAll());

function startSession() {
  loadAll();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadAll, 15000);
}

/* ---------- Chargement des données ---------- */

async function loadAll() {
  const [statsRes, playersRes] = await Promise.all([api('GET', '/stats'), api('GET', '/players')]);
  if (!statsRes.ok || !playersRes.ok) return;
  stats = statsRes.stats;
  players = playersRes.list;
  renderStats();
  renderTable();
  if (selectedUsername) {
    // Le rafraîchissement périodique ne doit pas écraser un formulaire en
    // cours de remplissage (sélecteurs, quantité) — on ne re-rend le
    // panneau que si l'admin n'a pas le focus dedans à cet instant.
    const panelBody = $('playerPanelBody');
    const active = document.activeElement;
    const isEditing = panelBody && active && panelBody.contains(active) &&
      (active.tagName === 'SELECT' || active.tagName === 'INPUT');
    if (!isEditing) renderPlayerPanel(players.find((p) => p.username === selectedUsername));
  }
}

function renderStats() {
  const classChips = Object.entries(stats.byClass || {})
    .map(([k, n]) => '<span class="chip">' + esc(((CLASSES[k] && CLASSES[k].label) || k)) + ' ×' + n + '</span>')
    .join('');
  $('statsBar').innerHTML =
    '<div class="stat-tile"><b>' + stats.total + '</b><span>Comptes inscrits</span></div>' +
    '<div class="stat-tile"><b>' + stats.online + '</b><span>Connectés</span></div>' +
    '<div class="stat-tile"><b>' + stats.admins + '</b><span>Administrateur' + (stats.admins > 1 ? 's' : '') + '</span></div>' +
    '<div class="stat-tile classes"><span>Répartition par classe</span><div class="chips">' + (classChips || '<span class="chip">—</span>') + '</div></div>';
}

function renderTable() {
  const q = $('searchInput').value.trim().toLowerCase();
  const list = q ? players.filter((p) => p.username.toLowerCase().includes(q)) : players;
  $('resultCount').textContent = list.length + ' / ' + players.length + ' compte(s)';
  $('playersBody').innerHTML = list.map((p) => (
    '<tr class="' + (p.role === 'admin' ? 'admin-row' : '') + '" data-username="' + esc(p.username) + '">' +
      '<td><span class="status-dot ' + (p.online ? 'on' : '') + '" title="' + (p.online ? 'En ligne' : 'Hors ligne') + '"></span></td>' +
      '<td class="name-cell">' + esc(p.username) + (p.role === 'admin' ? ' <span class="role-tag">Admin</span>' : '') + '</td>' +
      '<td>' + (p.role === 'admin' ? 'Admin' : 'Joueur') + '</td>' +
      '<td>' + esc(p.classLabel || '') + '</td>' +
      '<td>T' + p.harvestLevel + '</td>' +
      '<td>T' + p.weaponMastery + '</td>' +
      '<td>T' + p.weaponTier + '</td>' +
      '<td>T' + p.armorTier + '</td>' +
      '<td>' + (p.gold || 0).toLocaleString('fr-FR') + '</td>' +
      '<td>' + (p.premium || 0).toLocaleString('fr-FR') + '</td>' +
      '<td>' + p.charCount + ' / ' + p.charSlots + '</td>' +
      '<td>' + (p.createdAt ? new Date(p.createdAt).toLocaleDateString('fr-FR') : '?') + '</td>' +
    '</tr>'
  )).join('') || '';
  if (!list.length) {
    $('playersBody').innerHTML = '<tr><td colspan="12" class="empty-state">Aucun compte ne correspond.</td></tr>';
  }
  $('playersBody').querySelectorAll('tr[data-username]').forEach((tr) => {
    tr.addEventListener('click', () => openPlayerPanel(tr.dataset.username));
  });
}

$('searchInput').addEventListener('input', renderTable);

/* ---------- Panneau latéral : détail + actions ---------- */

function accessoryOptions() {
  return Object.values(ACCESSORY_ITEMS)
    .map((item) => '<option value="accessory:' + item.id + '">' + item.label + '</option>').join('');
}

function mountOptions() {
  return Object.values(MOUNT_ITEMS)
    .map((item) => '<option value="mount:' + item.id + '">' + item.label + '</option>').join('');
}

function grantFormHtml() {
  const resourceOptions = Object.keys(RESOURCES)
    .map((t) => '<option value="item:' + t + '">' + RESOURCES[t].label + '</option>').join('');
  const consumableOptions = Object.keys(CONSUMABLES)
    .map((t) => '<option value="item:' + t + '">' + CONSUMABLES[t].label + '</option>').join('');
  const tierOptions = [0, 1, 2, 3, 4, 5, 6]
    .map((t) => '<option value="' + t + '"' + (t === 1 ? ' selected' : '') + '>T' + t + '</option>').join('');
  return (
    '<form class="grant-form" id="grantForm">' +
      '<div class="grant-form-row">' +
        '<select id="grantWhat">' +
          '<optgroup label="Compte">' +
            '<option value="gold">Or</option>' +
            '<option value="premium">' + PREMIUM_CURRENCY.label + '</option>' +
          '</optgroup>' +
          '<optgroup label="Progression">' +
            '<option value="level:harvest">Niveau de récolte</option>' +
            '<option value="level:weapon">Maîtrise d’arme</option>' +
            '<option value="gear:weapon">Tier d’arme</option>' +
            '<option value="gear:armor">Tier d’armure</option>' +
          '</optgroup>' +
          '<optgroup label="Ressources">' + resourceOptions + '</optgroup>' +
          '<optgroup label="Consommables">' + consumableOptions + '</optgroup>' +
          '<optgroup label="Accessoires cosmétiques (rares)">' + accessoryOptions() + '</optgroup>' +
          '<optgroup label="Montures (rares)">' + mountOptions() + '</optgroup>' +
        '</select>' +
        '<select id="grantTier">' + tierOptions + '</select>' +
        '<input id="grantQty" type="number" min="1" max="999" value="1">' +
      '</div>' +
      '<button type="submit" class="btn primary wide">Attribuer</button>' +
    '</form>'
  );
}

function openPlayerPanel(username) {
  selectedUsername = username;
  $('panelOverlay').classList.remove('hidden');
  $('playerPanel').classList.remove('hidden');
  renderPlayerPanel(players.find((p) => p.username === username));
}

function closePlayerPanel() {
  selectedUsername = null;
  $('panelOverlay').classList.add('hidden');
  $('playerPanel').classList.add('hidden');
}

$('playerPanelClose').addEventListener('click', closePlayerPanel);
$('panelOverlay').addEventListener('click', closePlayerPanel);

function renderPlayerPanel(p) {
  if (!p) { closePlayerPanel(); return; }
  const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleString('fr-FR') : '?';
  $('playerPanelBody').innerHTML =
    '<div class="panel-head">' +
      '<h2>' + esc(p.username) + (p.role === 'admin' ? ' <span class="role-tag">Admin</span>' : '') + '</h2>' +
      '<p class="dim"><span class="status-dot ' + (p.online ? 'on' : '') + '"></span> ' + (p.online ? 'En ligne' : 'Hors ligne') + ' · Inscrit le ' + dateStr + '</p>' +
    '</div>' +

    '<div class="panel-section">' +
      '<div class="panel-section-title">Progression</div>' +
      '<div class="meta-grid">' +
        '<div><span>Classe</span> <b>' + esc(p.classLabel || '') + '</b></div>' +
        '<div><span>Personnages</span> <b>' + p.charCount + ' / ' + p.charSlots + '</b> (max ' + MAX_CHAR_SLOTS + ')</div>' +
        '<div><span>Niveau récolte</span> <b>T' + p.harvestLevel + '</b></div>' +
        '<div><span>Maîtrise d’arme</span> <b>T' + p.weaponMastery + '</b></div>' +
        '<div><span>Tier arme</span> <b>T' + p.weaponTier + '</b></div>' +
        '<div><span>Tier armure</span> <b>T' + p.armorTier + '</b></div>' +
        '<div><span>Or</span> <b>' + (p.gold || 0).toLocaleString('fr-FR') + '</b></div>' +
        '<div><span>' + esc(PREMIUM_CURRENCY.label) + '</span> <b>' + (p.premium || 0).toLocaleString('fr-FR') + '</b></div>' +
        '<div><span>Accessoire</span> <b>' + esc((ACCESSORY_ITEMS[p.accessoryId] || {}).label || '—') + '</b></div>' +
        '<div><span>Monture</span> <b>' + esc((MOUNT_ITEMS[p.mountId] || {}).label || '—') + '</b></div>' +
      '</div>' +
    '</div>' +

    '<div class="panel-section">' +
      '<div class="panel-section-title">Rôle et emplacements</div>' +
      '<div class="panel-row-actions">' +
        '<button class="btn" id="roleToggleBtn">' + (p.role === 'admin' ? 'Rétrograder utilisateur' : 'Promouvoir admin') + '</button>' +
        '<button class="btn" id="grantSlotBtn"' + (p.charSlots >= MAX_CHAR_SLOTS ? ' disabled' : '') + '>+1 emplacement perso</button>' +
      '</div>' +
    '</div>' +

    '<div class="panel-section">' +
      '<div class="panel-section-title">Attribuer</div>' +
      grantFormHtml() +
    '</div>';

  $('roleToggleBtn').addEventListener('click', async () => {
    const nextRole = p.role === 'admin' ? 'user' : 'admin';
    const r = await api('POST', '/players/' + encodeURIComponent(p.username) + '/role', { role: nextRole });
    toast(r.ok ? 'Rôle mis à jour.' : (r.error || 'Erreur.'), !r.ok);
    if (r.ok) loadAll();
  });
  $('grantSlotBtn').addEventListener('click', async () => {
    const r = await api('POST', '/players/' + encodeURIComponent(p.username) + '/slots', { count: 1 });
    toast(r.ok ? '+1 emplacement de personnage.' : (r.error || 'Erreur.'), !r.ok);
    if (r.ok) loadAll();
  });
  $('grantForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const what = $('grantWhat').value;
    const tier = Number($('grantTier').value);
    const qty = Math.max(1, Number($('grantQty').value) || 1);
    const u = encodeURIComponent(p.username);
    let r;
    if (what === 'gold') r = await api('POST', '/players/' + u + '/gold', { amount: qty });
    else if (what === 'premium') r = await api('POST', '/players/' + u + '/premium', { amount: qty });
    else if (what === 'level:harvest') r = await api('POST', '/players/' + u + '/level', { kind: 'harvest', tier });
    else if (what === 'level:weapon') r = await api('POST', '/players/' + u + '/level', { kind: 'weapon', tier });
    else if (what === 'gear:weapon') r = await api('POST', '/players/' + u + '/gear', { slot: 'weapon', tier });
    else if (what === 'gear:armor') r = await api('POST', '/players/' + u + '/gear', { slot: 'armor', tier });
    else if (what.indexOf('item:') === 0) r = await api('POST', '/players/' + u + '/item', { key: stackKey(what.slice(5), tier), qty });
    else if (what.indexOf('accessory:') === 0) r = await api('POST', '/players/' + u + '/accessory', { accessoryId: what.slice(10) });
    else if (what.indexOf('mount:') === 0) r = await api('POST', '/players/' + u + '/mount', { mountId: what.slice(6) });
    toast((r && r.ok) ? 'Attribution effectuée.' : ((r && r.error) || 'Erreur serveur.'), !(r && r.ok));
    if (r && r.ok) loadAll();
  });
}

/* ---------- Simulateur d'apparence (classe/skin/accessoire/monture) ----------
 * Réutilise le VRAI Renderer du jeu (render.js) pour un aperçu fidèle au
 * rendu en jeu, sans avoir à créer/modifier un compte réel pour vérifier
 * une combinaison. Le personnage prévisualisé est un objet local, jamais
 * envoyé au serveur — purement un aperçu côté client. */
let simRenderer = null;
let simSettleTimer = null;

function refreshSimSkinOptions() {
  const cls = $('simClass').value;
  const skins = SKIN_SHOP_ITEMS.filter((s) => s.speciesClass === cls);
  $('simSkin').innerHTML = '<option value="">Tenue de base</option>' +
    skins.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>').join('');
}

function populateSimSelectors() {
  $('simClass').innerHTML = Object.entries(CLASSES)
    .map(([id, c]) => '<option value="' + id + '">' + esc(c.label) + '</option>').join('');
  $('simAccessory').innerHTML = '<option value="">Aucun</option>' +
    Object.values(ACCESSORY_ITEMS).map((a) => '<option value="' + esc(a.id) + '">' + esc(a.label) + '</option>').join('');
  $('simMount').innerHTML = '<option value="">À pied</option>' +
    Object.values(MOUNT_ITEMS).map((m) => '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>').join('');
  refreshSimSkinOptions();
}

function simFakePlayer() {
  return {
    id: 'sim-preview', username: 'Aperçu', bot: false, mapId: 'world', status: 'IDLE',
    pos: { x: 0, y: 0 },
    speciesClass: $('simClass').value,
    skinId: $('simSkin').value || null,
    accessoryId: $('simAccessory').value || null,
    mountId: $('simMount').value || null,
    activeTitle: null, guildName: null,
  };
}

function drawSimPreview() {
  if (!simRenderer) return;
  simRenderer.resize();
  const ctx = simRenderer.ctx, w = simRenderer.w, h = simRenderer.h;
  ctx.clearRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#232833');
  grad.addColorStop(1, '#12151b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // pos (0,0) + caméra à l'origine (par défaut à la construction du Renderer)
  // => isoX/isoY(0,0) = 0, donc le personnage tombe pile au centre du canvas.
  simRenderer.drawPlayer(simFakePlayer(), $('simIsMe').checked, { x: 0, y: 0 }, 1);
}

// Les sprites (skin/accessoire/monture) se chargent de façon async — pas
// d'évènement global "tout est prêt", donc on redessine en rafale pendant
// ~3 s après chaque changement pour capter leur arrivée sans crayon fantôme.
function scheduleSimRedraws() {
  drawSimPreview();
  if (simSettleTimer) clearInterval(simSettleTimer);
  let ticks = 0;
  simSettleTimer = setInterval(() => {
    drawSimPreview();
    if (++ticks > 20) { clearInterval(simSettleTimer); simSettleTimer = null; }
  }, 150);
}

function openSimPanel() {
  $('simOverlay').classList.remove('hidden');
  $('simPanel').classList.remove('hidden');
  if (!simRenderer) {
    populateSimSelectors();
    // Construit APRÈS l'affichage du panneau : resize() lit clientWidth/Height,
    // qui valent 0 tant que le canvas est dans un ancêtre display:none.
    simRenderer = new Renderer($('simCanvas'), undefined, new Set());
    ['simClass', 'simSkin', 'simAccessory', 'simMount', 'simIsMe'].forEach((id) => {
      $(id).addEventListener('change', () => {
        if (id === 'simClass') refreshSimSkinOptions();
        scheduleSimRedraws();
      });
    });
  }
  scheduleSimRedraws();
}

function closeSimPanel() {
  $('simOverlay').classList.add('hidden');
  $('simPanel').classList.add('hidden');
  if (simSettleTimer) { clearInterval(simSettleTimer); simSettleTimer = null; }
}

$('openSimulatorBtn').addEventListener('click', openSimPanel);
$('simPanelClose').addEventListener('click', closeSimPanel);
$('simOverlay').addEventListener('click', closeSimPanel);

/* ---------- Démarrage ---------- */

if (token) {
  showDashboard();
  startSession();
} else {
  showLogin();
}
