'use strict';

/* ============================================================
 * quests.js — chaîne de quêtes guidée (tutoriel puis progression
 * d'équipement jusqu'au tier 6) + quêtes parallèles de haut niveau
 * (boss de donjon, boss mondial). Utilisable côté Node (backend)
 * comme côté navigateur, au même titre que config.js/achievements.js.
 *
 * Contrairement aux hauts faits (liste plate progress/target), la
 * chaîne principale est ORDONNÉE et SÉQUENTIELLE (une seule quête « en
 * cours » à la fois) et ses quêtes sont à ÉTAPES (steps[]) — chaque
 * étape a son propre check(p), pour guider pas à pas (« récolte X »
 * puis « va forger à la Capitale ») plutôt qu'un simple compteur.
 * ============================================================ */

/* Étape « récolter » : lit la recette réelle (UPGRADE_RECIPES), jamais un
 * montant en dur — si les recettes changent, la quête reste juste. */
function gatherStep(slot, tier) {
  const recipe = UPGRADE_RECIPES[slot][tier];
  const noun = slot === 'weapon' ? 'votre arme' : 'votre armure';
  const label = 'Récolter ' + Object.entries(recipe).map(([key, qty]) => {
    const { type, tier: t } = parseStackKey(key);
    return qty + '× ' + resourceLabel(type, t);
  }).join(', ') + ' pour ' + noun;
  return {
    key: 'gather_' + slot,
    label,
    recipe,   // exposé pour l'affichage have/need côté client (voir upgradeCard)
    // Une fois l'objet forgé à ce tier (ou plus), cette étape reste acquise
    // même si l'inventaire ne contient plus les ressources : upgrade() les
    // consomme à la forge (voir server/game.js), donc se re-baser uniquement
    // sur l'inventaire ferait « reculer » cette étape juste après avoir
    // forgé, ramenant la bannière en arrière au lieu d'avancer.
    check: (p) => (((p[slot] && p[slot].tier) || 0) >= tier) ||
      Object.entries(recipe).every(([key, qty]) => (p.inventory[key] || 0) >= qty),
  };
}

function craftStep(slot, tier) {
  const noun = slot === 'weapon' ? 'votre arme' : 'votre armure';
  return {
    key: 'craft_' + slot,
    label: 'Forger ' + noun + ' T' + tier + ' à la Capitale',
    check: (p) => (((p[slot] && p[slot].tier) || 0) >= tier),
  };
}

/* Tier 1 : seule quête d'équipement détaillant la récolte étape par étape —
 * sert à enseigner le mécanisme une fois. Les tiers suivants (voir
 * gearTierQuest ci-dessous) n'ont plus qu'un objectif unique : le joueur a
 * déjà compris qu'il faut récolter avant de forger. */
function gearTier1Quest() {
  return {
    id: 'gear_tier_1',
    title: 'Votre premier équipement',
    steps: [gatherStep('weapon', 1), craftStep('weapon', 1), gatherStep('armor', 1), craftStep('armor', 1)],
    reward: { gold: 20 },
  };
}

const GEAR_TIER_REWARDS = { 2: { gold: 40 }, 3: { gold: 80 }, 4: { gold: 150 }, 5: { gold: 300 }, 6: { gold: 600, moonstones: 5 } };

/* Tiers 2 à 6 : un objectif unique (pas de sous-étape de récolte) — la
 * maîtrise récolte/arme progresse de toute façon implicitement, puisque
 * récolter un nœud tier N exige déjà harvestLevel >= N et forger un
 * équipement tier N exige déjà weaponMastery >= N (voir server/game.js). */
function gearTierQuest(tier) {
  return {
    id: 'gear_tier_' + tier,
    title: 'Équipement — Tier ' + tier,
    steps: [{
      key: 'gear',
      label: 'Forger une arme et une armure Tier ' + tier,
      check: (p) => (((p.weapon && p.weapon.tier) || 0) >= tier) && (((p.armor && p.armor.tier) || 0) >= tier),
    }],
    reward: GEAR_TIER_REWARDS[tier],
  };
}

/* Chaîne principale — ordre = ordre d'affichage (bannière HUD, Profil). */
const QUESTS = [
  {
    id: 'intro_move',
    title: 'Bienvenue sur FERALIA',
    // Distance à la Capitale plutôt que exploredWorld.length : le brouillard
    // de guerre révèle déjà un cercle de CONFIG.VIEW_RADIUS (4, soit une
    // soixantaine de cases) rien qu'en apparaissant à (0,0), sans le moindre
    // déplacement — cette quête se validerait alors instantanément et ne
    // testerait jamais vraiment le mouvement.
    steps: [{ key: 'explore', label: 'S’éloigner de 5 cases de la Capitale', check: (p) => Math.hypot(p.pos.x, p.pos.y) >= 5 }],
    reward: { gold: 10 },
  },
  gearTier1Quest(),
  {
    id: 'first_kill',
    title: 'Premier sang',
    steps: [{ key: 'kill', label: 'Vaincre votre premier monstre', check: (p) => (p.stats.monsterKills || 0) >= 1 }],
    reward: { gold: 15 },
  },
  gearTierQuest(2),
  gearTierQuest(3),
  {
    id: 'join_guild',
    title: 'Esprit de guilde',
    steps: [{ key: 'guild', label: 'Rejoindre ou fonder une guilde', check: (p) => !!p.guildId }],
    reward: { gold: 30 },
  },
  gearTierQuest(4),
  {
    id: 'first_duel',
    title: 'Premier duel',
    // Participer suffit, gagner ou perdre : resolveDuel incrémente toujours
    // wins (vainqueur) OU losses (perdant) pour les DEUX duellistes, jamais
    // les deux à la fois — leur somme vaut donc « nombre de duels disputés ».
    steps: [{ key: 'duel', label: 'Participer à un duel amical', check: (p) => (((p.duels && p.duels.wins) || 0) + ((p.duels && p.duels.losses) || 0)) >= 1 }],
    reward: { gold: 30 },
  },
  gearTierQuest(5),
  gearTierQuest(6),
];

/* Quêtes de haut niveau, indépendantes de la chaîne principale : elles se
 * débloquent dès que la maîtrise d'arme atteint le seuil, quelle que soit
 * la position du joueur dans QUESTS — affronter un boss ne devrait pas
 * attendre d'avoir rejoint une guilde ou gagné un duel. */
const PARALLEL_QUESTS = [
  {
    id: 'first_boss',
    title: 'Premier donjon',
    unlockLabel: 'Se débloque à maîtrise d’arme 4',
    unlock: (p) => (p.weaponMastery || 1) >= 4,
    steps: [{ key: 'boss', label: 'Vaincre un boss de donjon', check: (p) => (p.stats.bossKills || 0) >= 1 }],
    reward: { gold: 60 },
  },
  {
    id: 'world_boss_intro',
    title: 'Légende en devenir',
    unlockLabel: 'Se débloque à maîtrise d’arme 6',
    unlock: (p) => (p.weaponMastery || 1) >= 6,
    steps: [{ key: 'wb', label: 'Vaincre le Wyrm Ancestral', check: (p) => (p.stats.worldBossKills || 0) >= 1 }],
    reward: { gold: 1000, moonstones: 15, title: 'Légende en devenir' },
  },
];

function ensureQuestState(p) {
  if (!Array.isArray(p.completedQuests)) p.completedQuests = [];
}

/* Une étape dont check() lève une exception ne doit jamais faire planter
 * l'action en cours (même filet que ach.progress() dans achievements.js) —
 * particulièrement utile ici car les steps lisent des champs dynamiques
 * (p.inventory, p[slot].tier) qui pourraient être malformés sur un compte
 * pas encore migré. */
function stepDone(step, p) {
  try { return !!step.check(p); } catch (e) { return false; }
}
function isQuestDone(q, p) {
  return q.steps.every((s) => stepDone(s, p));
}

function grantQuestReward(p, q) {
  const reward = q.reward || {};
  if (reward.gold) p.gold = (p.gold || 0) + reward.gold;
  if (reward.moonstones) p.moonstones = (p.moonstones || 0) + reward.moonstones;
  if (reward.title) {
    if (!p.titles.includes(reward.title)) p.titles.push(reward.title);
    p.activeTitle = reward.title;
  }
}

/* Avance la chaîne principale (s'arrête à la première quête encore
 * incomplète, mais continue tant que les suivantes sont déjà satisfaites —
 * rattrape d'un coup un joueur déjà avancé, ou un octroi admin, plutôt que
 * de le forcer à re-déclencher une à une des quêtes déjà remplies), PUIS
 * vérifie indépendamment chaque quête parallèle débloquée. Mute p.gold/
 * p.moonstones/p.titles/p.completedQuests directement (même style que
 * checkAchievements). Retourne la liste des quêtes venant d'être complétées
 * (chaîne + parallèles), pour notification côté appelant. */
function checkQuests(p) {
  ensureQuestState(p);
  const newlyCompleted = [];

  for (const q of QUESTS) {
    if (p.completedQuests.includes(q.id)) continue;
    if (!isQuestDone(q, p)) break;
    p.completedQuests.push(q.id);
    grantQuestReward(p, q);
    newlyCompleted.push(q);
  }

  for (const q of PARALLEL_QUESTS) {
    if (p.completedQuests.includes(q.id)) continue;
    let unlocked = false;
    try { unlocked = !!q.unlock(p); } catch (e) { unlocked = false; }
    if (!unlocked || !isQuestDone(q, p)) continue;
    p.completedQuests.push(q.id);
    grantQuestReward(p, q);
    newlyCompleted.push(q);
  }

  return newlyCompleted;
}

/* Quête PRINCIPALE en cours, pour la bannière HUD/Profil — saute d'abord
 * toute quête déjà dans p.completedQuests SANS re-vérifier ses conditions
 * en direct : certains champs peuvent régresser après coup (ex. guildId si
 * le joueur quitte sa guilde), sans que la quête acquise ne redevienne « à
 * faire ». */
function currentQuestFor(p) {
  ensureQuestState(p);
  for (const q of QUESTS) {
    if (p.completedQuests.includes(q.id)) continue;
    const stepIndex = q.steps.findIndex((s) => !stepDone(s, p));
    const idx = stepIndex === -1 ? q.steps.length - 1 : stepIndex;
    return { quest: q, stepIndex: idx, step: q.steps[idx] };
  }
  return null;   // chaîne principale entièrement terminée
}

/* Quêtes parallèles actuellement débloquées mais pas encore terminées —
 * pour le badge secondaire du HUD et la section Profil. */
function activeParallelQuestsFor(p) {
  ensureQuestState(p);
  return PARALLEL_QUESTS.filter((q) => {
    if (p.completedQuests.includes(q.id)) return false;
    try { return !!q.unlock(p); } catch (e) { return false; }
  });
}

/* Utilisable côté Node (backend) comme côté navigateur */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QUESTS, PARALLEL_QUESTS, checkQuests, currentQuestFor, activeParallelQuestsFor, ensureQuestState };
}
