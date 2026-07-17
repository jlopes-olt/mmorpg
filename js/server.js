'use strict';

/* ============================================================
 * server.js — ServerSim : backend simulé, autoritatif
 *
 * Toute la logique de jeu vit ici, derrière une API qui imite
 * le contrat de messages d'un futur backend Node + Socket.io
 * (voir README.md). Le client (main/ui/render) ne fait que
 * envoyer des intentions et afficher l'état.
 *
 * Horloge virtuelle : this.now avance via tick(dt), ce qui
 * permet l'accélération x10/x60 du panneau DEV sans toucher
 * à la logique.
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
    this.tiles = generateWorld(seed);
    this.players = new Map();   // id -> joueur (humain + bots)
    this.raids = new Map();     // tileKey -> raid
    this.pendingReplies = [];
    this.listeners = {};
    this.meId = 'me';
  }

  /* ---------- Événements (équivalent socket.emit côté serveur) */
  on(ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((cb) => cb(data)); }

  get me() { return this.players.get(this.meId); }

  log(text, type) { this.emit('chat', { from: null, text, type: type || 'event' }); }
  toast(text) { this.emit('toast', { text }); }

  /* ---------- Création du personnage ---------- */
  join(username, speciesClass) {
    const gear = CLASS_GEAR[speciesClass];
    const p = {
      id: this.meId, username, speciesClass, bot: false,
      pos: { x: 0, y: 0 },
      pa: CONFIG.PA.START, paMs: 0,
      hp: 100, hpMs: 0,
      harvestXp: 0, harvestLevel: 1,
      weaponXp: 0, weaponMastery: 1,
      weapon: { tier: 0, type: gear.weapon },
      armor: { tier: 0, type: gear.armor },
      inventory: {},
      status: 'IDLE',       // IDLE | HARVESTING | LOBBY_COMBAT
      harvestKey: null, harvestEndsAt: 0,
      raidKey: null,
    };
    p.hp = maxHp(p);
    this.players.set(p.id, p);
    this.spawnBots();
    this.log('Bienvenue dans les Terres Sauvages, ' + username + '.');
    return p;
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
      this.players.set('bot' + i, {
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

  /* ---------- Boucle serveur ---------- */
  tick(dt) {
    this.now += dt;
    const me = this.me;
    if (!me) return;

    // Recharge PA (+1/min) et PV (+1/30s) du joueur humain
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

    // Fin de récolte
    if (me.status === 'HARVESTING' && this.now >= me.harvestEndsAt) {
      this.finishHarvest(me);
    }

    // Résolution des lobbys arrivés à terme
    for (const [key, raid] of [...this.raids]) {
      if (this.now >= raid.endsAt) this.resolveRaid(key, raid);
    }

    // IA des bots
    for (const p of this.players.values()) {
      if (p.bot && this.now >= p.nextThink) {
        p.nextThink = this.now + CONFIG.BOT_TICK_MS * (0.7 + Math.random() * 0.6);
        this.botThink(p);
      }
    }

    // Réponses de chat différées
    this.pendingReplies = this.pendingReplies.filter((r) => {
      if (this.now >= r.at) { this.emit('chat', r.msg); return false; }
      return true;
    });
  }

  /* ---------- Déplacement (1 PA / case, adjacence stricte) ---------- */
  move(dx, dy) {
    const me = this.me;
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) {
      return { ok: false, error: 'Case non adjacente.' };
    }
    if (me.pa < CONFIG.COSTS.MOVE) return { ok: false, error: 'Pas assez de PA.' };
    const nx = me.pos.x + dx, ny = me.pos.y + dy;
    if (!isWalkable(this.tiles, nx, ny)) return { ok: false, error: 'Case bloquée.' };
    me.pa -= CONFIG.COSTS.MOVE;
    me.pos = { x: nx, y: ny };
    return { ok: true };
  }

  /* ---------- Récolte ---------- */
  harvest(x, y) {
    const me = this.me;
    const tile = this.tiles.get(tileKey(x, y));
    const node = tile && tile.content;
    if (!node || node.kind !== 'resource') return { ok: false, error: 'Rien à récolter ici.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(me.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (this.now < node.inactiveUntil) return { ok: false, error: 'Gisement épuisé (repousse en cours).' };
    if (me.harvestLevel < node.tier) {
      return { ok: false, error: 'Niveau de récolte insuffisant (T' + node.tier + ' requis, vous êtes T' + me.harvestLevel + ').' };
    }
    if (me.pa < CONFIG.COSTS.HARVEST) return { ok: false, error: 'Pas assez de PA (2 requis).' };

    me.pa -= CONFIG.COSTS.HARVEST;
    me.status = 'HARVESTING';
    me.harvestKey = tileKey(x, y);
    me.harvestEndsAt = this.now + CONFIG.HARVEST_MS;
    return { ok: true, duration: CONFIG.HARVEST_MS };
  }

  finishHarvest(me) {
    const tile = this.tiles.get(me.harvestKey);
    const node = tile.content;
    me.status = 'IDLE';
    me.harvestKey = null;

    const qty = 3 + Math.floor(Math.random() * 3);
    const key = stackKey(node.type, node.tier);
    me.inventory[key] = (me.inventory[key] || 0) + qty;
    node.inactiveUntil = this.now + CONFIG.RESPAWN_RESOURCE_MS;

    const xp = 8 + node.tier * 6;
    me.harvestXp += xp;
    this.log('+' + qty + ' ' + RESOURCES[node.type].label + ' T' + node.tier + ' (+' + xp + ' XP récolte)');
    this.checkLevelUp(me, 'harvest');
    this.emit('self', me);
  }

  /* ---------- Raids : lobby 30 s puis résolution instantanée ---------- */
  createRaid(x, y) {
    const me = this.me;
    const key = tileKey(x, y);
    const tile = this.tiles.get(key);
    const monster = tile && tile.content;
    if (!monster || monster.kind !== 'monster') return { ok: false, error: 'Aucun monstre ici.' };
    if (this.now < monster.inactiveUntil) return { ok: false, error: 'Ce groupe de monstres est vaincu (réapparition en cours).' };
    if (this.raids.has(key)) return this.joinRaid(key);
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(me.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (me.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (5 requis).' };

    me.pa -= CONFIG.COSTS.RAID;
    me.status = 'LOBBY_COMBAT';
    me.raidKey = key;
    this.raids.set(key, {
      key, tier: monster.tier, label: monster.label,
      monsterForce: monster.force,
      participants: [me.id],
      leaderId: me.id,
      endsAt: this.now + CONFIG.LOBBY_MS,
    });
    this.log('Lobby de raid ouvert : ' + monster.label + ' T' + monster.tier + ' (30 s)');
    return { ok: true };
  }

  joinRaid(key) {
    const me = this.me;
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.participants.includes(me.id)) return { ok: false, error: 'Vous êtes déjà dans ce lobby.' };
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    const tile = this.tiles.get(key);
    if (this.chebyshev(me.pos, tile) > CONFIG.JOIN_RADIUS) return { ok: false, error: 'Trop loin pour rejoindre.' };
    if (me.pa < CONFIG.COSTS.RAID) return { ok: false, error: 'Pas assez de PA (5 requis).' };

    me.pa -= CONFIG.COSTS.RAID;
    me.status = 'LOBBY_COMBAT';
    me.raidKey = key;
    raid.participants.push(me.id);
    return { ok: true };
  }

  /* Le chef du raid peut déclencher le combat sans attendre les 30 s */
  startRaidNow(key) {
    const me = this.me;
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.leaderId !== me.id) return { ok: false, error: 'Seul le créateur du raid peut lancer le combat.' };
    raid.endsAt = this.now;   // résolu au prochain tick
    return { ok: true };
  }

  botJoinRaid(bot, raid) {
    bot.status = 'LOBBY_COMBAT';
    bot.raidKey = raid.key;
    raid.participants.push(bot.id);
    this.log(bot.username + ' rejoint le raid ' + raid.label + ' T' + raid.tier + ' (' + raid.participants.length + ' participants)');
  }

  teamForce(raid) {
    const members = raid.participants.map((id) => this.players.get(id)).filter(Boolean);
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
    const members = raid.participants.map((id) => this.players.get(id)).filter(Boolean);
    const force = this.teamForce(raid);
    const victory = force > raid.monsterForce;
    const druid = victory && members.some((p) => p.speciesClass === 'CERF_DRUIDE');

    let myLoot = null, myHpLoss = 0, myXp = 0;

    for (const p of members) {
      p.status = 'IDLE';
      p.raidKey = null;

      let loss = victory ? 4 + raid.tier * 3 : 22 + raid.tier * 6;
      loss *= hpLossReduction(p);
      if (p.speciesClass === 'OURS_GUERRIER') loss *= 0.5;
      loss = Math.max(1, Math.round(loss));
      p.hp -= loss;
      if (druid) p.hp = Math.min(maxHp(p), p.hp + 15);

      if (p.id === this.meId) myHpLoss = loss;

      if (victory) {
        const xp = 15 + raid.tier * 15;
        const lootMult = p.speciesClass === 'RENARD_VOLEUR' ? 1.5 : 1;
        const loot = {};
        for (let i = 0; i < 2; i++) {
          const types = Object.keys(RESOURCES);
          const type = types[Math.floor(Math.random() * types.length)];
          const k = stackKey(type, raid.tier);
          loot[k] = (loot[k] || 0) + Math.ceil((2 + Math.floor(Math.random() * 3)) * lootMult);
        }
        if (!p.bot) {
          p.weaponXp += xp;
          for (const k in loot) p.inventory[k] = (p.inventory[k] || 0) + loot[k];
          myLoot = loot; myXp = xp;
          this.checkLevelUp(p, 'weapon');
        }
      }

      // KO : rapatriement à la Capitale
      if (p.hp <= 0) {
        p.hp = Math.ceil(maxHp(p) / 2);
        p.pos = { x: 0, y: 0 };
        if (!p.bot) this.log('KO ! Vous êtes rapatrié à la Capitale.');
      }
    }

    if (victory) monster.inactiveUntil = this.now + CONFIG.RESPAWN_MONSTER_MS;

    this.log('⚔ Raid ' + raid.label + ' T' + raid.tier + ' : ' +
      (victory ? 'VICTOIRE' : 'DÉFAITE') + ' (équipe ' + force + ' vs ' + raid.monsterForce + ')');

    if (raid.participants.includes(this.meId)) {
      this.emit('result', {
        victory, label: raid.label, tier: raid.tier,
        teamForce: force, monsterForce: raid.monsterForce,
        participants: members.map((p) => p.username),
        loot: myLoot, hpLoss: myHpLoss, xp: myXp, druid,
      });
    }
    this.emit('self', this.me);
  }

  /* ---------- PNJ de la Capitale (case 0,0) ---------- */
  upgrade(slot) {
    const me = this.me;
    if (me.pos.x !== 0 || me.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale (0,0).' };
    const item = me[slot];
    const target = item.tier + 1;
    if (target > 5) return { ok: false, error: 'Tier maximum atteint (T5).' };
    if (me.weaponMastery < target) {
      return { ok: false, error: 'Maîtrise d’arme T' + target + ' requise (actuelle : T' + me.weaponMastery + ').' };
    }
    const recipe = UPGRADE_RECIPES[slot][target];
    for (const k in recipe) {
      if ((me.inventory[k] || 0) < recipe[k]) {
        const r = parseStackKey(k);
        return { ok: false, error: 'Ressources insuffisantes : ' + recipe[k] + '× ' + RESOURCES[r.type].label + ' T' + r.tier + '.' };
      }
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
    this.log((slot === 'weapon' ? item.type : 'Armure de ' + item.type) + ' améliorée au T' + target + ' !');
    this.emit('self', me);
    return { ok: true };
  }

  rest() {
    const me = this.me;
    if (me.pos.x !== 0 || me.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale.' };
    me.hp = maxHp(me);
    this.log('Vous vous reposez à la fontaine de la Capitale. PV restaurés.');
    this.emit('self', me);
    return { ok: true };
  }

  setAdminTier(kind, tier) {
    const me = this.me;
    const target = Math.max(1, Math.min(5, Number(tier) || 1));
    if (kind === 'harvest') {
      me.harvestLevel = target;
      me.harvestXp = XP_LEVELS[target - 1];
      this.log('Admin : niveau de récolte fixé à T' + target + '.');
      this.emit('self', me);
      return { ok: true };
    }
    if (kind === 'weapon') {
      me.weaponMastery = target;
      me.weaponXp = XP_LEVELS[target - 1];
      this.log('Admin : maîtrise d’arme fixée à T' + target + '.');
      this.emit('self', me);
      return { ok: true };
    }
    return { ok: false, error: 'Catégorie admin inconnue.' };
  }

  setAdminGear(slot, tier) {
    const me = this.me;
    const target = Math.max(0, Math.min(5, Number(tier) || 0));
    if (slot === 'weapon') {
      me.weapon.tier = target;
      this.log('Admin : arme fixée à T' + target + '.');
      this.emit('self', me);
      return { ok: true };
    }
    if (slot === 'armor') {
      me.armor.tier = target;
      me.hp = Math.min(me.hp, maxHp(me));
      this.log('Admin : armure fixée à T' + target + '.');
      this.emit('self', me);
      return { ok: true };
    }
    return { ok: false, error: 'Équipement admin inconnu.' };
  }

  teleportVillage(x, y) {
    const me = this.me;
    if (me.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    const from = this.tiles.get(tileKey(me.pos.x, me.pos.y));
    if (!from || (from.content ? (from.content.kind !== 'village' && from.content.kind !== 'capital') : (from.x !== 0 || from.y !== 0))) {
      return { ok: false, error: 'Vous devez être dans un village ou à la Capitale pour voyager.' };
    }

    const dest = this.tiles.get(tileKey(x, y));
    if (!dest || !dest.content || (dest.content.kind !== 'village' && dest.content.kind !== 'capital')) {
      return { ok: false, error: 'Destination invalide.' };
    }
    if (dest.x === me.pos.x && dest.y === me.pos.y) {
      return { ok: false, error: 'Vous êtes déjà ici.' };
    }

    me.pos = { x: dest.x, y: dest.y };
    const targetLabel = dest.content.kind === 'capital' ? 'la Capitale' : (dest.content.name || 'un village');
    this.log('Vous voyagez vers ' + targetLabel + '.');
    this.emit('self', me);
    return { ok: true };
  }

  /* ---------- Social ---------- */
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

  /* ---------- XP / niveaux ---------- */
  checkLevelUp(p, kind) {
    if (kind === 'harvest') {
      const lvl = levelFromXp(p.harvestXp);
      if (lvl > p.harvestLevel) {
        p.harvestLevel = lvl;
        this.log('Niveau de récolte T' + lvl + ' atteint !');
        this.toast('Récolte T' + lvl + ' débloquée');
      }
    } else {
      const lvl = levelFromXp(p.weaponXp);
      if (lvl > p.weaponMastery) {
        p.weaponMastery = lvl;
        this.log('Maîtrise d’arme T' + lvl + ' atteinte !');
        this.toast('Maîtrise d’arme T' + lvl);
      }
    }
  }

  /* ---------- IA des bots ---------- */
  botThink(bot) {
    if (bot.status !== 'IDLE') return;

    // Rejoindre un lobby proche tant que la victoire n'est pas acquise
    for (const raid of this.raids.values()) {
      const tile = this.tiles.get(raid.key);
      const d = this.chebyshev(bot.pos, tile);
      if (d <= CONFIG.JOIN_RADIUS + 5 && this.teamForce(raid) < raid.monsterForce * 1.15) {
        if (d <= CONFIG.JOIN_RADIUS) { this.botJoinRaid(bot, raid); return; }
        this.botStepToward(bot, tile.x, tile.y);
        return;
      }
    }

    // Sinon : errance autour du point d'attache
    if (Math.random() < 0.25) {
      const chat = Math.random();
      if (chat < 0.06) {
        this.emit('chat', { from: bot.username, text: BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)], type: 'chat' });
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

  chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  /* ---------- Persistance ---------- */
  serialize() {
    const diffs = [];
    for (const [key, tile] of this.tiles) {
      if (tile.content && tile.content.inactiveUntil > this.now) {
        diffs.push([key, tile.content.inactiveUntil]);
      }
    }
    return { seed: this.seed, now: this.now, player: this.me, worldDiffs: diffs, savedAt: Date.now() };
  }

  restore(data) {
    this.now = data.now;
    const p = data.player;
    // Une action interrompue par la fermeture est simplement annulée
    p.status = 'IDLE'; p.harvestKey = null; p.raidKey = null;
    // Recharge hors-ligne : +1 PA / min écoulée depuis la sauvegarde
    const away = Math.max(0, Date.now() - (data.savedAt || Date.now()));
    p.pa = Math.min(CONFIG.PA.MAX, p.pa + Math.floor(away / CONFIG.PA.REGEN_MS));
    p.hp = Math.min(maxHp(p), p.hp + Math.floor(away / CONFIG.HP.REGEN_MS));
    this.players.set(p.id, p);
    for (const [key, until] of data.worldDiffs || []) {
      const tile = this.tiles.get(key);
      if (tile && tile.content) tile.content.inactiveUntil = until;
    }
    this.spawnBots();
    this.log('Bon retour, ' + p.username + '.' + (away > CONFIG.PA.REGEN_MS ? ' (+' + Math.min(CONFIG.PA.MAX, Math.floor(away / CONFIG.PA.REGEN_MS)) + ' PA hors-ligne)' : ''));
  }
}
