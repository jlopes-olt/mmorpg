'use strict';

/* ============================================================
 * Feralia Online
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

  // Glisser pour explorer la caméra loin du héros (tape une case révélée
  // pour s'y déplacer, bouton de recentrage tant qu'on n'est pas sur soi).
  // Repasser à false pour revenir instantanément à l'ancien comportement
  // (caméra toujours verrouillée sur le héros) sans toucher au reste du code.
  CAMERA_PAN_ENABLED: true,

  // Plafond pensé pour 1-3 sessions/jour : un réservoir vide se remplit en
  // 12h (720 min à +1/min), donc personne n'a besoin de se reconnecter
  // toutes les 2-3h pour ne pas « perdre » de PA en dépassant le plafond.
  PA: { MAX: 720, START: 720, REGEN_MS: 60000 },   // +1 PA / min
  HP: { REGEN_MS: 30000 },                         // +1 PV / 30 s

  COSTS: {
    MOVE: 1,
    HARVEST: 2,
    RAID: 5,                                       // créer OU rejoindre un lobby
    UPGRADE: { 1: 5, 2: 10, 3: 25, 4: 50, 5: 100, 6: 280 }, // PA par tier cible
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

  // Chance qu'un monstre vaincu lâche un ingrédient de cuisine de son tier
  FOOD_DROP_CHANCE: 0.3,
};

/* Combos espèce/classe fixes — un talent de GROUPE unique par classe.
 * Pensés pour les raids et les futurs donjons T6 non-soloables (trinité :
 * tank / soin / soutien / dégâts). Les talents d'équipe (Aura, Rempart,
 * Sève) ne se cumulent jamais : deux Ours = un seul Rempart. */
/* Bases resserrées (18-22) : avec le combat probabiliste, un gros écart de
 * base créerait des % de victoire trop inégaux entre classes au T1 — la
 * différenciation vient des talents, pas des stats brutes. */
/* baseHp suit le type d'armure de CLASS_GEAR (Plaques > Cuir > Étoffe),
 * lui-même aligné sur le rôle : le Tank encaisse, le mage trinque. */
const CLASSES = {
  SERAPHIN_ROYAL: {
    label: 'Séraphin Royal', icon: 'SR', color: '#f4e6a2', baseForce: 99993, baseHp: 99999,
    role: 'Divin',
    bonus: 'Mandat céleste : forme strictement réservée aux administrateurs, investie d’une puissance absolue.',
    adminOnly: true,
  },
  LION_PALADIN: {
    label: 'Lion Paladin', icon: 'LP', color: '#e8b23f', baseForce: 20, baseHp: 115,
    role: 'Soutien',
    bonus: 'Aura : +10 % de puissance pour toute l’équipe (ne se cumule pas)',
  },
  OURS_GUERRIER: {
    label: 'Ours Guerrier', icon: 'OG', color: '#c96f4a', baseForce: 22, baseHp: 130,
    role: 'Tank',
    bonus: 'Rempart : réduit de 30 % la perte de PV de toute l’équipe (ne se cumule pas)',
  },
  RENARD_VOLEUR: {
    label: 'Renard Voleur', icon: 'RV', color: '#d98f3d', baseForce: 19, baseHp: 95,
    role: 'Butin',
    bonus: 'Chapardeur : +50 % d’or looté en raid pour lui',
  },
  CHAT_MAGICIEN: {
    label: 'Chat Magicien', icon: 'CM', color: '#7f7fd9', baseForce: 18, baseHp: 85,
    role: 'Dégâts',
    bonus: 'Canalisation : la force de son arme compte ×1,3',
  },
  CERF_DRUIDE: {
    label: 'Cerf Druide', icon: 'CD', color: '#58b368', baseForce: 19, baseHp: 100,
    role: 'Soin',
    bonus: 'Sève : rend 15 % de leurs PV max aux participants après une victoire (ne se cumule pas)',
  },
  CORBEAU_NECROMANCIEN: {
    label: 'Corbeau Nécromancien', icon: 'CN', color: '#9a6fd1', baseForce: 19, baseHp: 90,
    role: 'Dégâts de groupe',
    bonus: 'Nuée : +8 % de puissance personnelle par participant au combat',
  },
};

/* Chaque forme doit incarner une classe différente : impossible de dépasser
 * le nombre de classes existantes, quel que soit le nombre d'emplacements
 * achetés/offerts. */
const MAX_CHAR_SLOTS = Object.keys(CLASSES).length;

/* Territoire de guilde : un château par biome. Le siège réutilise le combat
 * probabiliste existant (winChance/teamPowerOf) contre une force de défense
 * dérivée du niveau de renfort et des PS restants (même wound factor que
 * pour un joueur : un château entamé se défend moins bien). Simplification
 * assumée pour un premier jet : fondation/renfort/réparation sont payés en
 * or par la personne qui agit (pas de banque de guilde partagée) — l'effort
 * collectif vient du fait que plusieurs membres doivent contribuer tour à
 * tour, pas d'une trésorerie commune. */
const CASTLE_TERRAINS = ['FORET', 'PLAINE', 'MONTAGNE', 'MARECAGE'];
const CASTLE_BASE_HP = 400;
const CASTLE_HP_PER_LEVEL = 200;
const CASTLE_MAX_LEVEL = 5;
const CASTLE_CLAIM_COST_GOLD = 500;
const CASTLE_REINFORCE_COST_GOLD = 400;
const CASTLE_REPAIR_GOLD_PER_HP = 2;
const CASTLE_DAMAGE_PER_ASSAULT = 150;
const CASTLE_ZONE_GOLD_BONUS = 1.15;
// Capturer un château de niveau max (1400 PS / 150 par assaut) prend environ
// 10 assauts — sans ce délai, une guilde peut les enchaîner en quelques
// minutes (30 s de lobby chacun) sans laisser aux défenseurs le temps de
// réagir (rallier, réparer). Horloge murale (Date.now()), pas this.now, pour
// rester valable même en dev accéléré (voir WORLD_BOSS pour le même choix).
const CASTLE_SIEGE_COOLDOWN_MS = 5 * 60 * 1000;

// Fenêtre de vulnérabilité (heure de Paris — joueurs FR) : un château ne peut
// être assiégé qu'à l'intérieur de sa plage. Sans ça, une guilde peut vider
// les PS d'un château pendant la nuit sans que personne ne puisse jamais le
// défendre — avec, la défense dépend de la force réelle des deux guildes sur
// des heures où tout le monde peut légitimement être en ligne (voir Albion
// Online / EVE Online pour le même principe). Par château (pas une constante
// unique) pour pouvoir différencier plus tard par type de structure sans
// réécrire — les 4 démarrent avec la même plage.
const CASTLE_SIEGE_WINDOWS = {
  FORET: { startHour: 19, endHour: 23 },
  PLAINE: { startHour: 19, endHour: 23 },
  MONTAGNE: { startHour: 19, endHour: 23 },
  MARECAGE: { startHour: 19, endHour: 23 },
};

// Heure du jour à Paris (0-23), indépendante du fuseau horaire de la machine
// qui exécute le code (serveur en UTC, navigateur du joueur, peu importe) —
// hourCycle 'h23' plutôt que hour12:false, plus fiable à minuit selon l'ICU.
function parisHour(ts) {
  return parseInt(
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' }).format(ts || Date.now()),
    10
  );
}

// Gère aussi les plages traversant minuit (ex: 22h -> 2h), pour une future
// fenêtre nocturne sur un autre type de structure.
function isWithinSiegeWindow(win, ts) {
  if (!win) return true;
  const h = parisHour(ts);
  return win.startHour <= win.endHour ? (h >= win.startHour && h < win.endHour) : (h >= win.startHour || h < win.endHour);
}

// Renfort/réparation coûtent aussi des ressources (en plus de l'or) — la
// ressource du biome du château (bois en Forêt, minerai en Montagne, etc.),
// pour ancrer le château dans son terrain plutôt qu'un simple sink d'or.
const CASTLE_TERRAIN_RESOURCE = { FORET: 'BOIS', PLAINE: 'PLANTE', MONTAGNE: 'MINERAI', MARECAGE: 'INGREDIENT' };
// Renfort : coût fixe par niveau cible (comme les recettes de forge) — le
// tier de ressource suit le niveau ACTUEL du château (fort niveau 1 → bois
// T1, fort niveau 2 → bois T2, etc.).
// Quantités relevées en même temps que la courbe de progression individuelle
// (voir UPGRADE_RECIPES) — sinon un château deviendrait relativement trivial
// à monter au max une fois l'équipement personnel bien plus coûteux. Croissance
// plus douce que côté solo : c'est un effort de guilde, pas d'un seul joueur.
const CASTLE_REINFORCE_RESOURCES = {
  2: { tier: 1, qty: 60 },
  3: { tier: 2, qty: 150 },
  4: { tier: 3, qty: 350 },
  5: { tier: 4, qty: 800 },
};
// Réparation : entretien courant, même principe — le tier suit le niveau
// actuel du château, proportionnel aux PS rendus (1 unité pour 10 PS).
function castleRepairResourceTier(level) {
  return Math.max(1, Math.min(CASTLE_MAX_LEVEL, Number(level) || 1));
}
const CASTLE_REPAIR_HP_PER_RESOURCE = 10;

/* Engins de siège : objet consommable fabriqué à l'avance (Capitale), déployé
 * (1 par personne max) en rejoignant un siège. Ajoute de la force au combat —
 * une fraction du poids d'un joueur du même tier, jamais 1 pour 1 — ET des
 * dégâts de structure garantis, indépendants du jet de combat (une guilde
 * progresse même si l'assaut au corps-à-corps échoue). Recette universelle
 * (bois + minerai + plante), pas liée au château visé : on prépare l'attaque
 * en amont, on ne la matérialise pas sur place. */
const SIEGE_ENGINE_ITEM = 'ENGIN_SIEGE';
const SIEGE_ENGINE_RECIPES = {
  1: { BOIS_1: 25, MINERAI_1: 15, PLANTE_1: 10, gold: 50 },
  2: { BOIS_2: 30, MINERAI_2: 20, PLANTE_2: 15, gold: 100 },
  3: { BOIS_3: 35, MINERAI_3: 25, PLANTE_3: 20, gold: 175 },
  4: { BOIS_4: 40, MINERAI_4: 30, PLANTE_4: 25, gold: 275 },
  5: { BOIS_5: 50, MINERAI_5: 35, PLANTE_5: 30, gold: 400 },
};
const SIEGE_ENGINE_FORCE = { 1: 20, 2: 32, 3: 44, 4: 56, 5: 70 };
const SIEGE_ENGINE_DAMAGE = { 1: 40, 2: 60, 3: 80, 4: 100, 5: 130 };
const SIEGE_ENGINES = {
  1: { label: 'Bélier léger', asset: 'assets/siege_engines/engin_siege_t1_belier.png' },
  2: { label: 'Baliste', asset: 'assets/siege_engines/engin_siege_t2_baliste.png' },
  3: { label: 'Catapulte', asset: 'assets/siege_engines/engin_siege_t3_catapulte.png' },
  4: { label: 'Tour d’assaut', asset: 'assets/siege_engines/engin_siege_t4_tour_assaut.png' },
  5: { label: 'Trébuchet royal', asset: 'assets/siege_engines/engin_siege_t5_trebuchet_royal.png' },
};

/* Fortifications : investissement défensif séparé du renfort (niveau), qui
 * augmente la garnison de base SANS nécessiter de joueurs présents — une
 * guilde peut rendre son château dur à prendre même hors ligne. Même
 * principe de recette que le renfort (ressource du biome, tier = niveau cible). */
const CASTLE_MAX_FORT_LEVEL = 5;
const CASTLE_FORTIFY_COST_GOLD = 300;
const CASTLE_FORTIFY_BONUS_PER_LEVEL = 80;
const CASTLE_FORTIFY_RESOURCES = {
  1: { tier: 1, qty: 60 },
  2: { tier: 2, qty: 150 },
  3: { tier: 3, qty: 350 },
  4: { tier: 4, qty: 700 },
  5: { tier: 5, qty: 1400 },
};

const PREMIUM_CURRENCY = {
  key: 'moonstones',
  label: 'Écailles Lunaires',
  icon: '✦',
};

// Notifications push (Web Push) : la clé publique VAPID est sans danger à
// exposer côté client (c'est son rôle) — la clé privée reste exclusivement
// côté serveur (variable d'environnement VAPID_PRIVATE_KEY, voir server/index.js).
const VAPID_PUBLIC_KEY = 'BOoTgOebS-o98p-oW-BLV1ajB-Ur69-aBNubtBWFRLilwOc_BY0IJCxGSLDs_F2qOKdCZcP2feJd4X6V9r5wh78';

// Packs achetables en argent réel (Stripe) — prix/quantités fixés ici pour
// que le client puisse afficher les cartes ; les liens de paiement et clés
// Stripe restent eux exclusivement côté serveur (variables d'environnement).
// Le taux de bonus croît avec la taille du pack (pratique standard des IAP).
const MOONSTONE_PACKS = [
  { id: 'small', lunaires: 15, priceCents: 299, priceLabel: '2,99 €', bonusLabel: null },
  { id: 'medium', lunaires: 45, priceCents: 799, priceLabel: '7,99 €', bonusLabel: '+13 %' },
  { id: 'large', lunaires: 130, priceCents: 1999, priceLabel: '19,99 €', bonusLabel: '+30 %' },
];

/* Conversion premium → or. Les gros packs offrent un rendement légèrement
 * meilleur, sans rendre obsolètes les gains obtenus en jouant. */
const GOLD_PACKS = [
  { id: 'pouch', gold: 750, moonstones: 5, bonusLabel: null },
  { id: 'chest', gold: 2500, moonstones: 15, bonusLabel: '+11 %' },
  { id: 'hoard', gold: 7500, moonstones: 40, bonusLabel: '+25 %' },
];

// Parchemin d'Endurance : recharge les PA au maximum instantanément, payé en
// Écailles Lunaires (monnaie premium plutôt que l'or, pour ne pas dépendre
// d'une économie d'or qui peut devenir abondante) — un cooldown borne
// volontairement l'usage à 1-2 fois par jour pour éviter le pay-to-win.
const PA_SCROLL_COST_MOONSTONES = 5;
const PA_SCROLL_COOLDOWN_MS = 12 * 60 * 60 * 1000;

const SKIN_ASSET_REV = '20260721-flip';

const CLASS_SKIN_SCALE = {
  SERAPHIN_ROYAL: 1,
  RENARD_VOLEUR: 1,
  CERF_DRUIDE: 1,
  CHAT_MAGICIEN: 1,
  OURS_GUERRIER: 1,
  LION_PALADIN: 1,
  CORBEAU_NECROMANCIEN: 1,
};

/* Correction ponctuelle par skin (pixels, avant mise à l'échelle) : certains
 * arts ont une arme/prop tenue d'un côté qui élargit leur boîte alpha sans
 * élargir le buste symétriquement — centrer CETTE boîte (comme fait
 * drawWorldSprite) décale alors visuellement le buste par rapport aux
 * autres classes/skins, dont la boîte est, elle, équilibrée autour du buste.
 * Absent ou à 0 : comportement inchangé (centré normalement). */
const SKIN_OFFSET_X = {
  'base:OURS_GUERRIER': 10,
  skin_ours_sentinelle: 10,
};

const CLASS_BASE_SKINS = {
  SERAPHIN_ROYAL: 'assets/skins_coherent/seraphin_royal/seraphin_royal_base_v2.png',
  RENARD_VOLEUR: 'assets/skins_coherent/renard_voleur/renard_voleur_base.png',
  CERF_DRUIDE: 'assets/skins_coherent/cerf_druide/cerf_druide_base.png',
  CHAT_MAGICIEN: 'assets/skins_coherent/chat_magicien/chat_magicien_base.png',
  OURS_GUERRIER: 'assets/skins_coherent/ours_guerrier/ours_guerrier_base.png',
  LION_PALADIN: 'assets/skins_coherent/lion_paladin/lion_paladin_base.png',
  CORBEAU_NECROMANCIEN: 'assets/skins_coherent/corbeau_necromancien/corbeau_necromancien_base.png',
};

/* Arme et armure uniques, liées à la classe, évolutives T0→T5 */
const CLASS_GEAR = {
  SERAPHIN_ROYAL:        { weapon: 'Bâton',   armor: 'Étoffe' },
  LION_PALADIN:         { weapon: 'Épée',    armor: 'Plaques' },
  OURS_GUERRIER:        { weapon: 'Hache',   armor: 'Plaques' },
  RENARD_VOLEUR:        { weapon: 'Dagues',  armor: 'Cuir' },
  CHAT_MAGICIEN:        { weapon: 'Bâton',   armor: 'Étoffe' },
  CERF_DRUIDE:          { weapon: 'Sceptre', armor: 'Cuir' },
  CORBEAU_NECROMANCIEN: { weapon: 'Faux',    armor: 'Étoffe' },
};

/* Visuels communs au profil et à l'atelier. L'objet reste le même quand son
 * tier progresse : le badge T0→T6 porte l'information d'évolution. */
const EQUIPMENT_ASSETS = {
  weapon: {
    'Épée': 'assets/equipment/arme_epee_paladin.png',
    'Hache': 'assets/equipment/arme_hache_guerrier.png',
    'Dagues': 'assets/equipment/arme_dagues_voleur.png',
    'Bâton': 'assets/equipment/arme_baton_magicien.png',
    'Sceptre': 'assets/equipment/arme_sceptre_druide.png',
    'Faux': 'assets/equipment/arme_faux_necromancien.png',
  },
  armor: {
    'Plaques': 'assets/equipment/armure_plaques.png',
    'Cuir': 'assets/equipment/armure_cuir.png',
    'Étoffe': 'assets/equipment/armure_etoffe.png',
  },
};

function equipmentAsset(slot, type) {
  return (EQUIPMENT_ASSETS[slot] && EQUIPMENT_ASSETS[slot][type]) || '';
}

function classAvailableToRole(speciesClass, role) {
  const cls = CLASSES[speciesClass];
  if (!cls) return false;
  return !cls.adminOnly || role === 'admin';
}

const SKIN_SHOP_ITEMS = [
  {
    id: 'skin_renard_nomade',
    speciesClass: 'RENARD_VOLEUR',
    label: 'Corsaire cramoisi',
    asset: 'assets/skins_coherent/renard_voleur/renard_voleur_corsaire_cramoisi.png',
    currency: 'gold',
    price: 2000,
  },
  {
    id: 'skin_renard_duelliste',
    speciesClass: 'RENARD_VOLEUR',
    label: 'Ombre lunaire',
    asset: 'assets/skins_coherent/renard_voleur/renard_voleur_ombre_lunaire.png',
    currency: PREMIUM_CURRENCY.key,
    price: 12,
  },
  {
    id: 'skin_cerf_sage',
    speciesClass: 'CERF_DRUIDE',
    label: 'Sage fleuri',
    asset: 'assets/skins_coherent/cerf_druide/cerf_druide_sage_fleuri.png',
    currency: 'gold',
    price: 2000,
  },
  {
    id: 'skin_cerf_chaman',
    speciesClass: 'CERF_DRUIDE',
    label: 'Chaman des marais',
    asset: 'assets/skins_coherent/cerf_druide/cerf_druide_chaman_des_marais.png',
    currency: PREMIUM_CURRENCY.key,
    price: 12,
  },
  {
    id: 'skin_chat_astromancien',
    speciesClass: 'CHAT_MAGICIEN',
    label: 'Astromancien pourpre',
    asset: 'assets/skins_coherent/chat_magicien/chat_magicien_astromancien_pourpre.png',
    currency: 'gold',
    price: 2000,
  },
  {
    id: 'skin_chat_enchanteresse',
    speciesClass: 'CHAT_MAGICIEN',
    label: 'Enchanteresse émeraude',
    asset: 'assets/skins_coherent/chat_magicien/chat_magicien_enchanteresse_emeraude.png',
    currency: PREMIUM_CURRENCY.key,
    price: 12,
  },
  {
    id: 'skin_ours_berserker',
    speciesClass: 'OURS_GUERRIER',
    label: 'Berserker des glaces',
    asset: 'assets/skins_coherent/ours_guerrier/ours_guerrier_berserker_des_glaces.png',
    currency: 'gold',
    price: 2000,
  },
  {
    id: 'skin_ours_sentinelle',
    speciesClass: 'OURS_GUERRIER',
    label: 'Sentinelle des forges',
    asset: 'assets/skins_coherent/ours_guerrier/ours_guerrier_sentinelle_des_forges.png',
    currency: PREMIUM_CURRENCY.key,
    price: 12,
  },
  {
    id: 'skin_lion_croise',
    speciesClass: 'LION_PALADIN',
    label: 'Croisé royal cramoisi',
    asset: 'assets/skins_coherent/lion_paladin/lion_paladin_croise_royal_cramoisi.png',
    currency: 'gold',
    price: 2000,
  },
  {
    id: 'skin_lion_templier',
    speciesClass: 'LION_PALADIN',
    label: 'Templier émeraude',
    asset: 'assets/skins_coherent/lion_paladin/lion_paladin_templier_emeraude.png',
    currency: PREMIUM_CURRENCY.key,
    price: 12,
  },
  {
    id: 'skin_corbeau_oracle',
    speciesClass: 'CORBEAU_NECROMANCIEN',
    label: 'Oracle de peste',
    asset: 'assets/skins_coherent/corbeau_necromancien/corbeau_necromancien_oracle_de_peste.png',
    currency: 'gold',
    price: 2000,
  },
  {
    id: 'skin_corbeau_cultiste',
    speciesClass: 'CORBEAU_NECROMANCIEN',
    label: 'Cultiste lunaire',
    asset: 'assets/skins_coherent/corbeau_necromancien/corbeau_necromancien_cultiste_lunaire.png',
    currency: PREMIUM_CURRENCY.key,
    price: 12,
  },
];

const SKIN_BY_ID = Object.fromEntries(SKIN_SHOP_ITEMS.map((item) => [item.id, item]));

/* ---------- Boss de raid mondial ---------- */
// Un point fixe et unique sur toute la carte (contrairement aux châteaux/
// donjons, un par biome) — pensé pour un raid coordonné d'une dizaine de
// joueurs, bien au-delà d'un boss de donjon T6 (force ~660-700). Réapparaît
// sur une VRAIE horloge murale (Date.now(), voir server/game.js) et non
// l'horloge de jeu — qui accélère avec SPEED en dev — pour qu'un évènement
// rare reste rare même en test accéléré.
const WORLD_BOSS = {
  type: 'WYRM_ANCESTRAL',
  label: 'Wyrm Ancestral',
  force: 1150,
  tier: 6,
  pos: { x: 33, y: -33 },
  respawnMs: 36 * 60 * 60 * 1000,   // 36h
  goldMin: 150,
  goldMax: 220,
  xp: 150,
  // Volontairement pas de monnaie premium garantie (sinon un groupe pourrait
  // s'offrir un skin gratuit tous les 4-5 jours) : une chance modeste d'un
  // petit montant, comme le reste du loot rare.
  moonstoneChance: 0.25,
  moonstoneMin: 1,
  moonstoneMax: 2,
  paScrollChance: 0.08,
  accessoryChance: 0.02,
  accessoryId: 'wyrm_wings',
  mountChance: 0.01,
  mountId: 'wyrm_ancestral_hatchling',
};

/* Cosmétiques d'accessoire : calque additionnel dessiné en plus du skin
 * (indépendant de la classe), jamais en vente — uniquement en loot rare ou
 * attribution admin. Un seul actif à la fois par joueur (p.equippedAccessory). */
const ACCESSORY_ITEMS = {
  wyrm_wings: {
    id: 'wyrm_wings',
    label: 'Ailes du Wyrm Ancestral',
    asset: 'assets/accessories/wyrm_wings.png',
    // Le large vide central de l'asset accueille tous les héros. Ces dimensions
    // sont indépendantes du skin et serviront aussi aux prochains accessoires.
    // squeeze < 1 resserre les ailes horizontalement (uniquement la largeur,
    // la hauteur n'est pas affectée) ; groundOffset négatif les remonte.
    world: { maxW: 118, maxH: 92, groundOffset: -8, squeeze: 0.82 },
  },
};

/* Les montures encadrent le groupe cavalier sans modifier son échelle : la
 * monture est derrière, puis sa partie basse est redessinée devant les jambes.
 *
 * `shop` (optionnel) rend la monture achetable en boutique contre or ou
 * Écailles Lunaires (voir buyMount côté serveur et build_shop côté client) —
 * absent, la monture n'est obtenue que par le loot rare ou l'admin (comme le
 * Rejeton du Wyrm Ancestral ci-dessous). Dimensions `world` volontairement
 * homogènes pour les montures « simples » ci-dessous : à ajuster par animal
 * une fois les vrais assets importés (même exercice que pour les ailes/le
 * Wyrm — cf. loadCleanImage). */
const MOUNT_ITEMS = {
  wyrm_ancestral_hatchling: {
    id: 'wyrm_ancestral_hatchling',
    label: 'Rejeton du Wyrm Ancestral',
    asset: 'assets/mounts/rejeton_wyrm_ancestral.png',
    world: {
      maxW: 154,
      maxH: 110,
      groundOffset: 13,
      riderOffsetX: 8,
      riderOffsetY: -38,
      frontClip: 0.5,
    },
  },
  mount_cheval: {
    id: 'mount_cheval',
    label: 'Cheval',
    asset: 'assets/mounts/cheval.png',
    shop: { currency: 'gold', price: 3000 },
    world: { maxW: 140, maxH: 100, groundOffset: 10, riderOffsetX: 10, riderOffsetY: -34, frontClip: 0.5 },
  },
  mount_loup: {
    id: 'mount_loup',
    label: 'Loup',
    asset: 'assets/mounts/loup.png',
    shop: { currency: 'gold', price: 3000 },
    world: { maxW: 140, maxH: 100, groundOffset: 10, riderOffsetX: 10, riderOffsetY: -34, frontClip: 0.5 },
  },
  mount_tigre: {
    id: 'mount_tigre',
    label: 'Tigre',
    asset: 'assets/mounts/tigre.png',
    shop: { currency: 'gold', price: 3000 },
    world: { maxW: 140, maxH: 100, groundOffset: 10, riderOffsetX: 10, riderOffsetY: -34, frontClip: 0.5 },
  },
  mount_panthere: {
    id: 'mount_panthere',
    label: 'Panthère',
    asset: 'assets/mounts/panthere.png',
    shop: { currency: 'gold', price: 3000 },
    world: { maxW: 140, maxH: 100, groundOffset: 10, riderOffsetX: 10, riderOffsetY: -34, frontClip: 0.5 },
  },
};

/* Sacoche de voyage : accessoire décoratif UNIQUE, réutilisé sur TOUTE
 * monture (pas de config par monture) — dessinée centrée sous le cavalier,
 * pour camoufler la jonction nette entre son buste et le dos de la monture
 * plutôt que d'essayer de faire dépasser une jambe (cf. essais montures qui
 * n'ont pas abouti : le sprite du cavalier ne descend jamais assez bas pour ça). */
const MOUNT_SADDLE_PROP = {
  asset: 'assets/mounts/sac_voyage.png',
  width: 40,
  height: 40,
  groundMargin: 0.08, // fraction de la hauteur dessinée de la monture, au-dessus du sol (évite de toucher l'ombre)
};

function skinAssetUrl(path) {
  return path + '?v=' + SKIN_ASSET_REV;
}

function classSkinScale(speciesClass) {
  return CLASS_SKIN_SCALE[speciesClass] || 0.84;
}

function baseSkinAsset(speciesClass) {
  return CLASS_BASE_SKINS[speciesClass] || '';
}

/* Chaque palier porte un nom (aligné sur les assets) — l'affichage passe
 * par resourceLabel(type, tier) qui garde toujours le tier visible. */
const RESOURCES = {
  BOIS: {
    label: 'Bois', short: 'B',
    tierNames: { 1: 'Chêne', 2: 'Sapin', 3: 'Bouleau', 4: 'Acacia', 5: 'Arbre mort' },
  },
  MINERAI: {
    label: 'Minerai', short: 'M',
    tierNames: { 1: 'Cuivre', 2: 'Fer', 3: 'Argent', 4: 'Minerai d’or', 5: 'Cristal' },
  },
  PLANTE: {
    label: 'Plante', short: 'P',
    tierNames: { 1: 'Menthe', 2: 'Lavande', 3: 'Camomille', 4: 'Aloe vera', 5: 'Fougère' },
  },
  // Ingrédients de cuisine — biome Marais (T6 : Tourbe vivante, en donjon)
  INGREDIENT: {
    label: 'Ingrédient', short: 'I',
    tierNames: {
      1: 'Champignon brumeux',
      2: 'Baie de vase',
      3: 'Racine noueuse',
      4: 'Œuf de basilic',
      5: 'Miel des ombres',
    },
  },
  BOIS_ANCIEN:     { label: 'Bois ancien', short: 'BA', base: 'BOIS' },
  FLEUR_ASTRALE:   { label: 'Fleur astrale', short: 'FA', base: 'PLANTE' },
  MINERAI_RUNIQUE: { label: 'Minerai runique', short: 'MR', base: 'MINERAI' },
  TOURBE_VIVANTE:  { label: 'Tourbe vivante', short: 'TV', base: 'PLANTE' },
};

/* ---------- Cuisine : consommables & buffs ---------- */

const CONSUMABLES = {
  RAGOUT:      { label: 'Ragoût du chasseur', icon: '🍲', kind: 'buff',    role: 'Offensif' },
  BOUILLON:    { label: 'Bouillon d’écailles', icon: '🛡️', kind: 'buff',    role: 'Défensif' },
  POTION_SEVE: { label: 'Potion de sève',      icon: '❤️', kind: 'instant', role: 'Soin' },
  // Acheté à la Boutique contre des Écailles Lunaires (pas cuisiné à la
  // Marmite comme les trois plats ci-dessus) — stocké en inventaire, utilisé
  // quand on veut. Le cooldown (voir PA_SCROLL_COOLDOWN_MS) s'applique à
  // l'UTILISATION, pas à l'achat : on peut en garder plusieurs en réserve.
  PARCHEMIN_ENDURANCE: { label: 'Parchemin d’Endurance', icon: '📜', kind: 'pa_refill', role: 'Recharge PA' },
};

/* Effets par tier : RAGOUT = +puissance, BOUILLON = −usure de PV,
 * POTION_SEVE = % des PV max rendus instantanément. */
const CONSUMABLE_EFFECTS = {
  RAGOUT:      { 1: 0.05, 2: 0.10, 3: 0.15, 4: 0.20, 5: 0.25, 6: 0.30 },
  BOUILLON:    { 1: 0.10, 2: 0.15, 3: 0.20, 4: 0.25, 5: 0.30, 6: 0.35 },
  POTION_SEVE: { 1: 0.20, 2: 0.30, 3: 0.40, 4: 0.50, 5: 0.65, 6: 0.80 },
};

/* Un buff nourriture actif à la fois, compté en combats (pas en temps) */
const BUFF_COMBATS = 3;

/* Recettes : ingrédient du Marais + plante (+ or). Le T6 exige la
 * Tourbe vivante du donjon des marais. */
const CONSUMABLE_RECIPES = {
  1: { INGREDIENT_1: 2, PLANTE_1: 2, gold: 5 },
  2: { INGREDIENT_2: 2, PLANTE_2: 2, gold: 10 },
  3: { INGREDIENT_3: 2, PLANTE_3: 2, gold: 15 },
  4: { INGREDIENT_4: 2, PLANTE_4: 2, gold: 20 },
  5: { INGREDIENT_5: 2, PLANTE_5: 2, gold: 25 },
  6: { TOURBE_VIVANTE_6: 2, PLANTE_5: 3, gold: 40 },
};

function consumableDesc(type, tier) {
  if (type === 'PARCHEMIN_ENDURANCE') {
    return 'Recharge l’Endurance au maximum (' + CONFIG.PA.MAX + ' PA) — 1 utilisation toutes les ' +
      Math.round(PA_SCROLL_COOLDOWN_MS / 3600000) + ' h maximum';
  }
  const pct = Math.round(CONSUMABLE_EFFECTS[type][tier] * 100);
  if (type === 'RAGOUT') return '+' + pct + ' % de puissance pendant ' + BUFF_COMBATS + ' combats';
  if (type === 'BOUILLON') return '−' + pct + ' % d’usure de PV pendant ' + BUFF_COMBATS + ' combats';
  return 'Rend ' + pct + ' % des PV max immédiatement';
}

function buffPowerMult(p) {
  return p.buff && p.buff.type === 'RAGOUT' ? 1 + CONSUMABLE_EFFECTS.RAGOUT[p.buff.tier] : 1;
}

function buffLossReduction(p) {
  return p.buff && p.buff.type === 'BOUILLON' ? 1 - CONSUMABLE_EFFECTS.BOUILLON[p.buff.tier] : 1;
}

/* Ingrédient lâché par un monstre de ce tier (30 % de chances) */
function foodDropFor(tier) {
  return tier >= 6 ? 'TOURBE_VIVANTE_6' : 'INGREDIENT_' + tier;
}

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
// Seuils cumulés — même principe que les quantités de récolte : T1-T2
// rapides, puis ça se corse fort. Palier 6 = maîtrise/récolte/équipement T6.
const XP_LEVELS = [0, 90, 350, 1300, 4500, 15000];

function levelFromXp(xp) {
  let lvl = 1;
  for (let i = 1; i < XP_LEVELS.length; i++) {
    if (xp >= XP_LEVELS[i]) lvl = i + 1;
  }
  return lvl;
}

/* Recettes d'amélioration — une arme/armure Tn se craft avec des ressources Tn. */
// Courbe volontairement exponentielle (T1 très rapide → T5 dur), simulée
// pour atterrir sur plusieurs jours de jeu optimisé pour tout maxer sur un
// seul personnage (récolte + maîtrise + arme + armure). Le T6 est à part :
// exclusif aux ressources spéciales de donjon (BOIS_ANCIEN/MINERAI_RUNIQUE/
// FLEUR_ASTRALE), donc plus dur en pratique qu'un simple multiplicateur de
// quantité ne le montre (nœuds limités, repousse, monstres T6 costauds —
// d'où l'intérêt d'y aller en groupe).
const UPGRADE_RECIPES = {
  weapon: {
    1: { BOIS_1: 20, MINERAI_1: 10 },
    2: { MINERAI_2: 63, BOIS_2: 38 },
    3: { MINERAI_3: 180, PLANTE_3: 120 },
    4: { MINERAI_4: 520, PLANTE_4: 325 },
    5: { MINERAI_5: 1150, PLANTE_5: 690 },
    6: { MINERAI_RUNIQUE_6: 70, FLEUR_ASTRALE_6: 45 },
  },
  armor: {
    1: { MINERAI_1: 15, PLANTE_1: 15 },
    2: { BOIS_2: 50, PLANTE_2: 50 },
    3: { BOIS_3: 150, MINERAI_3: 150 },
    4: { BOIS_4: 390, MINERAI_4: 455 },
    5: { BOIS_5: 828, MINERAI_5: 966 },
    6: { BOIS_ANCIEN_6: 65, MINERAI_RUNIQUE_6: 75 },
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

/* PV max = socle de la classe (Tank > Soutien > Soin/Butin > Dégâts) +
 * l'armure, qui ajoute le même montant par tier pour tous. */
function maxHp(p) {
  return CLASSES[p.speciesClass].baseHp + p.armor.tier * 15;
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
    skinId: null,
    harvestXp: 0, harvestLevel: 1,
    weaponXp: 0, weaponMastery: 1,
    weapon: { tier: 0, type: gear.weapon },
    armor: { tier: 0, type: gear.armor },
  };
}

const CHARACTER_FIELDS = ['speciesClass', 'skinId', 'harvestXp', 'harvestLevel', 'weaponXp', 'weaponMastery', 'weapon', 'armor'];

function skinFor(id) {
  return id ? (SKIN_BY_ID[id] || null) : null;
}

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
  return (playerForce(p) + p.armor.tier * 8) * woundFactor * buffPowerMult(p);
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

/* Nom d'affichage harmonisé : nom du palier s'il existe, toujours avec le tier
 * (ex. « Menthe T1 », « Champignon brumeux T1 », « Bois ancien T6 ») */
function resourceLabel(type, tier) {
  const res = RESOURCES[type];
  const name = res ? ((res.tierNames && res.tierNames[tier]) || res.label) : type;
  return name + ' T' + tier;
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
  BOIS: '🌳', MINERAI: '🪨', PLANTE: '🌿', INGREDIENT: '🍄',
  BOIS_ANCIEN: '🌳', FLEUR_ASTRALE: '🌿', MINERAI_RUNIQUE: '🪨', TOURBE_VIVANTE: '🌿',
};
const MONSTER_EMOJI = { 1: '🐺', 2: '🐻', 3: '👻', 4: '🦎', 5: '🐉', 6: '💀' };

/* Utilisable côté Node (backend) comme côté navigateur */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG, CLASSES, CLASS_GEAR, EQUIPMENT_ASSETS, MAX_CHAR_SLOTS, RESOURCES, MONSTERS, MONSTER_FORCE,
    CASTLE_TERRAINS, CASTLE_BASE_HP, CASTLE_HP_PER_LEVEL, CASTLE_MAX_LEVEL,
    CASTLE_CLAIM_COST_GOLD, CASTLE_REINFORCE_COST_GOLD, CASTLE_REPAIR_GOLD_PER_HP,
    CASTLE_DAMAGE_PER_ASSAULT, CASTLE_ZONE_GOLD_BONUS, CASTLE_SIEGE_COOLDOWN_MS, CASTLE_SIEGE_WINDOWS,
    parisHour, isWithinSiegeWindow,
    CASTLE_TERRAIN_RESOURCE, CASTLE_REINFORCE_RESOURCES, castleRepairResourceTier, CASTLE_REPAIR_HP_PER_RESOURCE,
    SIEGE_ENGINE_ITEM, SIEGE_ENGINE_RECIPES, SIEGE_ENGINE_FORCE, SIEGE_ENGINE_DAMAGE, SIEGE_ENGINES,
    CASTLE_MAX_FORT_LEVEL, CASTLE_FORTIFY_COST_GOLD, CASTLE_FORTIFY_BONUS_PER_LEVEL, CASTLE_FORTIFY_RESOURCES,
    TERRAINS, TIER_COLORS, XP_LEVELS, UPGRADE_RECIPES, SPRITE_CELLS,
    RESOURCE_EMOJI, MONSTER_EMOJI, CHARACTER_FIELDS,
    PREMIUM_CURRENCY, MOONSTONE_PACKS, GOLD_PACKS, PA_SCROLL_COST_MOONSTONES, PA_SCROLL_COOLDOWN_MS, VAPID_PUBLIC_KEY,
    SKIN_SHOP_ITEMS, SKIN_BY_ID, SKIN_ASSET_REV, CLASS_SKIN_SCALE, SKIN_OFFSET_X, CLASS_BASE_SKINS,
    WORLD_BOSS, ACCESSORY_ITEMS, MOUNT_ITEMS, MOUNT_SADDLE_PROP,
    skinFor, skinAssetUrl, classSkinScale, baseSkinAsset, equipmentAsset, classAvailableToRole,
    levelFromXp, playerForce, maxHp, hpLossReduction, stackKey, parseStackKey, resourceFamily,
    newCharacter, syncActiveCharacter, applyCharacter, rollGoldLoot,
    combatPower, teamPowerOf, winChance,
    CONSUMABLES, CONSUMABLE_EFFECTS, CONSUMABLE_RECIPES, BUFF_COMBATS,
    consumableDesc, buffPowerMult, buffLossReduction, foodDropFor, resourceLabel,
  };
}
