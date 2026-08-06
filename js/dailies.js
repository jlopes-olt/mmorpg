'use strict';

/* ============================================================
 * dailies.js — Tableau des contrats : 3 contrats quotidiens + 1
 * hebdomadaire, et la monnaie qu'ils rapportent (Sceaux de contrat).
 * Utilisable côté Node (backend) comme côté navigateur, au même titre
 * que config.js / quests.js / achievements.js.
 *
 * Pourquoi ce système : un joueur T6 sans population en ligne n'a plus
 * aucun objectif — tout le contenu restant (boss de donjon, Wyrm, château)
 * demande 3 à 5 joueurs. Les contrats donnent une boucle quotidienne
 * réalisable seule, ET la monnaie qui finance les mercenaires (voir
 * MERC_* dans config.js) : trois contrats rapportent ~555 🪙, deux
 * contrats de mercenaire T6 en coûtent 500. La boucle s'autofinance.
 *
 * Contrairement aux quêtes (chaîne ordonnée, une seule en cours), les
 * contrats sont TIRÉS AU SORT chaque jour dans un vivier et mesurés en
 * DELTA : on photographie les compteurs cumulés de p.stats au moment du
 * reset (le « baseline »), ce qui évite d'ajouter un compteur journalier
 * par contrat. Seuls deux compteurs ont dû être créés côté serveur
 * (plats cuisinés, combats en coopération) et un suivi journalier propre
 * pour les villages — p.visitedVillages ne fait que croître et se sature.
 * ============================================================ */

/* Réinitialisation à 5 h heure de Paris (pas minuit : une session de
 * soirée qui déborde sur 1 h du matin doit rester « la même journée »).
 * Même fuseau de référence que les fenêtres de siège, voir parisHour(). */
const DAILY_RESET_HOUR = 5;

/* Clé de journée de jeu : la date de Paris, décalée pour que tout ce qui
 * précède DAILY_RESET_HOUR compte encore pour la veille. */
function gameDayKey(ts) {
  const now = typeof ts === 'number' ? ts : Date.now();
  const shifted = now - DAILY_RESET_HOUR * 3600000;
  // en-CA donne directement YYYY-MM-DD, triable comme une chaîne
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(shifted);
}

/* Clé de semaine de jeu : le lundi de la semaine en cours (même décalage
 * de 5 h). Sert à faire tourner le contrat hebdomadaire et à savoir quand
 * le réinitialiser. */
function gameWeekKey(ts) {
  const day = gameDayKey(ts);
  const [y, m, d] = day.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const dow = new Date(utc).getUTCDay();          // 0 = dimanche
  const monday = utc - ((dow + 6) % 7) * 86400000;
  return new Date(monday).toISOString().slice(0, 10);
}

/* Générateur déterministe à partir d'une chaîne : le tirage du jour doit
 * être stable (deux appels le même jour = mêmes contrats) sans stocker de
 * graine, et différent d'un joueur à l'autre. */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
function pickDeterministic(list, seedStr, count) {
  const pool = list.slice();
  const out = [];
  for (let i = 0; out.length < count && pool.length; i++) {
    const r = hashString(seedStr + '#' + i);
    out.push(pool.splice(Math.floor(r * pool.length), 1)[0]);
  }
  return out;
}

/* ---------- Le vivier ----------
 * Chaque contrat expose :
 *   unlock(p)              — disponible pour ce joueur ?
 *   target(p, params)      — quantité à atteindre
 *   label(p, params)       — intitulé affiché
 *   progress(p, base, day) — avancement, lu en DELTA sur le baseline
 *   params(p, seed)        — tirage annexe (type de monstre, famille…)
 * `base` est la photo de p.stats prise au reset (voir snapshotStats).
 */

function totalHarvest(stats) {
  return Object.values((stats && stats.harvest) || {}).reduce((n, v) => n + (Number(v) || 0), 0);
}
/* Les quatre ressources exclusives de donjon — dérivées de world.js plutôt
 * que listées à la main, pour rester justes si un biome change de matériau. */
const DUNGEON_RESOURCE_TYPES = ['BOIS_ANCIEN', 'FLEUR_ASTRALE', 'MINERAI_RUNIQUE', 'TOURBE_VIVANTE'];
function dungeonHarvest(stats) {
  return DUNGEON_RESOURCE_TYPES.reduce((n, t) => n + Number(((stats && stats.harvest) || {})[t] || 0), 0);
}
function killsOf(stats, type) { return Number(((stats && stats.kills) || {})[type] || 0); }
function killsAtOrAbove(stats, tier) {
  const byTier = (stats && stats.killsByTier) || {};
  let n = 0;
  for (const t of Object.keys(byTier)) if (Number(t) >= tier) n += Number(byTier[t]) || 0;
  return n;
}
/* Familles de récolte tirables pour « Le filon » : les quatre du monde
 * ouvert (les exclusives de donjon ont leur propre contrat, n°6). */
const HARVEST_FAMILIES = ['BOIS', 'MINERAI', 'PLANTE', 'INGREDIENT'];

const DAILY_CONTRACTS = [
  {
    id: 'hunt_any',
    icon: '🏹',
    name: 'Battue',
    gold: 180,
    target: () => 12,
    // Tier ≥ maîtrise−1 : le contrat suit la progression du joueur au lieu
    // de devenir trivial (ou infaisable) à un palier donné.
    params: (p) => ({ tier: Math.max(1, (p.weaponMastery || 1) - 1) }),
    label: (p, prm) => 'Tuer 12 monstres de tier ' + prm.tier + ' ou plus',
    progress: (p, base, prm) => killsAtOrAbove(p.stats, prm.tier) - killsAtOrAbove(base, prm.tier),
  },
  {
    id: 'hunt_type',
    icon: '🎯',
    name: 'Tête de liste',
    gold: 200,
    target: () => 5,
    params: (p, seed) => {
      // Tiré parmi le bestiaire du tier courant du joueur, tous biomes.
      const tier = Math.max(1, Math.min(5, p.weaponMastery || 1));
      const types = Object.values(MONSTERS_BY_TERRAIN)
        .map((byTier) => byTier[tier])
        .filter(Boolean);
      const pick = types[Math.floor(hashString(seed + '@type') * types.length)] || MONSTERS[tier];
      return { type: pick.type, monsterLabel: pick.label };
    },
    label: (p, prm) => 'Tuer 5 ' + prm.monsterLabel,
    progress: (p, base, prm) => killsOf(p.stats, prm.type) - killsOf(base, prm.type),
  },
  {
    id: 'hunt_dungeon',
    icon: '💀',
    name: 'Nettoyage',
    gold: 260,
    unlock: (p) => (p.weaponMastery || 1) >= 5,
    target: () => 8,
    label: () => 'Tuer 8 mobs de donjon (' + MONSTERS[6].label + ' T6)',
    progress: (p, base) => killsOf(p.stats, MONSTERS[6].type) - killsOf(base, MONSTERS[6].type),
  },
  {
    id: 'harvest_any',
    icon: '🧺',
    name: 'Charrettes pleines',
    gold: 150,
    target: () => 60,
    label: () => 'Récolter 60 unités de ressources, toutes familles',
    progress: (p, base) => totalHarvest(p.stats) - totalHarvest(base),
  },
  {
    id: 'harvest_family',
    icon: '⛏',
    name: 'Le filon',
    gold: 170,
    target: () => 40,
    params: (p, seed) => {
      const type = HARVEST_FAMILIES[Math.floor(hashString(seed + '@fam') * HARVEST_FAMILIES.length)];
      return { type, familyLabel: (RESOURCES[type] && RESOURCES[type].label) || type };
    },
    // Elision : « de Ingredient » est faux, « d'Ingredient » est correct.
    label: (p, prm) => 'Récolter 40 unités ' +
      (/^[aeiouyAEIOUYÉÈÊ]/.test(prm.familyLabel) ? 'd’' : 'de ') + prm.familyLabel,
    progress: (p, base, prm) =>
      Number((p.stats.harvest || {})[prm.type] || 0) - Number(((base && base.harvest) || {})[prm.type] || 0),
  },
  {
    id: 'harvest_dungeon',
    icon: '💎',
    name: 'Trésor des profondeurs',
    gold: 240,
    unlock: (p) => (p.weaponMastery || 1) >= 5,
    target: () => 15,
    label: () => 'Récolter 15 unités de ressource exclusive de donjon',
    progress: (p, base) => dungeonHarvest(p.stats) - dungeonHarvest(base),
  },
  {
    id: 'cook_any',
    icon: '🍲',
    name: 'À la marmite',
    gold: 160,
    target: () => 3,
    label: () => 'Cuisiner 3 plats de tier 3 ou plus',
    progress: (p, base) => Number(p.stats.cookedT3Plus || 0) - Number((base && base.cookedT3Plus) || 0),
  },
  {
    id: 'villages',
    icon: '📍',
    name: 'Tournée des villages',
    gold: 120,
    target: () => 3,
    label: () => 'Se rendre dans 3 villages différents',
    // Seul contrat à ne PAS se mesurer en delta : p.visitedVillages ne fait
    // que croître et se sature une fois les 8 villages découverts, ce qui
    // rendrait le contrat définitivement irréalisable. D'où un suivi
    // journalier propre, rempli dans move() côté serveur.
    progress: (p) => ((p.daily && p.daily.villagesToday) || []).length,
  },
];
const DAILY_BY_ID = Object.fromEntries(DAILY_CONTRACTS.map((c) => [c.id, c]));

/* Un contrat quotidien rapporte toujours 1 sceau en plus de son or. */
const DAILY_SEALS = 1;
const DAILY_COUNT = 3;

/* ---------- Contrat de la semaine ---------- */
const WEEKLY_CONTRACTS = [
  {
    id: 'weekly_bosses',
    icon: '🐗',
    name: 'Le Fléau des Profondeurs',
    gold: 800, seals: 10,
    target: () => 3,
    label: () => 'Vaincre 3 boss de donjon',
    progress: (p, base) => Number(p.stats.bossKills || 0) - Number((base && base.bossKills) || 0),
  },
  {
    id: 'weekly_harvest',
    icon: '🌾',
    name: 'Récolte du Siècle',
    gold: 800, seals: 10,
    target: () => 400,
    label: () => 'Récolter 400 unités de ressource exclusive de donjon',
    progress: (p, base) => dungeonHarvest(p.stats) - dungeonHarvest(base),
  },
  {
    id: 'weekly_wyrm',
    icon: '🐉',
    name: 'Chasseur de Légendes',
    gold: 1500, seals: 10, moonstones: 10,
    target: () => 1,
    label: () => 'Vaincre ' + WORLD_BOSS.label,
    progress: (p, base) => Number(p.stats.worldBossKills || 0) - Number((base && base.worldBossKills) || 0),
  },
  {
    id: 'weekly_together',
    icon: '🤝',
    name: 'Compagnons d’armes',
    gold: 1000, seals: 10, moonstones: 5,
    target: () => 10,
    label: () => 'Livrer 10 combats aux côtés d’au moins un autre joueur',
    progress: (p, base) => Number(p.stats.coopFights || 0) - Number((base && base.coopFights) || 0),
  },
];
const WEEKLY_BY_ID = Object.fromEntries(WEEKLY_CONTRACTS.map((c) => [c.id, c]));

/* ---------- Boutique aux sceaux ----------
 * Le fragment d'artefact est la raison d'être de la monnaie : 25 sceaux à
 * ~3/jour + 10/semaine (≈ 31/mois) mettent un artefact (4 fragments, 6 pour
 * l'Écaille) à un mois ou un mois et demi de jeu solo — contre deux ou trois
 * soirées pour un groupe qui les fait tomber du boss. Personne n'est bloqué,
 * le groupe reste très largement plus rapide. */
const SEAL_SHOP = [
  {
    id: 'fragment',
    label: 'Fragment d’artefact (au choix)',
    desc: 'Un fragment de l’artefact de votre choix.',
    cost: 25,
    needsArtifact: true,
  },
  {
    id: 'merc_t6',
    label: 'Contrat de mercenaire T6 (au choix)',
    desc: MERC_CONTRACT_COMBATS + ' combats aux côtés d’une lame de tier 6.',
    cost: 4,
    needsClass: true,
  },
  {
    id: 'moonstones',
    label: '5 ' + PREMIUM_CURRENCY.label,
    desc: 'La seule voie gratuite vers la monnaie premium.',
    cost: 20,
    grant: { moonstones: 5 },
  },
  {
    id: 'ragout_t6',
    label: 'Ragoût du Chasseur T6',
    desc: '+30 % de puissance pendant ' + BUFF_COMBATS + ' combats.',
    cost: 3,
    grant: { item: 'RAGOUT_6', qty: 1 },
  },
  {
    id: 'title',
    label: 'Titre « Vétéran des contrats »',
    desc: 'Récompense de prestige, achetable une seule fois.',
    cost: 100,
    grant: { title: 'Vétéran des contrats' },
    once: true,
  },
];
const SEAL_SHOP_BY_ID = Object.fromEntries(SEAL_SHOP.map((i) => [i.id, i]));

/* ---------- État joueur ---------- */

/* Photo des compteurs cumulés servant de point zéro aux deltas. Copie
 * PROFONDE des deux sous-objets : sans ça, base.kills et p.stats.kills
 * pointeraient sur la même référence et tout delta vaudrait 0. */
function snapshotStats(p) {
  const s = p.stats || {};
  return {
    kills: Object.assign({}, s.kills),
    killsByTier: Object.assign({}, s.killsByTier),
    harvest: Object.assign({}, s.harvest),
    monsterKills: Number(s.monsterKills || 0),
    bossKills: Number(s.bossKills || 0),
    worldBossKills: Number(s.worldBossKills || 0),
    cookedT3Plus: Number(s.cookedT3Plus || 0),
    coopFights: Number(s.coopFights || 0),
  };
}

/* Tire les contrats du jour et remet les compteurs à zéro si la journée (ou
 * la semaine) a tourné. Idempotent : appelable à chaque action sans coût. */
function ensureDailyState(p, ts) {
  if (typeof p.seals !== 'number' || !isFinite(p.seals)) p.seals = 0;
  if (!p.daily || typeof p.daily !== 'object') p.daily = {};
  const d = p.daily;
  const day = gameDayKey(ts);
  const week = gameWeekKey(ts);

  if (d.day !== day) {
    const seed = (p.id || p.username || 'anon') + '|' + day;
    const available = DAILY_CONTRACTS.filter((c) => {
      try { return c.unlock ? !!c.unlock(p) : true; } catch (e) { return false; }
    });
    const chosen = pickDeterministic(available, seed, DAILY_COUNT);
    d.day = day;
    d.ids = chosen.map((c) => c.id);
    d.params = {};
    for (const c of chosen) {
      let prm = {};
      try { prm = c.params ? c.params(p, seed + '|' + c.id) : {}; } catch (e) { prm = {}; }
      d.params[c.id] = prm;
    }
    d.baseline = snapshotStats(p);
    d.done = [];
    d.villagesToday = [];
  }

  if (d.week !== week) {
    // Rotation déterministe : même contrat hebdomadaire pour tout le monde,
    // ce qui donne un objectif commun à annoncer dans le chat.
    const idx = Math.floor(hashString('weekly|' + week) * WEEKLY_CONTRACTS.length);
    d.week = week;
    d.weeklyId = WEEKLY_CONTRACTS[idx].id;
    d.weeklyBaseline = snapshotStats(p);
    d.weeklyDone = false;
  }
  if (!Array.isArray(d.ids)) d.ids = [];
  if (!Array.isArray(d.done)) d.done = [];
  if (!Array.isArray(d.villagesToday)) d.villagesToday = [];
  if (!d.params || typeof d.params !== 'object') d.params = {};
  return d;
}

/* Vue prête à afficher (client comme serveur) : progression et état de
 * chaque contrat du jour + celui de la semaine. */
function dailyBoardFor(p, ts) {
  const d = ensureDailyState(p, ts);
  const daily = d.ids.map((id) => {
    const c = DAILY_BY_ID[id];
    if (!c) return null;
    const prm = d.params[id] || {};
    let progress = 0;
    try { progress = Math.max(0, Math.floor(c.progress(p, d.baseline, prm))); } catch (e) { progress = 0; }
    const target = c.target(p, prm);
    return {
      id, icon: c.icon, name: c.name,
      label: c.label(p, prm),
      progress: Math.min(progress, target), target,
      done: d.done.includes(id),
      reward: { gold: c.gold, seals: DAILY_SEALS },
    };
  }).filter(Boolean);

  const wc = WEEKLY_BY_ID[d.weeklyId];
  let weekly = null;
  if (wc) {
    let progress = 0;
    try { progress = Math.max(0, Math.floor(wc.progress(p, d.weeklyBaseline))); } catch (e) { progress = 0; }
    const target = wc.target(p);
    weekly = {
      id: wc.id, icon: wc.icon, name: wc.name,
      label: wc.label(p),
      progress: Math.min(progress, target), target,
      done: !!d.weeklyDone,
      reward: { gold: wc.gold, seals: wc.seals, moonstones: wc.moonstones || 0 },
    };
  }
  return { day: d.day, week: d.week, resetHour: DAILY_RESET_HOUR, daily, weekly, seals: p.seals || 0 };
}

/* Valide et récompense tout contrat venant d'être rempli. Même contrat que
 * checkQuests() : mute le joueur et retourne la liste des complétions pour
 * notification par l'appelant. */
function checkDailies(p, ts) {
  const d = ensureDailyState(p, ts);
  const completed = [];

  for (const id of d.ids) {
    if (d.done.includes(id)) continue;
    const c = DAILY_BY_ID[id];
    if (!c) continue;
    const prm = d.params[id] || {};
    let progress = 0;
    try { progress = c.progress(p, d.baseline, prm); } catch (e) { continue; }
    if (progress < c.target(p, prm)) continue;
    d.done.push(id);
    p.gold = (p.gold || 0) + c.gold;
    p.seals = (p.seals || 0) + DAILY_SEALS;
    completed.push({ kind: 'daily', id, icon: c.icon, name: c.name, gold: c.gold, seals: DAILY_SEALS });
  }

  const wc = WEEKLY_BY_ID[d.weeklyId];
  if (wc && !d.weeklyDone) {
    let progress = 0;
    try { progress = wc.progress(p, d.weeklyBaseline); } catch (e) { progress = -1; }
    if (progress >= wc.target(p)) {
      d.weeklyDone = true;
      p.gold = (p.gold || 0) + wc.gold;
      p.seals = (p.seals || 0) + wc.seals;
      if (wc.moonstones) p.moonstones = (p.moonstones || 0) + wc.moonstones;
      completed.push({
        kind: 'weekly', id: wc.id, icon: wc.icon, name: wc.name,
        gold: wc.gold, seals: wc.seals, moonstones: wc.moonstones || 0,
      });
    }
  }
  return completed;
}

/* Utilisable côté Node (backend) comme côté navigateur */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DAILY_RESET_HOUR, DAILY_CONTRACTS, DAILY_BY_ID, DAILY_SEALS, DAILY_COUNT,
    WEEKLY_CONTRACTS, WEEKLY_BY_ID, SEAL_SHOP, SEAL_SHOP_BY_ID,
    DUNGEON_RESOURCE_TYPES,
    gameDayKey, gameWeekKey, snapshotStats, ensureDailyState, dailyBoardFor, checkDailies,
  };
}
