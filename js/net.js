'use strict';

/* ============================================================
 * net.js — RemoteServer : client Socket.io.
 *
 * Expose exactement la même surface que ServerSim (tiles,
 * players, raids, now, me, move(), harvest()…) : le reste du
 * client (render/ui/main) ne voit pas la différence. Les
 * actions renvoient des Promesses résolues par l'ack serveur.
 * ============================================================ */

class RemoteServer {
  constructor() {
    this.remote = true;
    this.socket = null;
    this.listeners = {};
    this.players = new Map();
    this.raids = new Map();
    this.tiles = new Map();
    this.seed = 0;
    this.now = 0;
    this.speed = 1;
    this.meId = null;
    this.token = null;
  }

  on(ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((cb) => cb(data)); }

  get me() { return this.meId ? this.players.get(this.meId) : null; }

  chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  /* Le serveur pré-calcule la force d'équipe dans le payload des raids */
  teamForce(raid) { return raid.teamForce || 0; }

  /* Horloge : interpolation locale entre deux synchros serveur */
  tick(dt) {
    this.now += dt * this.speed;
    const me = this.me;
    if (me && me.pa < CONFIG.PA.MAX) me.paMs += dt * this.speed;
  }

  connect(token) {
    this.token = token || null;
    const s = this.socket = io();

    s.on('connect', () => s.emit('auth', { token: this.token }));
    s.on('connect_error', () => this.emit('toast', { text: 'Connexion au serveur impossible…' }));
    s.on('creation', (d) => {
      if (d && d.error) this.emit('toast', { text: d.error });
      this.emit('creation');
    });
    s.on('init', (d) => this.onInit(d));

    s.on('self', (p) => {
      if (!this.meId) return;
      this.players.set(this.meId, p);
      this.emit('self', p);
    });
    s.on('players', (list) => {
      for (const id of [...this.players.keys()]) {
        if (id !== this.meId) this.players.delete(id);
      }
      for (const p of list) {
        if (p.id !== this.meId) this.players.set(p.id, p);
      }
    });
    s.on('world', (patch) => {
      const t = this.tiles.get(patch.key);
      if (t && t.content) t.content.inactiveUntil = patch.inactiveUntil;
    });
    s.on('raids', (list) => {
      this.raids = new Map(list.map((r) => [r.key, r]));
    });
    s.on('time', (d) => { this.now = d.now; this.speed = d.speed || 1; });
    s.on('chat', (m) => {
      m.self = !!(m.from && this.me && m.from === this.me.username);
      this.emit('chat', m);
    });
    s.on('toast', (t) => this.emit('toast', t));
    s.on('result', (r) => this.emit('result', r));
  }

  onInit(d) {
    this.token = d.token;
    this.meId = d.selfId;
    this.seed = d.seed;
    this.now = d.now;
    this.speed = d.speed || 1;
    this.tiles = generateWorld(d.seed);
    for (const [key, until] of d.worldDiffs || []) {
      const t = this.tiles.get(key);
      if (t && t.content) t.content.inactiveUntil = until;
    }
    this.players = new Map([[d.selfId, d.self]]);
    for (const p of d.players || []) {
      if (p.id !== d.selfId) this.players.set(p.id, p);
    }
    this.raids = new Map((d.raids || []).map((r) => [r.key, r]));
    this.emit('ready');
    this.emit('self', this.me);
  }

  /* Création de compte (depuis l'écran de création) */
  join(username, speciesClass) {
    this.socket.emit('auth', { token: this.token, username, speciesClass });
  }

  /* Requête avec ack + timeout : toutes les actions passent par là */
  req(ev, payload) {
    return new Promise((resolve) => {
      let done = false;
      const to = setTimeout(() => {
        if (!done) { done = true; resolve({ ok: false, error: 'Le serveur ne répond pas.' }); }
      }, 5000);
      this.socket.emit(ev, payload, (res) => {
        if (!done) { done = true; clearTimeout(to); resolve(res || { ok: false, error: 'Réponse invalide.' }); }
      });
    });
  }

  move(dx, dy) { return this.req('move', { dx, dy }); }
  harvest(x, y) { return this.req('harvest', { x, y }); }
  createRaid(x, y) { return this.req('raid:create', { x, y }); }
  joinRaid(key) { return this.req('raid:join', { key }); }
  startRaidNow(key) { return this.req('raid:start', { key }); }
  upgrade(slot) { return this.req('upgrade', { slot }); }
  rest() { return this.req('rest', {}); }
  teleportVillage(x, y) { return this.req('village:teleport', { x, y }); }
  setAdminTier(kind, tier) { return this.req('admin:tier', { kind, tier }); }
  setAdminGear(slot, tier) { return this.req('admin:gear', { slot, tier }); }
  dev(action) { return this.req('dev', action); }
  say(text) { this.socket.emit('chat', { text }); }
}
