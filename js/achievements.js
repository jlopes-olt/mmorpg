'use strict';

/* ============================================================
 * achievements.js — hauts faits : conditions, récompenses, titres
 * Utilisable côté Node (backend) comme côté navigateur, au même
 * titre que config.js.
 * ============================================================ */

// 4 biomes (FORET/PLAINE/MONTAGNE/MARECAGE) × 2 villages chacun —
// voir placeBiomePois() dans js/world.js.
const TOTAL_VILLAGES = 8;

const ACHIEVEMENTS = [
  /* ---------- Combat — monstres (toutes espèces) ---------- */
  { id: 'kill_any_10', category: 'Combat', label: 'Tuer 10 monstres',
    test: (p) => (p.stats.monsterKills || 0) >= 10, reward: { gold: 20 } },
  { id: 'kill_any_100', category: 'Combat', label: 'Tuer 100 monstres',
    test: (p) => (p.stats.monsterKills || 0) >= 100, reward: { gold: 150, title: 'Guerrier' } },
  { id: 'kill_any_1000', category: 'Combat', label: 'Tuer 1 000 monstres',
    test: (p) => (p.stats.monsterKills || 0) >= 1000, reward: { gold: 1200, moonstones: 5, title: 'Vétéran de guerre' } },
  { id: 'kill_any_10000', category: 'Combat', label: 'Tuer 10 000 monstres',
    test: (p) => (p.stats.monsterKills || 0) >= 10000, reward: { gold: 8000, moonstones: 20, title: 'Légende du combat' } },

  /* ---------- Combat — loups ---------- */
  { id: 'kill_lupus_10', category: 'Combat', label: 'Tuer 10 loups',
    test: (p) => ((p.stats.kills && p.stats.kills.LUPUS) || 0) >= 10, reward: { gold: 15 } },
  { id: 'kill_lupus_100', category: 'Combat', label: 'Tuer 100 loups',
    test: (p) => ((p.stats.kills && p.stats.kills.LUPUS) || 0) >= 100, reward: { gold: 120, title: 'Chasseur de loups' } },
  { id: 'kill_lupus_1000', category: 'Combat', label: 'Tuer 1 000 loups',
    test: (p) => ((p.stats.kills && p.stats.kills.LUPUS) || 0) >= 1000, reward: { gold: 900, moonstones: 4, title: 'Fléau des loups' } },
  { id: 'kill_lupus_10000', category: 'Combat', label: 'Tuer 10 000 loups',
    test: (p) => ((p.stats.kills && p.stats.kills.LUPUS) || 0) >= 10000, reward: { gold: 6000, moonstones: 15, title: 'Exterminateur de loups' } },

  /* ---------- Combat — boss ---------- */
  { id: 'boss_1', category: 'Combat', label: 'Vaincre 1 boss',
    test: (p) => (p.stats.bossKills || 0) >= 1, reward: { gold: 100 } },
  { id: 'boss_10', category: 'Combat', label: 'Vaincre 10 boss',
    test: (p) => (p.stats.bossKills || 0) >= 10, reward: { gold: 800, moonstones: 5, title: 'Chasseur de titans' } },
  { id: 'boss_50', category: 'Combat', label: 'Vaincre 50 boss',
    test: (p) => (p.stats.bossKills || 0) >= 50, reward: { gold: 4000, moonstones: 15, title: 'Légende des donjons' } },

  /* ---------- Combat — boss de raid mondial (bien au-delà d'un boss de donjon) ---------- */
  { id: 'world_boss_1', category: 'Combat', label: 'Vaincre le Wyrm Ancestral',
    test: (p) => (p.stats.worldBossKills || 0) >= 1, reward: { gold: 500, moonstones: 8, title: 'Bourreau du Wyrm' } },
  { id: 'world_boss_5', category: 'Combat', label: 'Vaincre le Wyrm Ancestral 5 fois',
    test: (p) => (p.stats.worldBossKills || 0) >= 5, reward: { gold: 3000, moonstones: 25, title: 'Fléau Ancestral' } },

  /* ---------- Duels (PvP) ---------- */
  { id: 'duel_win_1', category: 'Duels', label: 'Gagner 1 duel',
    test: (p) => ((p.duels && p.duels.wins) || 0) >= 1, reward: { gold: 20 } },
  { id: 'duel_win_10', category: 'Duels', label: 'Gagner 10 duels',
    test: (p) => ((p.duels && p.duels.wins) || 0) >= 10, reward: { gold: 150, title: 'Bretteur' } },
  { id: 'duel_win_50', category: 'Duels', label: 'Gagner 50 duels',
    test: (p) => ((p.duels && p.duels.wins) || 0) >= 50, reward: { gold: 700, moonstones: 4, title: 'Champion d’arène' } },
  { id: 'duel_win_100', category: 'Duels', label: 'Gagner 100 duels',
    test: (p) => ((p.duels && p.duels.wins) || 0) >= 100, reward: { gold: 1500, moonstones: 8, title: 'Maître duelliste' } },
  { id: 'duel_streak_10', category: 'Duels', label: '10 victoires d’affilée sans défaite',
    test: (p) => (p.stats.bestDuelStreak || 0) >= 10, reward: { gold: 500, moonstones: 5, title: 'Invaincu' } },

  /* ---------- Récolte — bois ---------- */
  { id: 'harvest_bois_100', category: 'Récolte', label: 'Récolter 100 bois',
    test: (p) => ((p.stats.harvest && p.stats.harvest.BOIS) || 0) >= 100, reward: { gold: 20 } },
  { id: 'harvest_bois_1000', category: 'Récolte', label: 'Récolter 1 000 bois',
    test: (p) => ((p.stats.harvest && p.stats.harvest.BOIS) || 0) >= 1000, reward: { gold: 200, title: 'Bûcheron' } },
  { id: 'harvest_bois_10000', category: 'Récolte', label: 'Récolter 10 000 bois',
    test: (p) => ((p.stats.harvest && p.stats.harvest.BOIS) || 0) >= 10000, reward: { gold: 1800, moonstones: 6, title: 'Maître bûcheron' } },

  /* ---------- Récolte — minerai ---------- */
  { id: 'harvest_minerai_100', category: 'Récolte', label: 'Récolter 100 minerai',
    test: (p) => ((p.stats.harvest && p.stats.harvest.MINERAI) || 0) >= 100, reward: { gold: 20 } },
  { id: 'harvest_minerai_1000', category: 'Récolte', label: 'Récolter 1 000 minerai',
    test: (p) => ((p.stats.harvest && p.stats.harvest.MINERAI) || 0) >= 1000, reward: { gold: 200, title: 'Mineur' } },
  { id: 'harvest_minerai_10000', category: 'Récolte', label: 'Récolter 10 000 minerai',
    test: (p) => ((p.stats.harvest && p.stats.harvest.MINERAI) || 0) >= 10000, reward: { gold: 1800, moonstones: 6, title: 'Maître mineur' } },

  /* ---------- Récolte — progression ---------- */
  { id: 'harvest_level_max', category: 'Récolte', label: 'Atteindre le niveau de récolte maximum',
    test: (p) => (p.harvestLevel || 1) >= 6, reward: { gold: 500, moonstones: 5, title: 'Grand collecteur' } },

  /* ---------- Équipement ---------- */
  { id: 'weapon_t3', category: 'Équipement', label: 'Équiper une arme tier 3',
    test: (p) => ((p.weapon && p.weapon.tier) || 0) >= 3, reward: { gold: 50 } },
  { id: 'weapon_t5', category: 'Équipement', label: 'Équiper une arme tier 5',
    test: (p) => ((p.weapon && p.weapon.tier) || 0) >= 5, reward: { gold: 600, moonstones: 5, title: 'Porteur d’arme légendaire' } },
  { id: 'weapon_t6', category: 'Équipement', label: 'Équiper une arme tier 6',
    test: (p) => ((p.weapon && p.weapon.tier) || 0) >= 6, reward: { gold: 1500, moonstones: 10, title: 'Porteur d’arme mythique' } },
  { id: 'weapon_mastery_max', category: 'Équipement', label: 'Atteindre la maîtrise d’arme maximum',
    test: (p) => (p.weaponMastery || 1) >= 6, reward: { gold: 500, moonstones: 5, title: 'Maître d’armes' } },

  /* ---------- Guilde ---------- */
  { id: 'guild_join', category: 'Guilde', label: 'Rejoindre une guilde',
    test: (p) => !!p.guildId, reward: { gold: 30 } },
  { id: 'guild_found', category: 'Guilde', label: 'Fonder une guilde',
    test: (p) => !!(p.stats.guildFounded), reward: { gold: 100, title: 'Fondateur' } },
  { id: 'guild_full', category: 'Guilde', label: 'Une guilde que vous dirigez atteint 20 membres',
    test: (p) => !!(p.stats.guildReachedMax), reward: { gold: 300, moonstones: 5, title: 'Bâtisseur de guilde' } },

  /* ---------- Château / siège ---------- */
  { id: 'siege_participate_1', category: 'Château', label: 'Participer à 1 siège',
    test: (p) => (p.stats.siegeParticipations || 0) >= 1, reward: { gold: 40 } },
  { id: 'siege_participate_10', category: 'Château', label: 'Participer à 10 sièges',
    test: (p) => (p.stats.siegeParticipations || 0) >= 10, reward: { gold: 400, title: 'Vétéran des sièges' } },
  { id: 'siege_win_1', category: 'Château', label: 'Remporter 1 prise de château',
    test: (p) => (p.stats.siegeWins || 0) >= 1, reward: { gold: 80 } },
  { id: 'siege_win_10', category: 'Château', label: 'Remporter 10 prises de château',
    test: (p) => (p.stats.siegeWins || 0) >= 10, reward: { gold: 1000, moonstones: 6, title: 'Grand conquérant' } },
  { id: 'siege_win_50', category: 'Château', label: 'Remporter 50 prises de château',
    test: (p) => (p.stats.siegeWins || 0) >= 50, reward: { gold: 6000, moonstones: 20, title: 'Seigneur de guerre' } },

  /* ---------- Exploration ---------- */
  { id: 'explore_villages_5', category: 'Exploration', label: 'Visiter 5 villages',
    test: (p) => (p.visitedVillages || []).length >= 5, reward: { gold: 60 } },
  { id: 'explore_villages_all', category: 'Exploration', label: 'Visiter tous les villages',
    test: (p) => (p.visitedVillages || []).length >= TOTAL_VILLAGES, reward: { gold: 400, title: 'Grand voyageur' } },
  { id: 'explore_tiles_200', category: 'Exploration', label: 'Explorer 200 cases de la carte',
    test: (p) => (p.exploredWorld || []).length >= 200, reward: { gold: 40 } },
  { id: 'explore_tiles_1000', category: 'Exploration', label: 'Explorer 1 000 cases de la carte',
    test: (p) => (p.exploredWorld || []).length >= 1000, reward: { gold: 500, title: 'Cartographe' } },

  /* ---------- Commerce et économie ---------- */
  { id: 'trade_10', category: 'Commerce', label: 'Réaliser 10 échanges',
    test: (p) => (p.stats.trades || 0) >= 10, reward: { gold: 50 } },
  { id: 'trade_100', category: 'Commerce', label: 'Réaliser 100 échanges',
    test: (p) => (p.stats.trades || 0) >= 100, reward: { gold: 600, title: 'Marchand' } },
  { id: 'gold_10000', category: 'Commerce', label: 'Accumuler 10 000 or',
    test: (p) => (p.gold || 0) >= 10000, reward: { gold: 200 } },
  { id: 'gold_100000', category: 'Commerce', label: 'Accumuler 100 000 or',
    test: (p) => (p.gold || 0) >= 100000, reward: { gold: 1000, moonstones: 10, title: 'Magnat' } },

  /* ---------- Social / ancienneté ---------- */
  { id: 'friends_10', category: 'Social', label: 'Ajouter 10 amis',
    test: (p) => (p.friends || []).length >= 10, reward: { gold: 50 } },
  { id: 'seniority_30', category: 'Social', label: 'Jouer pendant 30 jours',
    test: (p) => (Date.now() - (p.createdAt || Date.now())) >= 30 * 86400000, reward: { gold: 100 } },
  { id: 'seniority_100', category: 'Social', label: 'Jouer pendant 100 jours',
    test: (p) => (Date.now() - (p.createdAt || Date.now())) >= 100 * 86400000, reward: { gold: 500, moonstones: 5, title: 'Pilier de la communauté' } },
];

/* Champs additionnels du joueur nécessaires au suivi des hauts faits —
 * défensif comme le reste des normalisations de register()/load(). */
function ensureAchievementState(p) {
  if (!p.stats || typeof p.stats !== 'object') p.stats = {};
  if (!p.stats.kills || typeof p.stats.kills !== 'object') p.stats.kills = {};
  if (!p.stats.harvest || typeof p.stats.harvest !== 'object') p.stats.harvest = {};
  if (typeof p.stats.monsterKills !== 'number') p.stats.monsterKills = 0;
  if (typeof p.stats.bossKills !== 'number') p.stats.bossKills = 0;
  if (typeof p.stats.trades !== 'number') p.stats.trades = 0;
  if (typeof p.stats.siegeParticipations !== 'number') p.stats.siegeParticipations = 0;
  if (typeof p.stats.siegeWins !== 'number') p.stats.siegeWins = 0;
  if (typeof p.stats.duelStreak !== 'number') p.stats.duelStreak = 0;
  if (typeof p.stats.bestDuelStreak !== 'number') p.stats.bestDuelStreak = 0;
  if (!Array.isArray(p.unlockedAchievements)) p.unlockedAchievements = [];
  if (!Array.isArray(p.titles)) p.titles = [];
  if (typeof p.activeTitle !== 'string') p.activeTitle = null;
  if (typeof p.createdAt !== 'number') p.createdAt = Date.now();
}

/* Vérifie les hauts faits non encore débloqués, applique les récompenses
 * (or, monnaie premium, titre) et retourne la liste de ceux venant d'être
 * débloqués — pour une notification côté client.
 * `categories` (optionnel) restreint la vérification aux catégories
 * concernées par l'action en cours (ex. un duel ne doit jamais faire
 * apparaître, en incident, un haut fait d'Équipement déjà acquis par
 * ailleurs) — sans lui, TOUTE la liste est vérifiée. */
function checkAchievements(p, categories) {
  ensureAchievementState(p);
  const unlocked = [];
  const list = categories ? ACHIEVEMENTS.filter((a) => categories.includes(a.category)) : ACHIEVEMENTS;
  for (const ach of list) {
    if (p.unlockedAchievements.includes(ach.id)) continue;
    let pass = false;
    try { pass = !!ach.test(p); } catch (e) { pass = false; }
    if (!pass) continue;
    p.unlockedAchievements.push(ach.id);
    const reward = ach.reward || {};
    if (reward.gold) p.gold = (p.gold || 0) + reward.gold;
    if (reward.moonstones) p.moonstones = (p.moonstones || 0) + reward.moonstones;
    if (reward.title) {
      if (!p.titles.includes(reward.title)) p.titles.push(reward.title);
      p.activeTitle = reward.title;
    }
    unlocked.push(ach);
  }
  return unlocked;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ACHIEVEMENTS, TOTAL_VILLAGES, ensureAchievementState, checkAchievements };
}
