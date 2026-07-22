'use strict';

/* ============================================================
 * server.js — ServerSim : backend simulé, autoritatif
 * Version multi-cartes : monde + donjons partagés
 * ============================================================ */

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

class ServerSim {
  constructor(seed) {
    this.seed = seed;
    this.now = 0;
    this.maps = generateGameMaps(seed);
    this.worldMap = this.maps.get('world');
    this.currentMapId = 'world';
    this.tiles = this.worldMap.tiles;
    this.players = new Map();
    this.raids = new Map();
    this.tradeInvites = new Map();
    this.trades = new Map();
    this.trade = null;
    this.pendingReplies = [];
    this.listeners = {};
    this.meId = 'me';
    this.rng = Math.random;   // injectable pour des tests déterministes
  }

  on(ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((cb) => cb(data)); }

  get me() { return this.players.get(this.meId); }
  mapOf(id) { return this.maps.get(id) || this.worldMap; }
  tilesOf(p) { return this.mapOf((p && p.mapId) || 'world').tiles; }
  raidId(mapId, x, y) { return raidKey(mapId || 'world', x, y); }
  skinStateOf(p) {
    if (!p) return;
    if (!Array.isArray(p.ownedSkins)) p.ownedSkins = [];
    if (!Array.isArray(p.ownedAccessories)) p.ownedAccessories = [];
    if (!Array.isArray(p.ownedMounts)) p.ownedMounts = [];
    if (typeof p.accessoryId === 'undefined') p.accessoryId = null;
    if (typeof p.mountId === 'undefined') p.mountId = null;
    if (typeof p[PREMIUM_CURRENCY.key] !== 'number') p[PREMIUM_CURRENCY.key] = 0;
    if (typeof p.skinId === 'undefined') p.skinId = null;
    if (!Array.isArray(p.characters) || !p.characters.length) return;
    for (const c of p.characters) {
      if (typeof c.skinId === 'undefined') c.skinId = null;
    }
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
      accessoryId: p.accessoryId || null,
      mountId: p.mountId || null,
    };
  }

  syncCurrentMap() {
    const me = this.me;
    this.currentMapId = (me && me.mapId) || 'world';
    this.tiles = this.tilesOf(me || { mapId: 'world' });
    this.emit('map', {
      mapId: this.currentMapId,
      bounds: boundsOf(this.tiles),
      mapDiffs: this.serialize().mapDiffs,
      mapStates: this.mapStates(),
    });
  }

  log(text, type) { this.emit('chat', { from: null, text, type: type || 'event' }); }
  toast(text) { this.emit('toast', { text }); }
  // Miroir de server/game.js consumeRegainBonus() : voir ce fichier pour le
  // détail du raisonnement (Regain = bonus d'XP, plus un gate d'action).
  consumeRegainBonus(me, cost) {
    if (me.pa >= cost) { me.pa -= cost; return true; }
    return false;
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

  isTradeableStack(key) {
    const parsed = parseStackKey(String(key || ''));
    return !!RESOURCES[parsed.type] && !CONSUMABLES[parsed.type];
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
    this.trade = trade ? this.tradePayloadFor(this.me, trade) : null;
    this.emit('trade', this.trade);
  }

  closeTrade(trade, reason) {
    if (!trade) return;
    this.trades.delete(trade.id);
    const me = this.me;
    if (me && me.tradeId === trade.id) {
      me.tradeId = null;
      if (me.status === 'TRADING') me.status = 'IDLE';
      this.emit('self', me);
    }
    this.pushTrade(null);
    if (reason) this.toast(reason);
  }

  requestTrade(targetId) {
    const target = this.players.get(String(targetId));
    const me = this.me;
    if (!target || target.bot) return { ok: false, error: 'Échanges disponibles en multijoueur réel.' };
    if (target.id === me.id) return { ok: false, error: 'Impossible d’échanger avec vous-même.' };
    return { ok: false, error: 'Échanges disponibles en multijoueur réel.' };
  }

  respondTradeInvite(fromId, accept) { return { ok: false, error: 'Échanges disponibles en multijoueur réel.' }; }
  updateTradeOffer(offer) { return { ok: false, error: 'Échanges disponibles en multijoueur réel.' }; }
  confirmTrade(accept) { return { ok: false, error: 'Échanges disponibles en multijoueur réel.' }; }
  cancelTrade() { return { ok: false, error: 'Aucun échange actif.' }; }

  requestDuel(targetId) {
    const target = this.players.get(String(targetId));
    const me = this.me;
    if (!target || target.bot) return { ok: false, error: 'Duels disponibles en multijoueur réel.' };
    if (target.id === me.id) return { ok: false, error: 'Impossible de se défier soi-même.' };
    return { ok: false, error: 'Duels disponibles en multijoueur réel.' };
  }

  respondDuelInvite(fromId, accept) { return { ok: false, error: 'Duels disponibles en multijoueur réel.' }; }

  createGuild(name) { return { ok: false, error: 'Guildes disponibles en multijoueur réel.' }; }
  inviteToGuild(username) { return { ok: false, error: 'Guildes disponibles en multijoueur réel.' }; }
  respondGuildInvite(accept) { return { ok: false, error: 'Guildes disponibles en multijoueur réel.' }; }
  leaveGuild() { return { ok: false, error: 'Vous n’êtes pas dans une guilde.' }; }
  kickFromGuild(username) { return { ok: false, error: 'Guildes disponibles en multijoueur réel.' }; }
  guildInfo() { return { ok: false, error: 'Vous n’êtes pas dans une guilde.' }; }
  sendFriendRequest(username) { return { ok: false, error: 'Amis disponibles en multijoueur réel.' }; }
  respondFriendRequest(fromId, accept) { return { ok: false, error: 'Amis disponibles en multijoueur réel.' }; }
  removeFriend(username) { return { ok: false, error: 'Amis disponibles en multijoueur réel.' }; }
  joinFriend(username) { return { ok: false, error: 'Amis disponibles en multijoueur réel.' }; }
  friendsList() { return { ok: true, list: [] }; }
  castlesInfo() { return { ok: true, list: [] }; }
  claimCastle(terrain) { return { ok: false, error: 'Châteaux de guilde disponibles en multijoueur réel.' }; }
  reinforceCastle(terrain) { return { ok: false, error: 'Châteaux de guilde disponibles en multijoueur réel.' }; }
  repairCastle(terrain, gold) { return { ok: false, error: 'Châteaux de guilde disponibles en multijoueur réel.' }; }
  fortifyCastle(terrain) { return { ok: false, error: 'Châteaux de guilde disponibles en multijoueur réel.' }; }
  assaultCastle(terrain) { return { ok: false, error: 'Châteaux de guilde disponibles en multijoueur réel.' }; }
  craftSiegeEngine(tier) { return { ok: false, error: 'Châteaux de guilde disponibles en multijoueur réel.' }; }
  deploySiegeEngine(key, tier) { return { ok: false, error: 'Châteaux de guilde disponibles en multijoueur réel.' }; }

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

  emitMapUpdate(mapId) {
    const map = this.mapOf(mapId);
    if (!map) return;
    this.emit('map', {
      mapId,
      bounds: boundsOf(map.tiles),
      mapDiffs: this.serialize().mapDiffs,
      mapStates: this.mapStates(),
    });
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
      this.emitMapUpdate(mapId);
      return;
    }

    if (!monster.dungeonMob || state.bossAlive) return;
    state.kills = Math.min(state.killsRequired, state.kills + 1);
    if (state.kills >= state.killsRequired && bossTile && !bossTile.content) {
      bossTile.content = { ...state.bossTemplate };
      state.bossAlive = true;
      this.log('Le boss du donjon est apparu !');
    }
    this.emitMapUpdate(mapId);
  }

  join(username, speciesClass) {
    if (!classAvailableToRole(speciesClass, 'user')) throw new Error('Classe réservée aux administrateurs.');
    const p = {
      id: this.meId, username, bot: false,
      mapId: 'world',
      pos: { x: 0, y: 0 },
      pa: CONFIG.PA.START, paMs: 0,
      hp: 100, hpMs: 0,
      inventory: {},
      gold: 0,
      [PREMIUM_CURRENCY.key]: 24,
      ownedSkins: [],
      ownedAccessories: [],
      accessoryId: null,
      ownedMounts: [],
      mountId: null,
      status: 'IDLE',
      harvestKey: null, harvestEndsAt: 0,
      raidKey: null,
      tradeId: null,
      duels: { wins: 0, losses: 0 },
      guildId: null,
      guildInvite: null,
      friends: [],
      friendRequests: [],
      characters: [newCharacter(speciesClass)],
      activeChar: 0,
      charSlots: CONFIG.FREE_CHAR_SLOTS,
      visitedVillages: [],
    };
    ensureAchievementState(p);
    this.skinStateOf(p);
    applyCharacter(p, 0);
    p.hp = maxHp(p);
    this.players.set(p.id, p);
    this.syncCurrentMap();
    this.spawnBots();
    this.log('Bienvenue dans les Terres Sauvages, ' + username + '.');
    return p;
  }

  atSanctuary(p) {
    if (p.mapId !== 'world') return false;
    const tile = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    if (!tile) return false;
    return (tile.content && (tile.content.kind === 'capital' || tile.content.kind === 'village')) || (p.pos.x === 0 && p.pos.y === 0);
  }

  createCharacter(speciesClass) {
    const me = this.me;
    if (!CLASSES[speciesClass]) return { ok: false, error: 'Classe invalide.' };
    if (!classAvailableToRole(speciesClass, me.role)) return { ok: false, error: 'Classe réservée aux administrateurs.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuary(me)) return { ok: false, error: 'L’éveil d’une nouvelle forme se fait à la Capitale ou dans un village.' };
    if (me.characters.length >= me.charSlots) return { ok: false, error: 'Tous vos emplacements sont occupés.' };
    if (me.characters.some((c) => c.speciesClass === speciesClass)) return { ok: false, error: 'Vous incarnez déjà cette forme.' };
    syncActiveCharacter(me);
    me.characters.push(newCharacter(speciesClass));
    this.skinStateOf(me);
    this.emit('self', me);
    return { ok: true, index: me.characters.length - 1 };
  }

  buySkin(skinId) {
    const me = this.me;
    const item = skinFor(String(skinId || ''));
    if (!item) return { ok: false, error: 'Skin inconnu.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (me.speciesClass !== item.speciesClass) return { ok: false, error: 'Ce skin est réservé à une autre classe.' };
    this.skinStateOf(me);
    if (me.ownedSkins.includes(item.id)) return { ok: false, error: 'Skin déjà possédé.' };
    const walletKey = item.currency === PREMIUM_CURRENCY.key ? PREMIUM_CURRENCY.key : 'gold';
    const balance = Number(me[walletKey] || 0);
    if (balance < item.price) {
      return { ok: false, error: walletKey === 'gold' ? 'Pas assez d’or.' : ('Pas assez de ' + PREMIUM_CURRENCY.label.toLowerCase() + '.') };
    }
    me[walletKey] = balance - item.price;
    me.ownedSkins.push(item.id);
    this.emit('self', me);
    return { ok: true };
  }

  buyMount(mountId) {
    const me = this.me;
    const item = MOUNT_ITEMS[String(mountId || '')];
    if (!item || !item.shop) return { ok: false, error: 'Monture inconnue.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (me.ownedMounts.includes(item.id)) return { ok: false, error: 'Monture déjà possédée.' };
    const walletKey = item.shop.currency === PREMIUM_CURRENCY.key ? PREMIUM_CURRENCY.key : 'gold';
    const balance = Number(me[walletKey] || 0);
    if (balance < item.shop.price) {
      return { ok: false, error: walletKey === 'gold' ? 'Pas assez d’or.' : ('Pas assez de ' + PREMIUM_CURRENCY.label.toLowerCase() + '.') };
    }
    me[walletKey] = balance - item.shop.price;
    me.ownedMounts.push(item.id);
    this.emit('self', me);
    return { ok: true };
  }

  setActiveTitle(title) {
    const me = this.me;
    const t = title ? String(title).slice(0, 40) : null;
    if (t && !me.titles.includes(t)) return { ok: false, error: 'Titre non débloqué.' };
    me.activeTitle = t;
    this.emit('self', me);
    return { ok: true };
  }

  buyGoldPack(packId) {
    const me = this.me;
    const pack = GOLD_PACKS.find((item) => item.id === String(packId || ''));
    if (!pack) return { ok: false, error: 'Pack d’or inconnu.' };
    const balance = Number(me[PREMIUM_CURRENCY.key] || 0);
    if (balance < pack.moonstones) return { ok: false, error: 'Pas assez de ' + PREMIUM_CURRENCY.label.toLowerCase() + '.' };
    me[PREMIUM_CURRENCY.key] = balance - pack.moonstones;
    me.gold = Number(me.gold || 0) + pack.gold;
    this.emit('self', me);
    return { ok: true, gold: pack.gold, cost: pack.moonstones };
  }

  buyCharSlot() {
    const me = this.me;
    if ((me.charSlots || 0) >= MAX_PLAYER_CHAR_SLOTS) {
      return { ok: false, error: 'Déjà au maximum d’emplacements disponibles.' };
    }
    const balance = Number(me[PREMIUM_CURRENCY.key] || 0);
    if (balance < CHAR_SLOT_COST_MOONSTONES) {
      return { ok: false, error: 'Il faut ' + CHAR_SLOT_COST_MOONSTONES + ' ' + PREMIUM_CURRENCY.label + '.' };
    }
    me[PREMIUM_CURRENCY.key] = balance - CHAR_SLOT_COST_MOONSTONES;
    me.charSlots = (me.charSlots || 0) + 1;
    this.emit('self', me);
    return { ok: true, charSlots: me.charSlots };
  }

  getCheckoutLink() {
    return { ok: false, error: 'Achats en argent réel disponibles en multijoueur réel.' };
  }

  subscribePush() { return { ok: false, error: 'Notifications disponibles en multijoueur réel.' }; }
  unsubscribePush() { return { ok: true }; }

  equipSkin(skinId) {
    const me = this.me;
    this.skinStateOf(me);
    const desired = skinId ? String(skinId) : null;
    if (!desired) {
      me.skinId = null;
      syncActiveCharacter(me);
      this.emit('self', me);
      return { ok: true };
    }
    const item = skinFor(desired);
    if (!item) return { ok: false, error: 'Skin inconnu.' };
    if (item.speciesClass !== me.speciesClass) return { ok: false, error: 'Ce skin ne correspond pas à votre forme active.' };
    if (!me.ownedSkins.includes(item.id)) return { ok: false, error: 'Vous ne possédez pas ce skin.' };
    me.skinId = item.id;
    syncActiveCharacter(me);
    this.emit('self', me);
    return { ok: true };
  }

  // Accessoire cosmétique : jamais obtenu en solo (pas de boss mondial hors
  // ligne), mais la méthode existe pour que l'UI du profil reste générique.
  equipAccessory(accessoryId) {
    const me = this.me;
    const desired = accessoryId ? String(accessoryId) : null;
    if (!desired) {
      me.accessoryId = null;
      this.emit('self', me);
      return { ok: true };
    }
    if (!ACCESSORY_ITEMS[desired]) return { ok: false, error: 'Accessoire inconnu.' };
    if (!me.ownedAccessories.includes(desired)) return { ok: false, error: 'Vous ne possédez pas cet accessoire.' };
    me.accessoryId = desired;
    this.emit('self', me);
    return { ok: true };
  }

  equipMount(mountId) {
    const me = this.me;
    const desired = mountId ? String(mountId) : null;
    if (!desired) {
      me.mountId = null;
      this.emit('self', me);
      return { ok: true };
    }
    if (!MOUNT_ITEMS[desired]) return { ok: false, error: 'Monture inconnue.' };
    if (!me.ownedMounts.includes(desired)) return { ok: false, error: 'Vous ne possédez pas cette monture.' };
    me.mountId = desired;
    this.emit('self', me);
    return { ok: true };
  }

  /* ---------- Cuisine : la Marmite (Capitale + villages) ---------- */
  cook(item, tier) {
    const me = this.me;
    tier = Math.floor(Number(tier));
    if (!CONSUMABLES[item]) return { ok: false, error: 'Recette inconnue.' };
    if (!(tier >= 1 && tier <= 6)) return { ok: false, error: 'Tier invalide.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuary(me)) return { ok: false, error: 'La Marmite se trouve à la Capitale et dans les villages.' };

    const recipe = CONSUMABLE_RECIPES[tier];
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') {
        if ((me.gold || 0) < n) return { ok: false, error: 'Pas assez d’or (' + n + ' 🪙 requis).' };
      } else if ((me.inventory[k] || 0) < n) {
        const r = parseStackKey(k);
        return { ok: false, error: 'Il manque : ' + n + '× ' + resourceLabel(r.type, r.tier) + '.' };
      }
    }
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') me.gold -= n;
      else {
        me.inventory[k] -= n;
        if (me.inventory[k] <= 0) delete me.inventory[k];
      }
    }
    const key = stackKey(item, tier);
    me.inventory[key] = (me.inventory[key] || 0) + 1;
    this.log(CONSUMABLES[item].icon + ' ' + CONSUMABLES[item].label + ' T' + tier + ' cuisiné !');
    this.emit('self', me);
    return { ok: true };
  }

  consume(key) {
    const me = this.me;
    const parsed = parseStackKey(String(key));
    const item = CONSUMABLES[parsed.type];
    if (!item) return { ok: false, error: 'Objet inconnu.' };
    if ((me.inventory[key] || 0) < 1) return { ok: false, error: 'Vous n’en avez plus.' };

    me.inventory[key] -= 1;
    if (me.inventory[key] <= 0) delete me.inventory[key];

    if (item.kind === 'instant') {
      const heal = Math.round(maxHp(me) * CONSUMABLE_EFFECTS[parsed.type][parsed.tier]);
      me.hp = Math.min(maxHp(me), me.hp + heal);
      this.toast(item.icon + ' +' + heal + ' PV');
    } else {
      me.buff = { type: parsed.type, tier: parsed.tier, combats: BUFF_COMBATS };
      this.toast(item.icon + ' ' + item.label + ' T' + parsed.tier + ' actif (' + BUFF_COMBATS + ' combats)');
    }
    this.emit('self', me);
    return { ok: true };
  }

  switchCharacter(index) {
    const me = this.me;
    index = Math.floor(Number(index));
    if (!(index >= 0 && index < me.characters.length)) return { ok: false, error: 'Forme inconnue.' };
    if (index === me.activeChar) return { ok: false, error: 'Cette forme est déjà active.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuary(me)) return { ok: false, error: 'La métamorphose se fait à la Capitale ou dans un village.' };
    const pct = Math.max(0, Math.min(1, me.hp / maxHp(me)));
    syncActiveCharacter(me);
    applyCharacter(me, index);
    me.hp = Math.max(1, Math.round(pct * maxHp(me)));
    this.emit('self', me);
    return { ok: true };
  }

  spawnBots() {
    for (let i = 0; i < CONFIG.BOT_COUNT; i++) {
      const classes = Object.keys(CLASSES).filter((cls) => classAvailableToRole(cls, 'user'));
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
      this.players.set('bot' + i, bot);
    }
  }

  tick(dt) {
    this.now += dt;
    const me = this.me;
    if (!me) return;

    me.paMs += dt;
    while (me.paMs >= CONFIG.PA.REGEN_MS) {
      me.paMs -= CONFIG.PA.REGEN_MS;
      if (me.pa < CONFIG.PA.MAX) me.pa++;
    }
    me.hpMs += dt;
    while (me.hpMs >= CONFIG.HP.REGEN_MS) {
      me.hpMs -= CONFIG.HP.REGEN_MS;
      if (me.hp < maxHp(me)) me.hp++;
    }

    if (me.status === 'HARVESTING' && this.now >= me.harvestEndsAt) this.finishHarvest(me);

    for (const [key, raid] of [...this.raids]) {
      if (this.now >= raid.endsAt) this.resolveRaid(key, raid);
    }

    for (const p of this.players.values()) {
      if (p.bot && this.now >= p.nextThink) {
        p.nextThink = this.now + CONFIG.BOT_TICK_MS * (0.7 + Math.random() * 0.6);
        this.botThink(p);
      }
    }

    this.pendingReplies = this.pendingReplies.filter((r) => {
      if (this.now >= r.at) { this.emit('chat', r.msg); return false; }
      return true;
    });
  }

  move(dx, dy) {
    const me = this.me;
    const tiles = this.tilesOf(me);
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return { ok: false, error: 'Case non adjacente.' };
    const nx = me.pos.x + dx;
    const ny = me.pos.y + dy;
    if (!isWalkable(tiles, nx, ny)) return { ok: false, error: 'Case bloquée.' };
    me.pos = { x: nx, y: ny };

    // Marcher sur un village le « découvre » : téléporteur débloqué
    const arrived = tiles.get(tileKey(nx, ny));
    if (arrived && arrived.content && arrived.content.kind === 'village') {
      const vk = tileKey(nx, ny);
      if (!me.visitedVillages.includes(vk)) {
        me.visitedVillages.push(vk);
        for (const a of checkAchievements(me, ['Exploration'])) this.emit('achievementUnlocked', { id: a.id, label: a.label, category: a.category, reward: a.reward || {} });
        this.log('📍 ' + (arrived.content.name || 'Village') + ' découvert — téléporteur débloqué !');
      }
    }
    this.syncCurrentMap();
    return { ok: true };
  }

  // Sans compte serveur, le brouillard de guerre est déjà entièrement
  // sauvegardé dans la sauvegarde locale (exploredByMap) — rien à synchroniser.
  exploreTiles() { return { ok: true, added: 0 }; }

  harvest(x, y) {
    const me = this.me;
    const tile = this.tilesOf(me).get(tileKey(x, y));
    const node = tile && tile.content;
    if (!node || node.kind !== 'resource') return { ok: false, error: 'Rien à récolter ici.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(me.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (this.now < node.inactiveUntil) return { ok: false, error: 'Gisement épuisé.' };
    const reqTier = Math.min(6, node.tier);
    if (me.harvestLevel < reqTier) return { ok: false, error: 'Niveau de récolte insuffisant (T' + reqTier + ' requis).' };
    me.status = 'HARVESTING';
    me.harvestKey = this.raidId(me.mapId, x, y);
    me.harvestEndsAt = this.now + CONFIG.HARVEST_MS;
    return { ok: true, duration: CONFIG.HARVEST_MS };
  }

  finishHarvest(me) {
    const [mapId, key] = String(me.harvestKey || '').split('|');
    const tile = this.mapOf(mapId || me.mapId).tiles.get(key || '');
    if (!tile || !tile.content) return;
    const node = tile.content;
    me.status = 'IDLE';
    me.harvestKey = null;

    const qty = 3 + Math.floor(Math.random() * 3);
    const invKey = stackKey(node.type, node.tier);
    me.inventory[invKey] = (me.inventory[invKey] || 0) + qty;
    node.inactiveUntil = this.now + (node.dungeonResource ? CONFIG.RESPAWN_DUNGEON_RESOURCE_MS : CONFIG.RESPAWN_RESOURCE_MS);

    const boosted = this.consumeRegainBonus(me, CONFIG.COSTS.HARVEST);
    const xp = (8 + Math.min(6, node.tier) * 6) * (boosted ? 2 : 1);
    me.harvestXp += xp;
    this.log('+' + qty + ' ' + resourceLabel(node.type, node.tier) + ' (+' + xp + ' XP récolte)');
    this.checkLevelUp(me, 'harvest');
    me.stats.harvest[node.type] = (me.stats.harvest[node.type] || 0) + qty;
    for (const a of checkAchievements(me, ['Récolte'])) this.emit('achievementUnlocked', { id: a.id, label: a.label, category: a.category, reward: a.reward || {} });
    this.emit('self', me);
  }

  createRaid(x, y) {
    const me = this.me;
    const tiles = this.tilesOf(me);
    const tile = tiles.get(tileKey(x, y));
    const monster = tile && tile.content;
    const raidIdKey = this.raidId(me.mapId, x, y);
    if (!monster || monster.kind !== 'monster') return { ok: false, error: 'Aucun monstre ici.' };
    if (this.now < monster.inactiveUntil) return { ok: false, error: 'Ce groupe est déjà vaincu.' };
    if (this.raids.has(raidIdKey)) return this.joinRaid(raidIdKey);
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(me.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    me.status = 'LOBBY_COMBAT';
    me.raidKey = raidIdKey;
    this.raids.set(raidIdKey, {
      key: raidIdKey,
      tileKey: tileKey(x, y),
      mapId: me.mapId,
      tier: monster.tier,
      label: monster.label,
      monsterForce: monster.force,
      participants: [me.id],
      leaderId: me.id,
      endsAt: this.now + CONFIG.LOBBY_MS,
    });
    return { ok: true };
  }

  joinRaid(key) {
    const me = this.me;
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.mapId !== me.mapId) return { ok: false, error: 'Ce lobby est sur une autre carte.' };
    if (raid.participants.includes(me.id)) return { ok: false, error: 'Vous êtes déjà dans ce lobby.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    const tile = this.tilesOf(me).get(raid.tileKey);
    if (this.chebyshev(me.pos, tile) > CONFIG.JOIN_RADIUS) return { ok: false, error: 'Trop loin pour rejoindre.' };
    me.status = 'LOBBY_COMBAT';
    me.raidKey = key;
    raid.participants.push(me.id);
    return { ok: true };
  }

  startRaidNow(key) {
    const me = this.me;
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.leaderId !== me.id) return { ok: false, error: 'Seul le créateur peut lancer le combat.' };
    raid.endsAt = this.now;
    return { ok: true };
  }

  botJoinRaid(bot, raid) {
    bot.status = 'LOBBY_COMBAT';
    bot.raidKey = raid.key;
    raid.participants.push(bot.id);
  }

  teamForce(raid) {
    const members = raid.participants.map((id) => this.players.get(id)).filter(Boolean);
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
    const members = raid.participants.map((id) => this.players.get(id)).filter(Boolean);
    const force = this.teamForce(raid);
    // Combat probabiliste : le sort en décide, à hauteur des puissances
    const chance = winChance(force, raid.monsterForce);
    const victory = this.rng() < chance;
    const druid = victory && members.some((p) => p.speciesClass === 'CERF_DRUIDE');
    const rampart = members.some((p) => p.speciesClass === 'OURS_GUERRIER');
    let myHpLoss = 0, myXp = 0, myGold = 0, myFood = null, myBoosted = false, myDied = false;

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
        }
        continue;
      }

      // Victoire : usure (réduite par l'armure, le Rempart et le Bouillon),
      // puis soignée par la Sève — dans cet ordre, pour qu'elle puisse encore
      // sauver d'une blessure autrement fatale. Gagner le combat ne protège
      // plus d'une mort par blessure : une victoire trop coûteuse en PV reste
      // mortelle (même traitement qu'une défaite — rapatriement, PV réduits).
      let loss = 4 + monster.tier * 3;
      loss *= hpLossReduction(p);
      if (rampart) loss *= 0.7;
      loss *= buffLossReduction(p);
      loss = Math.max(1, Math.round(loss));
      if (p.id === this.meId) myHpLoss = loss;
      let hpAfterLoss = p.hp - loss;
      if (druid) hpAfterLoss = Math.min(maxHp(p), hpAfterLoss + Math.round(maxHp(p) * CONFIG.COMBAT.DRUID_HEAL_PCT));
      if (hpAfterLoss <= 0) {
        p.hp = Math.max(1, Math.ceil(maxHp(p) * CONFIG.COMBAT.DEATH_HP_PCT));
        if (p.bot) p.pos = { ...p.home };
        else { p.mapId = 'world'; p.pos = { x: 0, y: 0 }; }
        if (p.id === this.meId) myDied = true;
      } else {
        p.hp = hpAfterLoss;
      }

      if (victory && !p.bot) {
        // Les monstres lâchent de l'or (+ XP) et, parfois, un ingrédient
        // de cuisine de leur tier.
        const boosted = this.consumeRegainBonus(p, CONFIG.COSTS.RAID);
        const xp = (15 + Math.min(6, monster.tier) * 15) * (boosted ? 2 : 1);
        // Chapardeur (Renard Voleur) : +50 % d'or pour lui
        const lootMult = p.speciesClass === 'RENARD_VOLEUR' ? 1.5 : 1;
        p.weaponXp += xp;
        const gold = Math.ceil(rollGoldLoot(monster.tier) * lootMult);
        p.gold = (p.gold || 0) + gold;
        if (this.rng() < CONFIG.FOOD_DROP_CHANCE) {
          myFood = foodDropFor(monster.tier);
          p.inventory[myFood] = (p.inventory[myFood] || 0) + 1;
        }
        myXp = xp;
        myGold = gold;
        if (p.id === this.meId) myBoosted = boosted;
        this.checkLevelUp(p, 'weapon');
        p.stats.monsterKills = (p.stats.monsterKills || 0) + 1;
        p.stats.kills[monster.type] = (p.stats.kills[monster.type] || 0) + 1;
        if (monster.boss) p.stats.bossKills = (p.stats.bossKills || 0) + 1;
        for (const a of checkAchievements(p, ['Combat', 'Équipement', 'Commerce'])) this.emit('achievementUnlocked', { id: a.id, label: a.label, category: a.category, reward: a.reward || {} });
      }
    }

    // Les buffs de cuisine se consument à chaque combat, victoire ou défaite
    const meP = this.me;
    if (meP && raid.participants.includes(meP.id) && meP.buff) {
      meP.buff.combats -= 1;
      if (meP.buff.combats <= 0) {
        this.log('Les effets de votre ' + CONSUMABLES[meP.buff.type].label + ' se dissipent.');
        delete meP.buff;
      }
    }

    if (victory) {
      if (monster.boss) monster.inactiveUntil = 0;
      else if (monster.dungeonMob) monster.inactiveUntil = this.now + CONFIG.RESPAWN_DUNGEON_MONSTER_MS;
      else monster.inactiveUntil = this.now + CONFIG.RESPAWN_MONSTER_MS;
      this.updateDungeonProgress(raid.mapId, monster, true);
    }
    this.emit('result', {
      victory,
      died: !victory || myDied,
      chance,
      label: raid.label,
      monsterType: monster.type,
      tier: raid.tier,
      teamForce: force,
      monsterForce: raid.monsterForce,
      participants: members.map((p) => p.username),
      gold: myGold,
      food: myFood,
      hpLoss: myHpLoss,
      xp: myXp,
      regainBoosted: myBoosted,
      druid,
    });
    this.syncCurrentMap();
    this.emit('self', this.me);
  }

  enterDungeon(mapId) {
    const me = this.me;
    const tile = this.tilesOf(me).get(tileKey(me.pos.x, me.pos.y));
    if (!tile || !tile.content || tile.content.kind !== 'dungeon') return { ok: false, error: 'Vous devez être sur une entrée de donjon.' };
    if (tile.content.mapId !== mapId) return { ok: false, error: 'Entrée invalide.' };
    const map = this.mapOf(mapId);
    this.resetTravelState(me);
    me.mapId = map.id;
    me.pos = this.nearestWalkablePos(map, map.entry);
    this.syncCurrentMap();
    this.emit('self', me);
    return { ok: true };
  }

  usePortal() {
    const me = this.me;
    const tile = this.tilesOf(me).get(tileKey(me.pos.x, me.pos.y));
    if (!tile || !tile.content || tile.content.kind !== 'portal') return { ok: false, error: 'Aucun portail ici.' };
    const map = this.mapOf(tile.content.targetMapId || 'world');
    this.resetTravelState(me);
    me.mapId = map.id;
    me.pos = this.nearestWalkablePos(map, tile.content.targetPos);
    this.syncCurrentMap();
    this.emit('self', me);
    return { ok: true };
  }

  upgrade(slot) {
    const me = this.me;
    if (me.mapId !== 'world' || me.pos.x !== 0 || me.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale (0,0).' };
    const item = me[slot];
    const target = item.tier + 1;
    if (target > 6) return { ok: false, error: 'Tier maximum atteint.' };
    if (me.weaponMastery < target) return { ok: false, error: 'Maîtrise d’arme T' + target + ' requise.' };
    const recipe = UPGRADE_RECIPES[slot][target];
    for (const k in recipe) {
      if ((me.inventory[k] || 0) < recipe[k]) return { ok: false, error: 'Ressources insuffisantes.' };
    }
    for (const k in recipe) {
      me.inventory[k] -= recipe[k];
      if (me.inventory[k] <= 0) delete me.inventory[k];
    }
    item.tier = target;
    if (slot === 'armor') me.hp = Math.min(maxHp(me), me.hp + 15);
    for (const a of checkAchievements(me, ['Équipement'])) this.emit('achievementUnlocked', { id: a.id, label: a.label, category: a.category, reward: a.reward || {} });
    this.emit('self', me);
    return { ok: true };
  }

  rest() {
    const me = this.me;
    if (me.mapId !== 'world' || me.pos.x !== 0 || me.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale.' };
    me.hp = maxHp(me);
    this.emit('self', me);
    return { ok: true };
  }

  setAdminTier(kind, tier) {
    const me = this.me;
    const target = Math.max(1, Math.min(6, Number(tier) || 1));
    if (kind === 'harvest') {
      me.harvestLevel = target;
      me.harvestXp = target >= 6 ? XP_LEVELS[XP_LEVELS.length - 1] : XP_LEVELS[target - 1];
      this.emit('self', me);
      return { ok: true };
    }
    if (kind === 'weapon') {
      me.weaponMastery = target;
      me.weaponXp = target >= 6 ? XP_LEVELS[XP_LEVELS.length - 1] : XP_LEVELS[target - 1];
      this.emit('self', me);
      return { ok: true };
    }
    return { ok: false, error: 'Catégorie admin inconnue.' };
  }

  setAdminGear(slot, tier) {
    const me = this.me;
    const target = Math.max(0, Math.min(6, Number(tier) || 0));
    if (slot === 'weapon') {
      me.weapon.tier = target;
      this.emit('self', me);
      return { ok: true };
    }
    if (slot === 'armor') {
      me.armor.tier = target;
      me.hp = Math.min(me.hp, maxHp(me));
      this.emit('self', me);
      return { ok: true };
    }
    return { ok: false, error: 'Équipement admin inconnu.' };
  }

  adminSpawnBoss() {
    const me = this.me;
    const map = this.mapOf(me.mapId || 'world');
    if (!map || map.kind !== 'dungeon' || !map.dungeon) return { ok: false, error: 'Vous devez être dans un donjon.' };
    const state = map.dungeon;
    const bossTile = map.tiles.get(state.bossTileKey);
    if (!bossTile) return { ok: false, error: 'Boss introuvable.' };
    state.kills = state.killsRequired;
    state.bossAlive = true;
    bossTile.content = { ...state.bossTemplate };
    this.emitMapUpdate(map.id);
    this.emit('self', me);
    return { ok: true };
  }

  teleportVillage(x, y) {
    const me = this.me;
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (me.mapId !== 'world') return { ok: false, error: 'Vous devez revenir dans le monde pour voyager.' };
    const from = this.tilesOf(me).get(tileKey(me.pos.x, me.pos.y));
    if (!from || (from.content ? (from.content.kind !== 'village' && from.content.kind !== 'capital') : (from.x !== 0 || from.y !== 0))) {
      return { ok: false, error: 'Vous devez être dans un village ou à la Capitale pour voyager.' };
    }
    const dest = this.worldMap.tiles.get(tileKey(x, y));
    if (!dest || !dest.content || (dest.content.kind !== 'village' && dest.content.kind !== 'capital')) return { ok: false, error: 'Destination invalide.' };
    // Un village doit avoir été découvert à pied avant d'être une destination
    if (dest.content.kind === 'village' && !me.visitedVillages.includes(tileKey(dest.x, dest.y))) {
      return { ok: false, error: 'Village inconnu — vous devez d’abord le découvrir à pied.' };
    }
    me.pos = { x: dest.x, y: dest.y };
    this.syncCurrentMap();
    this.emit('self', me);
    return { ok: true };
  }

  say(text, channel) {
    if (channel === 'guild' || channel === 'whisper') {
      return { ok: false, error: (channel === 'guild' ? 'Guildes' : 'Messages privés') + ' disponibles en multijoueur réel.' };
    }
    const me = this.me;
    this.emit('chat', { from: me.username, text, type: 'chat', channel: 'general', self: true });
    if (Math.random() < 0.5) {
      const bots = [...this.players.values()].filter((p) => p.bot);
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

  chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  serialize() {
    if (this.me) syncActiveCharacter(this.me);
    const mapDiffs = {};
    for (const [mapId, map] of this.maps) {
      mapDiffs[mapId] = [];
      for (const [key, tile] of map.tiles) {
        if (tile.content && tile.content.inactiveUntil > this.now) mapDiffs[mapId].push([key, tile.content.inactiveUntil]);
      }
    }
    return { seed: this.seed, now: this.now, player: this.me, mapDiffs, mapStates: this.mapStates(), savedAt: Date.now() };
  }

  restore(data) {
    this.now = data.now || 0;
    const p = data.player;
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
    if (typeof p.gold !== 'number') p.gold = 0;
    if (typeof p[PREMIUM_CURRENCY.key] !== 'number') p[PREMIUM_CURRENCY.key] = 0;
    if (!Array.isArray(p.ownedSkins)) p.ownedSkins = [];
    if (!Array.isArray(p.visitedVillages)) p.visitedVillages = [];
    if (!p.duels || typeof p.duels.wins !== 'number') p.duels = { wins: 0, losses: 0 };
    if (typeof p.guildId !== 'string') p.guildId = null;
    if (!p.guildInvite || typeof p.guildInvite !== 'object') p.guildInvite = null;
    if (!Array.isArray(p.friends)) p.friends = [];
    if (!Array.isArray(p.friendRequests)) p.friendRequests = [];
    // Parchemin d'Endurance retiré du jeu (voir Regain) : purge les piles
    // restantes d'une sauvegarde antérieure.
    if (p.inventory) {
      for (const k of Object.keys(p.inventory)) {
        if (k.startsWith('PARCHEMIN_ENDURANCE_')) delete p.inventory[k];
      }
    }
    ensureAchievementState(p);
    // Vérification complète (toutes catégories) au chargement de la
    // sauvegarde : rattrape les hauts faits déjà mérités par une progression
    // antérieure à leur ajout, plutôt que d'attendre la prochaine action.
    for (const a of checkAchievements(p)) this.emit('achievementUnlocked', { id: a.id, label: a.label, category: a.category, reward: a.reward || {} });
    const away = Math.max(0, Date.now() - (data.savedAt || Date.now()));
    p.pa = Math.min(CONFIG.PA.MAX, p.pa + Math.floor(away / CONFIG.PA.REGEN_MS));
    p.hp = Math.min(maxHp(p), p.hp + Math.floor(away / CONFIG.HP.REGEN_MS));
    this.skinStateOf(p);
    this.players.set(p.id, p);
    for (const [mapId, state] of Object.entries(data.mapStates || {})) {
      const map = this.mapOf(mapId);
      if (!map || map.kind !== 'dungeon' || !map.dungeon) continue;
      map.dungeon.kills = Number(state.kills) || 0;
      map.dungeon.killsRequired = Number(state.killsRequired) || map.dungeon.killsRequired;
      map.dungeon.bossAlive = !!state.bossAlive;
      const bossTile = map.tiles.get(map.dungeon.bossTileKey);
      if (bossTile) bossTile.content = map.dungeon.bossAlive ? { ...map.dungeon.bossTemplate } : null;
    }
    for (const [mapId, diffs] of Object.entries(data.mapDiffs || {})) {
      const map = this.mapOf(mapId);
      for (const [key, until] of diffs) {
        const tile = map.tiles.get(key);
        if (tile && tile.content) tile.content.inactiveUntil = until;
      }
    }
    this.syncCurrentMap();
    this.spawnBots();
  }

  dev(action) {
    const me = this.me;
    if (!me) return { ok: false, error: 'Aucun personnage.' };
    if (action && action.reset) {
      this.players.clear();
      this.raids.clear();
      this.maps = generateGameMaps(this.seed);
      this.worldMap = this.maps.get('world');
      this.currentMapId = 'world';
      this.tiles = this.worldMap.tiles;
      this.emit('creation');
      return { ok: true, reset: true };
    }
    if (action && action.pa) {
      me.pa = Math.min(CONFIG.PA.MAX, me.pa + Number(action.pa || 0));
      this.emit('self', me);
      return { ok: true };
    }
    if (action && action.speed) return { ok: false, error: 'Vitesse locale gérée par le client.' };
    return { ok: false, error: 'Action dev inconnue.' };
  }

  devAdminSpawnBoss(action) {
    if (action && action.spawnBoss) return this.adminSpawnBoss();
    return this.dev(action);
  }
}
