'use strict';

/* ============================================================
 * WildRift RPG — Greybox
 * config.js — constantes, équilibrage, données statiques
 * ============================================================ */

const CONFIG = {
  VERSION: 'greybox-0.1',
  SAVE_KEY: 'wildrift_greybox_v1',

  WORLD: { MIN: -50, MAX: 49, SEED: 20260717 },

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

  BOT_COUNT: 7,
  BOT_TICK_MS: 2200,
};

/* Combos espèce/classe fixes — bonus uniques appliqués en raid */
const CLASSES = {
  LION_PALADIN: {
    label: 'Lion Paladin', icon: 'LP', color: '#e8b23f', baseForce: 20,
    bonus: 'Aura : +10% de force pour toute l’équipe en raid',
  },
  OURS_GUERRIER: {
    label: 'Ours Guerrier', icon: 'OG', color: '#c96f4a', baseForce: 26,
    bonus: 'Robuste : perte de PV divisée par 2 en raid',
  },
  RENARD_VOLEUR: {
    label: 'Renard Voleur', icon: 'RV', color: '#d98f3d', baseForce: 18,
    bonus: 'Chapardeur : +50% de butin en raid',
  },
  CHAT_MAGICIEN: {
    label: 'Chat Magicien', icon: 'CM', color: '#7f7fd9', baseForce: 14,
    bonus: 'Canalisation : la force de l’arme compte +50%',
  },
  CERF_DRUIDE: {
    label: 'Cerf Druide', icon: 'CD', color: '#58b368', baseForce: 17,
    bonus: 'Sève : rend 15 PV aux participants après une victoire',
  },
  CORBEAU_NECROMANCIEN: {
    label: 'Corbeau Nécromancien', icon: 'CN', color: '#9a6fd1', baseForce: 16,
    bonus: 'Nuée : +8% de force personnelle par participant',
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
};

/* Type de monstre par tier (greybox : mapping direct, lisible) */
const MONSTERS = {
  1: { type: 'LUPUS',       label: 'Lupus' },
  2: { type: 'OURS_PIERRE', label: 'Ours de Pierre' },
  3: { type: 'SPECTRE',     label: 'Spectre' },
  4: { type: 'BASILIC',     label: 'Basilic' },
  5: { type: 'WYRM',        label: 'Wyrm' },
};

/* Monstres du monde : chaque tier est battable solo avec l'équipement du tier précédent.
 * La difficulté de groupe plus dure viendra des donjons / T6 et des rencontres spéciales. */
const MONSTER_FORCE = { 1: 18, 2: 40, 3: 60, 4: 80, 5: 100 };

const TERRAINS = {
  PLAINE:   { label: 'Plaine',   color: '#4f6b3c' },
  FORET:    { label: 'Forêt',    color: '#33512f' },
  MONTAGNE: { label: 'Montagne', color: '#5d616d' },
  MARECAGE: { label: 'Marécage', color: '#44594a' },
  RUINES:   { label: 'Ruines',   color: '#544663' },
};

const TIER_COLORS = { 0: '#6f7a87', 1: '#9aa5b1', 2: '#58b368', 3: '#4a9fd8', 4: '#a86fd1', 5: '#e8a33f' };

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
 * Le calibrage vise un monde ouvert soloable palier par palier. */
function playerForce(p) {
  const cls = CLASSES[p.speciesClass];
  const weaponMult = p.speciesClass === 'CHAT_MAGICIEN' ? 1.5 : 1;
  return Math.round(cls.baseForce + p.weapon.tier * 14 * weaponMult + p.weaponMastery * 6);
}

/* L'armure donne des PV max et réduit les pertes de PV en raid */
function maxHp(p) {
  return 100 + p.armor.tier * 15;
}

function hpLossReduction(p) {
  return 1 - 0.06 * p.armor.tier;
}

function stackKey(type, tier) { return type + '_' + tier; }

function parseStackKey(key) {
  const i = key.lastIndexOf('_');
  return { type: key.slice(0, i), tier: Number(key.slice(i + 1)) };
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

const RESOURCE_EMOJI = { BOIS: '🌳', MINERAI: '🪨', PLANTE: '🌿' };
const MONSTER_EMOJI = { 1: '🐺', 2: '🐻', 3: '👻', 4: '🦎', 5: '🐉' };

/* Utilisable côté Node (backend) comme côté navigateur */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG, CLASSES, CLASS_GEAR, RESOURCES, MONSTERS, MONSTER_FORCE,
    TERRAINS, TIER_COLORS, XP_LEVELS, UPGRADE_RECIPES, SPRITE_CELLS,
    RESOURCE_EMOJI, MONSTER_EMOJI,
    levelFromXp, playerForce, maxHp, hpLossReduction, stackKey, parseStackKey,
  };
}
