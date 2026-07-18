'use strict';

/* ============================================================
 * index.js — serveur WildRift RPG.
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
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game.js');
const { Store } = require('./store.js');
const { CONFIG, syncActiveCharacter } = require('../js/config.js');

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
    worldDiffs: store.loadDiffs(),
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

function saveWorld() {
  try {
    store.transaction(() => {
      store.setMeta('seed', game.seed);
      store.setMeta('now', game.now);
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

// Migration : on fige tout de suite l'état importé, puis on archive le JSON
if (store.countAccounts() === 0 && initialState && initialState.savedAt) {
  saveAll();
  try {
    fs.renameSync(LEGACY_STATE_FILE, LEGACY_STATE_FILE + '.imported');
    console.log('Migration terminée — state.json archivé en state.json.imported');
  } catch (e) { /* déjà archivé ou inaccessible */ }
}
saveWorld();   // fige seed + horloge dès le démarrage

/* ---------- HTTP + Socket.io ---------- */
const app = express();
app.use(express.static(ROOT));
app.get('/health', (req, res) => res.json({ ok: true, players: game.players.size, now: game.now }));

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
    socket.emit('init', game.initPayload(player));
    if (!created) game.log(player.username + ' est de retour en jeu.');
  };

  // Reprise de session automatique (token stocké côté navigateur)
  socket.on('auth', (data) => {
    const res = game.authToken(data && data.token);
    if (res.ok) finishAuth(res.player, false);
    else socket.emit('creation', {});   // → écran inscription / connexion
  });

  socket.on('register', (data) => {
    const res = game.register(data || {});
    if (res.ok) finishAuth(res.player, true);
    else socket.emit('creation', { error: res.error });
  });

  socket.on('login', (data) => {
    const res = game.login(data || {});
    if (res.ok) finishAuth(res.player, false);
    else socket.emit('creation', { error: res.error });
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
      io.emit('raids', game.raidsPayload());
      saveAccountOf(player);
    }
    ack(r);
  };

  socket.on('move', act((d) => game.move(player, d.dx, d.dy)));
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
  socket.on('cook', act((d) => game.cook(player, String(d.item), Number(d.tier))));
  socket.on('consume', act((d) => game.consume(player, String(d.key))));
  socket.on('admin:tier', act((d) => game.setAdminTier(player, String(d.kind), Number(d.tier))));
  socket.on('admin:gear', act((d) => game.setAdminGear(player, String(d.slot), Number(d.tier))));
  socket.on('dev', act((d) => {
    const r = game.dev(player, d);
    if (r.ok && r.reset) {
      store.deleteAccount(player.id);
      sockets.delete(player.id);
      setTimeout(() => socket.disconnect(true), 100);
    }
    return r;
  }));
  socket.on('chat', (d) => {
    if (player && d && d.text) game.say(player, String(d.text).slice(0, 120));
  });

  socket.on('disconnect', () => {
    if (!player) return;
    if (sockets.get(player.id) === socket) sockets.delete(player.id);
    player.online = false;
    player.lastSeen = Date.now();
    if (game.players.has(player.id)) saveAccountOf(player);
  });
});

/* ---------- Boucles serveur ---------- */
setInterval(() => game.tick(TICK_MS), TICK_MS);
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

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nArrêt — sauvegarde de l’état…');
    saveAll();
    store.close();
    process.exit(0);
  });
}

httpServer.listen(PORT, () => {
  console.log('WildRift RPG : http://localhost:' + PORT + '  (SPEED x' + game.speed + ', DB ' + DB_FILE + ')');
});
