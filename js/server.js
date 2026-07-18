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
    const p = {
      id: this.meId, username, bot: false,
      mapId: 'world',
      pos: { x: 0, y: 0 },
      pa: CONFIG.PA.START, paMs: 0,
      hp: 100, hpMs: 0,
      inventory: {},
      gold: 0,
      status: 'IDLE',
      harvestKey: null, harvestEndsAt: 0,
      raidKey: null,
      characters: [newCharacter(speciesClass)],
      activeChar: 0,
      charSlots: CONFIG.FREE_CHAR_SLOTS,
    };
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
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuary(me)) return { ok: false, error: 'L’éveil d’une nouvelle forme se fait à la Capitale ou dans un village.' };
    if (me.characters.length >= me.charSlots) return { ok: false, error: 'Tous vos emplacements sont occupés.' };
    if (me.characters.some((c) => c.speciesClass === speciesClass)) return { ok: false, error: 'Vous incarnez déjà cette forme.' };
    syncActiveCharacter(me);
    me.characters.push(newCharacter(speciesClass));
    this.emit('self', me);
    return { ok: true, index: me.characters.length - 1 };
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
      this.players.set('bot' + i, {
        id: 'bot' + i, username: BOT_NAMES[i % BOT_NAMES.length], speciesClass: cls, bot: true,
        mapId: 'world',
        pos: { x, y }, home: { x, y },
        hp: 100, pa: 100,
        harvestLevel: tier, weaponMastery: tier,
        weapon: { tier: Math.max(0, tier - 1), type: CLASS_GEAR[cls].weapon },
        armor: { tier: Math.max(0, tier - 1), type: CLASS_GEAR[cls].armor },
        inventory: {},
        status: 'IDLE', raidKey: null,
        nextThink: Math.random() * CONFIG.BOT_TICK_MS,
      });
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
    if (me.pa < CONFIG.COSTS.MOVE) return { ok: false, error: 'Pas assez de PA.' };
    const nx = me.pos.x + dx;
    const ny = me.pos.y + dy;
    if (!isWalkable(tiles, nx, ny)) return { ok: false, error: 'Case bloquée.' };
    me.pa -= CONFIG.COSTS.MOVE;
    me.pos = { x: nx, y: ny };
    this.syncCurrentMap();
    return { ok: true };
  }

  harvest(x, y) {
    const me = this.me;
    const tile = this.tilesOf(me).get(tileKey(x, y));
    const node = tile && tile.content;
    if (!node || node.kind !== 'resource') return { ok: false, error: 'Rien à récolter ici.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(me.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (this.now < node.inactiveUntil) return { ok: false, error: 'Gisement épuisé.' };
    const reqTier = Math.min(5, node.tier);
    if (me.harvestLevel < reqTier) return { ok: false, error: 'Niveau de récolte insuffisant (T' + reqTier + ' requis).' };
    if (me.pa < CONFIG.COSTS.HARVEST) return { ok: false, error: 'Pas assez de PA (2 requis).' };
    me.pa -= CONFIG.COSTS.HARVEST;
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

    const xp = 8 + Math.min(5, node.tier) * 6;
    me.harvestXp += xp;
    this.log('+' + qty + ' ' + RESOURCES[node.type].label + ' T' + node.tier + ' (+' + xp + ' XP récolte)');
    this.checkLevelUp(me, 'harvest');
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
    if (me.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (5 requis).' };
    me.pa -= CONFIG.COSTS.RAID;
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
    if (me.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (5 requis).' };
    me.pa -= CONFIG.COSTS.RAID;
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
    let myHpLoss = 0, myXp = 0, myGold = 0;

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

      // Victoire : usure (réduite par l'armure et le Rempart), soignée par la Sève
      let loss = 4 + monster.tier * 3;
      loss *= hpLossReduction(p);
      if (rampart) loss *= 0.7;
      loss = Math.max(1, Math.round(loss));
      p.hp = Math.max(1, p.hp - loss);
      if (druid) p.hp = Math.min(maxHp(p), p.hp + Math.round(maxHp(p) * CONFIG.COMBAT.DRUID_HEAL_PCT));
      if (p.id === this.meId) myHpLoss = loss;

      if (victory && !p.bot) {
        // Les monstres ne lâchent que de l'or (+ XP de maîtrise) — les
        // ressources viennent exclusivement de la récolte.
        const xp = 15 + Math.min(5, monster.tier) * 15;
        // Chapardeur (Renard Voleur) : +50 % d'or pour lui
        const lootMult = p.speciesClass === 'RENARD_VOLEUR' ? 1.5 : 1;
        p.weaponXp += xp;
        const gold = Math.ceil(rollGoldLoot(monster.tier) * lootMult);
        p.gold = (p.gold || 0) + gold;
        myXp = xp;
        myGold = gold;
        this.checkLevelUp(p, 'weapon');
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
      died: !victory,
      chance,
      label: raid.label,
      tier: raid.tier,
      teamForce: force,
      monsterForce: raid.monsterForce,
      participants: members.map((p) => p.username),
      gold: myGold,
      hpLoss: myHpLoss,
      xp: myXp,
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
    if (target > 5) return { ok: false, error: 'Tier maximum atteint.' };
    if (me.weaponMastery < target) return { ok: false, error: 'Maîtrise d’arme T' + target + ' requise.' };
    const recipe = UPGRADE_RECIPES[slot][target];
    for (const k in recipe) {
      if ((me.inventory[k] || 0) < recipe[k]) return { ok: false, error: 'Ressources insuffisantes.' };
    }
    const paCost = CONFIG.COSTS.UPGRADE[target];
    if (me.pa < paCost) return { ok: false, error: 'Pas assez de PA (' + paCost + ' requis).' };
    for (const k in recipe) {
      me.inventory[k] -= recipe[k];
      if (me.inventory[k] <= 0) delete me.inventory[k];
    }
    me.pa -= paCost;
    item.tier = target;
    if (slot === 'armor') me.hp = Math.min(maxHp(me), me.hp + 15);
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
    me.pos = { x: dest.x, y: dest.y };
    this.syncCurrentMap();
    this.emit('self', me);
    return { ok: true };
  }

  say(text) {
    const me = this.me;
    this.emit('chat', { from: me.username, text, type: 'chat', self: true });
    if (Math.random() < 0.5) {
      const bots = [...this.players.values()].filter((p) => p.bot);
      const bot = bots[Math.floor(Math.random() * bots.length)];
      this.pendingReplies.push({
        at: this.now + 1500 + Math.random() * 3500,
        msg: { from: bot.username, text: BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)], type: 'chat' },
      });
    }
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
    if (!Array.isArray(p.characters) || !p.characters.length) {
      const c = {};
      for (const f of CHARACTER_FIELDS) c[f] = p[f];
      p.characters = [c];
      p.activeChar = 0;
    }
    if (!p.mapId) p.mapId = 'world';
    if (typeof p.charSlots !== 'number') p.charSlots = CONFIG.FREE_CHAR_SLOTS;
    if (typeof p.gold !== 'number') p.gold = 0;
    const away = Math.max(0, Date.now() - (data.savedAt || Date.now()));
    p.pa = Math.min(CONFIG.PA.MAX, p.pa + Math.floor(away / CONFIG.PA.REGEN_MS));
    p.hp = Math.min(maxHp(p), p.hp + Math.floor(away / CONFIG.HP.REGEN_MS));
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
