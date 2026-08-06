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

// « En ligne » plutôt qu'une date : lastSeen vaut alors ~maintenant (mis à
// jour à chaque connexion/déconnexion, voir Game.adminPlayerList) et n'est
// donc pas informatif tant que le compte est connecté.
function formatLastSeen(p) {
  if (p.online) return 'En ligne';
  if (!p.lastSeen) return '?';
  return new Date(p.lastSeen).toLocaleString('fr-FR');
}

function renderTable() {
  const q = $('searchInput').value.trim().toLowerCase();
  const list = q ? players.filter((p) => p.username.toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q)) : players;
  $('resultCount').textContent = list.length + ' / ' + players.length + ' compte(s)';
  $('playersBody').innerHTML = list.map((p) => (
    '<tr class="' + (p.role === 'admin' ? 'admin-row' : '') + '" data-username="' + esc(p.username) + '">' +
      '<td><span class="status-dot ' + (p.online ? 'on' : '') + '" title="' + (p.online ? 'En ligne' : 'Hors ligne') + '"></span></td>' +
      '<td class="name-cell">' + esc(p.username) + (p.role === 'admin' ? ' <span class="role-tag">Admin</span>' : '') + '</td>' +
      '<td>' + esc(p.email || '—') + '</td>' +
      '<td>' + (p.role === 'admin' ? 'Admin' : 'Joueur') + '</td>' +
      '<td>' + esc(p.classLabel || '') + '</td>' +
      '<td>T' + p.harvestLevel + '</td>' +
      '<td>T' + p.weaponMastery + '</td>' +
      '<td>T' + p.weaponTier + '</td>' +
      '<td>T' + p.armorTier + '</td>' +
      '<td>' + (p.gold || 0).toLocaleString('fr-FR') + '</td>' +
      '<td>' + (p.premium || 0).toLocaleString('fr-FR') + '</td>' +
      '<td>' + (p.seals || 0).toLocaleString('fr-FR') + '</td>' +
      '<td>' + p.charCount + ' / ' + p.charSlots + '</td>' +
      '<td>' + (p.createdAt ? new Date(p.createdAt).toLocaleDateString('fr-FR') : '?') + '</td>' +
      '<td>' + esc(formatLastSeen(p)) + '</td>' +
    '</tr>'
  )).join('') || '';
  if (!list.length) {
    $('playersBody').innerHTML = '<tr><td colspan="15" class="empty-state">Aucun compte ne correspond.</td></tr>';
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

function diceOptions() {
  return DICE_SKIN_ITEMS
    .map((item) => '<option value="dice:' + item.id + '">' + item.label + '</option>').join('');
}

function artifactFragmentOptions() {
  return ARTIFACT_ORDER
    .map((id) => ARTIFACT_ITEMS[id])
    .map((item) => '<option value="artifactFragment:' + item.id + '">' + item.fragmentLabel + '</option>').join('');
}

function artifactOptions() {
  return ARTIFACT_ORDER
    .map((id) => ARTIFACT_ITEMS[id])
    .map((item) => '<option value="artifact:' + item.id + '">' + item.label + ' (complet)</option>').join('');
}

function trophyOptions() {
  return HOUSING_TROPHY_ITEMS
    .map((item) => '<option value="trophy:' + item.id + '">' + item.label + '</option>').join('');
}

/* Contrats de mercenaire : 6 classes x MERC_TIERS. Le tier vient de la liste
 * deroulante commune, comme pour une ressource. */
function mercContractOptions() {
  return Object.keys(MERC_CONTRACT_TYPES)
    .map((cls) => '<option value="item:' + MERC_CONTRACT_TYPES[cls] + '">' + esc(mercContractLabel(cls)) + '</option>')
    .join('');
}

function siegeEngineOptions() {
  return '<option value="item:' + SIEGE_ENGINE_ITEM + '">Engin de siege</option>';
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
            '<option value="seals">' + SEAL_CURRENCY.label + ' ' + SEAL_CURRENCY.icon + '</option>' +
          '</optgroup>' +
          '<optgroup label="Progression">' +
            '<option value="level:harvest">Niveau de récolte</option>' +
            '<option value="level:weapon">Maîtrise d’arme</option>' +
            '<option value="gear:weapon">Tier d’arme</option>' +
            '<option value="gear:armor">Tier d’armure</option>' +
          '</optgroup>' +
          '<optgroup label="Ressources">' + resourceOptions + '</optgroup>' +
          '<optgroup label="Consommables">' + consumableOptions + '</optgroup>' +
          '<optgroup label="Contrats de mercenaire">' + mercContractOptions() + '</optgroup>' +
          '<optgroup label="Engins de siège">' + siegeEngineOptions() + '</optgroup>' +
          '<optgroup label="Accessoires cosmétiques (rares)">' + accessoryOptions() + '</optgroup>' +
          '<optgroup label="Montures (rares)">' + mountOptions() + '</optgroup>' +
          '<optgroup label="Dés cosmétiques">' + diceOptions() + '</optgroup>' +
          '<optgroup label="Fragments d’artefact">' + artifactFragmentOptions() + '</optgroup>' +
          '<optgroup label="Artefacts (rares)">' + artifactOptions() + '</optgroup>' +
          '<optgroup label="TrophÃ©es de maison">' + trophyOptions() + '</optgroup>' +
        '</select>' +
        '<select id="grantTier">' + tierOptions + '</select>' +
        '<input id="grantQty" type="number" min="1" max="999" value="1">' +
      '</div>' +
      '<button type="submit" class="btn primary wide">Attribuer</button>' +
    '</form>'
  );
}

/* Mercenaires actifs, contrats en stock et avancement des contrats du jour :
 * sans cette vue, impossible de comprendre depuis le backoffice pourquoi un
 * joueur n'a pas la puissance attendue en raid, ni de vérifier qu'un contrat
 * progresse bien. */
function mercAndContractsSection(p) {
  const mercs = p.mercs || [];
  const contracts = p.mercContracts || [];
  const d = p.dailies;
  const mercLine = mercs.length
    ? mercs.map((m) => esc(((CLASSES[m.speciesClass] || {}).label) || m.speciesClass) +
        ' T' + m.tier + ' (' + m.combatsLeft + '/' + MERC_CONTRACT_COMBATS + ')').join(' · ')
    : '—';
  const stockLine = contracts.length
    ? contracts.map((c) => {
        const parsed = parseStackKey(c.key);
        const cls = MERC_CLASS_BY_CONTRACT_TYPE[parsed.type];
        return esc(((CLASSES[cls] || {}).label) || parsed.type) + ' T' + parsed.tier + ' ×' + c.qty;
      }).join(' · ')
    : '—';
  const dailyLine = d
    ? (d.done + ' / ' + d.total + ' contrat(s) du jour · hebdo ' + (d.weeklyDone ? 'rempli' : 'à faire') +
       ' · journée ' + esc(d.day || '?'))
    : '—';
  return (
    '<div class="panel-section">' +
      '<div class="panel-section-title">Mercenaires et contrats</div>' +
      '<div class="meta-grid">' +
        '<div><span>Lames actives (' + mercs.length + ' / ' + MERC_MAX_ACTIVE_PER_PLAYER + ')</span> <b>' + mercLine + '</b></div>' +
        '<div><span>Contrats en réserve</span> <b>' + stockLine + '</b></div>' +
        '<div><span>Tableau des contrats</span> <b>' + dailyLine + '</b></div>' +
      '</div>' +
    '</div>'
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
  // Pas de « Dernière connexion » si en ligne : lastSeen vaut alors ~maintenant
  // (voir formatLastSeen) et le statut « En ligne » juste avant le dit déjà.
  const lastSeenLine = p.online ? '' : (' · Dernière connexion : ' + esc(formatLastSeen(p)));
  $('playerPanelBody').innerHTML =
    '<div class="panel-head">' +
      '<h2>' + esc(p.username) + (p.role === 'admin' ? ' <span class="role-tag">Admin</span>' : '') + '</h2>' +
      '<p class="dim"><span class="status-dot ' + (p.online ? 'on' : '') + '"></span> ' + (p.online ? 'En ligne' : 'Hors ligne') + ' · Inscrit le ' + dateStr + lastSeenLine + '</p>' +
      '<p class="dim">' + esc(p.email || 'Email inconnu') + '</p>' +
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
        '<div><span>' + esc(SEAL_CURRENCY.label) + '</span> <b>' + (p.seals || 0).toLocaleString('fr-FR') + '</b></div>' +
        '<div><span>Accessoire</span> <b>' + esc((ACCESSORY_ITEMS[p.accessoryId] || {}).label || '—') + '</b></div>' +
        '<div><span>Monture</span> <b>' + esc((MOUNT_ITEMS[p.mountId] || {}).label || '—') + '</b></div>' +
        '<div><span>Dé</span> <b>' + esc((DICE_SKIN_BY_ID[p.diceId] || {}).label || 'Par défaut') + '</b></div>' +
        '<div><span>Artefact équipé</span> <b>' + esc((ARTIFACT_ITEMS[p.artifactId] || {}).label || '—') + '</b></div>' +
        '<div><span>Artefacts possédés</span> <b>' + ((p.ownedArtifacts || []).length) + ' / ' + ARTIFACT_ORDER.length + '</b></div>' +
        '<div><span>Maison</span> <b>' + (p.parcelId ? esc(p.parcelId) : '—') + '</b></div>' +
      '</div>' +
    '</div>' +

    mercAndContractsSection(p) +

    '<div class="panel-section">' +
      '<div class="panel-section-title">Rôle et emplacements</div>' +
      '<div class="panel-row-actions">' +
        '<button class="btn" id="roleToggleBtn">' + (p.role === 'admin' ? 'Rétrograder utilisateur' : 'Promouvoir admin') + '</button>' +
        '<button class="btn" id="grantSlotBtn"' + (p.charSlots >= MAX_CHAR_SLOTS ? ' disabled' : '') + '>+1 emplacement perso</button>' +
        '<button class="btn" id="resetHouseBtn"' + (p.parcelId ? '' : ' disabled') + '>Libérer la parcelle</button>' +
        '<button class="btn" id="rerollDailiesBtn" title="Retire immédiatement les contrats du jour et de la semaine">Retirer les contrats</button>' +
      '</div>' +
    '</div>' +

    '<div class="panel-section">' +
      '<div class="panel-section-title">Zone dangereuse</div>' +
      '<div class="panel-row-actions">' +
        '<button class="btn danger" id="deleteAccountBtn">Supprimer le compte</button>' +
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
  $('rerollDailiesBtn').addEventListener('click', async () => {
    const r = await api('POST', '/players/' + encodeURIComponent(p.username) + '/dailies/reroll');
    toast(r.ok ? 'Contrats retirés au sort.' : (r.error || 'Erreur.'), !r.ok);
    if (r.ok) loadAll();
  });
  const resetHouseBtn = $('resetHouseBtn');
  if (resetHouseBtn) {
    resetHouseBtn.addEventListener('click', async () => {
      if (!confirm('Libérer la parcelle de « ' + p.username + ' » ? Elle redeviendra disponible à l’achat (sans remboursement de l’or dépensé).')) return;
      const r = await api('POST', '/players/' + encodeURIComponent(p.username) + '/house/reset');
      toast(r.ok ? 'Parcelle libérée.' : (r.error || 'Erreur.'), !r.ok);
      if (r.ok) loadAll();
    });
  }
  $('deleteAccountBtn').addEventListener('click', async () => {
    if (!confirm('Supprimer définitivement le compte « ' + p.username + ' » ? Cette action est irréversible.')) return;
    const r = await api('POST', '/players/' + encodeURIComponent(p.username) + '/delete');
    toast(r.ok ? 'Compte « ' + p.username + ' » supprimé.' : (r.error || 'Erreur.'), !r.ok);
    if (r.ok) { closePlayerPanel(); loadAll(); }
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
    else if (what === 'seals') r = await api('POST', '/players/' + u + '/seals', { amount: qty });
    else if (what === 'level:harvest') r = await api('POST', '/players/' + u + '/level', { kind: 'harvest', tier });
    else if (what === 'level:weapon') r = await api('POST', '/players/' + u + '/level', { kind: 'weapon', tier });
    else if (what === 'gear:weapon') r = await api('POST', '/players/' + u + '/gear', { slot: 'weapon', tier });
    else if (what === 'gear:armor') r = await api('POST', '/players/' + u + '/gear', { slot: 'armor', tier });
    else if (what.indexOf('item:') === 0) r = await api('POST', '/players/' + u + '/item', { key: stackKey(what.slice(5), tier), qty });
    else if (what.indexOf('accessory:') === 0) r = await api('POST', '/players/' + u + '/accessory', { accessoryId: what.slice(10) });
    else if (what.indexOf('mount:') === 0) r = await api('POST', '/players/' + u + '/mount', { mountId: what.slice(6) });
    else if (what.indexOf('dice:') === 0) r = await api('POST', '/players/' + u + '/dice', { diceId: what.slice(5) });
    else if (what.indexOf('artifactFragment:') === 0) r = await api('POST', '/players/' + u + '/artifact-fragment', { artifactId: what.slice('artifactFragment:'.length), qty });
    else if (what.indexOf('artifact:') === 0) r = await api('POST', '/players/' + u + '/artifact', { artifactId: what.slice('artifact:'.length) });
    else if (what.indexOf('trophy:') === 0) r = await api('POST', '/players/' + u + '/item', { key: what.slice('trophy:'.length), qty });
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
  $('simDice').innerHTML = '<option value="">Dé par défaut</option>' +
    DICE_SKIN_ITEMS.map((d) => '<option value="' + esc(d.id) + '">' + esc(d.label) + '</option>').join('');
  refreshSimSkinOptions();
}

/* ---------- Aperçu du dé de combat ----------
 * Même rendu à deux calques que le jeu (aura fixe + sprite qui tourne, voir
 * js/ui.js playCombatClash) : cette page n'a jamais chargé js/ui.js (trop
 * couplé à l'écran de jeu pour être réutilisé tel quel), donc le détourage
 * magenta et la mini-animation sont dupliqués ici en version autonome. */
const diceSpriteCache = {};   // '' (dé par défaut) ou id -> sprite détouré (data URL)
const diceSpriteLoading = new Set();

function removeChromaToCanvas(image) {
  const c = document.createElement('canvas');
  c.width = image.naturalWidth;
  c.height = image.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const data = img.data;
  const KEY = 90;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], gg = data[i + 1], b = data[i + 2];
    const spill = Math.min(r, b) - gg;
    if (spill <= 0) continue;
    const amount = Math.min(1, spill / KEY);
    data[i + 3] = Math.round(data[i + 3] * (1 - amount));
    if (amount < 1) {
      data[i] = Math.round(r - (r - gg) * amount);
      data[i + 2] = Math.round(b - (b - gg) * amount);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function ensureDiceSpriteLoaded(diceId, onReady) {
  const key = diceId || '';
  if (diceSpriteCache[key]) { onReady(diceSpriteCache[key]); return; }
  if (diceSpriteLoading.has(key)) { setTimeout(() => ensureDiceSpriteLoaded(diceId, onReady), 150); return; }
  const src = diceId ? (DICE_SKIN_BY_ID[diceId] || {}).sprite : 'assets/dice_rune_base_magenta.png';
  if (!src) return;
  diceSpriteLoading.add(key);
  const img = new Image();
  img.onload = () => {
    diceSpriteCache[key] = removeChromaToCanvas(img).toDataURL('image/png');
    diceSpriteLoading.delete(key);
    onReady(diceSpriteCache[key]);
  };
  img.src = src;
}

let simDiceCloseTimer = null;
function playDicePreviewRoll(outcome) {
  const diceId = $('simDice').value || null;
  ensureDiceSpriteLoaded(diceId, (sprite) => {
    if (simDiceCloseTimer) { clearTimeout(simDiceCloseTimer); simDiceCloseTimer = null; }
    const wrap = $('simDicePreview');
    wrap.innerHTML =
      '<div class="combat-die spinning">' +
        '<div class="combat-die-face">' +
          '<img class="combat-die-fx" src="' + DICE_FX.idle + '" alt="">' +
          '<div class="combat-die-spin-layer">' +
            '<img class="combat-die-art" src="' + sprite + '" alt="">' +
            '<span class="combat-die-number">?</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    const dieEl = wrap.querySelector('.combat-die');
    const numberEl = wrap.querySelector('.combat-die-number');
    const fxEl = wrap.querySelector('.combat-die-fx');
    const roll = outcome === 'critSuccess' ? 100 : (outcome === 'critFail' ? 1 : (2 + Math.floor(Math.random() * 97)));
    const SPIN_MS = 1000;
    const spinStart = Date.now();
    const spinTimer = setInterval(() => {
      numberEl.textContent = String(1 + Math.floor(Math.random() * 100));
      if (Date.now() - spinStart >= SPIN_MS) {
        clearInterval(spinTimer);
        numberEl.textContent = String(roll);
        dieEl.classList.remove('spinning');
        dieEl.classList.add('settled');
        if (outcome === 'critSuccess') { dieEl.classList.add('crit-success'); fxEl.src = DICE_FX.critSuccess; }
        else if (outcome === 'critFail') { dieEl.classList.add('crit-fail'); fxEl.src = DICE_FX.critFail; }
      }
    }, 60);
    simDiceCloseTimer = setTimeout(() => { wrap.innerHTML = ''; }, SPIN_MS + 2500);
  });
}

$('simDiceNormal').addEventListener('click', () => playDicePreviewRoll('normal'));
$('simDiceCritSuccess').addEventListener('click', () => playDicePreviewRoll('critSuccess'));
$('simDiceCritFail').addEventListener('click', () => playDicePreviewRoll('critFail'));

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
  if (simDiceCloseTimer) { clearTimeout(simDiceCloseTimer); simDiceCloseTimer = null; }
  $('simDicePreview').innerHTML = '';
}

$('openSimulatorBtn').addEventListener('click', openSimPanel);
$('simPanelClose').addEventListener('click', closeSimPanel);
$('simOverlay').addEventListener('click', closeSimPanel);

/* ============================================================
 * Panneau d'équilibrage des contenus de groupe
 * ------------------------------------------------------------
 * Répond à une seule question : COMBIEN DE JOUEURS, à quel tier,
 * pour chaque contenu de groupe ?
 *
 * Tout est recalculé avec les VRAIES fonctions du jeu importées par
 * js/config.js (teamPowerOf, winChance, maxHp) et les forces de boss de
 * js/world.js (dungeonBossFor) — aucune valeur n'est recopiée en dur ici.
 * Toucher à l'équilibrage met donc cette page à jour toute seule, et les
 * « points d'attention » en bas (écarts entre l'intention documentée et le
 * résultat réel) se recalculent avec.
 *
 * Seule exception assumée : la formule de défense d'un château vit dans
 * server/game.js (castleDefenseForce), inaccessible côté navigateur — elle
 * est donc redite ici à partir des constantes partagées de config.js. Si
 * cette formule change côté serveur, mettre à jour balCastleDefense().
 * ============================================================ */

const BAL_MAX_GROUP = 12;          // effectif max affiché dans les matrices
const BAL_MAX_SEARCH = 20;         // effectif max exploré pour « joueurs requis »
const BAL_TIERS = [1, 2, 3, 4, 5, 6];

// Ordre de recrutement d'un groupe « équilibré » réaliste : un rôle de chaque
// d'abord (c'est ce qui maximise les bonus d'équipe, voir teamPowerOf), puis
// on boucle. Exclut les classes admin-only.
const BAL_ROLE_ORDER = [
  'OURS_GUERRIER', 'CERF_DRUIDE', 'LION_PALADIN',
  'CHAT_MAGICIEN', 'CORBEAU_NECROMANCIEN', 'RENARD_VOLEUR',
];

function balPlayableClasses() {
  return Object.keys(CLASSES).filter((c) => !CLASSES[c].adminOnly);
}

let balBuilt = false;

/* Un joueur fictif : arme/armure/maîtrise au même tier (la maîtrise T est de
 * toute façon exigée pour fabriquer une arme T, voir craftWeapon côté serveur,
 * donc « équipé T5 » implique « maîtrise 5 »). */
function balPlayer(speciesClass, tier, opts) {
  const p = {
    speciesClass,
    weapon: { tier },
    armor: { tier },
    weaponMastery: tier,
    artifactId: opts.artifactId || null,
    buff: opts.buffTier ? { type: 'RAGOUT', tier: opts.buffTier } : null,
    hp: 0,
  };
  p.hp = maxHp(p) * opts.hpPct;
  return p;
}

/* Toutes les combinaisons de classes AVEC répétition pour un effectif donné.
 * C(n+5, 5) : 56 à 3 joueurs, 252 à 5, 462 à 6 — réservé à l'affichage du
 * tableau « poids de la composition », qui reste sur de petits effectifs. */
function balCombos(pool, k) {
  const out = [];
  const cur = [];
  (function walk(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < pool.length; i++) { cur.push(pool[i]); walk(i); cur.pop(); }
  })(0);
  return out;
}

/* Composition la plus / la moins puissante pour un effectif donné, EXACTE et
 * en temps constant quel que soit l'effectif (l'énumération naïve exploserait :
 * 8008 combinaisons à 12 joueurs, et « joueurs requis » balaie jusqu'à 20).
 *
 * L'astuce : teamPowerOf ne dépend que (a) de la somme des puissances
 * individuelles et (b) de l'ENSEMBLE des classes présentes (les bonus de rôle
 * ne comptent pas les doublons ; la Nuée du Corbeau varie avec l'effectif, qui
 * est fixé ici). Pour un support donné S, la somme extrême s'obtient donc en
 * plaçant un exemplaire de chaque classe de S puis en remplissant les places
 * restantes avec la classe la plus (ou la moins) puissante de S. Il suffit de
 * balayer les 63 supports non vides. */
const balExtremeCache = new Map();
function balExtremeTeam(n, tier, opts, which) {
  const key = which + '|' + n + '|' + tier + '|' + (opts.artifactId || '-') + '|' + (opts.buffTier || 0) + '|' + opts.hpPct;
  const hit = balExtremeCache.get(key);
  if (hit) return hit;

  const pool = balPlayableClasses();
  let found = null;
  for (let mask = 1; mask < (1 << pool.length); mask++) {
    const support = pool.filter((_, i) => mask & (1 << i));
    if (support.length > n) continue;
    const byPower = support.slice().sort((a, b) =>
      combatPower(balPlayer(a, tier, opts)) - combatPower(balPlayer(b, tier, opts)));
    const filler = which === 'best' ? byPower[byPower.length - 1] : byPower[0];
    const combo = support.concat(new Array(n - support.length).fill(filler));
    const team = combo.map((c) => balPlayer(c, tier, opts));
    const power = teamPowerOf(team);
    if (!found || (which === 'best' ? power > found.power : power < found.power)) {
      found = { combo, team, power };
    }
  }
  balExtremeCache.set(key, found);
  return found;
}

function balTeam(n, tier, opts) {
  if (opts.comp === 'best' || opts.comp === 'worst') {
    const extreme = balExtremeTeam(n, tier, opts, opts.comp);
    if (extreme) return extreme.team;   // null seulement si n < 1
  }
  const team = [];
  for (let i = 0; i < n; i++) team.push(balPlayer(BAL_ROLE_ORDER[i % BAL_ROLE_ORDER.length], tier, opts));
  return team;
}

function balPower(n, tier, opts) { return teamPowerOf(balTeam(n, tier, opts)); }
function balChance(n, tier, opts, force) { return winChance(balPower(n, tier, opts), force); }

/* Effectif minimum pour atteindre `target` de chance de victoire. La sigmoïde
 * étant monotone en puissance et la puissance croissante avec l'effectif, un
 * simple balayage suffit. */
function balPlayersNeeded(tier, opts, force, target) {
  for (let n = 1; n <= BAL_MAX_SEARCH; n++) {
    if (balChance(n, tier, opts, force) >= target) return n;
  }
  return null;
}

/* La liste des contenus de groupe, dans l'ordre de progression. Les forces
 * viennent de MONSTER_FORCE (config.js), dungeonBossFor (world.js) et
 * WORLD_BOSS (config.js) — jamais recopiées. */
function balContents() {
  const rows = [];
  for (const t of [1, 2, 3, 4, 5]) {
    rows.push({
      group: 'Monde ouvert',
      label: MONSTERS[t].label + ' (T' + t + ')',
      force: MONSTER_FORCE[t],
    });
  }
  rows.push({
    group: 'Donjon',
    label: MONSTERS[6].label + ' — mob de donjon (T6)',
    force: MONSTER_FORCE[6],
    note: CONFIG.DUNGEON.BOSS_KILLS_REQUIRED + ' kills font apparaître le boss',
  });
  for (const terrain of CASTLE_TERRAINS) {
    const boss = dungeonBossFor(terrain);
    rows.push({
      group: 'Donjon',
      label: boss.label + ' — boss ' + (TERRAINS[terrain] ? TERRAINS[terrain].label.toLowerCase() : terrain),
      force: boss.force,
      boss: true,
    });
  }
  rows.push({
    group: 'Raid mondial',
    label: WORLD_BOSS.label,
    force: WORLD_BOSS.force,
    boss: true,
    note: 'respawn ' + Math.round(WORLD_BOSS.respawnMs / 3600000) + ' h',
  });
  return rows;
}

function balReadOpts() {
  return {
    comp: $('balComp').value,
    artifactId: $('balArtifact').value || null,
    buffTier: Number($('balBuff').value) || 0,
    hpPct: Number($('balHp').value),
  };
}

function balPct(x) { return Math.round(x * 100) + ' %'; }

function balCellClass(chance) {
  if (chance >= 0.9) return 'wc-max';
  if (chance >= 0.6) return 'wc-hi';
  if (chance >= 0.25) return 'wc-mid';
  return 'wc-lo';
}

/* ---------- Bloc « comment le combat est résolu » ---------- */

function balRenderModel() {
  const c = CONFIG.COMBAT;
  const cards = [
    ['Formule', 'sigmoïde(K × (puissance équipe ÷ force adverse − R₀))', 'Une seule et même formule pour un monstre, un boss de donjon, le boss mondial et un siège de château.'],
    ['Raideur K', String(c.K), 'Plus K est grand, plus le passage de « impossible » à « acquis » est brutal.'],
    ['Point de bascule R₀', String(c.R0), 'Ratio de puissance donnant 50 % de victoire. À ratio 1 (équipement au tier inférieur), on est déjà au-dessus.'],
    ['Bornes', balPct(c.MIN_CHANCE) + ' – ' + balPct(c.MAX_CHANCE), 'Il reste toujours au moins 1 chance sur 50 de chaque issue : aucun combat n’est jamais totalement acquis ni totalement perdu.'],
    ['Plancher de blessure', balPct(c.WOUND_FLOOR), 'Puissance résiduelle à 0 PV. Un groupe entamé tape nettement moins fort — c’est le facteur le plus violent après l’effectif.'],
    ['Bonus de rôle', 'Aura +' + balPct(c.ROLE_BONUS.PALADIN) + ' · Rempart +' + balPct(c.ROLE_BONUS.OURS) +
      ' · Sève +' + balPct(c.ROLE_BONUS.CERF) + ' · Nuée +' + balPct(c.ROLE_BONUS.CORBEAU_PER_MEMBER) + '/membre',
      'Multiplicatifs et cumulables entre classes DIFFÉRENTES, jamais avec eux-mêmes : deux Ours = un seul Rempart.'],
  ];
  $('balModel').innerHTML = cards.map(([t, v, d]) =>
    '<div class="bal-card"><span class="bal-card-title">' + esc(t) + '</span>' +
    '<b>' + esc(v) + '</b><span class="bal-card-desc">' + esc(d) + '</span></div>'
  ).join('');

  // Largeur de la bande de transition : de quel facteur la puissance doit-elle
  // grimper pour passer de 25 % à 90 % ? C'est LA propriété qui explique
  // pourquoi chaque contenu a un effectif seuil plutôt qu'une montée douce.
  const ratioAt = (p) => c.R0 + Math.log(p / (1 - p)) / c.K;
  const span = ratioAt(0.9) / ratioAt(0.25);
  $('balModelNote').innerHTML =
    'Conséquence pratique : il suffit d’un facteur <b>×' + span.toFixed(2) + '</b> sur la puissance de l’équipe pour passer de ' +
    '25 % à 90 % de victoire. Un joueur de plus vaut souvent davantage — <b>chaque contenu a donc un effectif seuil</b>, ' +
    'et à un joueur près on bascule d’« infaisable » à « acquis ». Il n’y a pas de zone de progression douce.';
}

/* ---------- Tableau principal : joueurs requis ---------- */

function balRenderRequired() {
  const opts = balReadOpts();
  const target = Number($('balTarget').value);
  const rows = balContents();

  let html = '<table class="bal-table"><thead><tr><th class="bal-sticky">Contenu</th><th>Force</th>';
  for (const t of BAL_TIERS) html += '<th>T' + t + '</th>';
  html += '</tr></thead><tbody>';

  let lastGroup = null;
  for (const row of rows) {
    if (row.group !== lastGroup) {
      html += '<tr class="bal-group-row"><td class="bal-sticky" colspan="' + (BAL_TIERS.length + 2) + '">' + esc(row.group) + '</td></tr>';
      lastGroup = row.group;
    }
    html += '<tr' + (row.boss ? ' class="bal-boss-row"' : '') + '>';
    html += '<td class="bal-sticky bal-name">' + esc(row.label) +
      (row.note ? '<span class="bal-subnote">' + esc(row.note) + '</span>' : '') + '</td>';
    html += '<td class="bal-force">' + row.force + '</td>';
    for (const t of BAL_TIERS) {
      const n = balPlayersNeeded(t, opts, row.force, target);
      if (n === null) html += '<td class="bal-need wc-lo">&gt;' + BAL_MAX_SEARCH + '</td>';
      else html += '<td class="bal-need ' + (n <= 1 ? 'wc-max' : n <= 3 ? 'wc-hi' : n <= 6 ? 'wc-mid' : 'wc-lo') + '">' + n + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '<p class="bal-note">Les colonnes sont le tier <b>équipé par le groupe</b>, pas celui du contenu. ' +
    'Côté contenu, le monde ouvert plafonne au tier ' +
    tierAtDistance(Math.hypot(CONFIG.WORLD.MAX, CONFIG.WORLD.MAX)) +
    ' (voir <code>tierAtDistance</code>) : <b>le T6 n’existe qu’en donjon et sur le boss mondial</b>, ' +
    'donc tout le contenu solo est borné par cette limite.</p>';
  $('balRequired').innerHTML = html;
}

/* ---------- Matrice détaillée ---------- */

function balRenderMatrix() {
  const opts = balReadOpts();
  const tier = Number($('balTier').value);
  const rows = balContents();

  let html = '<table class="bal-table"><thead><tr><th class="bal-sticky">Contenu</th><th>Force</th>';
  for (let n = 1; n <= BAL_MAX_GROUP; n++) html += '<th>' + n + '</th>';
  html += '</tr></thead><tbody>';

  html += '<tr class="bal-power-row"><td class="bal-sticky">Puissance de l’équipe</td><td class="bal-force">—</td>';
  for (let n = 1; n <= BAL_MAX_GROUP; n++) html += '<td>' + balPower(n, tier, opts) + '</td>';
  html += '</tr>';

  let lastGroup = null;
  for (const row of rows) {
    if (row.group !== lastGroup) {
      html += '<tr class="bal-group-row"><td class="bal-sticky" colspan="' + (BAL_MAX_GROUP + 2) + '">' + esc(row.group) + '</td></tr>';
      lastGroup = row.group;
    }
    html += '<tr' + (row.boss ? ' class="bal-boss-row"' : '') + '>';
    html += '<td class="bal-sticky bal-name">' + esc(row.label) + '</td>';
    html += '<td class="bal-force">' + row.force + '</td>';
    for (let n = 1; n <= BAL_MAX_GROUP; n++) {
      const ch = balChance(n, tier, opts, row.force);
      html += '<td class="' + balCellClass(ch) + '">' + Math.round(ch * 100) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '<p class="bal-note">Colonnes = nombre de participants. Valeurs en % de victoire. ' +
    'Le saut au 5ᵉ participant vient de la <b>Nuée</b> du Corbeau (+' + balPct(CONFIG.COMBAT.ROLE_BONUS.CORBEAU_PER_MEMBER) +
    ' de puissance <em>par participant</em>) : elle grossit avec le groupe, contrairement aux autres bonus de rôle.</p>';
  $('balMatrix').innerHTML = html;
}

/* ---------- Siège de château ----------
 * Miroir de castleDefenseForce() (server/game.js) : la formule vit côté
 * serveur, les constantes sont partagées via config.js. */
function balCastleDefense(level, fortLevel, hpPct) {
  const base = 300 + level * 150 + fortLevel * CASTLE_FORTIFY_BONUS_PER_LEVEL;
  const wound = CONFIG.COMBAT.WOUND_FLOOR + (1 - CONFIG.COMBAT.WOUND_FLOOR) * hpPct;
  return base * wound;
}

function balRenderCastle() {
  const opts = balReadOpts();
  const tier = Number($('balCastleTier').value);
  const hpPct = Number($('balCastleHp').value);
  const defCount = Number($('balDefenders').value);
  const defenderPower = defCount ? teamPowerOf(balTeam(defCount, tier, { comp: 'balanced', artifactId: opts.artifactId, buffTier: opts.buffTier, hpPct: 1 })) : 0;

  const forts = [0, Math.ceil(CASTLE_MAX_FORT_LEVEL / 2), CASTLE_MAX_FORT_LEVEL];
  let html = '<table class="bal-table"><thead><tr><th class="bal-sticky">Château</th><th>Défense</th>';
  for (let n = 1; n <= BAL_MAX_GROUP; n++) html += '<th>' + n + '</th>';
  html += '</tr></thead><tbody>';

  for (let level = 1; level <= CASTLE_MAX_LEVEL; level++) {
    for (const fort of forts) {
      const defense = balCastleDefense(level, fort, hpPct) + defenderPower;
      const isMax = level === CASTLE_MAX_LEVEL && fort === CASTLE_MAX_FORT_LEVEL;
      html += '<tr' + (isMax ? ' class="bal-boss-row"' : '') + '>';
      html += '<td class="bal-sticky bal-name">Niveau ' + level + ' · fortification ' + fort +
        (level === 1 && fort === 0 ? '<span class="bal-subnote">tout juste fondé</span>' : '') +
        (isMax ? '<span class="bal-subnote">maximum atteignable</span>' : '') + '</td>';
      html += '<td class="bal-force">' + Math.round(defense) + '</td>';
      for (let n = 1; n <= BAL_MAX_GROUP; n++) {
        const ch = winChance(balPower(n, tier, opts), defense);
        html += '<td class="' + balCellClass(ch) + '">' + Math.round(ch * 100) + '</td>';
      }
      html += '</tr>';
    }
  }
  html += '</tbody></table>';

  // Combien un défenseur coûte-t-il à l'attaquant, en attaquants supplémentaires ?
  const maxDefense = balCastleDefense(CASTLE_MAX_LEVEL, CASTLE_MAX_FORT_LEVEL, 1);
  const needAlone = balPlayersNeeded(tier, opts, maxDefense, 0.9);
  const needVsOne = balPlayersNeeded(tier, opts, maxDefense + teamPowerOf(balTeam(1, tier, Object.assign({}, opts, { hpPct: 1 }))), 0.9);
  const engineTiers = Object.keys(SIEGE_ENGINE_FORCE).map(Number).sort((a, b) => a - b);
  const bestEngine = engineTiers[engineTiers.length - 1];
  const soloPower = balPower(1, tier, opts);

  $('balSiegeNote').innerHTML =
    'Contre un château au maximum (défense ' + Math.round(maxDefense) + ', désert), il faut <b>' + (needAlone || '>' + BAL_MAX_SEARCH) +
    ' assaillants T' + tier + '</b> pour 90 % de victoire ; avec un seul défenseur présent, <b>' + (needVsOne || '>' + BAL_MAX_SEARCH) +
    '</b>. Un défenseur qui se rallie à temps coûte donc grossièrement <b>un attaquant de plus</b>. ' +
    'Un engin de siège T' + bestEngine + ' apporte ' + SIEGE_ENGINE_FORCE[bestEngine] + ' de force, soit <b>' +
    Math.round((SIEGE_ENGINE_FORCE[bestEngine] / soloPower) * 100) + ' % d’un joueur T' + tier +
    '</b> — son intérêt réel est ailleurs : les dégâts de structure sont garantis même sur un assaut perdu.';
  $('balCastle').innerHTML = html;
}

/* ---------- Poids de la composition ---------- */

function balRenderCompos() {
  const opts = balReadOpts();
  const scenarios = [
    { n: 3, tier: 6, force: dungeonBossFor('MONTAGNE').force, label: 'Boss de donjon le plus dur' },
    { n: 4, tier: 5, force: dungeonBossFor('MONTAGNE').force, label: 'Boss de donjon le plus dur' },
    { n: 5, tier: 6, force: WORLD_BOSS.force, label: WORLD_BOSS.label },
    { n: 6, tier: 6, force: WORLD_BOSS.force, label: WORLD_BOSS.label },
  ];

  let html = '<table class="bal-table"><thead><tr>' +
    '<th class="bal-sticky">Scénario</th><th>Meilleure compo</th><th>%</th>' +
    '<th>Pire compo</th><th>%</th><th>Écart</th><th>Compos ≥ 90 %</th></tr></thead><tbody>';

  const icons = (combo) => combo.map((c) => CLASSES[c].icon).join(' + ');

  for (const s of scenarios) {
    const pool = balPlayableClasses();
    const all = balCombos(pool, s.n).map((combo) => {
      const power = teamPowerOf(combo.map((c) => balPlayer(c, s.tier, opts)));
      return { combo, power, chance: winChance(power, s.force) };
    });
    all.sort((a, b) => b.power - a.power);
    const best = all[0];
    const worst = all[all.length - 1];
    const okCount = all.filter((r) => r.chance >= 0.9).length;
    html += '<tr>' +
      '<td class="bal-sticky bal-name">' + s.n + ' joueurs T' + s.tier +
        '<span class="bal-subnote">' + esc(s.label) + ' — force ' + s.force + '</span></td>' +
      '<td class="bal-compo">' + esc(icons(best.combo)) + '<span class="bal-subnote">puissance ' + best.power + '</span></td>' +
      '<td class="' + balCellClass(best.chance) + '">' + Math.round(best.chance * 100) + '</td>' +
      '<td class="bal-compo">' + esc(icons(worst.combo)) + '<span class="bal-subnote">puissance ' + worst.power + '</span></td>' +
      '<td class="' + balCellClass(worst.chance) + '">' + Math.round(worst.chance * 100) + '</td>' +
      '<td class="bal-force">' + Math.round((best.chance - worst.chance) * 100) + ' pts</td>' +
      '<td class="bal-force">' + okCount + ' / ' + all.length + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  html += '<p class="bal-note">Abréviations : ' +
    balPlayableClasses().map((c) => '<b>' + esc(CLASSES[c].icon) + '</b> ' + esc(CLASSES[c].label)).join(' · ') +
    '. Le design fonctionne : à effectif serré, la composition vaut plusieurs dizaines de points de pourcentage. ' +
    'Dès que l’effectif dépasse le seuil, l’écart s’écrase — la composition ne compte que sur le contenu tendu.</p>';
  $('balCompos').innerHTML = html;
}

/* ---------- Points d'attention ----------
 * Recalculés à chaque ouverture : ce sont des écarts entre l'intention écrite
 * dans les commentaires du code et ce que les constantes produisent
 * réellement aujourd'hui. Ils disparaissent d'eux-mêmes si l'équilibrage est
 * corrigé (ou si l'intention est réécrite). */
function balRenderWarnings() {
  const nu = { comp: 'balanced', artifactId: null, buffTier: 0, hpPct: 1 };
  const items = [];

  // 1. Boss de donjon — world.js annonce « ~92 % à cinq T5, ~57 % à quatre ».
  const hardBoss = dungeonBossFor('MONTAGNE');
  const t5x5 = balChance(5, 5, nu, hardBoss.force);
  const t5x4 = balChance(4, 5, nu, hardBoss.force);
  const t6x3 = balChance(3, 6, nu, hardBoss.force);
  items.push({
    level: Math.abs(t5x4 - 0.57) > 0.2 ? 'warn' : 'ok',
    title: 'Boss de donjon : plus faciles que documenté',
    body: 'Le commentaire de <code>dungeonBossFor</code> (js/world.js) annonce un calibrage « ~5 joueurs T5 : 92 %, ' +
      'à quatre : 57 % ». Aujourd’hui : <b>' + balPct(t5x5) + ' à cinq T5</b>, <b>' + balPct(t5x4) + ' à quatre T5</b>, ' +
      '<b>' + balPct(t6x3) + ' à trois T6</b>. Le contenu est plus accessible d’environ <b>un joueur entier</b> ' +
      'que ce que le commentaire décrit.',
  });

  // 2. Boss mondial — config.js le décrit comme un raid d'une dizaine de joueurs.
  const wbT6x5 = balChance(5, 6, nu, WORLD_BOSS.force);
  const needTen = balPlayersNeeded(6, nu, WORLD_BOSS.force, 0.9);
  // Force qu'il faudrait pour qu'il faille réellement ~10 joueurs T6 à 90 %.
  let forceForTen = WORLD_BOSS.force;
  for (let f = WORLD_BOSS.force; f <= 6000; f += 25) {
    if (balPlayersNeeded(6, nu, f, 0.9) >= 10) { forceForTen = f; break; }
  }
  items.push({
    level: needTen !== null && needTen < 8 ? 'warn' : 'ok',
    title: WORLD_BOSS.label + ' : dimensionné pour 5 joueurs, pas 10',
    body: 'Le commentaire de <code>WORLD_BOSS</code> (js/config.js) le décrit comme « pensé pour un raid coordonné ' +
      'd’une dizaine de joueurs ». En pratique <b>' + needTen + ' joueurs T6 suffisent</b> (' + balPct(wbT6x5) +
      ' à cinq). Pour qu’il en faille réellement dix, il faudrait porter sa force de <b>' + WORLD_BOSS.force +
      '</b> à <b>~' + forceForTen + '</b>.',
  });

  // 3. Écart entre boss de donjon : purement cosmétique ?
  const bossForces = CASTLE_TERRAINS.map((t) => dungeonBossFor(t).force);
  const minB = Math.min.apply(null, bossForces);
  const maxB = Math.max.apply(null, bossForces);
  const sameNeed = CASTLE_TERRAINS.every((t) =>
    balPlayersNeeded(6, nu, dungeonBossFor(t).force, 0.9) === balPlayersNeeded(6, nu, minB, 0.9));
  items.push({
    level: sameNeed ? 'info' : 'ok',
    title: 'Les quatre boss de donjon sont interchangeables',
    body: 'Leurs forces s’étalent de <b>' + minB + '</b> à <b>' + maxB + '</b> (soit ' +
      Math.round(((maxB / minB) - 1) * 100) + ' % d’écart), ce qui ' +
      (sameNeed ? '<b>ne change jamais l’effectif requis</b>' : 'change l’effectif requis') +
      '. La différenciation entre biomes est cosmétique — elle passe par le loot (artefacts, matériau exclusif), pas par la difficulté.',
  });

  // 4. Les PV comme deuxième levier après l'effectif.
  const wounded = { comp: 'balanced', artifactId: null, buffTier: 0, hpPct: 0.5 };
  const needFresh = balPlayersNeeded(6, nu, hardBoss.force, 0.9);
  const needHurt = balPlayersNeeded(6, wounded, hardBoss.force, 0.9);
  const hpCost = Math.max(0, needHurt - needFresh);
  items.push({
    level: 'info',
    title: 'Arriver au boss à mi-vie coûte ' + (hpCost === 0 ? 'zéro joueur' : hpCost + (hpCost > 1 ? ' joueurs' : ' joueur')),
    body: 'À PV pleins il faut <b>' + needFresh + '</b> joueurs T6 pour ' + esc(hardBoss.label) +
      ' ; à 50 % de PV, <b>' + needHurt + '</b>. Comme il faut enchaîner ' + CONFIG.DUNGEON.BOSS_KILLS_REQUIRED +
      ' mobs pour faire apparaître le boss, <b>l’usure du couloir est le vrai coût du donjon</b>, pas le boss lui-même.',
  });

  // 5. Rien n'est soloable au-delà du monde ouvert.
  const soloMob = balChance(1, 6, nu, MONSTER_FORCE[6]);
  items.push({
    level: 'info',
    title: 'Aucun contenu de donjon n’est soloable, même en T6 complet',
    body: 'Un joueur T6 seul n’a que <b>' + balPct(soloMob) + '</b> face à un simple mob de donjon. ' +
      'Le premier palier de groupe est donc à <b>2 joueurs</b> pour farmer le couloir, et à <b>' +
      balPlayersNeeded(6, nu, hardBoss.force, 0.7) + '</b> pour le boss — c’est le vrai plancher social du jeu.',
  });

  $('balWarnings').innerHTML = items.map((it) =>
    '<div class="bal-warn ' + it.level + '"><b>' + esc(it.title) + '</b><p>' + it.body + '</p></div>'
  ).join('');
}

function balRenderAll() {
  balRenderRequired();
  balRenderMatrix();
  balRenderCastle();
  balRenderCompos();
  balRenderWarnings();
}

function balBuildOnce() {
  if (balBuilt) return;
  balBuilt = true;

  const artifactSel = $('balArtifact');
  artifactSel.innerHTML = '<option value="">Aucun</option>' + ARTIFACT_ORDER.map((id) => {
    const a = ARTIFACT_ITEMS[id];
    return '<option value="' + id + '">' + esc(a.label) + ' (+' + (a.stats.power || 0) + ' puiss.)</option>';
  }).join('');

  const tierOptions = BAL_TIERS.map((t) => '<option value="' + t + '"' + (t === 6 ? ' selected' : '') + '>T' + t + '</option>').join('');
  $('balTier').innerHTML = tierOptions;
  $('balCastleTier').innerHTML = tierOptions;
  $('balFortPerLvl').textContent = String(CASTLE_FORTIFY_BONUS_PER_LEVEL);

  balRenderModel();

  // Les contrôles d'hypothèses invalident les compos extrêmes en cache.
  ['balComp', 'balArtifact', 'balBuff', 'balHp'].forEach((id) =>
    $(id).addEventListener('change', balRenderAll));
  ['balTarget'].forEach((id) => $(id).addEventListener('change', balRenderRequired));
  $('balTier').addEventListener('change', balRenderMatrix);
  ['balCastleTier', 'balCastleHp', 'balDefenders'].forEach((id) =>
    $(id).addEventListener('change', balRenderCastle));
}

function openBalancePanel() {
  $('balanceOverlay').classList.remove('hidden');
  $('balancePanel').classList.remove('hidden');
  balBuildOnce();
  balRenderAll();
}

function closeBalancePanel() {
  $('balanceOverlay').classList.add('hidden');
  $('balancePanel').classList.add('hidden');
}

$('openBalanceBtn').addEventListener('click', openBalancePanel);
$('balancePanelClose').addEventListener('click', closeBalancePanel);
$('balanceOverlay').addEventListener('click', closeBalancePanel);

/* ---------- Démarrage ---------- */

if (token) {
  showDashboard();
  startSession();
} else {
  showLogin();
}
