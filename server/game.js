'use strict';

/* ============================================================
 * game.js — logique de jeu autoritaire, multijoueur
 * Version multi-cartes : monde + donjons partagés
 * ============================================================ */

const crypto = require('crypto');

Object.assign(globalThis, require('../js/config.js'));
Object.assign(globalThis, require('../js/world.js'));

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
    this.pendingReplies = [];
    this.send = () => {};
    this.broadcast = () => {};
    this.onDirty = () => {};
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
      status: 'IDLE',
      harvestKey: null, harvestEndsAt: 0,
      raidKey: null,
      characters: [newCharacter(data.speciesClass)],
      activeChar: 0,
      charSlots: CONFIG.FREE_CHAR_SLOTS,
      visitedVillages: [],
      // Le tout premier compte créé sur une base vierge devient administrateur.
      role: this.players.size === 0 ? 'admin' : 'user',
    };
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
    };
  }

  publicPlayers() {
    const out = [];
    for (const p of this.players.values()) {
      if (p.online) out.push({ id: p.id, username: p.username, speciesClass: p.speciesClass, pos: p.pos, status: p.status, bot: false, mapId: p.mapId || 'world' });
    }
    for (const b of this.bots.values()) {
      out.push({ id: b.id, username: b.username, speciesClass: b.speciesClass, pos: b.pos, status: b.status, bot: true, mapId: b.mapId || 'world' });
    }
    return out;
  }

  raidsPayload() {
    return [...this.raids.values()].map((r) => ({
      key: r.key,
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
      this.bots.set('bot' + i, {
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
      if (this.now >= raid.endsAt) this.resolveRaid(key, raid);
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
        const gold = Math.ceil(rollGoldLoot(monster.tier) * lootMult);
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
      // Le % de victoire du lobby en cours doit refléter le buff
      if (p.raidKey) this.raidsChanged();
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

  say(p, text) {
    this.broadcast('chat', { from: p.username, text, type: 'chat' });
    if (Math.random() < 0.5) {
      const bots = [...this.bots.values()];
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

  serialize() {
    const credentials = {};
    for (const [id, cred] of this.credentials) credentials[id] = cred;
    return {
      seed: this.seed,
      now: this.now,
      speed: this.speed,
      players: [...this.players.values()],
      credentials,
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
      if (!Array.isArray(p.visitedVillages)) p.visitedVillages = [];
      if (p.role !== 'admin' && p.role !== 'user') p.role = 'user';
      this.players.set(p.id, p);
      if (p.token) this.tokens.set(p.token, p.id);
    }
    for (const [id, cred] of Object.entries(data.credentials || {})) this.credentials.set(id, cred);
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

module.exports = { Game };
