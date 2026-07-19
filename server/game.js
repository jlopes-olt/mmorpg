'use strict';

/* ============================================================
 * game.js — logique de jeu autoritaire, multijoueur
 * Version multi-cartes : monde + donjons partagés
 * ============================================================ */

const crypto = require('crypto');

Object.assign(globalThis, require('../js/config.js'));
Object.assign(globalThis, require('../js/world.js'));

const MAX_GUILD_MEMBERS = 20;
const CHAT_LOG_MAX = 300;
// Constantes de château (CASTLE_*) : partagées via js/config.js (Object.assign
// ci-dessous), au même titre que CLASSES/RESOURCES — l'UI en a besoin pour
// afficher les coûts, donc elles ne peuvent pas rester locales à ce fichier.
const BOT_NAMES = ['Kaelith', 'Brumm', 'Sylvane', 'Orzo', 'Nyra', 'Fenwick', 'Malko', 'Isha', 'Torvald', 'Lupa'];
const BOT_CHAT = [
  'quelqu’un pour le Basilic au nord ?',
  'je farm du minerai T2 vers l’est si besoin',
  'gg pour le raid !',
  'le Wyrm du sud-ouest est re-up',
  'échange plante T3 contre bois T3',
  'premier jour ici, c’est grand…',
  'les Ruines à l’ouest sont pleines de spectres',
];

class Game {
  constructor(seed, persisted) {
    this.seed = seed;
    this.now = 0;
    this.speed = Math.max(1, Number(process.env.SPEED) || 1);
    this.maps = generateGameMaps(seed);
    this.worldMap = this.maps.get('world');
    this.currentMapId = 'world';
    this.tiles = this.worldMap.tiles;
    this.players = new Map();
    this.credentials = new Map();
    this.bots = new Map();
    this.tokens = new Map();
    this.raids = new Map();
    this.tradeInvites = new Map();
    this.trades = new Map();
    this.duelInvites = new Map();
    this.guilds = new Map();
    this.castles = new Map();   // terrain -> { terrain, ownerGuildId, hp, hpMax, level }
    this.chatLog = [];   // historique borné : reprend vie à la reconnexion (coordination async)
    this.pendingReplies = [];
    this.send = () => {};
    this.broadcast = () => {};
    this.onDirty = () => {};
    this.onGuildsDirty = () => {};
    this.onChatDirty = () => {};
    this.rng = Math.random;   // injectable pour des tests déterministes
    if (persisted) this.load(persisted);
    this.spawnBots();
  }

  mapOf(id) { return this.maps.get(id) || this.worldMap; }
  tilesOf(p) { return this.mapOf((p && p.mapId) || 'world').tiles; }
  raidId(mapId, x, y) { return raidKey(mapId || 'world', x, y); }
  normalizeRaidKey(p, key) {
    if (this.raids.has(key)) return key;
    if (typeof key === 'string' && key.indexOf('|') < 0 && key.indexOf(',') > 0) {
      const [x, y] = key.split(',').map(Number);
      return this.raidId((p && p.mapId) || 'world', x, y);
    }
    return key;
  }

  skinStateOf(p) {
    if (!p) return;
    if (!Array.isArray(p.ownedSkins)) p.ownedSkins = [];
    if (typeof p[PREMIUM_CURRENCY.key] !== 'number') p[PREMIUM_CURRENCY.key] = 0;
    if (typeof p.skinId === 'undefined') p.skinId = null;
    if (!Array.isArray(p.characters) || !p.characters.length) return;
    for (const c of p.characters) {
      if (typeof c.skinId === 'undefined') c.skinId = null;
    }
  }
  memberById(id) { return this.players.get(id) || this.bots.get(id); }
  chebyshev(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

  log(text) { this.broadcast('chat', { from: null, text, type: 'event' }); }
  plog(p, text) { this.send(p.id, 'chat', { from: null, text, type: 'event' }); }
  toast(p, text) { this.send(p.id, 'toast', { text }); }
  pushSelf(p) { this.send(p.id, 'self', p); this.onDirty(p); }
  pushMap(p) {
    this.send(p.id, 'map', {
      mapId: p.mapId || 'world',
      bounds: boundsOf(this.tilesOf(p)),
      mapDiffs: this.mapDiffs(),
      mapStates: this.mapStates(),
    });
  }

  resetTravelState(p) {
    p.status = 'IDLE';
    p.harvestKey = null;
    p.harvestEndsAt = 0;
    p.raidKey = null;
  }

  nearestWalkablePos(map, pos) {
    const origin = { x: Number(pos.x) || 0, y: Number(pos.y) || 0 };
    if (isWalkable(map.tiles, origin.x, origin.y)) return origin;
    for (let radius = 1; radius <= 6; radius++) {
      for (let y = origin.y - radius; y <= origin.y + radius; y++) {
        for (let x = origin.x - radius; x <= origin.x + radius; x++) {
          if (Math.max(Math.abs(x - origin.x), Math.abs(y - origin.y)) !== radius) continue;
          if (isWalkable(map.tiles, x, y)) return { x, y };
        }
      }
    }
    return origin;
  }

  mapStates() {
    const out = {};
    for (const [mapId, map] of this.maps) {
      if (!map || map.kind !== 'dungeon' || !map.dungeon) continue;
      out[mapId] = {
        killsRequired: map.dungeon.killsRequired,
        kills: map.dungeon.kills,
        bossAlive: map.dungeon.bossAlive,
      };
    }
    return out;
  }

  pushMapState(mapId) {
    const map = this.mapOf(mapId);
    if (!map) return;
    const payload = {
      mapId,
      bounds: boundsOf(map.tiles),
      mapDiffs: this.mapDiffs(),
      mapStates: this.mapStates(),
    };
    for (const p of this.players.values()) {
      if (p.online && (p.mapId || 'world') === mapId) this.send(p.id, 'map', payload);
    }
  }

  updateDungeonProgress(mapId, monster, victory) {
    const map = this.mapOf(mapId);
    if (!map || map.kind !== 'dungeon' || !map.dungeon || !victory || !monster) return;
    const state = map.dungeon;
    const bossTile = map.tiles.get(state.bossTileKey);

    if (monster.boss) {
      state.kills = 0;
      state.bossAlive = false;
      if (bossTile) bossTile.content = null;
      this.log('Le boss du donjon a été vaincu. Il faudra terrasser ' + state.killsRequired + ' squelettes pour le faire revenir.');
      this.pushMapState(mapId);
      return;
    }

    if (!monster.dungeonMob || state.bossAlive) return;
    state.kills = Math.min(state.killsRequired, state.kills + 1);
    if (state.kills >= state.killsRequired && bossTile && !bossTile.content) {
      bossTile.content = { ...state.bossTemplate };
      state.bossAlive = true;
      this.log('Le boss du donjon est apparu !');
    }
    this.pushMapState(mapId);
  }

  hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
  }

  resumePlayer(p) {
    const away = Math.max(0, Date.now() - (p.lastSeen || Date.now()));
    p.pa = Math.min(CONFIG.PA.MAX, p.pa + Math.floor(away / CONFIG.PA.REGEN_MS));
    p.hp = Math.min(maxHp(p), p.hp + Math.floor(away / CONFIG.HP.REGEN_MS));
    p.lastSeen = Date.now();
  }

  authToken(token) {
    if (!token || !this.tokens.has(token)) return { ok: false };
    const p = this.players.get(this.tokens.get(token));
    if (!p) return { ok: false };
    this.resumePlayer(p);
    return { ok: true, player: p };
  }

  register(data) {
    const username = String(data.username || '').trim().slice(0, 16);
    const password = String(data.password || '');
    if (username.length < 3) return { ok: false, error: 'Nom trop court (3 caractères minimum).' };
    if (!/^[\p{L}\p{N} _-]+$/u.test(username)) return { ok: false, error: 'Nom invalide (lettres, chiffres, espaces, - et _).' };
    if (password.length < 4) return { ok: false, error: 'Mot de passe trop court (4 caractères minimum).' };
    if (!CLASSES[data.speciesClass]) return { ok: false, error: 'Classe invalide.' };

    const id = 'p_' + username.toLowerCase();
    if (this.players.has(id)) return { ok: false, error: 'Le nom « ' + username + ' » est déjà pris.' };

    const passSalt = crypto.randomBytes(16).toString('hex');
    this.credentials.set(id, {
      passHash: this.hashPassword(password, passSalt),
      passSalt,
      createdAt: Date.now(),
    });

    const p = {
      id, username, bot: false,
      token: crypto.randomBytes(16).toString('hex'),
      online: false, lastSeen: Date.now(),
      mapId: 'world',
      pos: { x: 0, y: 0 },
      pa: CONFIG.PA.START, paMs: 0,
      hp: 100, hpMs: 0,
      inventory: {},
      gold: 0,
      [PREMIUM_CURRENCY.key]: 0,
      ownedSkins: [],
      status: 'IDLE',
      harvestKey: null, harvestEndsAt: 0,
      raidKey: null,
      tradeId: null,
      duels: { wins: 0, losses: 0 },
      guildId: null,
      guildInvite: null,
      friends: [],
      friendRequests: [],
      characters: [newCharacter(data.speciesClass)],
      activeChar: 0,
      charSlots: CONFIG.FREE_CHAR_SLOTS,
      visitedVillages: [],
      // Le tout premier compte créé sur une base vierge devient administrateur.
      role: this.players.size === 0 ? 'admin' : 'user',
    };
    this.skinStateOf(p);
    applyCharacter(p, 0);
    p.hp = maxHp(p);
    this.players.set(id, p);
    this.tokens.set(p.token, id);
    this.onDirty(p);
    this.log('🐾 ' + username + ' entre dans les Terres Sauvages !');
    return { ok: true, created: true, player: p };
  }

  login(data) {
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const id = 'p_' + username.toLowerCase();
    const p = this.players.get(id);
    if (!p) return { ok: false, error: 'Compte inconnu.' };

    let cred = this.credentials.get(id);
    if (!cred || !cred.passHash) {
      if (password.length < 4) return { ok: false, error: 'Mot de passe trop court (4 caractères minimum).' };
      const passSalt = crypto.randomBytes(16).toString('hex');
      cred = { passHash: this.hashPassword(password, passSalt), passSalt, createdAt: Date.now() };
      this.credentials.set(id, cred);
    } else {
      const tryHash = Buffer.from(this.hashPassword(password, cred.passSalt), 'hex');
      const goodHash = Buffer.from(cred.passHash, 'hex');
      if (tryHash.length !== goodHash.length || !crypto.timingSafeEqual(tryHash, goodHash)) {
        return { ok: false, error: 'Mot de passe incorrect.' };
      }
    }

    if (p.token) this.tokens.delete(p.token);
    p.token = crypto.randomBytes(16).toString('hex');
    this.tokens.set(p.token, p.id);
    this.resumePlayer(p);
    this.onDirty(p);
    return { ok: true, player: p };
  }

  initPayload(p) {
    return {
      token: p.token,
      selfId: p.id,
      self: p,
      seed: this.seed,
      now: this.now,
      speed: this.speed,
      mapId: p.mapId || 'world',
      mapDiffs: this.mapDiffs(),
      mapStates: this.mapStates(),
      bounds: boundsOf(this.tilesOf(p)),
      players: this.publicPlayers(),
      raids: this.raidsPayload(),
      trade: p.tradeId ? this.tradePayloadFor(p, this.trades.get(p.tradeId)) : null,
      chatHistory: this.chatHistoryFor(p),
    };
  }

  publicPlayer(p) {
    return {
      id: p.id,
      username: p.username,
      speciesClass: p.speciesClass,
      classLabel: (CLASSES[p.speciesClass] && CLASSES[p.speciesClass].label) || p.speciesClass,
      role: (CLASSES[p.speciesClass] && CLASSES[p.speciesClass].role) || '',
      pos: p.pos,
      status: p.status,
      bot: !!p.bot,
      mapId: p.mapId || 'world',
      weaponTier: p.weapon ? p.weapon.tier : 0,
      armorTier: p.armor ? p.armor.tier : 0,
      weaponType: p.weapon ? p.weapon.type : '',
      armorType: p.armor ? p.armor.type : '',
      skinId: p.skinId || null,
    };
  }

  buySkin(p, skinId) {
    const item = skinFor(String(skinId || ''));
    if (!item) return { ok: false, error: 'Skin inconnu.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (p.speciesClass !== item.speciesClass) return { ok: false, error: 'Ce skin est réservé à une autre classe.' };
    this.skinStateOf(p);
    if (p.ownedSkins.includes(item.id)) return { ok: false, error: 'Skin déjà possédé.' };
    const walletKey = item.currency === PREMIUM_CURRENCY.key ? PREMIUM_CURRENCY.key : 'gold';
    const balance = Number(p[walletKey] || 0);
    if (balance < item.price) {
      return { ok: false, error: walletKey === 'gold' ? 'Pas assez d’or.' : ('Pas assez de ' + PREMIUM_CURRENCY.label.toLowerCase() + '.') };
    }
    p[walletKey] = balance - item.price;
    p.ownedSkins.push(item.id);
    this.pushSelf(p);
    return { ok: true };
  }

  equipSkin(p, skinId) {
    this.skinStateOf(p);
    const desired = skinId ? String(skinId) : null;
    if (!desired) {
      p.skinId = null;
      syncActiveCharacter(p);
      this.pushSelf(p);
      return { ok: true };
    }
    const item = skinFor(desired);
    if (!item) return { ok: false, error: 'Skin inconnu.' };
    if (item.speciesClass !== p.speciesClass) return { ok: false, error: 'Ce skin ne correspond pas à votre forme active.' };
    if (!p.ownedSkins.includes(item.id)) return { ok: false, error: 'Vous ne possédez pas ce skin.' };
    p.skinId = item.id;
    syncActiveCharacter(p);
    this.pushSelf(p);
    return { ok: true };
  }

  publicPlayers() {
    const out = [];
    for (const p of this.players.values()) {
      if (p.online) out.push(this.publicPlayer(p));
    }
    for (const b of this.bots.values()) {
      out.push(this.publicPlayer(b));
    }
    return out;
  }

  isTradeableStack(key) {
    const parsed = parseStackKey(String(key || ''));
    return !!RESOURCES[parsed.type] || !!CONSUMABLES[parsed.type];
  }

  playerNear(a, b, maxDist) {
    return !!(a && b && (a.mapId || 'world') === (b.mapId || 'world') && this.chebyshev(a.pos, b.pos) <= (maxDist || 1));
  }

  tradePayloadFor(viewer, trade) {
    if (!trade || !viewer) return null;
    const meOffer = trade.offers[viewer.id] || { gold: 0, items: {}, accepted: false };
    const otherId = trade.players.find((id) => id !== viewer.id);
    const other = this.players.get(otherId);
    const otherOffer = trade.offers[otherId] || { gold: 0, items: {}, accepted: false };
    return {
      id: trade.id,
      withPlayer: other ? this.publicPlayer(other) : null,
      offers: {
        self: { gold: meOffer.gold, items: { ...meOffer.items }, accepted: !!meOffer.accepted },
        other: { gold: otherOffer.gold, items: { ...otherOffer.items }, accepted: !!otherOffer.accepted },
      },
    };
  }

  pushTrade(trade) {
    if (!trade) return;
    for (const id of trade.players) {
      const p = this.players.get(id);
      if (p && p.online) this.send(id, 'trade', this.tradePayloadFor(p, trade));
    }
  }

  closeTrade(trade, reason) {
    if (!trade) return;
    this.trades.delete(trade.id);
    for (const id of trade.players) {
      const p = this.players.get(id);
      if (!p) continue;
      if (p.tradeId === trade.id) {
        p.tradeId = null;
        if (p.status === 'TRADING') p.status = 'IDLE';
        this.pushSelf(p);
      }
      this.send(id, 'trade', null);
      if (reason) this.toast(p, reason);
    }
  }

  startTrade(a, b) {
    const trade = {
      id: 'trade_' + Date.now() + '_' + Math.floor(this.rng() * 100000),
      players: [a.id, b.id],
      offers: {
        [a.id]: { gold: 0, items: {}, accepted: false },
        [b.id]: { gold: 0, items: {}, accepted: false },
      },
    };
    a.tradeId = trade.id;
    b.tradeId = trade.id;
    a.status = 'TRADING';
    b.status = 'TRADING';
    this.trades.set(trade.id, trade);
    this.pushSelf(a);
    this.pushSelf(b);
    this.pushTrade(trade);
    return trade;
  }

  normalizeTradeOffer(p, raw) {
    const offer = { gold: 0, items: {}, accepted: false };
    if (!p || !raw) return offer;
    offer.gold = Math.max(0, Math.min(p.gold || 0, Math.floor(Number(raw.gold) || 0)));
    for (const [key, qtyRaw] of Object.entries(raw.items || {})) {
      if (!this.isTradeableStack(key)) continue;
      const own = p.inventory[key] || 0;
      if (!own) continue;
      const qty = Math.max(0, Math.min(own, Math.floor(Number(qtyRaw) || 0)));
      if (qty > 0) offer.items[key] = qty;
    }
    return offer;
  }

  sameTradeOffer(a, b) {
    const goldA = Number((a && a.gold) || 0);
    const goldB = Number((b && b.gold) || 0);
    if (goldA !== goldB) return false;
    const itemsA = (a && a.items) || {};
    const itemsB = (b && b.items) || {};
    const keysA = Object.keys(itemsA).filter((k) => Number(itemsA[k]) > 0).sort();
    const keysB = Object.keys(itemsB).filter((k) => Number(itemsB[k]) > 0).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      const key = keysA[i];
      if (key !== keysB[i]) return false;
      if (Number(itemsA[key]) !== Number(itemsB[key])) return false;
    }
    return true;
  }

  requestTrade(p, targetId) {
    const target = this.players.get(String(targetId));
    if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === p.id) return { ok: false, error: 'Impossible d’échanger avec vous-même.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (target.status !== 'IDLE') return { ok: false, error: 'Ce joueur est occupé.' };
    if (!this.playerNear(p, target, 1)) return { ok: false, error: 'Vous devez être au contact pour échanger.' };
    if (p.tradeId || target.tradeId) return { ok: false, error: 'Un échange est déjà en cours.' };
    this.tradeInvites.set(target.id, { fromId: p.id, toId: target.id, at: this.now });
    this.send(target.id, 'tradeInvite', { fromPlayer: this.publicPlayer(p) });
    this.toast(p, 'Demande d’échange envoyée à ' + target.username + '.');
    return { ok: true };
  }

  respondTradeInvite(p, fromId, accept) {
    const invite = this.tradeInvites.get(p.id);
    if (!invite || invite.fromId !== String(fromId)) return { ok: false, error: 'Invitation introuvable.' };
    this.tradeInvites.delete(p.id);
    const from = this.players.get(invite.fromId);
    if (!from) return { ok: false, error: 'Le joueur n’est plus disponible.' };
    if (!accept) {
      this.toast(from, p.username + ' a refusé l’échange.');
      return { ok: true, declined: true };
    }
    if (from.status !== 'IDLE' || p.status !== 'IDLE') return { ok: false, error: 'L’un des joueurs est occupé.' };
    if (!this.playerNear(from, p, 1)) return { ok: false, error: 'Vous devez rester au contact pour échanger.' };
    this.startTrade(from, p);
    return { ok: true };
  }

  updateTradeOffer(p, offerRaw) {
    const trade = this.trades.get(p.tradeId || '');
    if (!trade) return { ok: false, error: 'Aucun échange actif.' };
    if (!trade.players.includes(p.id)) return { ok: false, error: 'Échange invalide.' };
    const nextOffer = this.normalizeTradeOffer(p, offerRaw);
    const prevOffer = trade.offers[p.id] || { gold: 0, items: {}, accepted: false };
    const changed = !this.sameTradeOffer(prevOffer, nextOffer);
    trade.offers[p.id] = nextOffer;
    trade.offers[p.id].accepted = changed ? false : !!prevOffer.accepted;
    const otherId = trade.players.find((id) => id !== p.id);
    if (changed && trade.offers[otherId]) trade.offers[otherId].accepted = false;
    this.pushTrade(trade);
    return { ok: true };
  }

  confirmTrade(p, accepted) {
    const trade = this.trades.get(p.tradeId || '');
    if (!trade) return { ok: false, error: 'Aucun échange actif.' };
    const mine = trade.offers[p.id];
    if (!mine) return { ok: false, error: 'Offre invalide.' };
    mine.accepted = accepted !== false;
    this.pushTrade(trade);
    if (!mine.accepted) return { ok: true };
    const otherId = trade.players.find((id) => id !== p.id);
    const other = this.players.get(otherId);
    if (!other || !trade.offers[otherId] || !trade.offers[otherId].accepted) return { ok: true };

    const a = this.players.get(trade.players[0]);
    const b = this.players.get(trade.players[1]);
    if (!a || !b) {
      this.closeTrade(trade, 'Échange interrompu.');
      return { ok: false, error: 'Échange interrompu.' };
    }
    if (!this.playerNear(a, b, 1)) {
      this.closeTrade(trade, 'Échange annulé : les joueurs se sont éloignés.');
      return { ok: false, error: 'Les joueurs se sont éloignés.' };
    }

    const oa = this.normalizeTradeOffer(a, trade.offers[a.id]);
    const ob = this.normalizeTradeOffer(b, trade.offers[b.id]);
    trade.offers[a.id] = { ...oa, accepted: true };
    trade.offers[b.id] = { ...ob, accepted: true };

    a.gold -= oa.gold;
    b.gold -= ob.gold;
    b.gold += oa.gold;
    a.gold += ob.gold;

    for (const [key, qty] of Object.entries(oa.items)) {
      a.inventory[key] -= qty;
      if (a.inventory[key] <= 0) delete a.inventory[key];
      b.inventory[key] = (b.inventory[key] || 0) + qty;
    }
    for (const [key, qty] of Object.entries(ob.items)) {
      b.inventory[key] -= qty;
      if (b.inventory[key] <= 0) delete b.inventory[key];
      a.inventory[key] = (a.inventory[key] || 0) + qty;
    }

    this.closeTrade(trade, 'Échange terminé.');
    return { ok: true, done: true };
  }

  cancelTrade(p) {
    const trade = this.trades.get(p.tradeId || '');
    if (!trade) return { ok: false, error: 'Aucun échange actif.' };
    const otherId = trade.players.find((id) => id !== p.id);
    const other = this.players.get(otherId);
    this.closeTrade(trade, other ? (p.username + ' a annulé l’échange.') : 'Échange annulé.');
    return { ok: true };
  }

  /* ---------- Duels amicaux (aucune perte de PV, ni d'or) ---------- */
  requestDuel(p, targetId) {
    const target = this.players.get(String(targetId));
    if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === p.id) return { ok: false, error: 'Impossible de se défier soi-même.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (target.status !== 'IDLE') return { ok: false, error: 'Ce joueur est occupé.' };
    if (!this.playerNear(p, target, 1)) return { ok: false, error: 'Vous devez être au contact pour défier.' };
    this.duelInvites.set(target.id, { fromId: p.id, toId: target.id, at: this.now });
    this.send(target.id, 'duelInvite', { fromPlayer: this.publicPlayer(p) });
    this.toast(p, 'Défi envoyé à ' + target.username + '.');
    return { ok: true };
  }

  respondDuelInvite(p, fromId, accept) {
    const invite = this.duelInvites.get(p.id);
    if (!invite || invite.fromId !== String(fromId)) return { ok: false, error: 'Défi introuvable.' };
    this.duelInvites.delete(p.id);
    const from = this.players.get(invite.fromId);
    if (!from) return { ok: false, error: 'Le joueur n’est plus disponible.' };
    if (!accept) {
      this.toast(from, p.username + ' a refusé le duel.');
      return { ok: true, declined: true };
    }
    if (from.status !== 'IDLE' || p.status !== 'IDLE') return { ok: false, error: 'L’un des joueurs est occupé.' };
    if (!this.playerNear(from, p, 1)) return { ok: false, error: 'Vous devez rester au contact pour le duel.' };
    this.resolveDuel(from, p);
    return { ok: true };
  }

  /* Amical : pas de PV perdus, pas d'or en jeu — seul le palmarès évolue. */
  resolveDuel(a, b) {
    const powerA = combatPower(a);
    const powerB = combatPower(b);
    const chance = winChance(powerA, powerB);
    const aWins = this.rng() < chance;
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;
    winner.duels.wins += 1;
    loser.duels.losses += 1;
    this.send(a.id, 'duelResult', {
      opponent: b.username, won: aWins,
      chance: Math.round(chance * 100), yourPower: Math.round(powerA), opponentPower: Math.round(powerB),
    });
    this.send(b.id, 'duelResult', {
      opponent: a.username, won: !aWins,
      chance: Math.round((1 - chance) * 100), yourPower: Math.round(powerB), opponentPower: Math.round(powerA),
    });
    this.log('⚔️ ' + winner.username + ' bat ' + loser.username + ' en duel amical.');
    this.pushSelf(a);
    this.pushSelf(b);
  }

  /* ---------- Guildes ---------- */
  findAccountByUsername(username) {
    return this.players.get('p_' + String(username || '').trim().toLowerCase()) || null;
  }

  guildOf(p) {
    return p.guildId ? this.guilds.get(p.guildId) || null : null;
  }

  guildRosterPublic(guild) {
    return guild.members.map((id) => {
      const m = this.players.get(id);
      if (!m) return null;
      return {
        id: m.id,
        username: m.username,
        online: !!m.online,
        classLabel: (CLASSES[m.speciesClass] && CLASSES[m.speciesClass].label) || m.speciesClass,
        isLeader: id === guild.leaderId,
      };
    }).filter(Boolean);
  }

  createGuild(p, name) {
    name = String(name || '').trim().slice(0, 24);
    if (name.length < 3) return { ok: false, error: 'Nom de guilde trop court (3 caractères minimum).' };
    if (!/^[\p{L}\p{N} _-]+$/u.test(name)) return { ok: false, error: 'Nom invalide (lettres, chiffres, espaces, - et _).' };
    if (p.guildId) return { ok: false, error: 'Vous êtes déjà dans une guilde.' };
    if ([...this.guilds.values()].some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: 'Ce nom de guilde est déjà pris.' };
    }
    const id = 'g_' + crypto.randomBytes(6).toString('hex');
    const guild = { id, name, leaderId: p.id, members: [p.id], createdAt: this.now };
    this.guilds.set(id, guild);
    p.guildId = id;
    this.pushSelf(p);
    this.onGuildsDirty();
    this.log('🏰 La guilde « ' + name + ' » a été fondée par ' + p.username + '.');
    return { ok: true, guildId: id };
  }

  inviteToGuild(p, targetUsername) {
    const guild = this.guildOf(p);
    if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
    if (guild.leaderId !== p.id) return { ok: false, error: 'Seul le chef de guilde peut inviter.' };
    const target = this.findAccountByUsername(targetUsername);
    if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === p.id) return { ok: false, error: 'Vous êtes déjà dans cette guilde.' };
    if (target.guildId) return { ok: false, error: 'Ce joueur est déjà dans une guilde.' };
    if (guild.members.length >= MAX_GUILD_MEMBERS) return { ok: false, error: 'Guilde complète (' + MAX_GUILD_MEMBERS + ' max).' };
    target.guildInvite = { guildId: guild.id, guildName: guild.name, fromUsername: p.username, at: this.now };
    this.pushSelf(target);
    this.toast(p, 'Invitation envoyée à ' + target.username + '.');
    return { ok: true };
  }

  respondGuildInvite(p, accept) {
    const invite = p.guildInvite;
    if (!invite) return { ok: false, error: 'Aucune invitation en attente.' };
    p.guildInvite = null;
    if (!accept) {
      this.pushSelf(p);
      return { ok: true, declined: true };
    }
    if (p.guildId) {
      this.pushSelf(p);
      return { ok: false, error: 'Vous êtes déjà dans une guilde.' };
    }
    const guild = this.guilds.get(invite.guildId);
    if (!guild) {
      this.pushSelf(p);
      return { ok: false, error: 'Cette guilde n’existe plus.' };
    }
    if (guild.members.length >= MAX_GUILD_MEMBERS) {
      this.pushSelf(p);
      return { ok: false, error: 'Guilde complète.' };
    }
    guild.members.push(p.id);
    p.guildId = guild.id;
    this.pushSelf(p);
    this.onGuildsDirty();
    this.log('🏰 ' + p.username + ' a rejoint la guilde « ' + guild.name + ' ».');
    return { ok: true };
  }

  leaveGuild(p) {
    const guild = this.guildOf(p);
    if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
    guild.members = guild.members.filter((id) => id !== p.id);
    p.guildId = null;
    if (!guild.members.length) {
      this.guilds.delete(guild.id);
      this.log('🏰 La guilde « ' + guild.name + ' » a été dissoute (plus aucun membre).');
    } else if (guild.leaderId === p.id) {
      guild.leaderId = guild.members[0];
      const newLeader = this.players.get(guild.leaderId);
      if (newLeader) this.pushSelf(newLeader);
      this.log('🏰 ' + (newLeader ? newLeader.username : '?') + ' devient chef de « ' + guild.name + ' ».');
    }
    this.pushSelf(p);
    this.onGuildsDirty();
    return { ok: true };
  }

  kickFromGuild(p, targetUsername) {
    const guild = this.guildOf(p);
    if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
    if (guild.leaderId !== p.id) return { ok: false, error: 'Seul le chef de guilde peut exclure un membre.' };
    const target = this.findAccountByUsername(targetUsername);
    if (!target || !guild.members.includes(target.id)) return { ok: false, error: 'Ce joueur n’est pas dans votre guilde.' };
    if (target.id === p.id) return { ok: false, error: 'Vous ne pouvez pas vous exclure vous-même (quittez la guilde).' };
    guild.members = guild.members.filter((id) => id !== target.id);
    target.guildId = null;
    this.pushSelf(target);
    this.onGuildsDirty();
    this.toast(p, target.username + ' a été exclu de la guilde.');
    this.log('🏰 ' + target.username + ' a été exclu de « ' + guild.name + ' ».');
    return { ok: true };
  }

  guildInfo(p) {
    const guild = this.guildOf(p);
    if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
    return {
      ok: true,
      guild: {
        id: guild.id, name: guild.name, leaderId: guild.leaderId, maxMembers: MAX_GUILD_MEMBERS,
        members: this.guildRosterPublic(guild),
      },
    };
  }

  /* ---------- Châteaux de guilde (territoire) ---------- */
  castleOf(terrain) {
    let c = this.castles.get(terrain);
    if (!c) {
      c = { terrain, ownerGuildId: null, hp: 0, hpMax: 0, level: 0 };
      this.castles.set(terrain, c);
    }
    return c;
  }

  castleTileFor(terrain) {
    for (const tile of this.worldMap.tiles.values()) {
      if (tile.content && tile.content.kind === 'castle' && tile.terrain === terrain) return tile;
    }
    return null;
  }

  atCastle(p, terrain) {
    if ((p.mapId || 'world') !== 'world') return false;
    const tile = this.castleTileFor(terrain);
    return !!tile && p.pos.x === tile.x && p.pos.y === tile.y;
  }

  castleDefenseForce(c) {
    const base = 300 + c.level * 150;
    const ratio = c.hpMax ? Math.max(0, Math.min(1, c.hp / c.hpMax)) : 0;
    const woundFactor = CONFIG.COMBAT.WOUND_FLOOR + (1 - CONFIG.COMBAT.WOUND_FLOOR) * ratio;
    return base * woundFactor;
  }

  castlesInfo(p) {
    return CASTLE_TERRAINS.map((terrain) => {
      const c = this.castleOf(terrain);
      const guild = c.ownerGuildId ? this.guilds.get(c.ownerGuildId) : null;
      const tile = this.castleTileFor(terrain);
      return {
        terrain,
        x: tile ? tile.x : 0,
        y: tile ? tile.y : 0,
        ownerGuildId: c.ownerGuildId,
        ownerGuildName: guild ? guild.name : null,
        hp: c.hp,
        hpMax: c.hpMax,
        level: c.level,
        maxLevel: CASTLE_MAX_LEVEL,
        isOwnGuild: !!(p.guildId && c.ownerGuildId === p.guildId),
      };
    });
  }

  claimCastle(p, terrain) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    if (!p.guildId) return { ok: false, error: 'Vous devez être dans une guilde.' };
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour le revendiquer.' };
    const c = this.castleOf(terrain);
    if (c.ownerGuildId) return { ok: false, error: 'Ce château appartient déjà à une guilde.' };
    if ((p.gold || 0) < CASTLE_CLAIM_COST_GOLD) {
      return { ok: false, error: 'Il faut ' + CASTLE_CLAIM_COST_GOLD + ' 🪙 (contribution personnelle) pour fonder.' };
    }
    p.gold -= CASTLE_CLAIM_COST_GOLD;
    c.ownerGuildId = p.guildId;
    c.level = 1;
    c.hpMax = CASTLE_BASE_HP;
    c.hp = c.hpMax;
    this.pushSelf(p);
    this.onGuildsDirty();
    const guild = this.guilds.get(p.guildId);
    this.log('🏰 La guilde « ' + guild.name + ' » a fondé un château en ' + terrain + '.');
    return { ok: true };
  }

  reinforceCastle(p, terrain) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    const c = this.castleOf(terrain);
    if (!c.ownerGuildId) return { ok: false, error: 'Ce château n’a pas encore été fondé.' };
    if (c.ownerGuildId !== p.guildId) return { ok: false, error: 'Vous ne pouvez renforcer que le château de votre guilde.' };
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour le renforcer.' };
    if (c.level >= CASTLE_MAX_LEVEL) return { ok: false, error: 'Niveau de renfort maximum atteint.' };
    if ((p.gold || 0) < CASTLE_REINFORCE_COST_GOLD) {
      return { ok: false, error: 'Il faut ' + CASTLE_REINFORCE_COST_GOLD + ' 🪙.' };
    }
    p.gold -= CASTLE_REINFORCE_COST_GOLD;
    c.level += 1;
    c.hpMax += CASTLE_HP_PER_LEVEL;
    c.hp = Math.min(c.hpMax, c.hp + CASTLE_HP_PER_LEVEL);
    this.pushSelf(p);
    this.onGuildsDirty();
    return { ok: true, level: c.level, hpMax: c.hpMax };
  }

  repairCastle(p, terrain, amountGold) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    const c = this.castleOf(terrain);
    if (!c.ownerGuildId) return { ok: false, error: 'Ce château n’a pas encore été fondé.' };
    if (c.ownerGuildId !== p.guildId) return { ok: false, error: 'Vous ne pouvez réparer que le château de votre guilde.' };
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour le réparer.' };
    if (c.hp >= c.hpMax) return { ok: false, error: 'Déjà à pleine structure.' };
    const budget = Math.max(0, Math.min(Math.floor(Number(amountGold) || 0), p.gold || 0));
    const healed = Math.min(c.hpMax - c.hp, Math.floor(budget / CASTLE_REPAIR_GOLD_PER_HP));
    if (healed <= 0) return { ok: false, error: 'Pas assez d’or (' + CASTLE_REPAIR_GOLD_PER_HP + ' 🪙 par point de structure).' };
    const cost = healed * CASTLE_REPAIR_GOLD_PER_HP;
    p.gold -= cost;
    c.hp += healed;
    this.pushSelf(p);
    this.onGuildsDirty();
    return { ok: true, healed, cost, hp: c.hp, hpMax: c.hpMax };
  }

  /* Lance (ou rejoint) un siège : un lobby de 30 s s'ouvre, comme pour un raid
   * de monstre — les autres membres de la guilde assaillante ont le temps
   * de venir grossir les rangs avant la résolution (voir resolveSiege). */
  createSiege(p, terrain) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    if (!p.guildId) return { ok: false, error: 'Vous devez être dans une guilde.' };
    const c = this.castleOf(terrain);
    if (!c.ownerGuildId) return { ok: false, error: 'Ce château n’appartient à personne — revendiquez-le plutôt.' };
    if (c.ownerGuildId === p.guildId) return { ok: false, error: 'Vous ne pouvez pas assiéger le château de votre propre guilde.' };
    const key = 'siege:' + terrain;
    if (this.raids.has(key)) return this.joinRaid(p, key);
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour lancer l’assaut.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (p.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (' + CONFIG.COSTS.RAID + ' requis).' };
    const tile = this.castleTileFor(terrain);
    p.pa -= CONFIG.COSTS.RAID;
    p.status = 'LOBBY_COMBAT';
    p.raidKey = key;
    this.raids.set(key, {
      key,
      siege: true,
      terrain,
      tileKey: tileKey(tile.x, tile.y),
      mapId: 'world',
      tier: c.level,
      label: 'Château (' + (TERRAINS[terrain] ? TERRAINS[terrain].label : terrain) + ')',
      monsterForce: this.castleDefenseForce(c),
      participants: [p.id],
      leaderId: p.id,
      attackerGuildId: p.guildId,
      defenderGuildId: c.ownerGuildId,
      endsAt: this.now + CONFIG.LOBBY_MS,
    });
    return { ok: true };
  }

  resolveSiege(key, raid) {
    this.raids.delete(key);
    const c = this.castleOf(raid.terrain);
    const members = raid.participants.map((id) => this.memberById(id)).filter(Boolean);
    const attackers = members.filter((m) => m.guildId === raid.attackerGuildId);
    for (const a of attackers) { a.status = 'IDLE'; a.raidKey = null; }
    const guildAtk = this.guilds.get(raid.attackerGuildId);
    const guildDef = c.ownerGuildId ? this.guilds.get(c.ownerGuildId) : null;

    // Le château peut ne plus avoir de propriétaire valide (guilde dissoute
    // pendant le siège) ou appartenir déjà aux assaillants : on annule sans dégâts.
    if (!guildDef || c.ownerGuildId === raid.attackerGuildId) {
      if (!guildDef) c.ownerGuildId = null;
      for (const a of attackers) {
        if (a.bot) continue;
        this.pushSelf(a);
        this.send(a.id, 'siegeResult', { cancelled: true, terrain: raid.terrain, label: raid.label });
      }
      return;
    }

    const force = teamPowerOf(attackers);
    const defense = this.castleDefenseForce(c);
    const chance = winChance(force, defense);
    const victory = this.rng() < chance;
    let captured = false;

    if (!victory) {
      for (const a of attackers) {
        a.hp = Math.max(1, Math.ceil(maxHp(a) * CONFIG.COMBAT.DEATH_HP_PCT));
        a.mapId = 'world';
        a.pos = { x: 0, y: 0 };
      }
      this.log('🏰 L’assaut de « ' + guildAtk.name + ' » contre le château (' + raid.terrain + ') de « ' + guildDef.name + ' » a échoué.');
    } else {
      c.hp = Math.max(0, c.hp - CASTLE_DAMAGE_PER_ASSAULT);
      if (c.hp <= 0) {
        captured = true;
        c.ownerGuildId = raid.attackerGuildId;
        c.hp = Math.round(c.hpMax * 0.5);
        this.log('🏰 « ' + guildAtk.name + ' » a pris le château (' + raid.terrain + ') à « ' + guildDef.name + ' » !');
      } else {
        this.log('🏰 « ' + guildAtk.name + ' » entame le château (' + raid.terrain + ') de « ' + guildDef.name + ' » (' + c.hp + '/' + c.hpMax + ' PS restants).');
      }
      this.onGuildsDirty();
    }

    for (const a of attackers) {
      if (a.bot) continue;
      this.pushSelf(a);
      this.send(a.id, 'siegeResult', {
        victory, captured, chance,
        terrain: raid.terrain,
        label: raid.label,
        teamForce: Math.round(force),
        defenseForce: Math.round(defense),
        hp: c.hp,
        hpMax: c.hpMax,
        attackerGuildName: guildAtk.name,
        defenderGuildName: guildDef.name,
        participants: attackers.map((m) => m.username),
      });
    }
  }

  /* ---------- Amis ---------- */
  sendFriendRequest(p, targetUsername) {
    const target = this.findAccountByUsername(targetUsername);
    if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === p.id) return { ok: false, error: 'Impossible de vous ajouter vous-même.' };
    if (p.friends.includes(target.id)) return { ok: false, error: target.username + ' est déjà votre ami.' };
    if (target.friendRequests.some((r) => r.fromId === p.id)) return { ok: false, error: 'Demande déjà envoyée.' };
    // Symétrie : si l'autre nous a déjà envoyé une demande, on l'accepte directement
    const reciprocalIdx = p.friendRequests.findIndex((r) => r.fromId === target.id);
    if (reciprocalIdx >= 0) {
      p.friendRequests.splice(reciprocalIdx, 1);
      p.friends.push(target.id);
      target.friends.push(p.id);
      this.pushSelf(p);
      this.pushSelf(target);
      this.toast(p, target.username + ' est maintenant votre ami.');
      this.toast(target, p.username + ' est maintenant votre ami.');
      return { ok: true, addedDirectly: true };
    }
    target.friendRequests.push({ fromId: p.id, fromUsername: p.username, at: this.now });
    this.pushSelf(target);
    this.toast(p, 'Demande d’ami envoyée à ' + target.username + '.');
    return { ok: true };
  }

  respondFriendRequest(p, fromId, accept) {
    const idx = p.friendRequests.findIndex((r) => r.fromId === String(fromId));
    if (idx < 0) return { ok: false, error: 'Demande introuvable.' };
    const req = p.friendRequests[idx];
    p.friendRequests.splice(idx, 1);
    const from = this.players.get(req.fromId);
    if (!accept) {
      this.pushSelf(p);
      if (from) this.toast(from, p.username + ' a refusé votre demande d’ami.');
      return { ok: true, declined: true };
    }
    if (!from) {
      this.pushSelf(p);
      return { ok: false, error: 'Ce joueur n’existe plus.' };
    }
    p.friends.push(from.id);
    from.friends.push(p.id);
    this.pushSelf(p);
    this.pushSelf(from);
    this.toast(from, p.username + ' a accepté votre demande d’ami.');
    return { ok: true };
  }

  removeFriend(p, targetUsername) {
    const target = this.findAccountByUsername(targetUsername);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    if (!p.friends.includes(target.id)) return { ok: false, error: 'Vous n’êtes pas amis.' };
    p.friends = p.friends.filter((id) => id !== target.id);
    target.friends = target.friends.filter((id) => id !== p.id);
    this.pushSelf(p);
    this.pushSelf(target);
    return { ok: true };
  }

  friendsList(p) {
    return p.friends.map((id) => {
      const f = this.players.get(id);
      if (!f) return null;
      return {
        id: f.id,
        username: f.username,
        online: !!f.online,
        classLabel: (CLASSES[f.speciesClass] && CLASSES[f.speciesClass].label) || f.speciesClass,
      };
    }).filter(Boolean);
  }

  /* ---------- Historique de discussion (coordination asynchrone) ---------- */
  recordChat(entry) {
    this.chatLog.push({ ...entry, at: this.now });
    if (this.chatLog.length > CHAT_LOG_MAX) this.chatLog.shift();
    this.onChatDirty();
  }

  /* Ce qu'un joueur a le droit de revoir en se (re)connectant : le général
   * pour tout le monde, la guilde courante, et les MP qui le concernent. */
  chatHistoryFor(p) {
    return this.chatLog
      .filter((m) => {
        if (m.channel === 'guild') return !!p.guildId && m.guildId === p.guildId;
        if (m.channel === 'whisper') return m.fromId === p.id || m.toId === p.id;
        return true;
      })
      .map((m) => ({ from: m.from, to: m.to, text: m.text, type: m.type, channel: m.channel }));
  }

  raidsPayload() {
    return [...this.raids.values()].map((r) => ({
      key: r.key,
      siege: !!r.siege,
      tileKey: r.tileKey,
      mapId: r.mapId,
      tier: r.tier,
      label: r.label,
      monsterForce: r.monsterForce,
      endsAt: r.endsAt,
      leaderId: r.leaderId,
      participants: r.participants,
      teamForce: this.teamForce(r),
      winChance: this.raidChance(r),
    }));
  }

  mapDiffs() {
    const out = {};
    for (const [mapId, map] of this.maps) {
      out[mapId] = [];
      for (const [key, tile] of map.tiles) {
        if (tile.content && tile.content.inactiveUntil > this.now) out[mapId].push([key, tile.content.inactiveUntil]);
      }
    }
    return out;
  }

  worldDiffs() {
    const diffs = [];
    for (const [mapId, map] of this.maps) {
      for (const [key, tile] of map.tiles) {
        if (tile.content && tile.content.inactiveUntil > this.now) diffs.push([mapId + '|' + key, tile.content.inactiveUntil]);
      }
    }
    return diffs;
  }

  spawnBots() {
    for (let i = 0; i < CONFIG.BOT_COUNT; i++) {
      const classes = Object.keys(CLASSES);
      const cls = classes[Math.floor(Math.random() * classes.length)];
      const tier = 1 + Math.floor(Math.random() * 3);
      let x = 0, y = 0, tries = 0;
      do {
        const a = Math.random() * Math.PI * 2;
        const d = 4 + Math.random() * 10;
        x = Math.round(Math.cos(a) * d);
        y = Math.round(Math.sin(a) * d);
        tries++;
      } while (!isWalkable(this.worldMap.tiles, x, y) && tries < 50);
      const bot = {
        id: 'bot' + i, username: BOT_NAMES[i % BOT_NAMES.length], speciesClass: cls, bot: true,
        mapId: 'world',
        pos: { x, y }, home: { x, y },
        pa: 100,
        harvestLevel: tier, weaponMastery: tier,
        weapon: { tier: Math.max(0, tier - 1), type: CLASS_GEAR[cls].weapon },
        armor: { tier: Math.max(0, tier - 1), type: CLASS_GEAR[cls].armor },
        inventory: {},
        status: 'IDLE', raidKey: null,
        nextThink: Math.random() * CONFIG.BOT_TICK_MS,
      };
      bot.hp = maxHp(bot);
      this.bots.set('bot' + i, bot);
    }
  }

  tick(dtReal) {
    const dt = dtReal * this.speed;
    this.now += dt;

    for (const p of this.players.values()) {
      if (!p.online) continue;
      p.paMs += dt;
      while (p.paMs >= CONFIG.PA.REGEN_MS) {
        p.paMs -= CONFIG.PA.REGEN_MS;
        if (p.pa < CONFIG.PA.MAX) p.pa++;
      }
      p.hpMs += dt;
      while (p.hpMs >= CONFIG.HP.REGEN_MS) {
        p.hpMs -= CONFIG.HP.REGEN_MS;
        if (p.hp < maxHp(p)) p.hp++;
      }
      if (p.status === 'HARVESTING' && this.now >= p.harvestEndsAt) this.finishHarvest(p);
    }

    for (const [key, raid] of [...this.raids]) {
      if (this.now >= raid.endsAt) {
        if (raid.siege) this.resolveSiege(key, raid);
        else this.resolveRaid(key, raid);
      }
    }

    for (const b of this.bots.values()) {
      if (this.now >= b.nextThink) {
        b.nextThink = this.now + CONFIG.BOT_TICK_MS * (0.7 + Math.random() * 0.6);
        this.botThink(b);
      }
    }

    this.pendingReplies = this.pendingReplies.filter((r) => {
      if (this.now >= r.at) { this.broadcast('chat', r.msg); return false; }
      return true;
    });
  }

  move(p, dx, dy) {
    const tiles = this.tilesOf(p);
    dx = Math.round(Number(dx) || 0);
    dy = Math.round(Number(dy) || 0);
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return { ok: false, error: 'Case non adjacente.' };
    if (p.pa < CONFIG.COSTS.MOVE) return { ok: false, error: 'Pas assez de PA.' };
    const nx = p.pos.x + dx;
    const ny = p.pos.y + dy;
    if (!isWalkable(tiles, nx, ny)) return { ok: false, error: 'Case bloquée.' };
    p.pa -= CONFIG.COSTS.MOVE;
    p.pos = { x: nx, y: ny };

    // Marcher sur un village le « découvre » : téléporteur débloqué
    const arrived = tiles.get(tileKey(nx, ny));
    if (arrived && arrived.content && arrived.content.kind === 'village') {
      const vk = tileKey(nx, ny);
      if (!p.visitedVillages.includes(vk)) {
        p.visitedVillages.push(vk);
        this.plog(p, '📍 ' + (arrived.content.name || 'Village') + ' découvert — téléporteur débloqué !');
      }
    }
    return { ok: true };
  }

  harvest(p, x, y) {
    const tile = this.tilesOf(p).get(tileKey(x, y));
    const node = tile && tile.content;
    if (!node || node.kind !== 'resource') return { ok: false, error: 'Rien à récolter ici.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(p.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (this.now < node.inactiveUntil) return { ok: false, error: 'Gisement épuisé.' };
    const reqTier = Math.min(5, node.tier);
    if (p.harvestLevel < reqTier) return { ok: false, error: 'Niveau de récolte insuffisant (T' + reqTier + ' requis).' };
    if (p.pa < CONFIG.COSTS.HARVEST) return { ok: false, error: 'Pas assez de PA (2 requis).' };
    p.pa -= CONFIG.COSTS.HARVEST;
    p.status = 'HARVESTING';
    p.harvestKey = this.raidId(p.mapId, x, y);
    p.harvestEndsAt = this.now + CONFIG.HARVEST_MS;
    return { ok: true, duration: CONFIG.HARVEST_MS };
  }

  finishHarvest(p) {
    const [mapId, key] = String(p.harvestKey || '').split('|');
    const tile = this.mapOf(mapId || p.mapId).tiles.get(key || '');
    if (!tile || !tile.content) return;
    const node = tile.content;
    p.status = 'IDLE';
    p.harvestKey = null;
    const qty = 3 + Math.floor(Math.random() * 3);
    const invKey = stackKey(node.type, node.tier);
    p.inventory[invKey] = (p.inventory[invKey] || 0) + qty;
    node.inactiveUntil = this.now + (node.dungeonResource ? CONFIG.RESPAWN_DUNGEON_RESOURCE_MS : CONFIG.RESPAWN_RESOURCE_MS);
    // Sans ce broadcast, les clients ne voient jamais le nœud passer en repousse
    this.broadcast('world', { mapId: mapId || p.mapId || 'world', key, inactiveUntil: node.inactiveUntil });
    p.harvestXp += 8 + Math.min(5, node.tier) * 6;
    this.checkLevelUp(p, 'harvest');
    this.pushSelf(p);
  }

  createRaid(p, x, y) {
    const tile = this.tilesOf(p).get(tileKey(x, y));
    const monster = tile && tile.content;
    const key = this.raidId(p.mapId, x, y);
    if (!monster || monster.kind !== 'monster') return { ok: false, error: 'Aucun monstre ici.' };
    if (this.now < monster.inactiveUntil) return { ok: false, error: 'Ce groupe est déjà vaincu.' };
    if (this.raids.has(key)) return this.joinRaid(p, key);
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(p.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (p.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (5 requis).' };
    p.pa -= CONFIG.COSTS.RAID;
    p.status = 'LOBBY_COMBAT';
    p.raidKey = key;
    this.raids.set(key, {
      key,
      tileKey: tileKey(x, y),
      mapId: p.mapId,
      tier: monster.tier,
      label: monster.label,
      monsterForce: monster.force,
      participants: [p.id],
      leaderId: p.id,
      endsAt: this.now + CONFIG.LOBBY_MS,
    });
    return { ok: true };
  }

  joinRaid(p, key) {
    key = this.normalizeRaidKey(p, key);
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.mapId !== p.mapId) return { ok: false, error: 'Ce lobby est sur une autre carte.' };
    if (raid.siege && p.guildId !== raid.attackerGuildId) {
      return { ok: false, error: 'Seuls les membres de la guilde assaillante peuvent rejoindre ce siège.' };
    }
    if (raid.participants.includes(p.id)) return { ok: false, error: 'Vous êtes déjà dans ce lobby.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    const tile = this.tilesOf(p).get(raid.tileKey);
    if (this.chebyshev(p.pos, tile) > CONFIG.JOIN_RADIUS) return { ok: false, error: 'Trop loin pour rejoindre.' };
    if (p.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (5 requis).' };
    p.pa -= CONFIG.COSTS.RAID;
    p.status = 'LOBBY_COMBAT';
    p.raidKey = key;
    raid.participants.push(p.id);
    return { ok: true };
  }

  startRaidNow(p, key) {
    key = this.normalizeRaidKey(p, key);
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.leaderId !== p.id) return { ok: false, error: 'Seul le créateur peut lancer le combat.' };
    raid.endsAt = this.now;
    return { ok: true };
  }

  botJoinRaid(bot, raid) {
    bot.status = 'LOBBY_COMBAT';
    bot.raidKey = raid.key;
    raid.participants.push(bot.id);
  }

  teamForce(raid) {
    const members = raid.participants.map((id) => this.memberById(id)).filter(Boolean);
    return teamPowerOf(members);
  }

  raidChance(raid) {
    return winChance(this.teamForce(raid), raid.monsterForce);
  }

  resolveRaid(key, raid) {
    this.raids.delete(key);
    const tile = this.mapOf(raid.mapId).tiles.get(raid.tileKey);
    if (!tile || !tile.content) return;
    const monster = tile.content;
    const members = raid.participants.map((id) => this.memberById(id)).filter(Boolean);
    const humans = members.filter((p) => !p.bot);
    const force = this.teamForce(raid);
    // Combat probabiliste : le sort en décide, à hauteur des puissances
    const chance = winChance(force, raid.monsterForce);
    const victory = this.rng() < chance;
    const druid = victory && members.some((p) => p.speciesClass === 'CERF_DRUIDE');
    const rampart = members.some((p) => p.speciesClass === 'OURS_GUERRIER');

    const rewards = new Map();   // accountId -> { loot, gold, xp }
    const lossById = new Map();  // accountId -> PV perdus (victoire)
    for (const p of members) {
      p.status = 'IDLE';
      p.raidKey = null;

      if (!victory) {
        // Défaite = mort : rapatriement à la Capitale, sans autre pénalité
        p.hp = Math.max(1, Math.ceil(maxHp(p) * CONFIG.COMBAT.DEATH_HP_PCT));
        if (p.bot) {
          p.pos = { ...p.home };
        } else {
          p.mapId = 'world';
          p.pos = { x: 0, y: 0 };
          this.pushSelf(p);
        }
        continue;
      }

      // Victoire : usure (réduite par l'armure, le Rempart et le Bouillon),
      // soignée par la Sève
      let loss = 4 + monster.tier * 3;
      loss *= hpLossReduction(p);
      if (rampart) loss *= 0.7;
      loss *= buffLossReduction(p);
      loss = Math.max(1, Math.round(loss));
      p.hp = Math.max(1, p.hp - loss);
      if (!p.bot) lossById.set(p.id, loss);
      if (druid) p.hp = Math.min(maxHp(p), p.hp + Math.round(maxHp(p) * CONFIG.COMBAT.DRUID_HEAL_PCT));

      if (victory && !p.bot) {
        // Les monstres lâchent de l'or (+ XP) et, parfois, un ingrédient
        // de cuisine de leur tier — les autres ressources viennent de la récolte.
        const xp = 15 + Math.min(5, monster.tier) * 15;
        p.weaponXp += xp;
        // Chapardeur (Renard Voleur) : +50 % d'or pour lui
        const lootMult = p.speciesClass === 'RENARD_VOLEUR' ? 1.5 : 1;
        // Territoire : la guilde propriétaire du château de la zone bonifie l'or de ses membres
        const zoneMult = (p.guildId && tile.terrain && this.castleOf(tile.terrain).ownerGuildId === p.guildId)
          ? CASTLE_ZONE_GOLD_BONUS : 1;
        const gold = Math.ceil(rollGoldLoot(monster.tier) * lootMult * zoneMult);
        p.gold = (p.gold || 0) + gold;
        let food = null;
        if (this.rng() < CONFIG.FOOD_DROP_CHANCE) {
          food = foodDropFor(monster.tier);
          p.inventory[food] = (p.inventory[food] || 0) + 1;
        }
        rewards.set(p.id, { gold, xp, food });
        this.checkLevelUp(p, 'weapon');
      }
      if (!p.bot) this.pushSelf(p);
    }

    // Les buffs de cuisine se consument à chaque combat, victoire ou défaite
    for (const p of humans) {
      if (!p.buff) continue;
      p.buff.combats -= 1;
      if (p.buff.combats <= 0) {
        this.plog(p, 'Les effets de votre ' + CONSUMABLES[p.buff.type].label + ' se dissipent.');
        delete p.buff;
      }
    }

    if (victory) {
      if (monster.boss) monster.inactiveUntil = 0;
      else if (monster.dungeonMob) monster.inactiveUntil = this.now + CONFIG.RESPAWN_DUNGEON_MONSTER_MS;
      else monster.inactiveUntil = this.now + CONFIG.RESPAWN_MONSTER_MS;
      // Diffuse l'état vaincu du monstre à tous les clients
      this.broadcast('world', { mapId: raid.mapId || 'world', key: raid.tileKey, inactiveUntil: monster.inactiveUntil });
      this.updateDungeonProgress(raid.mapId, monster, true);
    }
    this.log('⚔ Raid ' + raid.label + ' T' + raid.tier + ' : ' +
      (victory ? 'VICTOIRE' : 'DEFAITE — l’équipe a péri') +
      ' (' + Math.round(chance * 100) + ' % de chances, équipe ' + force + ' vs ' + raid.monsterForce + ')');

    for (const p of humans) {
      const rw = rewards.get(p.id);
      this.send(p.id, 'result', {
        victory,
        died: !victory,
        chance,
        label: raid.label,
        tier: raid.tier,
        teamForce: force,
        monsterForce: raid.monsterForce,
        participants: members.map((m) => m.username),
        gold: rw ? rw.gold : 0,
        food: rw ? rw.food : null,
        hpLoss: lossById.get(p.id) || 0,
        xp: rw ? rw.xp : 0,
        druid,
      });
    }
  }

  atSanctuaryPlayer(p) {
    if (p.mapId !== 'world') return false;
    const tile = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    return !!(tile && tile.content && (tile.content.kind === 'capital' || tile.content.kind === 'village'));
  }

  createCharacter(p, speciesClass) {
    if (!CLASSES[speciesClass]) return { ok: false, error: 'Classe invalide.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuaryPlayer(p)) return { ok: false, error: 'L’éveil d’une nouvelle forme se fait à la Capitale ou dans un village.' };
    if (p.characters.length >= p.charSlots) return { ok: false, error: 'Tous vos emplacements sont occupés.' };
    if (p.characters.some((c) => c.speciesClass === speciesClass)) return { ok: false, error: 'Vous incarnez déjà cette forme.' };
    syncActiveCharacter(p);
    p.characters.push(newCharacter(speciesClass));
    this.skinStateOf(p);
    this.pushSelf(p);
    return { ok: true, index: p.characters.length - 1 };
  }

  switchCharacter(p, index) {
    index = Math.floor(Number(index));
    if (!(index >= 0 && index < p.characters.length)) return { ok: false, error: 'Forme inconnue.' };
    if (index === p.activeChar) return { ok: false, error: 'Cette forme est déjà active.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuaryPlayer(p)) return { ok: false, error: 'La métamorphose se fait à la Capitale ou dans un village.' };
    const pct = Math.max(0, Math.min(1, p.hp / maxHp(p)));
    syncActiveCharacter(p);
    applyCharacter(p, index);
    p.hp = Math.max(1, Math.round(pct * maxHp(p)));
    this.pushSelf(p);
    return { ok: true };
  }

  enterDungeon(p, mapId) {
    const tile = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    if (!tile || !tile.content || tile.content.kind !== 'dungeon') return { ok: false, error: 'Vous devez être sur une entrée de donjon.' };
    if (tile.content.mapId !== mapId) return { ok: false, error: 'Entrée invalide.' };
    const map = this.mapOf(mapId);
    this.resetTravelState(p);
    p.mapId = map.id;
    p.pos = this.nearestWalkablePos(map, map.entry);
    this.pushMap(p);
    this.pushSelf(p);
    return { ok: true };
  }

  usePortal(p) {
    const tile = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    if (!tile || !tile.content || tile.content.kind !== 'portal') return { ok: false, error: 'Aucun portail ici.' };
    const map = this.mapOf(tile.content.targetMapId || 'world');
    this.resetTravelState(p);
    p.mapId = map.id;
    p.pos = this.nearestWalkablePos(map, tile.content.targetPos);
    this.pushMap(p);
    this.pushSelf(p);
    return { ok: true };
  }

  teleportVillage(p, x, y) {
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (p.mapId !== 'world') return { ok: false, error: 'Vous devez revenir dans le monde pour voyager.' };
    const from = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    if (!from || !from.content || (from.content.kind !== 'village' && from.content.kind !== 'capital')) {
      return { ok: false, error: 'Vous devez être dans un village ou à la Capitale pour voyager.' };
    }
    const dest = this.worldMap.tiles.get(tileKey(Number(x), Number(y)));
    if (!dest || !dest.content || (dest.content.kind !== 'village' && dest.content.kind !== 'capital')) return { ok: false, error: 'Destination invalide.' };
    // Un village doit avoir été découvert à pied avant d'être une destination
    if (dest.content.kind === 'village' && !p.visitedVillages.includes(tileKey(dest.x, dest.y))) {
      return { ok: false, error: 'Village inconnu — vous devez d’abord le découvrir à pied.' };
    }
    p.pos = { x: dest.x, y: dest.y };
    this.pushSelf(p);
    return { ok: true };
  }

  upgrade(p, slot) {
    if (p.mapId !== 'world' || p.pos.x !== 0 || p.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale (0,0).' };
    const item = p[slot];
    const target = item.tier + 1;
    if (target > 5) return { ok: false, error: 'Tier maximum atteint.' };
    if (p.weaponMastery < target) return { ok: false, error: 'Maîtrise d’arme T' + target + ' requise.' };
    const recipe = UPGRADE_RECIPES[slot][target];
    for (const k in recipe) {
      if ((p.inventory[k] || 0) < recipe[k]) return { ok: false, error: 'Ressources insuffisantes.' };
    }
    const paCost = CONFIG.COSTS.UPGRADE[target];
    if (p.pa < paCost) return { ok: false, error: 'Pas assez de PA (' + paCost + ' requis).' };
    for (const k in recipe) {
      p.inventory[k] -= recipe[k];
      if (p.inventory[k] <= 0) delete p.inventory[k];
    }
    p.pa -= paCost;
    item.tier = target;
    if (slot === 'armor') p.hp = Math.min(maxHp(p), p.hp + 15);
    this.pushSelf(p);
    return { ok: true };
  }

  rest(p) {
    if (p.mapId !== 'world' || p.pos.x !== 0 || p.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale.' };
    p.hp = maxHp(p);
    this.pushSelf(p);
    return { ok: true };
  }

  /* ---------- Cuisine : la Marmite (Capitale + villages) ---------- */
  cook(p, item, tier) {
    tier = Math.floor(Number(tier));
    if (!CONSUMABLES[item]) return { ok: false, error: 'Recette inconnue.' };
    if (!(tier >= 1 && tier <= 6)) return { ok: false, error: 'Tier invalide.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuaryPlayer(p)) return { ok: false, error: 'La Marmite se trouve à la Capitale et dans les villages.' };

    const recipe = CONSUMABLE_RECIPES[tier];
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') {
        if ((p.gold || 0) < n) return { ok: false, error: 'Pas assez d’or (' + n + ' 🪙 requis).' };
      } else if ((p.inventory[k] || 0) < n) {
        const r = parseStackKey(k);
        return { ok: false, error: 'Il manque : ' + n + '× ' + resourceLabel(r.type, r.tier) + '.' };
      }
    }
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') p.gold -= n;
      else {
        p.inventory[k] -= n;
        if (p.inventory[k] <= 0) delete p.inventory[k];
      }
    }
    const key = stackKey(item, tier);
    p.inventory[key] = (p.inventory[key] || 0) + 1;
    this.plog(p, CONSUMABLES[item].icon + ' ' + CONSUMABLES[item].label + ' T' + tier + ' cuisiné !');
    return { ok: true };
  }

  consume(p, key) {
    const parsed = parseStackKey(String(key));
    const item = CONSUMABLES[parsed.type];
    if (!item) return { ok: false, error: 'Objet inconnu.' };
    if ((p.inventory[key] || 0) < 1) return { ok: false, error: 'Vous n’en avez plus.' };

    p.inventory[key] -= 1;
    if (p.inventory[key] <= 0) delete p.inventory[key];

    if (item.kind === 'instant') {
      const heal = Math.round(maxHp(p) * CONSUMABLE_EFFECTS[parsed.type][parsed.tier]);
      p.hp = Math.min(maxHp(p), p.hp + heal);
      this.toast(p, item.icon + ' +' + heal + ' PV');
    } else {
      p.buff = { type: parsed.type, tier: parsed.tier, combats: BUFF_COMBATS };
      this.toast(p, item.icon + ' ' + item.label + ' T' + parsed.tier + ' actif (' + BUFF_COMBATS + ' combats)');
      // Le % de victoire du lobby en cours (raid ou siège) reflétera le buff au
      // prochain broadcast périodique de raidsPayload() (toutes les 500 ms).
    }
    return { ok: true };
  }

  setAdminTier(p, kind, tier) {
    if (!p || p.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    return this.applyLevelTier(p, kind, tier);
  }

  applyLevelTier(p, kind, tier) {
    const target = Math.max(1, Math.min(6, Number(tier) || 1));
    if (kind === 'harvest') {
      p.harvestLevel = target;
      p.harvestXp = target >= 6 ? XP_LEVELS[XP_LEVELS.length - 1] : XP_LEVELS[target - 1];
      this.pushSelf(p);
      return { ok: true };
    }
    if (kind === 'weapon') {
      p.weaponMastery = target;
      p.weaponXp = target >= 6 ? XP_LEVELS[XP_LEVELS.length - 1] : XP_LEVELS[target - 1];
      this.pushSelf(p);
      return { ok: true };
    }
    return { ok: false, error: 'Catégorie admin inconnue.' };
  }

  setAdminGear(p, slot, tier) {
    if (!p || p.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    return this.applyGearTier(p, slot, tier);
  }

  applyGearTier(p, slot, tier) {
    const target = Math.max(0, Math.min(6, Number(tier) || 0));
    if (slot === 'weapon') {
      p.weapon.tier = target;
      this.pushSelf(p);
      return { ok: true };
    }
    if (slot === 'armor') {
      p.armor.tier = target;
      p.hp = Math.min(p.hp, maxHp(p));
      this.pushSelf(p);
      return { ok: true };
    }
    return { ok: false, error: 'Équipement admin inconnu.' };
  }

  adminSpawnBoss(p) {
    const map = this.mapOf(p.mapId || 'world');
    if (!map || map.kind !== 'dungeon' || !map.dungeon) return { ok: false, error: 'Vous devez être dans un donjon.' };
    const state = map.dungeon;
    const bossTile = map.tiles.get(state.bossTileKey);
    if (!bossTile) return { ok: false, error: 'Boss introuvable.' };
    state.kills = state.killsRequired;
    state.bossAlive = true;
    bossTile.content = { ...state.bossTemplate };
    this.pushMapState(map.id);
    this.pushSelf(p);
    return { ok: true };
  }

  dev(p, action) {
    if (!p || p.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    if (action && action.reset) {
      this.players.delete(p.id);
      if (p.token) this.tokens.delete(p.token);
      return { ok: true, reset: true };
    }
    if (action && action.pa) {
      p.pa = Math.min(CONFIG.PA.MAX, p.pa + Number(action.pa || 0));
      this.pushSelf(p);
      return { ok: true };
    }
    if (action && action.spawnBoss) return this.adminSpawnBoss(p);
    if (action && action.speed) {
      this.speed = Math.max(1, Number(action.speed) || 1);
      return { ok: true };
    }
    return { ok: false, error: 'Action dev inconnue.' };
  }

  /* ---------- Administration (rôle admin uniquement) ---------- */
  adminFindTarget(username) {
    return this.players.get('p_' + String(username || '').trim().toLowerCase()) || null;
  }

  adminStats() {
    const players = [...this.players.values()];
    const byClass = {};
    for (const p of players) byClass[p.speciesClass] = (byClass[p.speciesClass] || 0) + 1;
    return {
      total: players.length,
      online: players.filter((p) => p.online).length,
      admins: players.filter((p) => p.role === 'admin').length,
      byClass,
    };
  }

  adminPlayerList() {
    return [...this.players.values()].map((p) => ({
      username: p.username,
      role: p.role || 'user',
      online: !!p.online,
      createdAt: (this.credentials.get(p.id) || {}).createdAt || null,
      speciesClass: p.speciesClass,
      classLabel: (CLASSES[p.speciesClass] || {}).label || p.speciesClass,
      harvestLevel: p.harvestLevel,
      weaponMastery: p.weaponMastery,
      weaponTier: p.weapon ? p.weapon.tier : null,
      armorTier: p.armor ? p.armor.tier : null,
      gold: p.gold || 0,
      premium: p[PREMIUM_CURRENCY.key] || 0,
      charSlots: p.charSlots,
      charCount: (p.characters || []).length,
    })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  adminSetRole(admin, username, role) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    if (role !== 'user' && role !== 'admin') return { ok: false, error: 'Rôle invalide.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    target.role = role;
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantSlot(admin, username, count) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const current = target.charSlots || CONFIG.FREE_CHAR_SLOTS;
    if (current >= MAX_CHAR_SLOTS) return { ok: false, error: 'Déjà au maximum (' + MAX_CHAR_SLOTS + ' — une par classe).' };
    const n = Math.max(1, Math.min(10, Math.floor(Number(count)) || 1));
    target.charSlots = Math.min(MAX_CHAR_SLOTS, current + n);
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantGold(admin, username, amount) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const n = Math.floor(Number(amount)) || 0;
    target.gold = Math.max(0, (target.gold || 0) + n);
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantPremium(admin, username, amount) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const n = Math.floor(Number(amount)) || 0;
    target[PREMIUM_CURRENCY.key] = Math.max(0, (target[PREMIUM_CURRENCY.key] || 0) + n);
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantItem(admin, username, key, qty) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const parsed = parseStackKey(String(key));
    if (!RESOURCES[parsed.type] && !CONSUMABLES[parsed.type]) return { ok: false, error: 'Objet inconnu.' };
    const n = Math.max(1, Math.min(999, Math.floor(Number(qty)) || 1));
    target.inventory[key] = (target.inventory[key] || 0) + n;
    this.pushSelf(target);
    return { ok: true };
  }

  adminSetLevel(admin, username, kind, tier) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    return this.applyLevelTier(target, kind, tier);
  }

  adminSetGear(admin, username, slot, tier) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    return this.applyGearTier(target, slot, tier);
  }

  say(p, text, channel, targetUsername) {
    text = String(text || '').trim().slice(0, 120);
    if (!text) return { ok: false, error: 'Message vide.' };
    channel = (channel === 'guild' || channel === 'whisper') ? channel : 'general';

    if (channel === 'guild') {
      const guild = this.guildOf(p);
      if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
      const payload = { from: p.username, text, type: 'chat', channel: 'guild' };
      this.recordChat({ ...payload, fromId: p.id, guildId: guild.id });
      for (const id of guild.members) {
        const m = this.players.get(id);
        if (m && m.online) this.send(m.id, 'chat', payload);
      }
      return { ok: true };
    }

    if (channel === 'whisper') {
      const target = this.findAccountByUsername(targetUsername);
      if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
      if (target.id === p.id) return { ok: false, error: 'Impossible de vous écrire à vous-même.' };
      if (!p.friends.includes(target.id)) return { ok: false, error: 'Les messages privés sont réservés à vos amis.' };
      const payload = { from: p.username, to: target.username, text, type: 'chat', channel: 'whisper' };
      this.recordChat({ ...payload, fromId: p.id, toId: target.id });
      this.send(p.id, 'chat', payload);
      if (target.online) this.send(target.id, 'chat', payload);
      return { ok: true, offline: !target.online };
    }

    const generalPayload = { from: p.username, text, type: 'chat', channel: 'general' };
    this.recordChat({ ...generalPayload, fromId: p.id });
    this.broadcast('chat', generalPayload);
    if (Math.random() < 0.5) {
      const bots = [...this.bots.values()];
      const bot = bots[Math.floor(Math.random() * bots.length)];
      this.pendingReplies.push({
        at: this.now + 1500 + Math.random() * 3500,
        msg: { from: bot.username, text: BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)], type: 'chat', channel: 'general' },
      });
    }
    return { ok: true };
  }

  checkLevelUp(p, kind) {
    if (kind === 'harvest') {
      const lvl = levelFromXp(p.harvestXp);
      if (lvl > p.harvestLevel) p.harvestLevel = lvl;
    } else {
      const lvl = levelFromXp(p.weaponXp);
      if (lvl > p.weaponMastery) p.weaponMastery = lvl;
    }
  }

  botThink(bot) {
    if (bot.status !== 'IDLE' || bot.mapId !== 'world') return;
    for (const raid of this.raids.values()) {
      if (raid.mapId !== 'world') continue;
      const tile = this.worldMap.tiles.get(raid.tileKey);
      const d = this.chebyshev(bot.pos, tile);
      if (d <= CONFIG.JOIN_RADIUS + 5 && this.teamForce(raid) < raid.monsterForce * 1.15) {
        if (d <= CONFIG.JOIN_RADIUS) { this.botJoinRaid(bot, raid); return; }
        this.botStepToward(bot, tile.x, tile.y);
        return;
      }
    }
    if (Math.random() < 0.25) return;
    const tx = bot.home.x + Math.round((Math.random() - 0.5) * 12);
    const ty = bot.home.y + Math.round((Math.random() - 0.5) * 12);
    this.botStepToward(bot, tx, ty);
  }

  botStepToward(bot, tx, ty) {
    const dx = Math.sign(tx - bot.pos.x);
    const dy = Math.sign(ty - bot.pos.y);
    const options = [[dx, dy], [dx, 0], [0, dy]].filter(([a, b]) => a || b);
    for (const [a, b] of options) {
      if (isWalkable(this.worldMap.tiles, bot.pos.x + a, bot.pos.y + b)) {
        bot.pos = { x: bot.pos.x + a, y: bot.pos.y + b };
        return;
      }
    }
  }

  serialize() {
    const credentials = {};
    for (const [id, cred] of this.credentials) credentials[id] = cred;
    return {
      seed: this.seed,
      now: this.now,
      speed: this.speed,
      players: [...this.players.values()],
      credentials,
      guilds: [...this.guilds.values()],
      castles: [...this.castles.values()],
      chatLog: this.chatLog,
      mapDiffs: this.mapDiffs(),
      mapStates: this.mapStates(),
      worldDiffs: this.worldDiffs(),
      savedAt: Date.now(),
    };
  }

  load(data) {
    this.now = data.now || 0;
    this.speed = data.speed || 1;
    for (const p of data.players || []) {
      p.online = false;
      p.status = 'IDLE';
      p.harvestKey = null;
      p.raidKey = null;
      p.tradeId = null;
      if (!Array.isArray(p.characters) || !p.characters.length) {
        const c = {};
        for (const f of CHARACTER_FIELDS) c[f] = p[f];
        p.characters = [c];
        p.activeChar = 0;
      }
      if (!p.mapId) p.mapId = 'world';
      if (typeof p.charSlots !== 'number') p.charSlots = CONFIG.FREE_CHAR_SLOTS;
      p.charSlots = Math.min(p.charSlots, MAX_CHAR_SLOTS);
      if (typeof p.gold !== 'number') p.gold = 0;
      if (typeof p[PREMIUM_CURRENCY.key] !== 'number') p[PREMIUM_CURRENCY.key] = 0;
      if (!Array.isArray(p.ownedSkins)) p.ownedSkins = [];
      if (!Array.isArray(p.visitedVillages)) p.visitedVillages = [];
      if (p.role !== 'admin' && p.role !== 'user') p.role = 'user';
      if (!p.duels || typeof p.duels.wins !== 'number') p.duels = { wins: 0, losses: 0 };
      if (typeof p.guildId !== 'string') p.guildId = null;
      if (!p.guildInvite || typeof p.guildInvite !== 'object') p.guildInvite = null;
      if (!Array.isArray(p.friends)) p.friends = [];
      if (!Array.isArray(p.friendRequests)) p.friendRequests = [];
      // Rééquilibrage des PV par classe : évite qu'un compte existant se
      // retrouve avec plus de PV affichés que son nouveau maximum.
      p.hp = Math.min(p.hp, maxHp(p));
      this.skinStateOf(p);
      this.players.set(p.id, p);
      if (p.token) this.tokens.set(p.token, p.id);
    }
    for (const [id, cred] of Object.entries(data.credentials || {})) this.credentials.set(id, cred);
    for (const g of data.guilds || []) {
      if (g && g.id) this.guilds.set(g.id, g);
    }
    for (const c of data.castles || []) {
      if (c && c.terrain) this.castles.set(c.terrain, c);
    }
    if (Array.isArray(data.chatLog)) this.chatLog = data.chatLog.slice(-CHAT_LOG_MAX);
    // Migration d'une base existante sans rôles : le compte le plus ancien
    // (par date de création) hérite du rôle admin, faute de quoi personne
    // n'aurait accès à l'administration après coup.
    if (this.players.size && ![...this.players.values()].some((p) => p.role === 'admin')) {
      let oldest = null;
      let oldestAt = Infinity;
      for (const p of this.players.values()) {
        const at = (this.credentials.get(p.id) || {}).createdAt;
        if (typeof at === 'number' && at < oldestAt) { oldest = p; oldestAt = at; }
      }
      if (oldest) oldest.role = 'admin';
    }
    for (const [mapId, state] of Object.entries(data.mapStates || {})) {
      const map = this.mapOf(mapId);
      if (!map || map.kind !== 'dungeon' || !map.dungeon) continue;
      map.dungeon.kills = Number(state.kills) || 0;
      map.dungeon.killsRequired = Number(state.killsRequired) || map.dungeon.killsRequired;
      map.dungeon.bossAlive = !!state.bossAlive;
      const bossTile = map.tiles.get(map.dungeon.bossTileKey);
      if (bossTile) bossTile.content = map.dungeon.bossAlive ? { ...map.dungeon.bossTemplate } : null;
    }
    if (data.mapDiffs) {
      for (const [mapId, diffs] of Object.entries(data.mapDiffs || {})) {
        const map = this.mapOf(mapId);
        for (const [key, until] of diffs) {
          const tile = map.tiles.get(key);
          if (tile && tile.content) tile.content.inactiveUntil = until;
        }
      }
    } else {
      for (const [flatKey, until] of data.worldDiffs || []) {
        const sep = String(flatKey).indexOf('|');
        const mapId = sep >= 0 ? flatKey.slice(0, sep) : 'world';
        const key = sep >= 0 ? flatKey.slice(sep + 1) : flatKey;
        const tile = this.mapOf(mapId).tiles.get(key);
        if (tile && tile.content) tile.content.inactiveUntil = until;
      }
    }
  }
}

module.exports = { Game, CHAT_LOG_MAX };
