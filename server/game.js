'use strict';

/* ============================================================
 * game.js — logique de jeu autoritaire, multijoueur.
 *
 * Reprend la logique validée de js/server.js (ServerSim) en la
 * généralisant à N joueurs persistants (comptes par token) +
 * bots. Aucune dépendance au transport : index.js branche
 * this.send / this.broadcast sur Socket.io.
 * ============================================================ */

const crypto = require('crypto');

// config.js / world.js sont partagés avec le client (globals navigateur) :
// on injecte leurs exports dans globalThis pour garder le code identique.
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
    this.tiles = generateWorld(seed);
    this.players = new Map();   // accountId -> joueur humain (persistant)
    this.bots = new Map();      // botId -> bot
    this.tokens = new Map();    // token -> accountId
    this.raids = new Map();     // tileKey -> raid
    this.pendingReplies = [];
    this.send = () => {};       // (accountId, ev, data) — branché par index.js
    this.broadcast = () => {};  // (ev, data)
    if (persisted) this.load(persisted);
    this.spawnBots();
  }

  /* ---------- Notifications ---------- */
  log(text) { this.broadcast('chat', { from: null, text, type: 'event' }); }
  plog(p, text) { this.send(p.id, 'chat', { from: null, text, type: 'event' }); }
  toast(p, text) { this.send(p.id, 'toast', { text }); }
  pushSelf(p) { this.send(p.id, 'self', p); }
  raidsChanged() { this.broadcast('raids', this.raidsPayload()); }
  worldPatch(key, inactiveUntil) { this.broadcast('world', { key, inactiveUntil }); }

  memberById(id) { return this.players.get(id) || this.bots.get(id); }

  chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  /* ---------- Comptes ---------- */
  auth(data) {
    // Reprise de session par token
    if (data.token && this.tokens.has(data.token)) {
      const p = this.players.get(this.tokens.get(data.token));
      if (p) {
        const away = Math.max(0, Date.now() - (p.lastSeen || Date.now()));
        p.pa = Math.min(CONFIG.PA.MAX, p.pa + Math.floor(away / CONFIG.PA.REGEN_MS));
        p.hp = Math.min(maxHp(p), p.hp + Math.floor(away / CONFIG.HP.REGEN_MS));
        p.lastSeen = Date.now();
        return { ok: true, player: p };
      }
    }
    // Création de compte
    if (data.username && data.speciesClass && CLASSES[data.speciesClass]) {
      const username = String(data.username).trim().slice(0, 16);
      if (!username) return { ok: false, needsCreation: true, error: 'Nom invalide.' };
      const id = 'p_' + username.toLowerCase();
      if (this.players.has(id)) {
        return { ok: false, needsCreation: true, error: 'Le nom « ' + username + ' » est déjà pris.' };
      }
      const gear = CLASS_GEAR[data.speciesClass];
      const p = {
        id, username, speciesClass: data.speciesClass, bot: false,
        token: crypto.randomBytes(16).toString('hex'),
        online: false, lastSeen: Date.now(),
        pos: { x: 0, y: 0 },
        pa: CONFIG.PA.START, paMs: 0,
        hp: 100, hpMs: 0,
        harvestXp: 0, harvestLevel: 1,
        weaponXp: 0, weaponMastery: 1,
        weapon: { tier: 0, type: gear.weapon },
        armor: { tier: 0, type: gear.armor },
        inventory: {},
        status: 'IDLE',
        harvestKey: null, harvestEndsAt: 0,
        raidKey: null,
      };
      p.hp = maxHp(p);
      this.players.set(id, p);
      this.tokens.set(p.token, id);
      this.log('🐾 ' + username + ' entre dans les Terres Sauvages !');
      return { ok: true, created: true, player: p };
    }
    return { ok: false, needsCreation: true };
  }

  initPayload(p) {
    return {
      token: p.token,
      selfId: p.id,
      self: p,
      seed: this.seed,
      now: this.now,
      speed: this.speed,
      worldDiffs: this.worldDiffs(),
      players: this.publicPlayers(),
      raids: this.raidsPayload(),
    };
  }

  publicPlayers() {
    const out = [];
    for (const p of this.players.values()) {
      if (p.online) {
        out.push({ id: p.id, username: p.username, speciesClass: p.speciesClass, pos: p.pos, status: p.status, bot: false });
      }
    }
    for (const b of this.bots.values()) {
      out.push({ id: b.id, username: b.username, speciesClass: b.speciesClass, pos: b.pos, status: b.status, bot: true });
    }
    return out;
  }

  raidsPayload() {
    return [...this.raids.values()].map((r) => ({
      key: r.key, tier: r.tier, label: r.label,
      monsterForce: r.monsterForce, endsAt: r.endsAt,
      leaderId: r.leaderId, participants: r.participants,
      teamForce: this.teamForce(r),
    }));
  }

  worldDiffs() {
    const diffs = [];
    for (const [key, tile] of this.tiles) {
      if (tile.content && tile.content.inactiveUntil > this.now) {
        diffs.push([key, tile.content.inactiveUntil]);
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
      } while (!isWalkable(this.tiles, x, y) && tries < 50);
      this.bots.set('bot' + i, {
        id: 'bot' + i, username: BOT_NAMES[i % BOT_NAMES.length], speciesClass: cls, bot: true,
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

  /* ---------- Boucle serveur (dtReal en ms) ---------- */
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

      if (p.status === 'HARVESTING' && this.now >= p.harvestEndsAt) {
        this.finishHarvest(p);
      }
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

  /* ---------- Actions joueur ---------- */
  move(p, dx, dy) {
    dx = Math.round(Number(dx) || 0); dy = Math.round(Number(dy) || 0);
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) {
      return { ok: false, error: 'Case non adjacente.' };
    }
    if (p.pa < CONFIG.COSTS.MOVE) return { ok: false, error: 'Pas assez de PA.' };
    const nx = p.pos.x + dx, ny = p.pos.y + dy;
    if (!isWalkable(this.tiles, nx, ny)) return { ok: false, error: 'Case bloquée.' };
    p.pa -= CONFIG.COSTS.MOVE;
    p.pos = { x: nx, y: ny };
    return { ok: true };
  }

  harvest(p, x, y) {
    const tile = this.tiles.get(tileKey(x, y));
    const node = tile && tile.content;
    if (!node || node.kind !== 'resource') return { ok: false, error: 'Rien à récolter ici.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(p.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (this.now < node.inactiveUntil) return { ok: false, error: 'Gisement épuisé (repousse en cours).' };
    if (p.harvestLevel < node.tier) {
      return { ok: false, error: 'Niveau de récolte insuffisant (T' + node.tier + ' requis, vous êtes T' + p.harvestLevel + ').' };
    }
    if (p.pa < CONFIG.COSTS.HARVEST) return { ok: false, error: 'Pas assez de PA (2 requis).' };

    p.pa -= CONFIG.COSTS.HARVEST;
    p.status = 'HARVESTING';
    p.harvestKey = tileKey(x, y);
    p.harvestEndsAt = this.now + CONFIG.HARVEST_MS;
    return { ok: true, duration: CONFIG.HARVEST_MS };
  }

  finishHarvest(p) {
    const tile = this.tiles.get(p.harvestKey);
    const node = tile.content;
    p.status = 'IDLE';
    p.harvestKey = null;

    const qty = 3 + Math.floor(Math.random() * 3);
    const key = stackKey(node.type, node.tier);
    p.inventory[key] = (p.inventory[key] || 0) + qty;
    node.inactiveUntil = this.now + CONFIG.RESPAWN_RESOURCE_MS;
    this.worldPatch(tileKey(tile.x, tile.y), node.inactiveUntil);

    const xp = 8 + node.tier * 6;
    p.harvestXp += xp;
    this.plog(p, '+' + qty + ' ' + RESOURCES[node.type].label + ' T' + node.tier + ' (+' + xp + ' XP récolte)');
    this.checkLevelUp(p, 'harvest');
    this.pushSelf(p);
  }

  createRaid(p, x, y) {
    const key = tileKey(x, y);
    const tile = this.tiles.get(key);
    const monster = tile && tile.content;
    if (!monster || monster.kind !== 'monster') return { ok: false, error: 'Aucun monstre ici.' };
    if (this.now < monster.inactiveUntil) return { ok: false, error: 'Ce groupe de monstres est vaincu (réapparition en cours).' };
    if (this.raids.has(key)) return this.joinRaid(p, key);
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(p.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (p.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (5 requis).' };

    p.pa -= CONFIG.COSTS.RAID;
    p.status = 'LOBBY_COMBAT';
    p.raidKey = key;
    this.raids.set(key, {
      key, tier: monster.tier, label: monster.label,
      monsterForce: monster.force,
      participants: [p.id],
      leaderId: p.id,
      endsAt: this.now + CONFIG.LOBBY_MS,
    });
    this.log('⚔ ' + p.username + ' ouvre un raid : ' + monster.label + ' T' + monster.tier + ' en (' + x + ', ' + y + ')');
    this.raidsChanged();
    return { ok: true };
  }

  joinRaid(p, key) {
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.participants.includes(p.id)) return { ok: false, error: 'Vous êtes déjà dans ce lobby.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    const tile = this.tiles.get(key);
    if (this.chebyshev(p.pos, tile) > CONFIG.JOIN_RADIUS) return { ok: false, error: 'Trop loin pour rejoindre.' };
    if (p.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (5 requis).' };

    p.pa -= CONFIG.COSTS.RAID;
    p.status = 'LOBBY_COMBAT';
    p.raidKey = key;
    raid.participants.push(p.id);
    this.log(p.username + ' rejoint le raid ' + raid.label + ' T' + raid.tier + ' (' + raid.participants.length + ' participants)');
    this.raidsChanged();
    return { ok: true };
  }

  /* Le chef du raid peut déclencher le combat sans attendre les 30 s */
  startRaidNow(p, key) {
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.leaderId !== p.id) return { ok: false, error: 'Seul le créateur du raid peut lancer le combat.' };
    raid.endsAt = this.now;   // résolu au prochain tick
    this.raidsChanged();
    return { ok: true };
  }

  botJoinRaid(bot, raid) {
    bot.status = 'LOBBY_COMBAT';
    bot.raidKey = raid.key;
    raid.participants.push(bot.id);
    this.log(bot.username + ' rejoint le raid ' + raid.label + ' T' + raid.tier + ' (' + raid.participants.length + ' participants)');
    this.raidsChanged();
  }

  teamForce(raid) {
    const members = raid.participants.map((id) => this.memberById(id)).filter(Boolean);
    let total = 0;
    for (const p of members) {
      let f = playerForce(p);
      if (p.speciesClass === 'CORBEAU_NECROMANCIEN') f *= 1 + 0.08 * members.length;
      total += f;
    }
    if (members.some((p) => p.speciesClass === 'LION_PALADIN')) total *= 1.10;
    return Math.round(total);
  }

  resolveRaid(key, raid) {
    this.raids.delete(key);
    const tile = this.tiles.get(key);
    const monster = tile.content;
    const members = raid.participants.map((id) => this.memberById(id)).filter(Boolean);
    const force = this.teamForce(raid);
    const victory = force > raid.monsterForce;
    const druid = victory && members.some((p) => p.speciesClass === 'CERF_DRUIDE');
    const names = members.map((p) => p.username);

    for (const p of members) {
      p.status = 'IDLE';
      p.raidKey = null;

      let loss = victory ? 4 + raid.tier * 3 : 22 + raid.tier * 6;
      loss *= hpLossReduction(p);
      if (p.speciesClass === 'OURS_GUERRIER') loss *= 0.5;
      loss = Math.max(1, Math.round(loss));
      p.hp -= loss;
      if (druid) p.hp = Math.min(maxHp(p), p.hp + 15);

      let loot = null, xp = 0;
      if (victory && !p.bot) {
        xp = 15 + raid.tier * 15;
        const lootMult = p.speciesClass === 'RENARD_VOLEUR' ? 1.5 : 1;
        loot = {};
        for (let i = 0; i < 2; i++) {
          const types = Object.keys(RESOURCES);
          const type = types[Math.floor(Math.random() * types.length)];
          const k = stackKey(type, raid.tier);
          loot[k] = (loot[k] || 0) + Math.ceil((2 + Math.floor(Math.random() * 3)) * lootMult);
        }
        p.weaponXp += xp;
        for (const k in loot) p.inventory[k] = (p.inventory[k] || 0) + loot[k];
        this.checkLevelUp(p, 'weapon');
      }

      // KO : rapatriement à la Capitale
      if (p.hp <= 0) {
        p.hp = Math.ceil(maxHp(p) / 2);
        p.pos = { x: 0, y: 0 };
        if (!p.bot) this.plog(p, 'KO ! Vous êtes rapatrié à la Capitale.');
      }

      if (!p.bot) {
        this.send(p.id, 'result', {
          victory, label: raid.label, tier: raid.tier,
          teamForce: force, monsterForce: raid.monsterForce,
          participants: names,
          loot, hpLoss: loss, xp, druid,
        });
        this.pushSelf(p);
      }
    }

    if (victory) {
      monster.inactiveUntil = this.now + CONFIG.RESPAWN_MONSTER_MS;
      this.worldPatch(key, monster.inactiveUntil);
    }

    this.log('⚔ Raid ' + raid.label + ' T' + raid.tier + ' : ' +
      (victory ? 'VICTOIRE' : 'DÉFAITE') + ' (équipe ' + force + ' vs ' + raid.monsterForce + ')');
    this.raidsChanged();
  }

  upgrade(p, slot) {
    if (slot !== 'weapon' && slot !== 'armor') return { ok: false, error: 'Équipement inconnu.' };
    if (p.pos.x !== 0 || p.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale (0,0).' };
    const item = p[slot];
    const target = item.tier + 1;
    if (target > 5) return { ok: false, error: 'Tier maximum atteint (T5).' };
    if (p.weaponMastery < target) {
      return { ok: false, error: 'Maîtrise d’arme T' + target + ' requise (actuelle : T' + p.weaponMastery + ').' };
    }
    const recipe = UPGRADE_RECIPES[slot][target];
    for (const k in recipe) {
      if ((p.inventory[k] || 0) < recipe[k]) {
        const r = parseStackKey(k);
        return { ok: false, error: 'Ressources insuffisantes : ' + recipe[k] + '× ' + RESOURCES[r.type].label + ' T' + r.tier + '.' };
      }
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
    this.log('⚒ ' + p.username + ' forge ' + (slot === 'weapon' ? 'son ' + item.type : 'son armure de ' + item.type) + ' au T' + target + ' !');
    return { ok: true };
  }

  rest(p) {
    if (p.pos.x !== 0 || p.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale.' };
    p.hp = maxHp(p);
    this.plog(p, 'Vous vous reposez à la fontaine de la Capitale. PV restaurés.');
    return { ok: true };
  }

  setAdminTier(p, kind, tier) {
    const target = Math.max(1, Math.min(5, Number(tier) || 1));
    if (kind === 'harvest') {
      p.harvestLevel = target;
      p.harvestXp = XP_LEVELS[target - 1];
      this.plog(p, 'Admin : niveau de récolte fixé à T' + target + '.');
      return { ok: true };
    }
    if (kind === 'weapon') {
      p.weaponMastery = target;
      p.weaponXp = XP_LEVELS[target - 1];
      this.plog(p, 'Admin : maîtrise d’arme fixée à T' + target + '.');
      return { ok: true };
    }
    return { ok: false, error: 'Catégorie admin inconnue.' };
  }

  setAdminGear(p, slot, tier) {
    const target = Math.max(0, Math.min(5, Number(tier) || 0));
    if (slot === 'weapon') {
      p.weapon.tier = target;
      this.plog(p, 'Admin : arme fixée à T' + target + '.');
      return { ok: true };
    }
    if (slot === 'armor') {
      p.armor.tier = target;
      p.hp = Math.min(p.hp, maxHp(p));
      this.plog(p, 'Admin : armure fixée à T' + target + '.');
      return { ok: true };
    }
    return { ok: false, error: 'Équipement admin inconnu.' };
  }

  teleportVillage(p, x, y) {
    const from = this.tiles.get(tileKey(p.pos.x, p.pos.y));
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!from || (from.content ? (from.content.kind !== 'village' && from.content.kind !== 'capital') : (from.x !== 0 || from.y !== 0))) {
      return { ok: false, error: 'Vous devez être dans un village ou à la Capitale pour voyager.' };
    }

    const dest = this.tiles.get(tileKey(Number(x), Number(y)));
    if (!dest || !dest.content || (dest.content.kind !== 'village' && dest.content.kind !== 'capital')) {
      return { ok: false, error: 'Destination invalide.' };
    }
    if (dest.x === p.pos.x && dest.y === p.pos.y) {
      return { ok: false, error: 'Vous êtes déjà ici.' };
    }

    p.pos = { x: dest.x, y: dest.y };
    const targetLabel = dest.content.kind === 'capital' ? 'la Capitale' : (dest.content.name || 'un village');
    this.plog(p, 'Vous voyagez vers ' + targetLabel + '.');
    return { ok: true };
  }

  say(p, text) {
    this.broadcast('chat', { from: p.username, text, type: 'chat' });
    if (Math.random() < 0.35) {
      const bots = [...this.bots.values()];
      const bot = bots[Math.floor(Math.random() * bots.length)];
      if (bot) {
        this.pendingReplies.push({
          at: this.now + 1500 + Math.random() * 3500,
          msg: { from: bot.username, text: BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)], type: 'chat' },
        });
      }
    }
  }

  /* Commandes de test (prototype) */
  dev(p, action) {
    if (action.speed) {
      this.speed = Math.max(1, Math.min(120, Number(action.speed) || 1));
      this.broadcast('time', { now: this.now, speed: this.speed });
      this.log('⚙ Vitesse serveur : x' + this.speed + ' (par ' + p.username + ')');
      return { ok: true };
    }
    if (action.pa) {
      p.pa = Math.min(CONFIG.PA.MAX, p.pa + Math.max(0, Number(action.pa) || 0));
      return { ok: true };
    }
    if (action.reset) {
      if (p.raidKey) return { ok: false, error: 'Impossible pendant un raid.' };
      this.players.delete(p.id);
      this.tokens.delete(p.token);
      this.log(p.username + ' a quitté définitivement les Terres Sauvages.');
      return { ok: true, reset: true };
    }
    return { ok: false, error: 'Commande inconnue.' };
  }

  checkLevelUp(p, kind) {
    if (kind === 'harvest') {
      const lvl = levelFromXp(p.harvestXp);
      if (lvl > p.harvestLevel) {
        p.harvestLevel = lvl;
        this.plog(p, 'Niveau de récolte T' + lvl + ' atteint !');
        this.toast(p, 'Récolte T' + lvl + ' débloquée');
      }
    } else {
      const lvl = levelFromXp(p.weaponXp);
      if (lvl > p.weaponMastery) {
        p.weaponMastery = lvl;
        this.plog(p, 'Maîtrise d’arme T' + lvl + ' atteinte !');
        this.toast(p, 'Maîtrise d’arme T' + lvl);
      }
    }
  }

  /* ---------- IA des bots ---------- */
  botThink(bot) {
    if (bot.status !== 'IDLE') return;

    for (const raid of this.raids.values()) {
      const tile = this.tiles.get(raid.key);
      const d = this.chebyshev(bot.pos, tile);
      if (d <= CONFIG.JOIN_RADIUS + 5 && this.teamForce(raid) < raid.monsterForce * 1.15) {
        if (d <= CONFIG.JOIN_RADIUS) { this.botJoinRaid(bot, raid); return; }
        this.botStepToward(bot, tile.x, tile.y);
        return;
      }
    }

    if (Math.random() < 0.25) {
      if (Math.random() < 0.06) {
        this.broadcast('chat', { from: bot.username, text: BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)], type: 'chat' });
      }
      return;
    }
    const tx = bot.home.x + Math.round((Math.random() - 0.5) * 12);
    const ty = bot.home.y + Math.round((Math.random() - 0.5) * 12);
    this.botStepToward(bot, tx, ty);
  }

  botStepToward(bot, tx, ty) {
    const dx = Math.sign(tx - bot.pos.x), dy = Math.sign(ty - bot.pos.y);
    const options = [[dx, dy], [dx, 0], [0, dy]].filter(([a, b]) => a || b);
    for (const [a, b] of options) {
      if (isWalkable(this.tiles, bot.pos.x + a, bot.pos.y + b)) {
        bot.pos = { x: bot.pos.x + a, y: bot.pos.y + b };
        return;
      }
    }
  }

  /* ---------- Persistance ---------- */
  serialize() {
    return {
      seed: this.seed,
      now: this.now,
      speed: this.speed,
      players: [...this.players.values()],
      worldDiffs: this.worldDiffs(),
      savedAt: Date.now(),
    };
  }

  load(data) {
    this.now = data.now || 0;
    for (const p of data.players || []) {
      // Une action interrompue par l'arrêt du serveur est annulée
      p.online = false;
      p.status = 'IDLE';
      p.harvestKey = null;
      p.raidKey = null;
      this.players.set(p.id, p);
      if (p.token) this.tokens.set(p.token, p.id);
    }
    for (const [key, until] of data.worldDiffs || []) {
      const tile = this.tiles.get(key);
      if (tile && tile.content) tile.content.inactiveUntil = until;
    }
  }
}

module.exports = { Game };
