'use strict';

/* ============================================================
 * index.js — serveur WildRift RPG.
 *
 * - Sert le client statique (racine du repo)
 * - Socket.io : auth par token, actions avec ack, broadcasts
 * - Persistance : server/data/state.json (30 s + arrêt propre)
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
const { CONFIG } = require('../js/config.js');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');
const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 250;

/* ---------- État persistant ---------- */
let persisted = null;
try {
  persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  console.log('État restauré :', persisted.players.length, 'compte(s), horloge', Math.round(persisted.now / 1000) + ' s');
} catch (e) {
  console.log('Aucun état sauvegardé — nouveau monde (seed ' + CONFIG.WORLD.SEED + ')');
}

const game = new Game((persisted && persisted.seed) || CONFIG.WORLD.SEED, persisted);

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(game.serialize()));
  } catch (e) {
    console.error('Sauvegarde impossible :', e.message);
  }
}

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

  socket.on('auth', (data) => {
    const res = game.auth(data || {});
    if (!res.ok) {
      socket.emit('creation', res.error ? { error: res.error } : {});
      return;
    }
    player = res.player;

    // Une seule session par compte : on débranche l'ancienne
    const old = sockets.get(player.id);
    if (old && old !== socket) old.disconnect(true);
    sockets.set(player.id, socket);
    player.online = true;
    player.lastSeen = Date.now();

    socket.emit('init', game.initPayload(player));
    if (!res.created) game.log(player.username + ' est de retour en jeu.');
  });

  // Toutes les actions : validation authentifié + ack {ok, error?}
  // + push de l'état perso après une action réussie.
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
    if (r && r.ok) socket.emit('self', player);
    ack(r);
  };

  socket.on('move', act((d) => game.move(player, d.dx, d.dy)));
  socket.on('harvest', act((d) => game.harvest(player, Number(d.x), Number(d.y))));
  socket.on('raid:create', act((d) => game.createRaid(player, Number(d.x), Number(d.y))));
  socket.on('raid:join', act((d) => game.joinRaid(player, String(d.key))));
  socket.on('raid:start', act((d) => game.startRaidNow(player, String(d.key))));
  socket.on('upgrade', act((d) => game.upgrade(player, d.slot)));
  socket.on('rest', act(() => game.rest(player)));
  socket.on('village:teleport', act((d) => game.teleportVillage(player, Number(d.x), Number(d.y))));
  socket.on('admin:tier', act((d) => game.setAdminTier(player, String(d.kind), Number(d.tier))));
  socket.on('admin:gear', act((d) => game.setAdminGear(player, String(d.slot), Number(d.tier))));
  socket.on('dev', act((d) => {
    const r = game.dev(player, d);
    if (r.ok && r.reset) {
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
  });
});

/* ---------- Boucles serveur ---------- */
setInterval(() => game.tick(TICK_MS), TICK_MS);
setInterval(() => io.emit('players', game.publicPlayers()), 500);
setInterval(() => io.emit('time', { now: game.now, speed: game.speed }), 2000);
// État perso : recharge passive PA/PV visible sans attendre une action
setInterval(() => {
  for (const [accountId, sock] of sockets) {
    const p = game.players.get(accountId);
    if (p) sock.emit('self', p);
  }
}, 2000);
setInterval(saveState, 30000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nArrêt — sauvegarde de l’état…');
    saveState();
    process.exit(0);
  });
}

httpServer.listen(PORT, () => {
  console.log('WildRift RPG : http://localhost:' + PORT + '  (SPEED x' + game.speed + ')');
});
