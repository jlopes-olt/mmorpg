'use strict';

/* ============================================================
 * WildRift RPG — Greybox
 * config.js — constantes, équilibrage, données statiques
 * ============================================================ */

const CONFIG = {
  VERSION: 'greybox-0.1',
  SAVE_KEY: 'wildrift_greybox_v1',

  WORLD: { MIN: -50, MAX: 49, SEED: 20260717 },
  DUNGEON: { MIN: -18, MAX: 18, BOSS_KILLS_REQUIRED: 14 },

  VIEW_RADIUS: 4,      // rayon de vision (brouillard de guerre)
  JOIN_RADIUS: 6,      // distance max pour rejoindre un lobby de raid
  SAFE_RADIUS: 3,      // zone sans monstre autour de la Capitale

  PA: { MAX: 100, START: 60, REGEN_MS: 60000 },   // +1 PA / min
  HP: { REGEN_MS: 30000 },                         // +1 PV / 30 s

  COSTS: {
    MOVE: 1,
    HARVEST: 2,
    RAID: 5,                                       // créer OU rejoindre un lobby
    UPGRADE: { 1: 5, 2: 10, 3: 25, 4: 50, 5: 100 }, // PA par tier cible
  },

  HARVEST_MS: 3000,
  LOBBY_MS: 30000,
  RESPAWN_RESOURCE_MS: 90000,
  RESPAWN_MONSTER_MS: 150000,
  RESPAWN_DUNGEON_RESOURCE_MS: 360000,
  RESPAWN_DUNGEON_MONSTER_MS: 300000,

  BOT_COUNT: 7,
  BOT_TICK_MS: 2200,

  // Personnages multiples par compte : PA/PV(%)/position/inventaire au
  // compte, classe/maîtrises/équipement par forme. Slots supplémentaires
  // prévus via la boutique.
  FREE_CHAR_SLOTS: 2,

  // Combat probabiliste : P(victoire) = sigmoïde(K × (ratio − R0)),
  // bornée [MIN, MAX]. Ratio 1 = équipement au tier inférieur du monstre
  // (un T0 affronte un T1 à ~70 %). Les PV entament la puissance :
  // à 0 PV on ne vaut plus que WOUND_FLOOR de sa puissance.
  COMBAT: {
    K: 9,
    R0: 0.9,
    MIN_CHANCE: 0.02,
    MAX_CHANCE: 0.98,
    WOUND_FLOOR: 0.4,
    DEATH_HP_PCT: 0.25,     // PV au réveil à la Capitale après une mort
    DRUID_HEAL_PCT: 0.15,   // Sève : % des PV max rendus après une victoire
  },
};

/* Combos espèce/classe fixes — un talent de GROUPE unique par classe.
 * Pensés pour les raids et les futurs donjons T6 non-soloables (trinité :
 * tank / soin / soutien / dégâts). Les talents d'équipe (Aura, Rempart,
 * Sève) ne se cumulent jamais : deux Ours = un seul Rempart. */
/* Bases resserrées (18-22) : avec le combat probabiliste, un gros écart de
 * base créerait des % de victoire trop inégaux entre classes au T1 — la
 * différenciation vient des talents, pas des stats brutes. */
const CLASSES = {
  LION_PALADIN: {
    label: 'Lion Paladin', icon: 'LP', color: '#e8b23f', baseForce: 20,
    role: 'Soutien',
    bonus: 'Aura : +10 % de puissance pour toute l’équipe (ne se cumule pas)',
  },
  OURS_GUERRIER: {
    label: 'Ours Guerrier', icon: 'OG', color: '#c96f4a', baseForce: 22,
    role: 'Tank',
    bonus: 'Rempart : réduit de 30 % la perte de PV de toute l’équipe (ne se cumule pas)',
  },
  RENARD_VOLEUR: {
    label: 'Renard Voleur', icon: 'RV', color: '#d98f3d', baseForce: 19,
    role: 'Butin',
    bonus: 'Chapardeur : +50 % d’or looté en raid pour lui',
  },
  CHAT_MAGICIEN: {
    label: 'Chat Magicien', icon: 'CM', color: '#7f7fd9', baseForce: 18,
    role: 'Dégâts',
    bonus: 'Canalisation : la force de son arme compte ×1,3',
  },
  CERF_DRUIDE: {
    label: 'Cerf Druide', icon: 'CD', color: '#58b368', baseForce: 19,
    role: 'Soin',
    bonus: 'Sève : rend 15 % de leurs PV max aux participants après une victoire (ne se cumule pas)',
  },
  CORBEAU_NECROMANCIEN: {
    label: 'Corbeau Nécromancien', icon: 'CN', color: '#9a6fd1', baseForce: 19,
    role: 'Dégâts de groupe',
    bonus: 'Nuée : +8 % de puissance personnelle par participant au combat',
  },
};

/* Arme et armure uniques, liées à la classe, évolutives T0→T5 */
const CLASS_GEAR = {
  LION_PALADIN:         { weapon: 'Épée',    armor: 'Plaques' },
  OURS_GUERRIER:        { weapon: 'Hache',   armor: 'Plaques' },
  RENARD_VOLEUR:        { weapon: 'Dagues',  armor: 'Cuir' },
  CHAT_MAGICIEN:        { weapon: 'Bâton',   armor: 'Étoffe' },
  CERF_DRUIDE:          { weapon: 'Sceptre', armor: 'Cuir' },
  CORBEAU_NECROMANCIEN: { weapon: 'Faux',    armor: 'Étoffe' },
};

const RESOURCES = {
  BOIS:    { label: 'Bois',    short: 'B' },
  MINERAI: { label: 'Minerai', short: 'M' },
  PLANTE:  { label: 'Plante',  short: 'P' },
  BOIS_ANCIEN:     { label: 'Bois ancien', short: 'BA', base: 'BOIS' },
  FLEUR_ASTRALE:   { label: 'Fleur astrale', short: 'FA', base: 'PLANTE' },
  MINERAI_RUNIQUE: { label: 'Minerai runique', short: 'MR', base: 'MINERAI' },
  TOURBE_VIVANTE:  { label: 'Tourbe vivante', short: 'TV', base: 'PLANTE' },
};

/* Type de monstre par tier (greybox : mapping direct, lisible) */
const MONSTERS = {
  1: { type: 'LUPUS',       label: 'Lupus' },
  2: { type: 'OURS_PIERRE', label: 'Ours de Pierre' },
  3: { type: 'SPECTRE',     label: 'Spectre' },
  4: { type: 'BASILIC',     label: 'Basilic' },
  5: { type: 'WYRM',        label: 'Wyrm' },
  6: { type: 'SQUELETTE',   label: 'Squelette' },
};

/* Puissance des monstres, calibrée pour le combat probabiliste :
 * ratio = 1 (≈70 % de victoire) quand l'équipement (arme + armure) est au
 * tier inférieur, à pleine vie. Le T6 de donjon vaut ~2 joueurs T5 :
 * insoloable (2 %), confortable à 3-4. */
/* T6 (squelettes de donjon) : ~3 joueurs T5 (94 %) — le duo T5 est
 * dissuasif (29 %) ; en équipement T6 le duo devient tentable (52 %). */
const MONSTER_FORCE = { 1: 26, 2: 54, 3: 82, 4: 110, 5: 138, 6: 400 };

const TERRAINS = {
  PLAINE:   { label: 'Plaine',   color: '#4f6b3c' },
  FORET:    { label: 'Forêt',    color: '#33512f' },
  MONTAGNE: { label: 'Montagne', color: '#5d616d' },
  MARECAGE: { label: 'Marécage', color: '#44594a' },
  RUINES:   { label: 'Ruines',   color: '#544663' },
};

const TIER_COLORS = { 0: '#6f7a87', 1: '#9aa5b1', 2: '#58b368', 3: '#4a9fd8', 4: '#a86fd1', 5: '#e8a33f', 6: '#d66a4a' };

/* XP cumulée requise pour atteindre le niveau (index = niveau - 1) */
const XP_LEVELS = [0, 100, 300, 700, 1500];

function levelFromXp(xp) {
  let lvl = 1;
  for (let i = 1; i < XP_LEVELS.length; i++) {
    if (xp >= XP_LEVELS[i]) lvl = i + 1;
  }
  return lvl;
}

/* Recettes d'amélioration — une arme/armure Tn se craft avec des ressources Tn. */
const UPGRADE_RECIPES = {
  weapon: {
    1: { BOIS_1: 20, MINERAI_1: 10 },
    2: { MINERAI_2: 25, BOIS_2: 15 },
    3: { MINERAI_3: 30, PLANTE_3: 20 },
    4: { MINERAI_4: 40, PLANTE_4: 25 },
    5: { MINERAI_5: 50, PLANTE_5: 30 },
  },
  armor: {
    1: { MINERAI_1: 15, PLANTE_1: 15 },
    2: { BOIS_2: 20, PLANTE_2: 20 },
    3: { BOIS_3: 25, MINERAI_3: 25 },
    4: { BOIS_4: 30, MINERAI_4: 35 },
    5: { BOIS_5: 36, MINERAI_5: 42 },
  },
};

/* Force individuelle : classe + arme + maîtrise.
 * Le calibrage vise un monde ouvert soloable palier par palier.
 * Canalisation (Chat Magicien) : ×1,3 sur l'arme — assez pour être le
 * meilleur DPS en fin de progression sans écraser les autres classes. */
function playerForce(p) {
  const cls = CLASSES[p.speciesClass];
  const weaponMult = p.speciesClass === 'CHAT_MAGICIEN' ? 1.3 : 1;
  return Math.round(cls.baseForce + p.weapon.tier * 14 * weaponMult + p.weaponMastery * 6);
}

/* L'armure donne des PV max et réduit les pertes de PV en raid */
function maxHp(p) {
  return 100 + p.armor.tier * 15;
}

function hpLossReduction(p) {
  return 1 - 0.06 * p.armor.tier;
}

/* Une « forme » (personnage) : tout ce qui est propre à une classe.
 * Le reste (PA, PV en %, position, inventaire) appartient au compte. */
function newCharacter(speciesClass) {
  const gear = CLASS_GEAR[speciesClass];
  return {
    speciesClass,
    harvestXp: 0, harvestLevel: 1,
    weaponXp: 0, weaponMastery: 1,
    weapon: { tier: 0, type: gear.weapon },
    armor: { tier: 0, type: gear.armor },
  };
}

const CHARACTER_FIELDS = ['speciesClass', 'harvestXp', 'harvestLevel', 'weaponXp', 'weaponMastery', 'weapon', 'armor'];

/* Recopie la forme active (champs à plat sur le joueur) dans son slot */
function syncActiveCharacter(p) {
  if (!p.characters) return;
  const c = p.characters[p.activeChar];
  if (!c) return;
  for (const f of CHARACTER_FIELDS) c[f] = p[f];
}

/* Applique une forme (slot) sur les champs à plat du joueur */
function applyCharacter(p, index) {
  const c = p.characters[index];
  for (const f of CHARACTER_FIELDS) p[f] = c[f];
  p.activeChar = index;
}

/* ---------- Combat probabiliste ---------- */

/* Puissance de combat individuelle : l'arme, l'armure ET l'état de santé.
 * Blessé, on se bat moins bien : facteur de WOUND_FLOOR (à 0 PV) à 1 (à plein). */
function combatPower(p) {
  const woundFactor = CONFIG.COMBAT.WOUND_FLOOR +
    (1 - CONFIG.COMBAT.WOUND_FLOOR) * Math.max(0, Math.min(1, p.hp / maxHp(p)));
  return (playerForce(p) + p.armor.tier * 8) * woundFactor;
}

/* Puissance d'équipe : somme des puissances + talents de groupe
 * (Nuée par participant, puis Aura — jamais cumulés). */
function teamPowerOf(members) {
  let total = 0;
  for (const p of members) {
    let f = combatPower(p);
    if (p.speciesClass === 'CORBEAU_NECROMANCIEN') f *= 1 + 0.08 * members.length;
    total += f;
  }
  if (members.some((p) => p.speciesClass === 'LION_PALADIN')) total *= 1.10;
  return Math.round(total);
}

/* P(victoire) : sigmoïde du ratio de puissance, bornée [2 %, 98 %].
 * Ratio 1 (équipement au tier inférieur, plein PV) ≈ 70 %. */
function winChance(teamPower, monsterForce) {
  const r = teamPower / Math.max(1, monsterForce);
  const p = 1 / (1 + Math.exp(-CONFIG.COMBAT.K * (r - CONFIG.COMBAT.R0)));
  return Math.min(CONFIG.COMBAT.MAX_CHANCE, Math.max(CONFIG.COMBAT.MIN_CHANCE, p));
}

/* Or lâché par un monstre vaincu (par participant humain).
 * T1 ≈ 7-9, T3 ≈ 15-21, T5 ≈ 23-33, T6 ≈ 27-39 — le Chapardeur
 * du Renard (×1,5) s'applique aussi à l'or. */
function rollGoldLoot(tier) {
  return 3 + tier * 4 + Math.floor(Math.random() * (tier * 2 + 1));
}

function stackKey(type, tier) { return type + '_' + tier; }

function parseStackKey(key) {
  const i = key.lastIndexOf('_');
  return { type: key.slice(0, i), tier: Number(key.slice(i + 1)) };
}

function resourceFamily(type) {
  const entry = RESOURCES[type];
  return (entry && entry.base) || type;
}

/* ---------- Habillage : sprites & icônes ---------- */

/* Position [colonne, ligne] de chaque classe dans assets/personnages_*.png (grille 3x2) */
const SPRITE_CELLS = {
  RENARD_VOLEUR:        [0, 0],
  CERF_DRUIDE:          [1, 0],
  CHAT_MAGICIEN:        [2, 0],
  OURS_GUERRIER:        [0, 1],
  LION_PALADIN:         [1, 1],
  CORBEAU_NECROMANCIEN: [2, 1],
};

const RESOURCE_EMOJI = {
  BOIS: '🌳', MINERAI: '🪨', PLANTE: '🌿',
  BOIS_ANCIEN: '🌳', FLEUR_ASTRALE: '🌿', MINERAI_RUNIQUE: '🪨', TOURBE_VIVANTE: '🌿',
};
const MONSTER_EMOJI = { 1: '🐺', 2: '🐻', 3: '👻', 4: '🦎', 5: '🐉', 6: '💀' };

/* Utilisable côté Node (backend) comme côté navigateur */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG, CLASSES, CLASS_GEAR, RESOURCES, MONSTERS, MONSTER_FORCE,
    TERRAINS, TIER_COLORS, XP_LEVELS, UPGRADE_RECIPES, SPRITE_CELLS,
    RESOURCE_EMOJI, MONSTER_EMOJI, CHARACTER_FIELDS,
    levelFromXp, playerForce, maxHp, hpLossReduction, stackKey, parseStackKey, resourceFamily,
    newCharacter, syncActiveCharacter, applyCharacter, rollGoldLoot,
    combatPower, teamPowerOf, winChance,
  };
}
