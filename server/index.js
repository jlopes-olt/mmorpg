'use strict';

/* ============================================================
 * index.js — serveur Feralia Online.
 *
 * - Sert le client statique (racine du repo)
 * - Socket.io : inscription/connexion (mot de passe) + reprise de
 *   session par token, actions avec ack, broadcasts
 * - Persistance : SQLite (server/data/wildrift.db) — chaque compte
 *   est écrit immédiatement après un événement important, plus un
 *   filet de sécurité périodique pour l'horloge et les respawns.
 *
 * Lancement :  npm start          (port 3000)
 *              PORT=8080 SPEED=10 npm start   (tests accélérés)
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game.js');
const { Store } = require('./store.js');
const { CONFIG, syncActiveCharacter, MOONSTONE_PACKS, VAPID_PUBLIC_KEY } = require('../js/config.js');

// Notifications push (Web Push) : la clé publique est partagée avec le
// client via js/config.js (VAPID_PUBLIC_KEY, sans danger à exposer) ; la clé
// privée reste ici, remplaçable en prod via la variable d'environnement
// VAPID_PRIVATE_KEY (valeur par défaut = la clé générée pour ce prototype).
const webpush = require('web-push');
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'xNsjhBY9fO_BEr4SGpblft5XEInrBtmK1iK63kgcXI0';
webpush.setVapidDetails('mailto:contact@feralia-online.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Envoie une notif push à TOUS les abonnements enregistrés d'un compte (peut
// avoir plusieurs appareils) ; retire silencieusement les abonnements que le
// navigateur a révoqués (404/410 — l'utilisateur a désinstallé/désactivé).
function sendPushToAccount(accountId, title, body) {
  const player = game.players.get(String(accountId || ''));
  if (!player || !Array.isArray(player.pushSubscriptions) || !player.pushSubscriptions.length) return;
  const payload = JSON.stringify({ title, body });
  for (const sub of [...player.pushSubscriptions]) {
    webpush.sendNotification(sub, payload).catch((err) => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        player.pushSubscriptions = player.pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint);
        saveAccountOf(player);
      } else {
        console.error('Erreur envoi push :', err && err.message);
      }
    });
  }
}

// Achat d'Écailles Lunaires (Stripe) : clé secrète + liens de paiement par
// pack, fournis plus tard via variables d'environnement. Tant qu'ils sont
// absents, les fonctionnalités correspondantes répondent juste
// « indisponible » plutôt que de planter au démarrage.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PAYMENT_LINKS = {
  small: process.env.STRIPE_PAYMENT_LINK_SMALL || '',
  medium: process.env.STRIPE_PAYMENT_LINK_MEDIUM || '',
  large: process.env.STRIPE_PAYMENT_LINK_LARGE || '',
};
const stripeClient = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

/* ---------- Emails transactionnels (Resend) : OTP connexion + mot de passe
 * oublié. Tant que RESEND_API_KEY est absent — ou que l'envoi échoue (ex.
 * nom de domaine pas encore vérifié : l'adresse resend.dev par défaut ne
 * délivre alors souvent qu'à l'adresse du compte Resend lui-même) — le code
 * est journalisé côté serveur ET renvoyé au client dans `devCode` (jamais le
 * cas en usage normal, seulement ce repli), pour ne jamais bloquer le
 * développement/les tests avant que le domaine soit prêt. */
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'FERALIA Online <onboarding@resend.dev>';

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '···';
  const user = s.slice(0, at);
  const maskedUser = user.length <= 2 ? user[0] + '···' : user.slice(0, 2) + '···';
  return maskedUser + s.slice(at);
}

// Tant que RESEND_FROM_EMAIL n'a pas été configuré vers un domaine vérifié,
// l'adresse sandbox par défaut de Resend ne délivre en général qu'à
// l'adresse du compte Resend lui-même — mais l'API répond quand même 200 OK
// pour n'importe quel destinataire. On ne peut donc PAS se fier à un envoi
// « réussi » pour savoir si un joueur quelconque recevra vraiment l'email.
const USING_SANDBOX_SENDER = RESEND_FROM_EMAIL.includes('resend.dev');

async function sendOtpEmail(to, code, kind) {
  const subject = kind === 'reset' ? 'Code de réinitialisation — FERALIA Online' : 'Code de connexion — FERALIA Online';
  const intro = kind === 'reset'
    ? 'Voici ton code pour réinitialiser ton mot de passe :'
    : 'Voici ton code de connexion :';
  // Palette alignée sur le jeu (--bg/--ink/--gold, voir css/style.css) — logo
  // servi en statique par l'appli elle-même (express.static), donc en URL
  // absolue vers le domaine de prod (jamais chargé tant que USING_SANDBOX_SENDER
  // est vrai de toute façon, voir plus bas : pas d'envoi réel avant domaine prêt).
  const html =
    '<div style="background:#14181d;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">' +
      '<div style="max-width:420px;margin:0 auto;background:#1c2128;border:1px solid #2c333d;border-radius:16px;overflow:hidden;">' +
        '<div style="background:#14181d;padding:28px 24px 16px;text-align:center;border-bottom:1px solid #2c333d;">' +
          '<img src="https://feraliaonline.fr/assets/feralia_online_logo.png" alt="FERALIA Online" width="72" height="72" style="display:block;margin:0 auto 12px;border-radius:14px;">' +
          '<div style="color:#e8b23f;font-size:20px;font-weight:800;letter-spacing:0.03em;">FERALIA ONLINE</div>' +
        '</div>' +
        '<div style="padding:28px 24px;text-align:center;">' +
          '<p style="color:#e8ecf1;font-size:15px;margin:0 0 20px;">' + intro + '</p>' +
          '<div style="display:inline-block;background:#14181d;border:1px solid #e8b23f;border-radius:12px;padding:16px 28px;margin-bottom:20px;">' +
            '<span style="font-size:34px;font-weight:800;letter-spacing:0.14em;color:#e8b23f;">' + code + '</span>' +
          '</div>' +
          '<p style="color:#8a94a3;font-size:12px;margin:0;">Ce code expire dans quelques minutes. Si tu n’es pas à l’origine de cette demande, ignore cet email.</p>' +
        '</div>' +
        '<div style="background:#14181d;padding:14px 24px;text-align:center;border-top:1px solid #2c333d;">' +
          '<span style="color:#565f6b;font-size:11px;">FERALIA Online — feraliaonline.fr</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  if (!RESEND_API_KEY) {
    console.log('[Resend non configuré] Code ' + kind + ' pour ' + to + ' : ' + code);
    return { sent: false, devFallback: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, html }),
    });
    if (!res.ok) {
      console.error('Échec envoi email Resend (' + res.status + ') : ' + (await res.text().catch(() => '')));
      console.log('[Repli — envoi échoué] Code ' + kind + ' pour ' + to + ' : ' + code);
      return { sent: false, devFallback: true };
    }
    // Resend renvoie 200 même quand l'adresse sandbox ne délivrera pas
    // vraiment à ce destinataire (voir USING_SANDBOX_SENDER) — on affiche
    // quand même le code par sécurité tant qu'aucun domaine n'est vérifié,
    // sans quoi un joueur pourrait ne jamais recevoir son code nulle part.
    if (USING_SANDBOX_SENDER) {
      console.log('[Repli — domaine non vérifié] Code ' + kind + ' pour ' + to + ' : ' + code);
      return { sent: true, devFallback: true };
    }
    return { sent: true, devFallback: false };
  } catch (e) {
    console.error('Erreur envoi email Resend :', e.message);
    console.log('[Repli — envoi échoué] Code ' + kind + ' pour ' + to + ' : ' + code);
    return { sent: false, devFallback: true };
  }
}

function buildCheckoutLink(player, packId) {
  const pack = MOONSTONE_PACKS.find((p) => p.id === packId);
  if (!pack) return { ok: false, error: 'Pack inconnu.' };
  const baseUrl = STRIPE_PAYMENT_LINKS[packId];
  if (!baseUrl) return { ok: false, error: 'Ce pack n’est pas encore disponible à l’achat.' };
  const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'client_reference_id=' + encodeURIComponent(player.id);
  return { ok: true, url };
}

const ROOT = path.join(__dirname, '..');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'wildrift.db');
const LEGACY_STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');
const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 250;

/* ---------- Persistance SQLite ---------- */
const store = new Store(DB_FILE);

let seed = store.getMeta('seed', null);
let initialState = null;

if (store.countAccounts() === 0 && seed === null && fs.existsSync(LEGACY_STATE_FILE)) {
  // Migration unique depuis l'ancien state.json
  try {
    initialState = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
    seed = initialState.seed;
    console.log('Migration de state.json → SQLite (' + (initialState.players || []).length + ' compte(s))');
  } catch (e) {
    console.error('state.json illisible, ignoré :', e.message);
  }
} else if (seed !== null) {
  initialState = {
    now: store.getMeta('now', 0),
    players: [],
    credentials: {},
    guilds: store.getMeta('guilds', []),
    castles: store.getMeta('castles', []),
    chatLog: store.getMeta('chatLog', []),
    worldDiffs: store.loadDiffs(),
    wildSalt: store.getMeta('wildSalt', 0),
    worldBossAlive: store.getMeta('worldBossAlive', false),
    worldBossNextSpawnAt: store.getMeta('worldBossNextSpawnAt', Date.now()),
  };
  for (const { player, credentials } of store.loadAccounts()) {
    initialState.players.push(player);
    initialState.credentials[player.id] = credentials;
  }
  console.log('État restauré : ' + initialState.players.length + ' compte(s), horloge ' +
    Math.round(initialState.now / 1000) + ' s');
}

if (seed === null) {
  seed = CONFIG.WORLD.SEED;
  console.log('Nouveau monde (seed ' + seed + ')');
}

const game = new Game(seed, initialState);

function saveAccountOf(p) {
  try {
    syncActiveCharacter(p);   // recopie la forme active dans son slot
    store.saveAccount(p, game.credentials.get(p.id));
  } catch (e) {
    console.error('Sauvegarde compte impossible :', e.message);
  }
}

// OTP requis uniquement à la création de compte (voir 'register' plus bas) —
// les reconnexions ultérieures (mot de passe, token stocké) n'en redemandent
// plus, seule l'inscription vérifie que l'email fourni est le bon.
async function beginOtpFlow(socket, p) {
  const { code } = game.beginLoginOtp(p, { justRegistered: true });
  const sendRes = await sendOtpEmail(p.email, code, 'login');
  socket.emit('otpRequired', {
    accountId: p.id,
    stage: 'otp',
    email: maskEmail(p.email),
    devCode: sendRes.devFallback ? code : undefined,
  });
}

function saveWorld() {
  try {
    store.transaction(() => {
      store.setMeta('seed', game.seed);
      store.setMeta('now', game.now);
      store.setMeta('guilds', [...game.guilds.values()]);
      store.setMeta('castles', [...game.castles.values()]);
      store.setMeta('chatLog', game.chatLog);
      store.setMeta('wildSalt', game.wildSalt);
      store.setMeta('worldBossAlive', game.worldBossAlive);
      store.setMeta('worldBossNextSpawnAt', game.worldBossNextSpawnAt);
      store.setMeta('savedAt', Date.now());
    });
    store.saveDiffs(game.worldDiffs());
  } catch (e) {
    console.error('Sauvegarde monde impossible :', e.message);
  }
}

function saveAll() {
  saveWorld();
  for (const p of game.players.values()) saveAccountOf(p);
}

// Événements internes (fin de récolte, résolution de raid…) → écriture immédiate
game.onDirty = (p) => saveAccountOf(p);
// Création/adhésion/départ de guilde → écriture immédiate (pas d'attente du filet de sécurité)
game.onGuildsDirty = () => saveWorld();
// Chaque message (général/guilde/MP) → écriture immédiate, pour survivre à un redémarrage
// entre l'envoi et la prochaine connexion du destinataire (coordination asynchrone).
game.onChatDirty = () => saveWorld();
// Réveil/mort du boss mondial → écriture immédiate (sinon un redémarrage
// juste après sa mort le referait apparaître aussitôt, horloge murale perdue).
// Diffuse aussi à tous les clients déjà connectés (mort ou réveil) — sans ça,
// un client resté ouvert ne voit jamais la transition tant qu'il ne se
// reconnecte pas (le rendu de la case dépend de ce champ, voir js/render.js).
game.onWorldBossDirty = () => { saveWorld(); io.emit('worldBoss', game.worldBossPayload()); };
game.sendPush = sendPushToAccount;

// Migration : on fige tout de suite l'état importé, puis on archive le JSON
if (store.countAccounts() === 0 && initialState && initialState.savedAt) {
  saveAll();
  try {
    fs.renameSync(LEGACY_STATE_FILE, LEGACY_STATE_FILE + '.imported');
    console.log('Migration terminée — state.json archivé en state.json.imported');
  } catch (e) { /* déjà archivé ou inaccessible */ }
}

// Filet de secours admin : si ADMIN_USERNAMES est défini (pseudos séparés par
// des virgules), ces comptes sont (re)promus admin à chaque démarrage — utile
// pour se garantir l'accès même si la promotion automatique du compte le plus
// ancien (cf. Game.load) a déjà trouvé un autre titulaire, ou pour se
// redonner l'accès après un incident. Sans effet si la variable est absente.
const forcedAdmins = (process.env.ADMIN_USERNAMES || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
for (const username of forcedAdmins) {
  const p = game.players.get('p_' + username);
  if (p) { p.role = 'admin'; console.log('Admin forcé via ADMIN_USERNAMES : ' + p.username); }
  else console.log('ADMIN_USERNAMES : compte introuvable pour « ' + username + ' »');
}

// Toujours écrire l'état des comptes une fois au démarrage : une migration
// en mémoire (ex. promotion admin dans Game.load, ADMIN_USERNAMES ci-dessus)
// ne doit pas rester lettre morte si le compte concerné ne se reconnecte
// pas tout de suite — sans ça elle ne survit qu'en RAM jusqu'au prochain
// redémarrage, qui la refait sans jamais l'écrire sur disque.
for (const p of game.players.values()) saveAccountOf(p);
saveWorld();   // fige seed + horloge dès le démarrage

/* ---------- HTTP + Socket.io ---------- */
const app = express();
app.use(express.static(ROOT));
app.get('/health', (req, res) => res.json({ ok: true, players: game.players.size, now: game.now }));

// Webhook Stripe : express.raw() car la vérification de signature a besoin
// du corps BRUT, avant tout parsing JSON (aucun middleware JSON global
// n'existe ailleurs dans ce fichier, donc pas de conflit d'ordre ici).
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripeClient || !STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Signature Stripe invalide :', e.message);
    return res.status(400).end();
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const accountId = session.client_reference_id;
    const pack = MOONSTONE_PACKS.find((p) => p.priceCents === session.amount_total);
    if (!accountId || !pack) {
      console.error('Webhook Stripe : session non reconnue (client_reference_id=' + accountId + ', montant=' + session.amount_total + ').');
    } else {
      const r = game.creditMoonstones(accountId, pack.lunaires);
      if (!r.ok) console.error('Échec crédit Stripe pour ' + accountId + ' :', r.error);
    }
  }
  res.json({ received: true });
});

/* ---------- Backoffice /admin (page statique + API JSON) ----------
 * Page autonome, hors du client de jeu : authentification par
 * pseudo/mot de passe (comptes existants ayant le rôle admin),
 * puis un jeton porteur (Authorization: Bearer <token>) pour les
 * appels suivants. Le jeton vit en mémoire (perdu au redémarrage du
 * serveur — l'admin doit alors se reconnecter, ce qui est très bien
 * pour un outil interne). */
const adminSessions = new Map();   // token -> { playerId, expiresAt }
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

function adminAuth(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = token && adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ ok: false, error: 'Session admin invalide ou expirée.' });
  }
  const admin = game.players.get(session.playerId);
  if (!admin || admin.role !== 'admin') {
    adminSessions.delete(token);
    return res.status(403).json({ ok: false, error: 'Accès réservé aux administrateurs.' });
  }
  session.expiresAt = Date.now() + ADMIN_SESSION_MS;   // prolonge la session à l'usage
  req.adminToken = token;
  req.adminPlayer = admin;
  next();
}

app.use('/admin/api', express.json());

app.post('/admin/api/login', (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  const id = 'p_' + username.toLowerCase();
  const cred = game.credentials.get(id);
  const player = game.players.get(id);
  if (!cred || !player || game.hashPassword(password, cred.passSalt) !== cred.passHash) {
    return res.status(401).json({ ok: false, error: 'Identifiants incorrects.' });
  }
  if (player.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Ce compte n’est pas administrateur.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, { playerId: player.id, expiresAt: Date.now() + ADMIN_SESSION_MS });
  res.json({ ok: true, token, username: player.username });
});

app.post('/admin/api/logout', adminAuth, (req, res) => {
  adminSessions.delete(req.adminToken);
  res.json({ ok: true });
});

app.get('/admin/api/stats', adminAuth, (req, res) => {
  res.json({ ok: true, stats: game.adminStats() });
});

app.get('/admin/api/players', adminAuth, (req, res) => {
  res.json({ ok: true, list: game.adminPlayerList() });
});

app.post('/admin/api/players/:username/role', adminAuth, (req, res) => {
  const r = game.adminSetRole(req.adminPlayer, req.params.username, String((req.body || {}).role || ''));
  res.json(r);
});

app.post('/admin/api/players/:username/slots', adminAuth, (req, res) => {
  const r = game.adminGrantSlot(req.adminPlayer, req.params.username, Number((req.body || {}).count));
  res.json(r);
});

app.post('/admin/api/players/:username/gold', adminAuth, (req, res) => {
  const r = game.adminGrantGold(req.adminPlayer, req.params.username, Number((req.body || {}).amount));
  res.json(r);
});

app.post('/admin/api/players/:username/premium', adminAuth, (req, res) => {
  const r = game.adminGrantPremium(req.adminPlayer, req.params.username, Number((req.body || {}).amount));
  res.json(r);
});

app.post('/admin/api/players/:username/item', adminAuth, (req, res) => {
  const b = req.body || {};
  const r = game.adminGrantItem(req.adminPlayer, req.params.username, String(b.key || ''), Number(b.qty));
  res.json(r);
});

app.post('/admin/api/players/:username/accessory', adminAuth, (req, res) => {
  const b = req.body || {};
  const r = game.adminGrantAccessory(req.adminPlayer, req.params.username, String(b.accessoryId || ''));
  res.json(r);
});

app.post('/admin/api/players/:username/mount', adminAuth, (req, res) => {
  const b = req.body || {};
  const r = game.adminGrantMount(req.adminPlayer, req.params.username, String(b.mountId || ''));
  res.json(r);
});

app.post('/admin/api/players/:username/level', adminAuth, (req, res) => {
  const b = req.body || {};
  const r = game.adminSetLevel(req.adminPlayer, req.params.username, String(b.kind || ''), Number(b.tier));
  res.json(r);
});

app.post('/admin/api/players/:username/gear', adminAuth, (req, res) => {
  const b = req.body || {};
  const r = game.adminSetGear(req.adminPlayer, req.params.username, String(b.slot || ''), Number(b.tier));
  res.json(r);
});

const httpServer = http.createServer(app);
const io = new Server(httpServer);

const sockets = new Map();   // accountId -> socket

game.send = (accountId, ev, data) => {
  const sock = sockets.get(accountId);
  if (sock) sock.emit(ev, data);
};
game.broadcast = (ev, data) => io.emit(ev, data);

io.on('connection', (socket) => {
  let player = null;

  const finishAuth = (p, created) => {
    player = p;
    // Une seule session par compte : on débranche l'ancienne
    const old = sockets.get(player.id);
    if (old && old !== socket) old.disconnect(true);
    sockets.set(player.id, socket);
    player.online = true;
    player.lastSeen = Date.now();
    saveAccountOf(player);
    const payload = game.initPayload(player);
    payload.created = created;
    socket.emit('init', payload);
    if (!created) game.log(player.username + ' est de retour en jeu.');
  };

  // Reprise de session automatique (token stocké côté navigateur)
  socket.on('auth', (data) => {
    const res = game.authToken(data && data.token);
    if (res.ok) finishAuth(res.player, false);
    else socket.emit('creation', {});   // → écran inscription / connexion
  });

  socket.on('register', async (data) => {
    const res = game.register(data || {});
    if (!res.ok) { socket.emit('creation', { error: res.error }); return; }
    await beginOtpFlow(socket, res.player);
  });

  socket.on('login', (data) => {
    const res = game.login(data || {});
    if (!res.ok) { socket.emit('creation', { error: res.error }); return; }
    // Comptes créés avant l'email obligatoire : on force juste son ajout
    // (nécessaire pour "mot de passe oublié"), sans code OTP — l'OTP ne sert
    // plus qu'à la création de compte, pas aux reconnexions.
    if (!res.player.email) { socket.emit('otpRequired', { accountId: res.player.id, stage: 'need-email' }); return; }
    finishAuth(res.player, false);
  });

  // --- Étape intermédiaire avant finishAuth() pour les comptes créés avant
  // l'email obligatoire : ajout de l'email, sans OTP (voir 'login' ci-dessus).
  // Pas de wrapper act() ici : cet échange précède l'authentification,
  // `player` n'est pas encore posé. ---
  socket.on('auth:setEmail', (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const res = game.setAccountEmail(String((data && data.accountId) || ''), data && data.email);
    if (!res.ok) { ack(res); return; }
    ack({ ok: true });
    finishAuth(res.player, false);
  });

  socket.on('auth:verifyOtp', (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const res = game.verifyLoginOtp(String((data && data.accountId) || ''), data && data.code);
    if (!res.ok) { ack(res); return; }
    ack({ ok: true });
    finishAuth(res.player, res.justRegistered);
  });

  socket.on('auth:resendOtp', async (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const res = game.resendLoginOtp(String((data && data.accountId) || ''));
    if (!res.ok) { ack(res); return; }
    const sendRes = await sendOtpEmail(res.email, res.code, 'login');
    ack({ ok: true, devCode: sendRes.devFallback ? res.code : undefined });
  });

  // --- Mot de passe oublié : indépendant de toute session (pas besoin d'être
  // connecté — c'est justement le problème que ça résout). ---
  socket.on('auth:forgotPassword', async (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const res = game.requestPasswordReset((data && data.username) || '');
    if (!res.found) { ack({ ok: true, message: 'Si ce compte existe, un code a été envoyé.' }); return; }
    if (!res.hasEmail) { ack({ ok: false, error: 'Ce compte n’a pas d’email enregistré — impossible d’envoyer un code.' }); return; }
    const sendRes = await sendOtpEmail(res.email, res.code, 'reset');
    ack({ ok: true, message: 'Code envoyé à ' + maskEmail(res.email) + '.', devCode: sendRes.devFallback ? res.code : undefined });
  });

  socket.on('auth:resendPasswordReset', async (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const res = game.resendPasswordReset((data && data.username) || '');
    if (!res.ok) { ack(res); return; }
    const sendRes = await sendOtpEmail(res.email, res.code, 'reset');
    ack({ ok: true, devCode: sendRes.devFallback ? res.code : undefined });
  });

  socket.on('auth:resetPassword', (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    ack(game.resetPassword((data && data.username) || '', data && data.code, data && data.newPassword));
  });

  // Toutes les actions : validation authentifié + ack {ok, error?}
  // + push de l'état perso et écriture SQLite après une action réussie.
  const act = (fn) => (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (!player || !game.players.has(player.id)) {
      ack({ ok: false, error: 'Non authentifié.' });
      return;
    }
    let r;
    try {
      r = fn(payload || {});
    } catch (e) {
      console.error('Erreur action :', e);
      r = { ok: false, error: 'Erreur serveur.' };
    }
    if (r && r.ok) {
      socket.emit('self', player);
      io.emit('players', game.publicPlayers());
      io.emit('raids', game.raidsPayload());
      saveAccountOf(player);
    }
    ack(r);
  };

  socket.on('move', act((d) => game.move(player, d.dx, d.dy)));
  socket.on('explore', act((d) => game.exploreTiles(player, d.keys)));
  socket.on('harvest', act((d) => game.harvest(player, Number(d.x), Number(d.y))));
  socket.on('raid:create', act((d) => game.createRaid(player, Number(d.x), Number(d.y))));
  socket.on('raid:join', act((d) => game.joinRaid(player, String(d.key))));
  socket.on('raid:start', act((d) => game.startRaidNow(player, String(d.key))));
  socket.on('dungeon:enter', act((d) => game.enterDungeon(player, String(d.mapId))));
  socket.on('portal:use', act(() => game.usePortal(player)));
  socket.on('upgrade', act((d) => game.upgrade(player, d.slot)));
  socket.on('rest', act(() => game.rest(player)));
  socket.on('village:teleport', act((d) => game.teleportVillage(player, Number(d.x), Number(d.y))));
  socket.on('char:create', act((d) => game.createCharacter(player, String(d.speciesClass))));
  socket.on('char:switch', act((d) => game.switchCharacter(player, d.index)));
  socket.on('shop:buySkin', act((d) => game.buySkin(player, String(d.skinId))));
  socket.on('shop:buyMount', act((d) => game.buyMount(player, String(d.mountId))));
  socket.on('shop:equipSkin', act((d) => game.equipSkin(player, d.skinId ? String(d.skinId) : null)));
  socket.on('accessory:equip', act((d) => game.equipAccessory(player, d.accessoryId ? String(d.accessoryId) : null)));
  socket.on('mount:equip', act((d) => game.equipMount(player, d.mountId ? String(d.mountId) : null)));
  socket.on('shop:buyGoldPack', act((d) => game.buyGoldPack(player, String(d.packId || ''))));
  socket.on('shop:buyCharSlot', act(() => game.buyCharSlot(player)));
  socket.on('shop:checkoutLink', act((d) => buildCheckoutLink(player, String(d.packId || ''))));
  socket.on('push:subscribe', act((d) => {
    const sub = d && d.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return { ok: false, error: 'Abonnement invalide.' };
    if (!Array.isArray(player.pushSubscriptions)) player.pushSubscriptions = [];
    if (!player.pushSubscriptions.some((s) => s.endpoint === sub.endpoint)) player.pushSubscriptions.push(sub);
    return { ok: true };
  }));
  socket.on('push:unsubscribe', act((d) => {
    const endpoint = String((d && d.endpoint) || '');
    if (Array.isArray(player.pushSubscriptions)) {
      player.pushSubscriptions = player.pushSubscriptions.filter((s) => s.endpoint !== endpoint);
    }
    return { ok: true };
  }));
  socket.on('cook', act((d) => game.cook(player, String(d.item), Number(d.tier))));
  socket.on('consume', act((d) => game.consume(player, String(d.key))));
  socket.on('trade:request', act((d) => game.requestTrade(player, String(d.targetId))));
  socket.on('trade:respond', act((d) => game.respondTradeInvite(player, String(d.fromId), !!d.accept)));
  socket.on('trade:offer', act((d) => game.updateTradeOffer(player, d.offer || {})));
  socket.on('trade:confirm', act((d) => game.confirmTrade(player, d.accept !== false)));
  socket.on('trade:cancel', act(() => game.cancelTrade(player)));
  socket.on('duel:request', act((d) => game.requestDuel(player, String(d.targetId))));
  socket.on('duel:respond', act((d) => game.respondDuelInvite(player, String(d.fromId), !!d.accept)));
  socket.on('admin:tier', act((d) => game.setAdminTier(player, String(d.kind), Number(d.tier))));
  socket.on('admin:gear', act((d) => game.setAdminGear(player, String(d.slot), Number(d.tier))));
  socket.on('admin:stats', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (!player || player.role !== 'admin') return ack({ ok: false, error: 'Accès réservé aux administrateurs.' });
    ack({ ok: true, stats: game.adminStats() });
  });
  socket.on('admin:players', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (!player || player.role !== 'admin') return ack({ ok: false, error: 'Accès réservé aux administrateurs.' });
    ack({ ok: true, list: game.adminPlayerList() });
  });
  socket.on('admin:setRole', act((d) => game.adminSetRole(player, String(d.username), String(d.role))));
  socket.on('admin:grantSlot', act((d) => game.adminGrantSlot(player, String(d.username), Number(d.count))));
  socket.on('admin:grantGold', act((d) => game.adminGrantGold(player, String(d.username), Number(d.amount))));
  socket.on('admin:grantPremium', act((d) => game.adminGrantPremium(player, String(d.username), Number(d.amount))));
  socket.on('admin:grantItem', act((d) => game.adminGrantItem(player, String(d.username), String(d.key), Number(d.qty))));
  socket.on('admin:setLevel', act((d) => game.adminSetLevel(player, String(d.username), String(d.kind), Number(d.tier))));
  socket.on('admin:setGear', act((d) => game.adminSetGear(player, String(d.username), String(d.slot), Number(d.tier))));
  socket.on('dev', act((d) => {
    const r = game.dev(player, d);
    if (r.ok && r.reset) {
      store.deleteAccount(player.id);
      sockets.delete(player.id);
      setTimeout(() => socket.disconnect(true), 100);
    }
    return r;
  }));
  socket.on('chat', act((d) => game.say(player, String(d.text || ''), d.channel ? String(d.channel) : 'general', d.target ? String(d.target) : '')));
  socket.on('guild:create', act((d) => game.createGuild(player, String(d.name))));
  socket.on('guild:invite', act((d) => game.inviteToGuild(player, String(d.username))));
  socket.on('guild:respond', act((d) => game.respondGuildInvite(player, !!d.accept)));
  socket.on('guild:leave', act(() => game.leaveGuild(player)));
  socket.on('guild:kick', act((d) => game.kickFromGuild(player, String(d.username))));
  socket.on('guild:info', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (!player || !game.players.has(player.id)) return ack({ ok: false, error: 'Non authentifié.' });
    ack(game.guildInfo(player));
  });
  socket.on('title:set', act((d) => game.setActiveTitle(player, d.title ? String(d.title) : null)));
  socket.on('friend:request', act((d) => game.sendFriendRequest(player, String(d.username))));
  socket.on('friend:respond', act((d) => game.respondFriendRequest(player, String(d.fromId), !!d.accept)));
  socket.on('friend:remove', act((d) => game.removeFriend(player, String(d.username))));
  socket.on('friend:join', act((d) => game.joinFriend(player, String(d.username))));
  socket.on('friend:list', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (!player || !game.players.has(player.id)) return ack({ ok: false, error: 'Non authentifié.' });
    ack({ ok: true, list: game.friendsList(player) });
  });
  socket.on('castle:info', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (!player || !game.players.has(player.id)) return ack({ ok: false, error: 'Non authentifié.' });
    ack({ ok: true, list: game.castlesInfo(player) });
  });
  socket.on('castle:claim', act((d) => game.claimCastle(player, String(d.terrain))));
  socket.on('castle:reinforce', act((d) => game.reinforceCastle(player, String(d.terrain))));
  socket.on('castle:repair', act((d) => game.repairCastle(player, String(d.terrain), Number(d.gold))));
  socket.on('castle:fortify', act((d) => game.fortifyCastle(player, String(d.terrain))));
  socket.on('castle:assault', act((d) => game.createSiege(player, String(d.terrain))));
  socket.on('castle:craftEngine', act((d) => game.craftSiegeEngine(player, Number(d.tier))));
  socket.on('siege:deployEngine', act((d) => game.deploySiegeEngine(player, String(d.key), Number(d.tier))));

  socket.on('disconnect', () => {
    if (!player) return;
    if (player.tradeId) game.cancelTrade(player);
    // Une reconnexion (rafraîchissement de page, coupure réseau brève) fait
    // déjà tourner finishAuth() → online=true sur la NOUVELLE socket avant
    // que Socket.IO ne déclenche cet évènement pour l'ANCIENNE — sans cette
    // garde, ce handler tardif effaçait online=true juste posé, laissant le
    // compte figé « hors ligne » aux yeux de ses amis malgré une session active.
    if (sockets.get(player.id) !== socket) return;
    sockets.delete(player.id);
    player.online = false;
    player.lastSeen = Date.now();
    game.schedulePaFullNotify(player);
    if (game.players.has(player.id)) saveAccountOf(player);
  });
});

/* ---------- Boucles serveur ---------- */
setInterval(() => game.tick(TICK_MS), TICK_MS);
// Notifs push « Regain au maximum » : vérifiées indépendamment de la boucle de
// jeu (qui ne fait progresser le Regain que des comptes en ligne) — 30 s
// suffit, ce n'est pas une action sensible au timing comme le reste du jeu.
setInterval(() => game.checkPaFullNotifications(), 30000);
setInterval(() => io.emit('players', game.publicPlayers()), 500);
setInterval(() => io.emit('raids', game.raidsPayload()), 500);
setInterval(() => io.emit('time', { now: game.now, speed: game.speed }), 2000);
// État perso : recharge passive PA/PV visible sans attendre une action
setInterval(() => {
  for (const [accountId, sock] of sockets) {
    const p = game.players.get(accountId);
    if (p) sock.emit('self', p);
  }
}, 2000);
// Filet de sécurité : horloge, respawns et joueurs connectés
setInterval(() => {
  saveWorld();
  for (const id of sockets.keys()) {
    const p = game.players.get(id);
    if (p) saveAccountOf(p);
  }
}, 30000);

// Redistribution nocturne de la faune sauvage (ressources ET monstres —
// jamais les villages/donjons/château/capitale) : évite qu'une case reste la
// meilleure case de farm/chasse indéfiniment. Heure locale du serveur,
// réglable via WILD_RESET_HOUR (2 par défaut = 2 h du matin).
const WILD_RESET_HOUR = Math.max(0, Math.min(23, Number(process.env.WILD_RESET_HOUR) || 2));
function msUntilNextWildReset() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), WILD_RESET_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
function runNightlyWildReset() {
  const r = game.redistributeWildlife();
  saveWorld();
  console.log('🌱 Redistribution nocturne de la faune sauvage effectuée (salt ' + r.salt + ').');
}
(function scheduleNightlyWildReset() {
  const wait = msUntilNextWildReset();
  console.log('🌙 Prochaine redistribution de la faune sauvage dans ' + Math.round(wait / 60000) + ' min (' + WILD_RESET_HOUR + 'h, heure serveur).');
  setTimeout(() => {
    runNightlyWildReset();
    setInterval(runNightlyWildReset, 24 * 60 * 60 * 1000);
  }, wait);
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nArrêt — sauvegarde de l’état…');
    saveAll();
    store.close();
    process.exit(0);
  });
}

httpServer.listen(PORT, () => {
  console.log('FERALIA Online : http://localhost:' + PORT + '  (SPEED x' + game.speed + ', DB ' + DB_FILE + ')');
});
