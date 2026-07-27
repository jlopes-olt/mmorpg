'use strict';

/* ============================================================
 * net.js — RemoteServer : client Socket.io
 * Support des cartes world + dungeon:*
 * ============================================================ */

class RemoteServer {
  constructor() {
    this.remote = true;
    this.socket = null;
    this.listeners = {};
    this.players = new Map();
    this.raids = new Map();
    this.maps = new Map();
    this.tiles = new Map();
    this.housingList = [];
    this.currentMapId = 'world';
    this.seed = 0;
    this.now = 0;
    this.speed = 1;
    this.wildSalt = 0;
    this.meId = null;
    this.token = null;
    this.trade = null;
    this.chatHistory = [];
  }

  on(ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((cb) => cb(data)); }
  get me() { return this.meId ? this.players.get(this.meId) : null; }
  parcelTileFor(parcelId) {
    const map = this.maps.get(HOUSING_MAP_ID);
    if (!map) return null;
    for (const tile of map.tiles.values()) {
      if (tile.content && tile.content.kind === 'parcel' && tile.content.id === parcelId) return tile;
    }
    return null;
  }
  invalidateHouseMap(parcelId) {
    this.maps.delete(houseInteriorMapId(parcelId));
  }
  mapOf(id) {
    const mapId = String(id || 'world');
    if (this.maps.has(mapId)) return this.maps.get(mapId);
    if (mapId.indexOf('house:') === 0) {
      const parcelId = mapId.slice(6);
      const fromList = this.housingList.find((h) => h && h.parcelId === parcelId);
      const modelId = (fromList && fromList.modelId) || 'house_petite';
      const tile = this.parcelTileFor(parcelId);
      const map = generateHouseInteriorMap(parcelId, modelId, tile ? { x: tile.x, y: tile.y } : null);
      this.maps.set(map.id, map);
      return map;
    }
    return this.maps.get('world');
  }
  houseInfoFor(parcelId) {
    return this.housingList.find((h) => h && h.parcelId === parcelId) || null;
  }
  currentHouseInfo() {
    const map = this.mapOf(this.currentMapId);
    if (!map || map.kind !== 'houseInterior') return null;
    return this.houseInfoFor(map.parcelId);
  }
  furnitureAt(x, y) {
    const house = this.currentHouseInfo();
    if (!house || !Array.isArray(house.furniture)) return null;
    for (const placed of house.furniture) {
      const item = housingFurnitureFor(placed.itemId);
      const fp = (item && item.footprint) || { w: 1, h: 1 };
      for (let oy = 0; oy < fp.h; oy++) {
        for (let ox = 0; ox < fp.w; ox++) {
          if (placed.x + ox === x && placed.y + oy === y) return placed;
        }
      }
    }
    return null;
  }
  updateHousingEntry(house) {
    if (!house || !house.parcelId) return;
    const idx = this.housingList.findIndex((h) => h && h.parcelId === house.parcelId);
    const prev = idx >= 0 ? this.housingList[idx] : null;
    if (!prev || prev.modelId !== house.modelId) this.invalidateHouseMap(house.parcelId);
    if (idx >= 0) this.housingList[idx] = house;
    else this.housingList.push(house);
  }
  chebyshev(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
  teamForce(raid) { return raid.teamForce || 0; }
  raidChance(raid) { return raid.winChance || 0; }

  tick(dt) {
    this.now += dt * this.speed;
    const me = this.me;
    if (me && me.pa < CONFIG.PA.MAX) me.paMs += dt * this.speed;
  }

  applyMapDiffs(mapDiffs) {
    for (const [mapId, diffs] of Object.entries(mapDiffs || {})) {
      const map = this.mapOf(mapId);
      if (!map) continue;
      for (const [key, until] of diffs) {
        const t = map.tiles.get(key);
        if (t && t.content) t.content.inactiveUntil = until;
      }
    }
  }

  applyMapStates(mapStates) {
    for (const [mapId, state] of Object.entries(mapStates || {})) {
      const map = this.mapOf(mapId);
      if (!map || map.kind !== 'dungeon' || !map.dungeon) continue;
      map.dungeon.kills = Number(state.kills) || 0;
      map.dungeon.killsRequired = Number(state.killsRequired) || map.dungeon.killsRequired;
      map.dungeon.bossAlive = !!state.bossAlive;
      const bossTile = map.tiles.get(map.dungeon.bossTileKey);
      if (bossTile) bossTile.content = map.dungeon.bossAlive ? { ...map.dungeon.bossTemplate } : null;
    }
  }

  switchMap(mapId) {
    this.currentMapId = mapId || 'world';
    const map = this.mapOf(this.currentMapId);
    this.tiles = map ? map.tiles : new Map();
    this.emit('map', { mapId: this.currentMapId, bounds: boundsOf(this.tiles) });
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
    s.on('otpRequired', (d) => this.emit('otpRequired', d));
    s.on('accountDeleted', () => this.emit('accountDeleted'));
    s.on('init', (d) => this.onInit(d));
    s.on('map', (d) => {
      this.applyMapStates(d.mapStates || {});
      this.applyMapDiffs(d.mapDiffs || {});
      this.switchMap(d.mapId || (this.me && this.me.mapId) || 'world');
    });

    s.on('self', (p) => {
      if (!this.meId) return;
      const prev = this.me;
      this.players.set(this.meId, p);
      if (!prev || prev.mapId !== p.mapId) this.switchMap(p.mapId || 'world');
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
      const map = this.mapOf(patch.mapId || this.currentMapId);
      const t = map && map.tiles.get(patch.key);
      if (t && t.content) t.content.inactiveUntil = patch.inactiveUntil;
    });
    s.on('raids', (list) => {
      this.raids = new Map(list.map((r) => [r.key, r]));
    });
    // Mort/réveil du boss mondial : sans ce câblage, un client déjà connecté
    // au moment de la transition ne le saurait jamais (this.worldBoss ne
    // serait sinon posé qu'une fois, à la connexion — voir onInit ci-dessous).
    s.on('worldBoss', (d) => { this.worldBoss = d; });
    s.on('time', (d) => { this.now = d.now; this.speed = d.speed || 1; });
    s.on('world:wildSalt', (d) => {
      this.wildSalt = d.salt || 0;
      const world = this.mapOf('world');
      if (world) applyWildLayer(world.tiles, this.seed, this.wildSalt);
    });
    s.on('chat', (m) => {
      m.self = !!(m.from && this.me && m.from === this.me.username);
      this.emit('chat', m);
    });
    s.on('toast', (t) => this.emit('toast', t));
    s.on('result', (r) => this.emit('result', r));
    s.on('siegeResult', (r) => this.emit('siegeResult', r));
    s.on('tradeInvite', (d) => this.emit('tradeInvite', d));
    s.on('trade', (d) => {
      this.trade = d || null;
      this.emit('trade', this.trade);
    });
    s.on('duelInvite', (d) => this.emit('duelInvite', d));
    s.on('duelResult', (d) => this.emit('duelResult', d));
    s.on('achievementUnlocked', (d) => this.emit('achievementUnlocked', d));
  }

  onInit(d) {
    this.token = d.token;
    this.meId = d.selfId;
    this.seed = d.seed;
    this.now = d.now;
    this.speed = d.speed || 1;
    this.wildSalt = d.wildSalt || 0;
    this.worldBoss = d.worldBoss || null;
    this.justCreated = !!d.created;
    this.maps = generateGameMaps(d.seed);
    if (this.wildSalt > 0) {
      const world = this.maps.get('world');
      if (world) applyWildLayer(world.tiles, d.seed, this.wildSalt);
    }
    this.applyMapStates(d.mapStates || {});
    this.applyMapDiffs(d.mapDiffs || {});
    this.players = new Map([[d.selfId, d.self]]);
    for (const p of d.players || []) {
      if (p.id !== d.selfId) this.players.set(p.id, p);
    }
    this.raids = new Map((d.raids || []).map((r) => [r.key, r]));
    this.trade = d.trade || null;
    this.chatHistory = d.chatHistory || [];
    this.switchMap(d.mapId || (d.self && d.self.mapId) || 'world');
    this.emit('ready');
    this.emit('self', this.me);
    if (this.trade) this.emit('trade', this.trade);
  }

  register(username, password, speciesClass, email) {
    this.socket.emit('register', { username, password, speciesClass, email });
  }

  login(username, password) {
    this.socket.emit('login', { username, password });
  }

  // --- OTP par email (connexion) : voir 'otpRequired' câblé dans js/main.js ---
  setEmail(accountId, email) { return this.req('auth:setEmail', { accountId, email }); }
  verifyOtp(accountId, code) { return this.req('auth:verifyOtp', { accountId, code }); }
  resendOtp(accountId) { return this.req('auth:resendOtp', { accountId }); }

  // --- Mot de passe oublié ---
  forgotPassword(username) { return this.req('auth:forgotPassword', { username }); }
  resendPasswordReset(username) { return this.req('auth:resendPasswordReset', { username }); }
  resetPassword(username, code, newPassword) { return this.req('auth:resetPassword', { username, code, newPassword }); }

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
  exploreTiles(keys) { return this.req('explore', { keys }); }
  harvest(x, y) { return this.req('harvest', { x, y }); }
  createRaid(x, y) { return this.req('raid:create', { x, y }); }
  joinRaid(key) { return this.req('raid:join', { key }); }
  startRaidNow(key) { return this.req('raid:start', { key }); }
  enterDungeon(mapId) { return this.req('dungeon:enter', { mapId }); }
  usePortal() { return this.req('portal:use', {}); }
  upgrade(slot) { return this.req('upgrade', { slot }); }
  rest() { return this.req('rest', {}); }
  teleportVillage(x, y) { return this.req('village:teleport', { x, y }); }
  createCharacter(speciesClass) { return this.req('char:create', { speciesClass }); }
  switchCharacter(index) { return this.req('char:switch', { index }); }
  buySkin(skinId) { return this.req('shop:buySkin', { skinId }); }
  buyMount(mountId) { return this.req('shop:buyMount', { mountId }); }
  buyDiceSkin(diceId) { return this.req('shop:buyDice', { diceId }); }
  equipSkin(skinId) { return this.req('shop:equipSkin', { skinId }); }
  equipAccessory(accessoryId) { return this.req('accessory:equip', { accessoryId }); }
  equipArtifact(artifactId) { return this.req('artifact:equip', { artifactId }); }
  equipMount(mountId) { return this.req('mount:equip', { mountId }); }
  equipDiceSkin(diceId) { return this.req('dice:equip', { diceId }); }
  buyPaScroll() { return this.req('shop:buyPaScroll', {}); }
  buyGoldPack(packId) { return this.req('shop:buyGoldPack', { packId }); }
  buyCharSlot() { return this.req('shop:buyCharSlot', {}); }
  getCheckoutLink(packId) { return this.req('shop:checkoutLink', { packId }); }
  subscribePush(subscription) { return this.req('push:subscribe', { subscription }); }
  unsubscribePush(endpoint) { return this.req('push:unsubscribe', { endpoint }); }
  cook(item, tier) { return this.req('cook', { item, tier }); }
  consume(key) { return this.req('consume', { key }); }
  requestTrade(targetId) { return this.req('trade:request', { targetId }); }
  respondTradeInvite(fromId, accept) { return this.req('trade:respond', { fromId, accept }); }
  updateTradeOffer(offer) { return this.req('trade:offer', { offer }); }
  confirmTrade(accept) { return this.req('trade:confirm', { accept }); }
  cancelTrade() { return this.req('trade:cancel', {}); }
  duelPreview(targetId) { return this.req('duel:preview', { targetId }); }
  requestDuel(targetId) { return this.req('duel:request', { targetId }); }
  respondDuelInvite(fromId, accept) { return this.req('duel:respond', { fromId, accept }); }
  setAdminTier(kind, tier) { return this.req('admin:tier', { kind, tier }); }
  setAdminGear(slot, tier) { return this.req('admin:gear', { slot, tier }); }
  dev(action) { return this.req('dev', action); }
  adminStats() { return this.req('admin:stats', {}); }
  adminPlayers() { return this.req('admin:players', {}); }
  adminSetRole(username, role) { return this.req('admin:setRole', { username, role }); }
  adminGrantSlot(username, count) { return this.req('admin:grantSlot', { username, count }); }
  adminGrantGold(username, amount) { return this.req('admin:grantGold', { username, amount }); }
  adminGrantPremium(username, amount) { return this.req('admin:grantPremium', { username, amount }); }
  adminGrantItem(username, key, qty) { return this.req('admin:grantItem', { username, key, qty }); }
  adminSetLevel(username, kind, tier) { return this.req('admin:setLevel', { username, kind, tier }); }
  adminSetGear(username, slot, tier) { return this.req('admin:setGear', { username, slot, tier }); }
  adminJoinPlayer(username) { return this.req('admin:joinPlayer', { username }); }
  say(text, channel, target) { return this.req('chat', { text, channel, target }); }
  createGuild(name) { return this.req('guild:create', { name }); }
  inviteToGuild(username) { return this.req('guild:invite', { username }); }
  respondGuildInvite(accept) { return this.req('guild:respond', { accept }); }
  leaveGuild() { return this.req('guild:leave', {}); }
  kickFromGuild(username) { return this.req('guild:kick', { username }); }
  guildInfo() { return this.req('guild:info', {}); }
  setActiveTitle(title) { return this.req('title:set', { title }); }
  sendFriendRequest(username) { return this.req('friend:request', { username }); }
  respondFriendRequest(fromId, accept) { return this.req('friend:respond', { fromId, accept }); }
  removeFriend(username) { return this.req('friend:remove', { username }); }
  joinFriend(username) { return this.req('friend:join', { username }); }
  friendsList() { return this.req('friend:list', {}); }
  castlesInfo() { return this.req('castle:info', {}); }
  housingInfo() {
    return this.req('housing:info', {}).then((res) => {
      if (res && res.ok && Array.isArray(res.list)) {
        const next = res.list.slice();
        const prevById = new Map(this.housingList.filter((h) => h && h.parcelId).map((h) => [h.parcelId, h]));
        for (const house of next) {
          const prev = prevById.get(house.parcelId);
          if (!prev || prev.modelId !== house.modelId) this.invalidateHouseMap(house.parcelId);
        }
        this.housingList = next;
      }
      return res;
    });
  }
  claimParcel(parcelId, modelId) { return this.req('housing:claim', { parcelId, modelId }); }
  enterHouse(parcelId) {
    return this.housingInfo().then(() => {
      const targetParcelId = String(parcelId || (this.me && this.me.parcelId) || '');
      if (targetParcelId) this.invalidateHouseMap(targetParcelId);
      return this.req('housing:enter', { parcelId });
    });
  }
  leaveHouse() { return this.req('housing:leave', {}); }
  craftFurniture(itemId) { return this.req('housing:craftFurniture', { itemId }); }
  placeFurniture(itemId, x, y) {
    return this.req('housing:placeFurniture', { itemId, x, y }).then((res) => {
      if (res && res.ok && res.house) this.updateHousingEntry(res.house);
      return res;
    });
  }
  removeFurniture(x, y) {
    return this.req('housing:removeFurniture', { x, y }).then((res) => {
      if (res && res.ok && res.house) this.updateHousingEntry(res.house);
      return res;
    });
  }
  claimCastle(terrain) { return this.req('castle:claim', { terrain }); }
  reinforceCastle(terrain) { return this.req('castle:reinforce', { terrain }); }
  repairCastle(terrain, gold) { return this.req('castle:repair', { terrain, gold }); }
  fortifyCastle(terrain) { return this.req('castle:fortify', { terrain }); }
  assaultCastlePreview(terrain) { return this.req('castle:assaultPreview', { terrain }); }
  assaultCastle(terrain) { return this.req('castle:assault', { terrain }); }
  craftSiegeEngine(tier) { return this.req('castle:craftEngine', { tier }); }
  deploySiegeEngine(key, tier) { return this.req('siege:deployEngine', { key, tier }); }
}
