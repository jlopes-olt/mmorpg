'use strict';

/* Test de la logique multijoueur (Game), sans réseau. */

process.env.SPEED = '1';

const assert = require('assert');
const { Game, CHAT_LOG_MAX } = require('./game.js');
const {
  CONFIG, CLASSES, MAX_CHAR_SLOTS, MAX_PLAYER_CHAR_SLOTS, CHAR_SLOT_COST_MOONSTONES, MONSTER_FORCE, playerForce, maxHp,
  combatPower, maxPower, teamPowerOf, winChance, BUFF_COMBATS, reviveHpPct,
  CASTLE_TERRAINS, CASTLE_BASE_HP, CASTLE_HP_PER_LEVEL, CASTLE_MAX_LEVEL,
  CASTLE_CLAIM_COST_GOLD, CASTLE_REINFORCE_COST_GOLD, CASTLE_REPAIR_GOLD_PER_HP,
  CASTLE_DAMAGE_PER_ASSAULT, CASTLE_ZONE_GOLD_BONUS,
  SIEGE_ENGINE_ITEM, SIEGE_ENGINE_RECIPES, SIEGE_ENGINE_FORCE, SIEGE_ENGINE_DAMAGE,
  CASTLE_FORTIFY_COST_GOLD, CASTLE_FORTIFY_BONUS_PER_LEVEL, stackKey,
  PREMIUM_CURRENCY, GOLD_PACKS,
  MOUNT_ITEMS, SIEGE_CAPTURE_GOLD_PER_LEVEL, RENARD_SIEGE_LOOT_BONUS,
  DICE_SKIN_ITEMS, DICE_SKIN_BY_ID,
  ARTIFACT_ITEMS, ARTIFACT_ORDER,
  HOUSING_MAP_ID, HOUSE_MODELS, HOUSE_MODEL_BY_ID, housingParcelId,
  HOUSING_GRID_COORDS, HOUSING_PORTAL_WORLD_POS, HOUSING_PLAZA_POS,
} = require('../js/config.js');
const { ACHIEVEMENTS } = require('../js/achievements.js');

const g = new Game(CONFIG.WORLD.SEED, null);
const sent = [];
g.send = (id, ev, data) => sent.push({ id, ev, data });
g.broadcast = () => {};
const pushed = [];
g.sendPush = (id, title, body) => pushed.push({ id, title, body });
// La fenêtre de vulnérabilité des châteaux (CASTLE_SIEGE_WINDOWS) dépend de
// l'heure réelle — sans ce stub, la suite deviendrait non déterministe selon
// le moment où elle s'exécute. Le comportement de la fenêtre elle-même est
// testé séparément plus bas, en la réactivant ponctuellement.
g.isSiegeWindowOpen = () => true;

// Jets de dé déterministes : resolveRaid()/resolveSiege() consomment un
// this.rng() pour le jet de victoire PUIS un autre pour le tirage au sort du
// « lanceur de dé » affiché (voir Game.resolveRaid) ; resolveDuel() en
// consomme un par duelliste (jet propre à chacun, voir Game.resolveDuel).
// Une simple constante ne suffit donc plus toujours à forcer un résultat
// (ex. victoire ET récolte d'un objet à chance fixe dans le même combat) —
// rngSequence fournit une valeur par appel, en répétant la dernière au-delà.
function rngSequence(...values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

// Les personnages « historiques » de ce fichier (alice, bob, carl…) ne
// testent pas les quêtes (voir tout en bas pour ça) — sans ce vaccin, les
// récompenses en or de checkQuests() (câblé aux mêmes points que
// checkAchievements) viendraient fausser les innombrables assertions de
// solde exact déjà écrites contre ce fichier avant l'existence des quêtes.
function skipQuestsFor(p) {
  p.completedQuests = QUESTS.map((q) => q.id).concat(PARALLEL_QUESTS.map((q) => q.id));
}

// --- Comptes : inscription / connexion / token ---
let r = g.register({ username: 'Alice', password: 'secret1', speciesClass: 'LION_PALADIN', email: 'alice@test.dev' });
assert.ok(r.ok && r.created, 'inscription');
const alice = r.player;
skipQuestsFor(alice);
alice.online = true;

assert.ok(!g.register({ username: 'Al', password: 'secret1', speciesClass: 'LION_PALADIN', email: 'al@test.dev' }).ok, 'nom trop court refusé');
assert.ok(!g.register({ username: 'Zoe', password: '123', speciesClass: 'LION_PALADIN', email: 'zoe@test.dev' }).ok, 'mot de passe trop court refusé');
assert.ok(!g.register({ username: 'alice', password: 'autre', speciesClass: 'CHAT_MAGICIEN', email: 'alice2@test.dev' }).ok, 'nom déjà pris (insensible à la casse)');
assert.ok(!g.register({ username: 'Zola', password: 'secret1', speciesClass: 'LION_PALADIN', email: 'pas-un-email' }).ok, 'email invalide refusé');

const r2 = g.authToken(alice.token);
assert.strictEqual(r2.player, alice, 'reprise de session par token');
assert.ok(!g.authToken('mauvais-token').ok, 'token invalide refusé');

assert.ok(!g.login({ username: 'Alice', password: 'mauvais' }).ok, 'mauvais mot de passe refusé');
const oldToken = alice.token;
const rLogin = g.login({ username: 'ALICE', password: 'secret1' });
assert.ok(rLogin.ok, 'connexion (insensible à la casse)');
assert.notStrictEqual(alice.token, oldToken, 'token de session régénéré à la connexion');
assert.ok(!g.authToken(oldToken).ok, 'ancien token invalidé');

r = g.register({ username: 'Bob', password: 'secret2', speciesClass: 'CERF_DRUIDE', email: 'bob@test.dev' });
assert.ok(r.ok, 'second compte');
const bob = r.player;
skipQuestsFor(bob);
bob.online = true;

// --- Déplacement ---
let moved = false;
for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
  if (g.move(alice, dx, dy).ok) { moved = true; break; }
}
assert.ok(moved, 'déplacement');
assert.strictEqual(alice.pa, CONFIG.PA.START, 'déplacement gratuit — Regain inchangé');

// --- Progression T0 -> T5 cohérente ---
assert.strictEqual(alice.weapon.tier, 0, 'arme de départ T0');
assert.strictEqual(alice.armor.tier, 0, 'armure de départ T0');
assert.ok(g.tiles, 'monde initialisé');

for (let target = 1; target <= 5; target++) {
  const weaponRecipe = require('../js/config.js').UPGRADE_RECIPES.weapon[target];
  const armorRecipe = require('../js/config.js').UPGRADE_RECIPES.armor[target];
  assert.ok(weaponRecipe && armorRecipe, 'recettes présentes pour T' + target);
  for (const key of Object.keys(weaponRecipe)) assert.ok(key.endsWith('_' + target), 'arme T' + target + ' consomme ressource T' + target);
  for (const key of Object.keys(armorRecipe)) assert.ok(key.endsWith('_' + target), 'armure T' + target + ' consomme ressource T' + target);
}

// Calibrage probabiliste : à parité (équipement au tier inférieur, plein PV),
// chaque classe doit avoir des chances raisonnables ; avec l'équipement du
// tier du monstre, la victoire doit être quasi sûre.
for (let tier = 1; tier <= 5; tier++) {
  for (const speciesClass of Object.keys(CLASSES).filter((k) => !CLASSES[k].adminOnly)) {
    const parity = {
      speciesClass,
      weapon: { tier: tier - 1 },
      armor: { tier: tier - 1 },
      weaponMastery: tier,
    };
    parity.hp = maxHp(parity);   // plein PV, quel que soit le socle de la classe
    const pParity = winChance(teamPowerOf([parity]), MONSTER_FORCE[tier]);
    assert.ok(pParity >= 0.5 && pParity <= 0.92,
      speciesClass + ' à parité vs T' + tier + ' : ' + Math.round(pParity * 100) + ' % (attendu 50-92)');

    const geared = { ...parity, weapon: { tier }, armor: { tier } };
    geared.hp = maxHp(geared);
    const pGeared = winChance(teamPowerOf([geared]), MONSTER_FORCE[tier]);
    assert.ok(pGeared >= 0.9,
      speciesClass + ' suréquipé vs T' + tier + ' : ' + Math.round(pGeared * 100) + ' % (attendu ≥ 90)');
  }
}

// --- Récolte ---
let node = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'resource' && t.content.tier === 1) { node = t; break; }
}
alice.pos = { x: node.x - 1, y: node.y };
assert.ok(g.harvest(alice, node.x, node.y).ok, 'récolte acceptée');
g.tick(CONFIG.HARVEST_MS + 200);
assert.strictEqual(alice.status, 'IDLE', 'récolte terminée');
assert.ok(Object.keys(alice.inventory).length, 'inventaire rempli');

// --- Raid : lobby, rejoindre, lancer immédiatement ---
let mon = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'monster' && t.content.tier === 2) { mon = t; break; }
}
alice.pos = { x: mon.x - 1, y: mon.y };
bob.pos = { x: mon.x + 1, y: mon.y };
alice.pa = 50; bob.pa = 50;
for (const b of g.bots.values()) { b.pos = { x: mon.x + 2, y: mon.y + 2 }; b.home = b.pos; }

sent.length = 0;
assert.ok(g.createRaid(alice, mon.x, mon.y).ok, 'lobby créé');
// Alerte de proximité : seule façon de savoir qu'un combat vient de s'ouvrir
// avant que le lobby (30 s) ne se referme sans qu'on ne l'ait remarqué —
// voir Game.createRaid. Bob est adjacent au monstre : il doit être alerté ;
// les bots (jamais dans this.players, voir la génération des bots) ne
// peuvent de toute façon pas en recevoir.
const proximityToasts = sent.filter((m) => m.ev === 'toast');
assert.strictEqual(proximityToasts.length, 1, 'un seul joueur proche alerté (Bob)');
assert.strictEqual(proximityToasts[0].id, bob.id, 'Bob est le destinataire du toast de proximité');
assert.ok(/affronte/.test(proximityToasts[0].data.text), 'le toast mentionne le combat en cours');

assert.ok(g.joinRaid(bob, tileKeyOf(mon)).ok, 'Bob rejoint');
g.tick(5000);   // le temps que les bots rejoignent

const key = 'world|' + tileKeyOf(mon);   // clé de raid multi-cartes
const raid = g.raids.get(key);
assert.ok(raid, 'lobby encore ouvert (30 s non écoulées)');
assert.ok(raid.participants.length >= 2, 'participants présents : ' + raid.participants.length);

assert.ok(!g.startRaidNow(bob, key).ok, 'seul le chef peut lancer');
g.rng = () => 0.999;   // victoire forcée (jet 100) pour tester les récompenses
assert.ok(g.startRaidNow(alice, key).ok, 'lancement immédiat par le chef');
g.tick(300);
g.rng = Math.random;
assert.ok(!g.raids.has(key), 'raid résolu');

const results = sent.filter((m) => m.ev === 'result');
assert.strictEqual(results.length, 2, 'résultat envoyé aux deux humains');
assert.ok(results[0].data.victory, 'victoire attendue');
// Jet de dé (d100) : le jet forcé au maximum (100) doit dépasser le seuil,
// être signalé comme réussite critique, et le lanceur affiché doit être un
// des deux participants humains — même jet et même lanceur envoyés aux deux
// (issue collective, voir Game.resolveRaid).
assert.strictEqual(results[0].data.roll, 100, 'jet forcé au maximum reflété dans le rapport');
assert.ok(results[0].data.threshold >= 1 && results[0].data.threshold <= 100, 'seuil dans [1,100]');
assert.ok(results[0].data.roll >= results[0].data.threshold, 'jet ≥ seuil ⇒ victoire');
assert.strictEqual(results[0].data.critical, 'success', 'jet 100 = réussite critique');
assert.ok(['Alice', 'Bob'].includes(results[0].data.rollerUsername), 'lanceur tiré au sort parmi les humains');
assert.strictEqual(results[0].data.rollerUsername, results[1].data.rollerUsername, 'même lanceur affiché aux deux (issue collective)');
console.log('Raid T2 : équipe ' + results[0].data.teamForce + ' vs ' + results[0].data.monsterForce +
  ' (' + results[0].data.participants.length + ' participants)');
assert.strictEqual(alice.status, 'IDLE');

// --- Or looté en victoire (rapport + solde du compte) ---
assert.ok(results[0].data.hpLoss > 0, 'le rapport indique les PV réellement perdus');
const goldWon = results[0].data.gold;
assert.ok(goldWon >= 11 && goldWon <= 15, 'or T2 dans la fourchette 11-15 : ' + goldWon);
assert.strictEqual(alice.gold, goldWon, 'or crédité sur le compte');
console.log('Or looté (T2) : +' + goldWon + ' 🪙, rapport PV −' + results[0].data.hpLoss);

// --- Forge ---
alice.pos = { x: 0, y: 0 };
alice.pa = 100;
alice.inventory.BOIS_1 = 20; alice.inventory.MINERAI_1 = 10;
alice.weaponMastery = 0;
assert.ok(!g.upgrade(alice, 'weapon').ok, 'refus maîtrise insuffisante');
alice.weaponMastery = 1;
assert.ok(g.upgrade(alice, 'weapon').ok, 'forge T1');
assert.strictEqual(alice.weapon.tier, 1);

// --- Voyage village : découverte à pied obligatoire ---
const { isWalkable } = require('../js/world.js');
let village = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'village') { village = t; break; }
}
assert.ok(village, 'village trouvé');

// Non découvert : téléportation refusée depuis la Capitale
alice.pos = { x: 0, y: 0 };
assert.ok(!g.teleportVillage(alice, village.x, village.y).ok, 'village non découvert : téléportation refusée');

// On marche sur la tuile → découvert
let adj = null;
for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
  if (isWalkable(g.tiles, village.x + dx, village.y + dy)) { adj = { dx, dy }; break; }
}
alice.pos = { x: village.x + adj.dx, y: village.y + adj.dy };
alice.pa = 10;
assert.ok(g.move(alice, -adj.dx, -adj.dy).ok, 'entrée dans le village à pied');
assert.ok(alice.visitedVillages.includes(village.x + ',' + village.y), 'village marqué découvert');

// Découvert : les deux sens de téléportation fonctionnent
assert.ok(g.teleportVillage(alice, 0, 0).ok, 'téléportation vers la capitale');
assert.deepStrictEqual(alice.pos, { x: 0, y: 0 }, 'arrivée à la capitale');
assert.ok(g.teleportVillage(alice, village.x, village.y).ok, 'village découvert : téléportation autorisée');
alice.pos = { x: 0, y: 0 };
console.log('Villages : découverte à pied ✔, téléporteur conditionné ✔');

// --- Nommage harmonisé des ressources ---
const { resourceLabel } = require('../js/config.js');
assert.strictEqual(resourceLabel('PLANTE', 1), 'Menthe T1');
assert.strictEqual(resourceLabel('MINERAI', 4), 'Minerai d’or T4');
assert.strictEqual(resourceLabel('INGREDIENT', 3), 'Racine noueuse T3');
assert.strictEqual(resourceLabel('BOIS_ANCIEN', 6), 'Bois ancien T6');

// --- Combat probabiliste : mort en défaite, Sève %, Rempart ---
// Bots éloignés + rng injecté pour des scénarios déterministes
for (const b of g.bots.values()) { b.pos = { x: -45, y: -45 }; b.home = b.pos; }
let boss = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'monster' && t.content.tier === 5 &&
      Math.max(Math.abs(t.x + 45), Math.abs(t.y + 45)) > 12) { boss = t; break; }
}

// 1) Défaite forcée (jet 1, sous n'importe quel seuil) : MORT, retour Capitale, or intact
alice.pos = { x: boss.x - 1, y: boss.y };
bob.pos = { x: boss.x + 1, y: boss.y };
alice.pa = 50; bob.pa = 50;
alice.hp = 100; bob.hp = 100;
const goldBeforeDeath = alice.gold;
sent.length = 0;
g.rng = () => 0;
assert.ok(g.createRaid(alice, boss.x, boss.y).ok, 'lobby T5 créé');
assert.ok(g.joinRaid(bob, boss.x + ',' + boss.y).ok, 'Bob rejoint le T5');
assert.ok(g.startRaidNow(alice, boss.x + ',' + boss.y).ok);
g.tick(300);
let res = sent.filter((m) => m.ev === 'result').map((m) => m.data);
assert.strictEqual(res.length, 2, 'résultats envoyés');
assert.ok(!res[0].victory && res[0].died, 'défaite = mort');
assert.ok(typeof res[0].chance === 'number' && res[0].chance > 0, '% de victoire dans le rapport');
assert.deepStrictEqual(alice.pos, { x: 0, y: 0 }, 'mort → rapatriement Capitale');
assert.strictEqual(alice.mapId, 'world', 'mort → carte monde');
assert.strictEqual(alice.hp, Math.ceil(maxHp(alice) * reviveHpPct([alice, bob])), 'réveil (Sève de Bob incluse)');
assert.strictEqual(alice.gold, goldBeforeDeath, 'aucune perte d’or à la mort');

// 2) Victoire forcée (jet 100, au-dessus de n'importe quel seuil) : Rempart d'équipe + Sève en % des PV max
let rr = g.register({ username: 'Cara', password: 'secret3', speciesClass: 'OURS_GUERRIER', email: 'cara@test.dev' });
assert.ok(rr.ok, 'troisième compte');
const cara = rr.player;
skipQuestsFor(cara);
cara.online = true;
alice.pos = { x: boss.x - 1, y: boss.y };
bob.pos = { x: boss.x + 1, y: boss.y };
cara.pos = { x: boss.x, y: boss.y + 1 };
cara.pa = 50; alice.pa = 50; bob.pa = 50;
alice.hp = 50; bob.hp = 50; cara.hp = 50;
sent.length = 0;
g.rng = () => 0.999;
assert.ok(g.createRaid(alice, boss.x, boss.y).ok, 'second lobby T5');
assert.ok(g.joinRaid(bob, boss.x + ',' + boss.y).ok);
assert.ok(g.joinRaid(cara, boss.x + ',' + boss.y).ok);
assert.ok(g.startRaidNow(alice, boss.x + ',' + boss.y).ok);
g.tick(300);
res = sent.filter((m) => m.ev === 'result').map((m) => m.data);
assert.strictEqual(res.length, 3, 'résultats envoyés aux trois');
assert.ok(res[0].victory, 'victoire forcée');
// Jet 100 == marge maximale → multiplicateur de marge au plancher
// (HP_LOSS_MARGIN_MIN = 0.4), Rempart réduit encore de 30 % :
// 19 × 0.4 × 0.7 = 5.32 → 5.
assert.strictEqual(res[0].hpLoss, 5, 'Rempart + marge maximale : usure réduite (19 → 5)');
const aliceHeal = Math.round(maxHp(alice) * CONFIG.COMBAT.DRUID_HEAL_PCT);
const caraHeal = Math.round(maxHp(cara) * CONFIG.COMBAT.DRUID_HEAL_PCT);
assert.strictEqual(alice.hp, 50 - 5 + aliceHeal, 'Sève : +15 % des PV max après victoire');
assert.strictEqual(cara.hp, 50 - 5 + caraHeal, 'Rempart + Sève profitent aussi à l’Ours');

// 3) Victoire mortelle (rng toujours à 0.999, sans Bob/Sève) : une usure
// trop lourde tue malgré la victoire — plus de plancher à 1 PV. Perte
// attendue (marge maximale, Rempart actif via Cara) : 5 PV (voir plus haut) —
// PV d'Alice fixés en dessous pour rester létaux même avec la perte réduite.
boss.content.inactiveUntil = 0;
alice.pos = { x: boss.x - 1, y: boss.y };
cara.pos = { x: boss.x + 1, y: boss.y };
alice.pa = 50; cara.pa = 50;
alice.hp = 4; cara.hp = 100;
const goldBeforeLethalVictory = alice.gold;
sent.length = 0;
assert.ok(g.createRaid(alice, boss.x, boss.y).ok, 'troisième lobby T5 (sans Bob)');
assert.ok(g.joinRaid(cara, boss.x + ',' + boss.y).ok);
assert.ok(g.startRaidNow(alice, boss.x + ',' + boss.y).ok);
g.tick(300);
res = sent.filter((m) => m.ev === 'result').map((m) => m.data);
assert.strictEqual(res.length, 2, 'résultats envoyés aux deux (victoire mortelle)');
assert.ok(res[0].victory, 'combat gagné malgré la mort d’Alice');
assert.ok(res[0].died, 'victoire trop coûteuse en PV = mort (plus de plancher à 1 PV)');
assert.strictEqual(alice.hp, Math.ceil(maxHp(alice) * reviveHpPct([alice, cara])), 'réveil (Rempart de Cara inclus) malgré la victoire');
assert.deepStrictEqual(alice.pos, { x: 0, y: 0 }, 'victoire mortelle → rapatriement Capitale');
assert.strictEqual(alice.mapId, 'world', 'victoire mortelle → carte monde');
assert.ok(alice.gold > goldBeforeLethalVictory, 'le butin reste acquis malgré une victoire mortelle');
assert.ok(!res[1].died, 'Cara (PV hauts) survit à la même victoire');

// 4) La Sève peut sauver d'une blessure autrement fatale (avec Bob)
boss.content.inactiveUntil = 0;
alice.pos = { x: boss.x - 1, y: boss.y };
bob.pos = { x: boss.x + 1, y: boss.y };
alice.pa = 50; bob.pa = 50;
alice.hp = 5; bob.hp = 100;
sent.length = 0;
assert.ok(g.createRaid(alice, boss.x, boss.y).ok, 'quatrième lobby T5 (avec Bob)');
assert.ok(g.joinRaid(bob, boss.x + ',' + boss.y).ok);
assert.ok(g.startRaidNow(alice, boss.x + ',' + boss.y).ok);
g.tick(300);
res = sent.filter((m) => m.ev === 'result').map((m) => m.data);
assert.strictEqual(res.length, 2, 'résultats envoyés aux deux (Sève sauve)');
assert.ok(res[0].victory && !res[0].died, 'Sève évite la mort malgré une blessure autrement fatale');
assert.ok(alice.hp > 0, 'Alice survit grâce à la Sève');
g.rng = Math.random;
console.log('Combat : mort en défaite ✔, Sève % ✔, Rempart ✔, victoire mortelle ✔, Sève sauve d’une blessure fatale ✔');

// --- Usure proportionnelle à la marge du jet (pas un montant fixe par tier) ---
// Même joueur, même monstre : un jet tout juste au seuil (marge nulle, la
// victoire la plus juste possible) doit coûter le maximum de PV, un jet à
// 100 (marge maximale) le minimum — vérifié en forçant les deux jets plutôt
// que de supposer la formule correcte.
{
  let t1mob = null;
  for (const t of g.tiles.values()) {
    if (t.content && t.content.kind === 'monster' && t.content.tier === 1) { t1mob = t; break; }
  }
  const soloThreshold = winThreshold(winChance(teamPowerOf([alice]), t1mob.content.force));

  alice.pos = { x: t1mob.x - 1, y: t1mob.y };
  alice.pa = 50; alice.hp = maxHp(alice);
  sent.length = 0;
  g.rng = () => Math.max(0, (soloThreshold - 1) / 100);   // jet == seuil (marge nulle)
  assert.ok(g.createRaid(alice, t1mob.x, t1mob.y).ok, 'lobby T1 (marge nulle)');
  assert.ok(g.startRaidNow(alice, tileKeyOf(t1mob)).ok);
  g.tick(300);
  const narrowResult = sent.filter((m) => m.ev === 'result')[0].data;
  assert.ok(narrowResult.victory, 'jet == seuil reste une victoire');
  const narrowLoss = narrowResult.hpLoss;

  t1mob.content.inactiveUntil = 0;
  alice.pos = { x: t1mob.x - 1, y: t1mob.y };
  alice.pa = 50; alice.hp = maxHp(alice);
  sent.length = 0;
  g.rng = () => 0.999;   // jet 100 (marge maximale)
  assert.ok(g.createRaid(alice, t1mob.x, t1mob.y).ok, 'lobby T1 (marge maximale)');
  assert.ok(g.startRaidNow(alice, tileKeyOf(t1mob)).ok);
  g.tick(300);
  const wideLoss = sent.filter((m) => m.ev === 'result')[0].data.hpLoss;

  assert.ok(narrowLoss > wideLoss,
    'une victoire arrachée (marge nulle, ' + narrowLoss + ' PV) coûte plus qu’une victoire écrasante (marge maximale, ' + wideLoss + ' PV)');
  g.rng = Math.random;
  console.log('Usure de victoire proportionnelle à la marge du jet : ' + narrowLoss + ' PV de justesse vs ' + wideLoss + ' PV en écrasant ✔');
}

// --- Ancres de la courbe de probabilité ---
assert.ok(Math.abs(winChance(26, 26) - 0.71) < 0.02, 'parité (T0 vs T1) ≈ 70 %');
assert.strictEqual(winChance(10, 100), CONFIG.COMBAT.MIN_CHANCE, 'plancher à 2 %');
assert.strictEqual(winChance(300, 100), CONFIG.COMBAT.MAX_CHANCE, 'plafond à 98 %');
// Blessé, on est plus faible : la même équipe voit ses chances baisser
const fullHp = { speciesClass: 'LION_PALADIN', weapon: { tier: 1 }, armor: { tier: 1 }, weaponMastery: 2, hp: 100 };
const wounded = { ...fullHp, hp: 30 };
assert.ok(combatPower(wounded) < combatPower(fullHp) * 0.7, 'les PV entament la puissance');
assert.ok(
  winChance(teamPowerOf([wounded]), MONSTER_FORCE[1]) < winChance(teamPowerOf([fullHp]), MONSTER_FORCE[1]),
  'blessé → % de victoire plus faible'
);
// Donjons T6 : squelette ≈ 3 joueurs T5, boss ≈ 5 joueurs T5 —
// et l'équipement T6 allège d'une personne.
const t5p = (cls) => { const p = { speciesClass: cls || 'RENARD_VOLEUR', weapon: { tier: 5 }, armor: { tier: 5 }, weaponMastery: 5 }; p.hp = maxHp(p); return p; };
const t6p = (cls) => { const p = { speciesClass: cls || 'RENARD_VOLEUR', weapon: { tier: 6 }, armor: { tier: 6 }, weaponMastery: 5 }; p.hp = maxHp(p); return p; };
const team = (n, mk) => Array.from({ length: n }, () => mk());
const BOSS_FORCE = 680;

assert.strictEqual(winChance(teamPowerOf(team(1, t5p)), MONSTER_FORCE[6]), CONFIG.COMBAT.MIN_CHANCE, 'squelette T6 insoloable (2 %)');
assert.ok(winChance(teamPowerOf(team(2, t5p)), MONSTER_FORCE[6]) < 0.4, 'squelette : duo T5 dissuasif');
assert.ok(winChance(teamPowerOf(team(3, t5p)), MONSTER_FORCE[6]) > 0.85, 'squelette : trio T5 confortable');
assert.ok(winChance(teamPowerOf(team(2, t6p)), MONSTER_FORCE[6]) > 0.45, 'squelette : duo T6 tentable');

assert.ok(winChance(teamPowerOf(team(4, t5p)), BOSS_FORCE) < 0.7, 'boss : 4 joueurs T5 risqué');
assert.ok(winChance(teamPowerOf(team(5, t5p)), BOSS_FORCE) > 0.85, 'boss : 5 joueurs T5 confortable');
assert.ok(winChance(teamPowerOf(team(4, t6p)), BOSS_FORCE) > 0.75, 'boss : 4 joueurs T6 suffisent');
console.log('Donjons : squelette 3×T5 ✔ (duo T6 tentable), boss 5×T5 ✔ (4×T6 suffisent)');
console.log('Courbe de probabilité : parité ~70 %, bornes 2/98 %, PV influents ✔');

// --- Génération de donjon : aucune salle inaccessible (îlot sans chemin) ---
// Régression : les salles bonus (boucle des 7 couloirs aléatoires + la salle
// du bas) n'étaient reliées à rien d'autre qu'elles-mêmes, laissant des
// salles entières hors d'atteinte à pied (voir generateDungeonMap).
const { generateDungeonMap: genDungeonForTest } = require('../js/world.js');
function reachableFloorCount(map) {
  const floors = [];
  for (const t of map.tiles.values()) { if (!t.blocked) floors.push(t.x + ',' + t.y); }
  const floorSet = new Set(floors);
  const visited = new Set(['0,0']);
  const stack = ['0,0'];
  while (stack.length) {
    const [x, y] = stack.pop().split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nk = (x + dx) + ',' + (y + dy);
      if (floorSet.has(nk) && !visited.has(nk)) { visited.add(nk); stack.push(nk); }
    }
  }
  return { total: floors.length, reachable: visited.size };
}
for (const terrain of ['FORET', 'PLAINE', 'MONTAGNE', 'MARECAGE']) {
  for (const [wx, wy] of [[0, 0], [7, -13], [-20, 25], [33, 5]]) {
    const map = genDungeonForTest(CONFIG.WORLD.SEED, terrain, 'donjontest_' + terrain + '_' + wx + '_' + wy, wx, wy);
    const { total, reachable } = reachableFloorCount(map);
    assert.strictEqual(reachable, total,
      'donjon ' + terrain + ' (' + wx + ',' + wy + ') : toutes les salles accessibles depuis l’entrée (' + reachable + '/' + total + ')');
  }
}
console.log('Génération de donjon : aucune salle inaccessible (toutes reliées à l’entrée) ✔');

// --- Personnages multiples : création, métamorphose, partages ---
assert.strictEqual(alice.characters.length, 1, 'un personnage à l’inscription');
assert.strictEqual(alice.charSlots, 2, 'deux emplacements gratuits');

// Création : refusée hors sanctuaire, acceptée à la Capitale
alice.pos = { x: boss.x - 1, y: boss.y };
assert.ok(!g.createCharacter(alice, 'CERF_DRUIDE').ok, 'éveil refusé en pleine nature');
alice.pos = { x: 0, y: 0 };
assert.ok(!g.createCharacter(alice, 'LION_PALADIN').ok, 'doublon de classe refusé');
assert.ok(g.createCharacter(alice, 'CERF_DRUIDE').ok, 'éveil du Cerf Druide à la Capitale');
assert.strictEqual(alice.characters.length, 2);
bob.pos = { x: 0, y: 0 };
assert.ok(!g.createCharacter(bob, 'SERAPHIN_ROYAL').ok, 'classe admin-only refusée à un joueur normal');
assert.ok(!g.createCharacter(alice, 'CHAT_MAGICIEN').ok, 'troisième forme refusée (slots pleins)');

// Métamorphose : PV en pourcentage, maîtrises et équipement séparés,
// inventaire et PA partagés
alice.armor.tier = 2;
alice.hp = 70;                                           // PV arbitraires avant métamorphose
const lionPct = alice.hp / maxHp(alice);                 // % des PV max du Lion à cet instant
const paBefore = alice.pa;
const invBefore = JSON.stringify(alice.inventory);
const lionMastery = alice.weaponMastery;
assert.ok(g.switchCharacter(alice, 1).ok, 'métamorphose à la Capitale');
assert.strictEqual(alice.speciesClass, 'CERF_DRUIDE', 'forme active changée');
assert.strictEqual(alice.hp, Math.max(1, Math.round(lionPct * maxHp(alice))),
  'PV recalculés au même pourcentage dans le nouveau socle (Cerf Druide, armure T0)');
assert.strictEqual(alice.weaponMastery, 1, 'maîtrise propre à la nouvelle forme');
assert.strictEqual(alice.weapon.tier, 0, 'équipement propre à la nouvelle forme');
assert.strictEqual(alice.pa, paBefore, 'PA partagés (inchangés)');
assert.strictEqual(JSON.stringify(alice.inventory), invBefore, 'inventaire partagé (inchangé)');
assert.strictEqual(alice.characters[0].weaponMastery, lionMastery, 'la forme Lion garde sa maîtrise');

// Hors sanctuaire : métamorphose refusée
alice.pos = { x: boss.x - 1, y: boss.y };
assert.ok(!g.switchCharacter(alice, 0).ok, 'métamorphose refusée en pleine nature');
alice.pos = { x: 0, y: 0 };
assert.ok(g.switchCharacter(alice, 0).ok, 'retour à la forme Lion');
assert.strictEqual(alice.weaponMastery, lionMastery, 'maîtrise du Lion restaurée');
assert.strictEqual(alice.armor.tier, 2, 'équipement du Lion restauré');
console.log('Multi-personnages : sanctuaires ✔, PV % ✔, partages ✔');

// --- Cuisine : Marmite (sanctuaire), buffs, potion, drop d'ingrédient ---
alice.gold = 100;
alice.inventory.INGREDIENT_1 = 2;
alice.inventory.PLANTE_1 = 2;

alice.pos = { x: boss.x - 1, y: boss.y };
assert.ok(!g.cook(alice, 'RAGOUT', 1).ok, 'Marmite refusée hors sanctuaire');
alice.pos = { x: 0, y: 0 };
const goldBeforeCook = alice.gold;
assert.ok(g.cook(alice, 'RAGOUT', 1).ok, 'Ragoût T1 cuisiné à la Capitale');
assert.strictEqual(alice.inventory.RAGOUT_1, 1, 'consommable en inventaire');
assert.ok(!alice.inventory.INGREDIENT_1, 'ingrédients consommés');
assert.strictEqual(alice.gold, goldBeforeCook - 5, 'or de la recette débité');

alice.hp = maxHp(alice);
const powerBefore = combatPower(alice);
assert.ok(g.consume(alice, 'RAGOUT_1').ok, 'Ragoût bu');
assert.ok(alice.buff && alice.buff.type === 'RAGOUT' && alice.buff.combats === BUFF_COMBATS, 'buff actif 3 combats');
assert.ok(combatPower(alice) > powerBefore, 'puissance dopée par le Ragoût (+5 %)');
assert.ok(!alice.inventory.RAGOUT_1, 'consommable consommé');

alice.inventory.POTION_SEVE_1 = 1;
alice.hp = 40;
assert.ok(g.consume(alice, 'POTION_SEVE_1').ok, 'potion bue');
assert.strictEqual(alice.hp, 40 + Math.round(maxHp(alice) * 0.20), 'Potion de sève : +20 % des PV max');
assert.ok(alice.buff && alice.buff.type === 'RAGOUT', 'la potion ne remplace pas le buff');

// Combat : le buff se consume, et le monstre lâche un ingrédient (rng forcé)
let mob = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'monster' && t.content.tier <= 2 &&
      t.content.inactiveUntil <= g.now &&
      Math.max(Math.abs(t.x + 45), Math.abs(t.y + 45)) > 12) { mob = t; break; }
}
alice.pos = { x: mob.x - 1, y: mob.y };
alice.pa = 50;
alice.hp = maxHp(alice);
sent.length = 0;
g.rng = rngSequence(0.999, 0, 0);   // jet de victoire (100) puis tirage du lanceur/drop garantis (0)
assert.ok(g.createRaid(alice, mob.x, mob.y).ok, 'raid cuisine');
assert.ok(g.startRaidNow(alice, mob.x + ',' + mob.y).ok);
g.tick(300);
g.rng = Math.random;
const foodKey = 'INGREDIENT_' + mob.content.tier;
res = sent.filter((m) => m.ev === 'result').map((m) => m.data);
assert.strictEqual(res[0].food, foodKey, 'trouvaille dans le rapport');
assert.ok(alice.inventory[foodKey] >= 1, 'ingrédient looté sur le monstre');
assert.strictEqual(alice.buff.combats, BUFF_COMBATS - 1, 'le buff se consume à chaque combat');
console.log('Cuisine : Marmite ✔, buffs ✔, potion ✔, drop d’ingrédient ✔');

// --- Rôles : le tout premier compte devient admin, les suivants sont user ---
assert.strictEqual(alice.role, 'admin', 'premier compte inscrit = admin');
assert.strictEqual(bob.role, 'user', 'compte suivant = user par défaut');

const rCarl = g.register({ username: 'Carl', password: 'secret3', speciesClass: 'RENARD_VOLEUR', email: 'carl@test.dev' });
assert.ok(rCarl.ok, 'troisième compte');
const carl = rCarl.player;
skipQuestsFor(carl);
assert.strictEqual(carl.role, 'user', 'troisième compte = user');
assert.strictEqual(carl.online, false, 'Carl reste hors ligne pour la suite de ces tests');

// --- Les outils de triche self-service sont désormais réservés au rôle admin ---
assert.ok(!g.setAdminTier(bob, 'harvest', 5).ok, 'un non-admin ne peut pas s’auto-attribuer un niveau');
assert.ok(!g.setAdminGear(bob, 'weapon', 3).ok, 'un non-admin ne peut pas s’auto-attribuer un équipement');
assert.ok(!g.dev(bob, { pa: 50 }).ok, 'un non-admin n’a pas accès au panneau DEV');
assert.ok(g.setAdminTier(alice, 'harvest', alice.harvestLevel).ok, 'un admin garde l’accès aux outils de triche');

// --- Dashboard admin : gestion de n’importe quel compte, même hors ligne ---
assert.strictEqual(g.adminFindTarget('cArL'), carl, 'recherche de compte insensible à la casse');
assert.strictEqual(g.adminFindTarget('personne'), null, 'compte inconnu → null');

assert.ok(!g.adminGrantGold(bob, 'Carl', 100).ok, 'un non-admin ne peut pas administrer un autre compte');

const goldBefore = carl.gold || 0;
assert.ok(g.adminGrantGold(alice, 'Carl', 250).ok, 'admin : don d’or');
assert.strictEqual(carl.gold, goldBefore + 250, 'or crédité sur le compte cible');

assert.ok(g.adminGrantItem(alice, 'Carl', 'BOIS_3', 5).ok, 'admin : don de ressource');
assert.strictEqual(carl.inventory.BOIS_3, 5, 'ressource ajoutée à l’inventaire cible');
assert.ok(!g.adminGrantItem(alice, 'Carl', 'INCONNU_1', 1).ok, 'objet inconnu refusé');

assert.ok(g.adminSetLevel(alice, 'Carl', 'harvest', 4).ok, 'admin : niveau de récolte fixé');
assert.strictEqual(carl.harvestLevel, 4, 'niveau de récolte cible mis à jour');

assert.ok(g.adminSetGear(alice, 'Carl', 'weapon', 3).ok, 'admin : tier d’arme fixé');
assert.strictEqual(carl.weapon.tier, 3, 'tier d’arme cible mis à jour');

const slotsBefore = carl.charSlots;
assert.ok(g.adminGrantSlot(alice, 'Carl', 1).ok, 'admin : emplacement de personnage offert');
assert.strictEqual(carl.charSlots, slotsBefore + 1, 'emplacement supplémentaire accordé');

// --- Les emplacements de personnage ne peuvent pas dépasser le nombre de classes ---
assert.strictEqual(MAX_CHAR_SLOTS, Object.keys(CLASSES).length, 'plafond = une classe par forme');
assert.ok(g.adminGrantSlot(alice, 'Carl', 999).ok, 'don massif accepté mais plafonné');
assert.strictEqual(carl.charSlots, MAX_CHAR_SLOTS, 'emplacements plafonnés au nombre de classes');
assert.ok(!g.adminGrantSlot(alice, 'Carl', 1).ok, 'don refusé une fois le plafond atteint');

assert.ok(g.adminSetRole(alice, 'Carl', 'admin').ok, 'admin : promotion');
assert.strictEqual(carl.role, 'admin', 'compte cible promu admin');
carl.pos = { x: 0, y: 0 };
assert.ok(g.createCharacter(carl, 'SERAPHIN_ROYAL').ok, 'admin : classe divine accessible');
assert.ok(carl.characters.some((c) => c.speciesClass === 'SERAPHIN_ROYAL'), 'la forme Séraphin Royal est bien ajoutée');
assert.strictEqual(CLASSES.SERAPHIN_ROYAL.baseHp, 99999, 'PV de base divins configurés');
assert.strictEqual(playerForce({ speciesClass: 'SERAPHIN_ROYAL', weapon: { tier: 0 }, weaponMastery: 1 }), 99999, 'force de départ divine exacte');
assert.ok(g.adminSetRole(alice, 'Carl', 'user').ok, 'admin : rétrogradation');
assert.strictEqual(carl.role, 'user', 'compte cible rétrogradé');
assert.ok(!g.adminSetRole(alice, 'Carl', 'superadmin').ok, 'rôle invalide refusé');

const stats = g.adminStats();
assert.ok(stats.total >= 3 && stats.admins >= 1, 'stats globales cohérentes');
const carlRow = g.adminPlayerList().find((row) => row.username === 'Carl');
assert.ok(carlRow && carlRow.gold === carl.gold && carlRow.role === 'user', 'liste des comptes à jour');
console.log('Administration : rôles ✔, triche gatée ✔, dashboard ✔');

// --- Admin : réveil forcé du boss mondial ---
// Endormi explicitement avant le test : l'horloge RÉELLE (Date.now(), voir
// tick()) l'aurait sinon déjà réveillé de lui-même à ce stade du fichier.
g.worldBossAlive = false;
assert.ok(!g.adminSpawnWorldBoss(bob).ok, 'un non-admin ne peut pas réveiller le boss mondial');
assert.ok(g.adminSpawnWorldBoss(alice).ok, 'admin : réveil forcé du boss mondial');
assert.strictEqual(g.worldBossAlive, true, 'boss mondial réveillé');
assert.ok(!g.adminSpawnWorldBoss(alice).ok, 'refus si déjà réveillé');
g.worldBossAlive = false;
console.log('Admin : réveil forcé du boss mondial ✔');

// --- Admin : rejoindre n'importe quel joueur connecté ---
alice.mapId = 'world'; alice.pos = { x: 0, y: 0 };
bob.online = true; bob.mapId = 'world'; bob.pos = { x: -6, y: 3 };
assert.ok(!g.adminJoinPlayer(bob, 'Bob').ok, 'un non-admin ne peut pas utiliser rejoindre-joueur');
assert.ok(!g.adminJoinPlayer(alice, 'Alice').ok, 'impossible de se rejoindre soi-même');
assert.ok(!g.adminJoinPlayer(alice, 'Personne').ok, 'joueur inconnu refusé');
bob.online = false;
assert.ok(!g.adminJoinPlayer(alice, 'Bob').ok, 'rejoindre un joueur hors ligne refusé');
bob.online = true;
const expectedAdminJoinPos = g.nearestWalkablePos(g.worldMap, bob.pos);
assert.ok(g.adminJoinPlayer(alice, 'Bob').ok, 'admin : rejoindre un joueur en ligne accepté');
assert.deepStrictEqual(alice.pos, expectedAdminJoinPos, 'téléportation sur la position du joueur rejoint');
assert.strictEqual(alice.mapId, 'world', 'arrivée sur la carte du monde');
bob.online = false;
alice.pos = { x: 0, y: 0 };
console.log('Admin : rejoindre n’importe quel joueur connecté ✔');

// --- Admin : suppression de compte (nettoyage guilde/jeton, jamais son propre compte) ---
const rDave = g.register({ username: 'Dave', password: 'secret4', speciesClass: 'CHAT_MAGICIEN', email: 'dave@test.dev' });
assert.ok(rDave.ok, 'compte jetable pour le test de suppression');
const dave = rDave.player;
skipQuestsFor(dave);
const rEve = g.register({ username: 'Eve', password: 'secret5', speciesClass: 'CORBEAU_NECROMANCIEN', email: 'eve@test.dev' });
const eve = rEve.player;
skipQuestsFor(eve);
assert.ok(g.createGuild(dave, 'Éphémères').ok, 'Dave fonde une guilde jetable');
const daveGuildId = dave.guildId;
assert.ok(g.inviteToGuild(dave, 'Eve').ok && g.respondGuildInvite(eve, true).ok, 'Eve rejoint la guilde de Dave');
assert.strictEqual(g.guilds.get(daveGuildId).leaderId, dave.id, 'Dave est bien le chef');
assert.ok(g.sendFriendRequest(eve, 'Dave').ok && g.respondFriendRequest(dave, eve.id, true).ok, 'Eve et Dave amis (référence pendante à vérifier après suppression)');

let deletedAccountId = null;
g.onAccountDeleted = (id) => { deletedAccountId = id; };
assert.ok(!g.adminDeleteAccount(bob, 'Dave').ok, 'un non-admin ne peut pas supprimer un compte');
assert.ok(!g.adminDeleteAccount(alice, 'Personne').ok, 'suppression d’un compte inconnu refusée');
assert.ok(!g.adminDeleteAccount(alice, 'Alice').ok, 'un admin ne peut pas supprimer son propre compte');

const daveId = dave.id;
assert.ok(g.adminDeleteAccount(alice, 'Dave').ok, 'admin : suppression de compte acceptée');
assert.strictEqual(deletedAccountId, daveId, 'le hook onAccountDeleted reçoit le bon identifiant (persistance déléguée à index.js)');
assert.ok(!g.players.has(daveId), 'compte retiré de la partie en mémoire');
assert.strictEqual(g.adminFindTarget('Dave'), null, 'compte introuvable après suppression');
assert.strictEqual(g.guilds.get(daveGuildId).leaderId, eve.id, 'le chef restant hérite de la guilde (leaveGuild réutilisé)');
assert.deepStrictEqual(g.friendsList(eve), [], 'aucune référence pendante ne fait planter la liste d’amis d’un tiers');
assert.ok(!g.adminDeleteAccount(alice, 'Dave').ok, 'suppression d’un compte déjà supprimé refusée');
g.onAccountDeleted = () => {};
console.log('Admin : suppression de compte ✔ (nettoyage guilde, jamais son propre compte)');

// --- Duels amicaux : aucune perte de PV ni d'or, seul le palmarès évolue ---
bob.pos = { x: 5, y: 5 }; bob.mapId = 'world'; bob.status = 'IDLE';
carl.pos = { x: 50, y: 50 }; carl.mapId = 'world'; carl.status = 'IDLE';   // trop loin
assert.ok(!g.requestDuel(bob, carl.id).ok, 'duel refusé hors de portée');

carl.pos = { x: 6, y: 5 };   // adjacent à Bob
assert.ok(!g.requestDuel(bob, bob.id).ok, 'impossible de se défier soi-même');
assert.ok(!g.requestDuel(bob, 'bot0').ok, 'impossible de défier un bot');

sent.length = 0;
assert.ok(g.requestDuel(bob, carl.id).ok, 'défi envoyé');
const duelInvites = sent.filter((m) => m.ev === 'duelInvite');
assert.strictEqual(duelInvites.length, 1, 'invitation reçue');
assert.strictEqual(duelInvites[0].id, carl.id, 'invitation adressée à Carl');
// L'invitation embarque la chance vue par l'INVITÉ(E) (Carl), pour afficher
// le jet nécessaire avant même d'accepter ou de refuser (voir showDuelInvite).
assert.strictEqual(typeof duelInvites[0].data.yourChance, 'number', 'invitation : chance de l’invité(e) incluse');
assert.ok(Math.abs(duelInvites[0].data.yourChance + duelInvites[0].data.opponentChance - 1) < 1e-9,
  'invitation : chances complémentaires (invité(e) + adversaire = 1)');

// --- Aperçu AVANT l'envoi d'un défi (duelPreview, lecture seule) ---
// Une invitation réelle (bob → carl, ci-dessus) est déjà en attente à ce
// stade : on vérifie que duelPreview ne la modifie ni n'en ajoute d'autre,
// plutôt que de supposer duelInvites vide.
const duelInvitesSizeBefore = g.duelInvites.size;
const duelInviteForCarlBefore = g.duelInvites.get(carl.id);
const preview1 = g.duelPreview(bob, carl.id);
assert.ok(preview1.ok && preview1.opponent === 'Carl', 'aperçu de duel accepté, adversaire identifié');
assert.strictEqual(typeof preview1.yourChance, 'number', 'aperçu : chance du challenger incluse');
assert.ok(Math.abs(preview1.yourChance + preview1.opponentChance - 1) < 1e-9, 'aperçu : chances complémentaires');
// Cohérence croisée : la chance de Bob vue dans SON propre aperçu (avant
// envoi) doit être EXACTEMENT celle que Carl voit comme « chance adverse »
// dans l'invitation déjà reçue — pas juste chacune complémentaire en
// interne. winChance() n'étant pas garantie symétrique (winChance(A,B) ≠
// 1 − winChance(B,A) en général), un bug déjà rencontré ici faisait que
// requestDuel recalculait la chance de l'invité(e) via un second appel à
// winChance() aux arguments inversés au lieu de réutiliser le complément
// de la chance du challenger — les deux popups affichaient alors des jets
// nécessaires incohérents pour le même duel.
assert.ok(Math.abs(preview1.yourChance - duelInvites[0].data.opponentChance) < 1e-9,
  'cohérence : chance du challenger (aperçu) === chance adverse vue par l’invité(e) (invitation)');
assert.ok(!g.duelPreview(bob, bob.id).ok, 'aperçu refusé : impossible de se prévisualiser soi-même');
assert.ok(!g.duelPreview(bob, 'bot0').ok, 'aperçu refusé : impossible de prévisualiser un défi à un bot');
assert.ok(!g.duelPreview(bob, 'p_personne').ok, 'aperçu refusé : joueur introuvable');
assert.strictEqual(g.duelInvites.size, duelInvitesSizeBefore, 'duelPreview ne crée aucune invitation (lecture seule)');
assert.deepStrictEqual(g.duelInvites.get(carl.id), duelInviteForCarlBefore, 'duelPreview laisse l’invitation existante intacte');

// Indépendance vis-à-vis de qui défie qui : winChance() n'étant pas garantie
// symétrique par inversion (winChance(A,B) ≠ 1 − winChance(B,A) en général —
// sigmoïde du ratio brut des puissances, pas de son logarithme), un calcul
// naïf ferait dépendre l'issue réelle du MÊME duel (Bob 25 contre Carl X)
// de qui clique sur « Défier » en premier. duelChanceOf() fige un ordre
// stable : la chance de Bob contre Carl doit être identique, que ce soit
// Bob qui prévisualise un défi à Carl, ou Carl qui prévisualise un défi à
// Bob (aperçu symétrique, pas juste complémentaire en interne).
const previewBobToCarl = g.duelPreview(bob, carl.id);
const previewCarlToBob = g.duelPreview(carl, bob.id);
assert.ok(Math.abs(previewBobToCarl.yourChance - previewCarlToBob.opponentChance) < 1e-9,
  'la chance de Bob contre Carl ne dépend pas de qui initie le duel');
assert.ok(Math.abs(previewCarlToBob.yourChance - previewBobToCarl.opponentChance) < 1e-9,
  'la chance de Carl contre Bob ne dépend pas de qui initie le duel');

// Refus : pas de résolution, aucun résultat envoyé
sent.length = 0;
assert.ok(g.respondDuelInvite(carl, bob.id, false).ok, 'refus du duel');
assert.strictEqual(sent.filter((m) => m.ev === 'duelResult').length, 0, 'aucun duel résolu après refus');

// Acceptation : résolution immédiate, amicale (aucun enjeu)
const bobGoldBefore = bob.gold, carlGoldBefore = carl.gold;
const bobHpBefore = bob.hp, carlHpBefore = carl.hp;
const bobWinsBefore = bob.duels.wins, carlLossesBefore = carl.duels.losses;
sent.length = 0;
assert.ok(g.requestDuel(bob, carl.id).ok, 'second défi envoyé');
// Bob équipe un dé cosmétique avant la résolution : comme Bob est le lanceur
// désigné ci-dessous (rng forcé), les DEUX duellistes doivent voir SON dé —
// pas le leur propre — pour que l'habillage donne envie à l'adversaire aussi.
bob.ownedDice = [DICE_SKIN_ITEMS[0].id];
bob.diceId = DICE_SKIN_ITEMS[0].id;
// resolveDuel tire désormais UN SEUL jet partagé (issue collective, comme un
// raid/siège — voir Game.resolveDuel) plutôt qu'un jet indépendant par
// duelliste : deux dés indépendants faussaient le pourcentage annoncé (la
// comparaison par marge favorisait le favori bien plus que la chance
// affichée ne le laissait supposer). rng() est consommé deux fois : le jet
// (forcé au maximum, 100) puis le tirage au sort du « lanceur de dé ».
g.rng = rngSequence(0.999, 0);   // jet 100 (Bob l'emporte à coup sûr), Bob tiré comme lanceur
assert.ok(g.respondDuelInvite(carl, bob.id, true).ok, 'duel accepté');
g.rng = Math.random;

const duelResults = sent.filter((m) => m.ev === 'duelResult');
assert.strictEqual(duelResults.length, 2, 'résultat envoyé aux deux duellistes');
const bobResult = duelResults.find((m) => m.id === bob.id).data;
const carlResult = duelResults.find((m) => m.id === carl.id).data;
assert.ok(bobResult.won && !carlResult.won, 'Bob remporte le duel forcé');
assert.strictEqual(bobResult.opponent, 'Carl', 'adversaire de Bob correctement identifié');
// Un seul jet réel (100, forcé), mais chaque duelliste voit son propre
// jet/seuil affiché en miroir (101 − jet / 102 − seuil pour Carl) plutôt que
// le même jet brut des deux côtés — cohérent avec showSiegeResult qui fait
// déjà ce miroir côté client pour l'attaquant/défenseur d'un siège.
assert.strictEqual(bobResult.roll, 100, 'jet forcé au maximum (vu par Bob)');
assert.strictEqual(bobResult.critical, 'success', 'jet 100 = réussite critique pour Bob');
assert.strictEqual(carlResult.roll, 1, 'jet miroir (101 − 100) vu par Carl');
assert.strictEqual(carlResult.critical, 'fail', 'jet 1 = échec critique pour Carl (miroir de la réussite de Bob)');
assert.strictEqual(carlResult.roll, 101 - bobResult.roll, 'jet de Carl = miroir exact du jet de Bob (101 − jet)');
assert.strictEqual(carlResult.threshold, 102 - bobResult.threshold, 'seuil de Carl = miroir exact du seuil de Bob (102 − seuil)');
assert.strictEqual(bobResult.rollerUsername, carlResult.rollerUsername, 'le même lanceur de dé est rapporté aux deux duellistes');
assert.ok(['Bob', 'Carl'].includes(bobResult.rollerUsername), 'le lanceur de dé est bien l’un des deux duellistes');
assert.strictEqual(bobResult.rollerUsername, 'Bob', 'Bob est le lanceur désigné (rng forcé)');
assert.strictEqual(bobResult.rollerDiceId, bob.diceId, 'Bob voit SON PROPRE dé (il est le lanceur)');
assert.strictEqual(carlResult.rollerDiceId, bob.diceId, 'Carl voit le dé de Bob (le lanceur), pas le sien (aucun équipé)');
assert.strictEqual(carlResult.opponent, 'Bob', 'adversaire de Carl correctement identifié');
assert.strictEqual(bob.duels.wins, bobWinsBefore + 1, 'victoire comptabilisée');
assert.strictEqual(carl.duels.losses, carlLossesBefore + 1, 'défaite comptabilisée');
// Le duel lui-même n'accorde aucun or — mais la première victoire débloque
// le haut fait « Gagner 1 duel », qui lui accorde une petite récompense.
const duelWin1Gold = (ACHIEVEMENTS.find((a) => a.id === 'duel_win_1') || {}).reward.gold || 0;
const bobDuelAchBonus = bob.unlockedAchievements.includes('duel_win_1') ? duelWin1Gold : 0;
assert.strictEqual(bob.gold, bobGoldBefore + bobDuelAchBonus, 'duel amical : aucun or de l’enjeu (hors haut fait)');
assert.strictEqual(carl.gold, carlGoldBefore, 'duel amical : aucun or gagné/perdu');
assert.strictEqual(bob.hp, bobHpBefore, 'duel amical : aucun PV perdu (vainqueur)');
assert.strictEqual(carl.hp, carlHpBefore, 'duel amical : aucun PV perdu (perdant)');
console.log('Duels : portée ✔, invitation/refus ✔, résolution amicale ✔ (palmarès, sans perte)');

// --- Guildes ---
assert.ok(g.createGuild(bob, 'Aigles').ok, 'création de guilde');
assert.ok(bob.guildId, 'le fondateur rejoint sa guilde');
assert.ok(!g.createGuild(bob, 'Corbeaux').ok, 'impossible de fonder une seconde guilde');
assert.ok(!g.createGuild(carl, 'ai').ok, 'nom de guilde trop court refusé');
assert.ok(!g.createGuild(carl, 'aigles').ok, 'nom de guilde déjà pris refusé (insensible à la casse)');

assert.ok(g.inviteToGuild(bob, 'Carl').ok, 'invitation envoyée par le chef');
assert.ok(carl.guildInvite && carl.guildInvite.guildName === 'Aigles', 'invitation reçue par Carl');
assert.ok(g.respondGuildInvite(carl, true).ok, 'invitation acceptée');
assert.strictEqual(carl.guildId, bob.guildId, 'Carl a rejoint la guilde de Bob');
assert.ok(!carl.guildInvite, 'invitation consommée après réponse');

assert.ok(!g.inviteToGuild(carl, 'Alice').ok, 'un simple membre ne peut pas inviter');

let info = g.guildInfo(bob);
assert.ok(info.ok && info.guild.members.length === 2, 'roster à jour (2 membres)');
assert.ok(info.guild.members.find((m) => m.username === 'Bob').isLeader, 'Bob repéré comme chef');

assert.ok(g.leaveGuild(carl).ok, 'Carl quitte la guilde');
assert.strictEqual(carl.guildId, null, 'Carl n’a plus de guilde');
assert.strictEqual(g.guilds.get(bob.guildId).members.length, 1, 'roster réduit à Bob seul');

assert.ok(g.inviteToGuild(bob, 'Carl').ok && g.respondGuildInvite(carl, true).ok, 'Carl rejoint à nouveau');
assert.ok(g.kickFromGuild(bob, 'Carl').ok, 'le chef exclut Carl');
assert.strictEqual(carl.guildId, null, 'Carl exclu de la guilde');
assert.ok(!g.kickFromGuild(bob, 'Carl').ok, 'exclure un non-membre échoue');

assert.ok(g.inviteToGuild(bob, 'Carl').ok && g.respondGuildInvite(carl, true).ok, 'Carl rejoint une troisième fois');
const guildId = bob.guildId;
assert.ok(g.leaveGuild(bob).ok, 'le chef quitte la guilde');
assert.strictEqual(g.guilds.get(guildId).leaderId, carl.id, 'le rôle de chef est transféré au dernier membre restant');
assert.ok(g.leaveGuild(carl).ok, 'dernier membre quitte à son tour');
assert.ok(!g.guilds.has(guildId), 'guilde dissoute une fois vide');
console.log('Guildes : création/invitation/rôles ✔, exclusion ✔, transfert de chef ✔, dissolution ✔');

// --- Amis ---
assert.ok(g.sendFriendRequest(alice, 'Bob').ok, 'demande d’ami envoyée');
assert.ok(bob.friendRequests.some((r) => r.fromId === alice.id), 'Bob reçoit la demande');
assert.ok(!g.sendFriendRequest(alice, 'Alice').ok, 'impossible de s’ajouter soi-même');
assert.ok(!g.sendFriendRequest(alice, 'Personne').ok, 'joueur inconnu refusé');

assert.ok(g.respondFriendRequest(bob, alice.id, true).ok, 'demande acceptée');
assert.ok(alice.friends.includes(bob.id) && bob.friends.includes(alice.id), 'amitié symétrique');
assert.ok(!g.sendFriendRequest(alice, 'Bob').ok, 'déjà amis : nouvelle demande refusée');

assert.ok(g.sendFriendRequest(carl, 'Alice').ok, 'Carl envoie une demande à Alice');
const reciprocal = g.sendFriendRequest(alice, 'Carl');
assert.ok(reciprocal.ok && reciprocal.addedDirectly, 'demande réciproque acceptée directement');
assert.ok(alice.friends.includes(carl.id) && carl.friends.includes(alice.id), 'Alice et Carl amis sans étape supplémentaire');
assert.strictEqual(alice.friendRequests.length, 0, 'la demande en attente est consommée par la réciprocité');

assert.ok(g.removeFriend(alice, 'Bob').ok, 'retrait d’ami');
assert.ok(!alice.friends.includes(bob.id) && !bob.friends.includes(alice.id), 'amitié rompue des deux côtés');
console.log('Amis : demandes ✔, symétrie ✔, réciprocité automatique ✔, retrait ✔');

// --- Localisation des amis + « Rejoindre » (Alice et Carl restent amis, voir plus haut) ---
carl.online = true;
carl.mapId = 'world';
carl.pos = { x: 5, y: -3 };
let friendsRes = g.friendsList(alice);
let carlEntry = friendsRes.find((f) => f.username === 'Carl');
assert.ok(carlEntry.location && carlEntry.location.mapId === 'world', 'localisation monde renvoyée pour un ami en ligne');
assert.strictEqual(carlEntry.location.x, 5, 'coordonnée X transmise');
assert.strictEqual(carlEntry.location.y, -3, 'coordonnée Y transmise');
assert.ok(carlEntry.location.terrain, 'terrain renseigné');

carl.online = false;
carlEntry = g.friendsList(alice).find((f) => f.username === 'Carl');
assert.strictEqual(carlEntry.location, null, 'aucune localisation pour un ami hors ligne (position obsolète)');
carl.online = true;

// Donjon : ni coordonnées (repère local, sans intérêt pour l’appelant) ni
// bouton rejoindre (sinon on court-circuite la découverte de ce donjon).
const dungeonMapId = [...g.maps.keys()].find((id) => id !== 'world');
assert.ok(dungeonMapId, 'un donjon existe dans les cartes générées');
carl.mapId = dungeonMapId;
carlEntry = g.friendsList(alice).find((f) => f.username === 'Carl');
assert.ok(carlEntry.location && carlEntry.location.dungeon, 'ami en donjon signalé comme tel');
assert.strictEqual(carlEntry.location.x, undefined, 'pas de coordonnées transmises en donjon');
assert.ok(!g.joinFriend(alice, 'Carl').ok, 'rejoindre un ami en donjon refusé');
carl.mapId = 'world';

// Rejoindre : refus hors amitié / hors ligne, téléportation exacte sinon
assert.ok(!g.joinFriend(alice, 'Bob').ok, 'rejoindre un non-ami refusé');
carl.online = false;
assert.ok(!g.joinFriend(alice, 'Carl').ok, 'rejoindre un ami hors ligne refusé');
carl.online = true;
alice.mapId = 'world'; alice.pos = { x: 0, y: 0 }; alice.status = 'IDLE';
const expectedJoinPos = g.nearestWalkablePos(g.worldMap, carl.pos);
const joinRes = g.joinFriend(alice, 'Carl');
assert.ok(joinRes.ok, 'rejoindre un ami en ligne accepté');
assert.deepStrictEqual(alice.pos, expectedJoinPos, 'téléportation sur la position de l’ami (ou la case libre la plus proche)');
assert.strictEqual(alice.mapId, 'world', 'arrivée sur la carte du monde');
console.log('Localisation amis : coordonnées monde ✔, masquée en donjon ✔, rejoindre (en ligne, même monde) ✔');

// Carl reste hors ligne pour la suite de ces tests (voir plus haut) — on
// restaure son état pour ne pas perturber les tests suivants.
carl.online = false;
carl.pos = { x: 0, y: 0 };

// --- Canaux de discussion ---
assert.ok(!g.say(alice, 'yo', 'guild').ok, 'canal guilde refusé hors guilde');

assert.ok(g.createGuild(carl, 'Faucons').ok, 'nouvelle guilde pour tester le canal');
assert.ok(g.inviteToGuild(carl, 'Bob').ok && g.respondGuildInvite(bob, true).ok, 'Bob rejoint les Faucons');
bob.online = true; carl.online = true;
sent.length = 0;
assert.ok(g.say(carl, 'Assaut à 20h', 'guild').ok, 'message de guilde envoyé');
const guildMsgs = sent.filter((m) => m.ev === 'chat' && m.data.channel === 'guild');
assert.ok(guildMsgs.some((m) => m.id === bob.id), 'Bob (membre en ligne) reçoit le message de guilde');
assert.ok(!guildMsgs.some((m) => m.id === alice.id), 'Alice (hors guilde) ne reçoit rien');
// Horodatage RÉEL (Date.now()), pas this.now (compteur de jeu relatif,
// accéléré par SPEED en dev) — sinon impossible d'afficher une heure/date
// véritable dans le chat (voir Game.say).
const guildMsgData = guildMsgs.find((m) => m.id === bob.id).data;
assert.strictEqual(typeof guildMsgData.ts, 'number', 'horodatage réel inclus dans le message de guilde');
assert.ok(Math.abs(guildMsgData.ts - Date.now()) < 5000, 'horodatage proche de l’heure réelle');

sent.length = 0;
assert.ok(!g.say(alice, 'x', 'whisper', 'Bob').ok, 'MP refusé entre non-amis');
assert.ok(!g.say(alice, 'x', 'whisper', 'Alice').ok, 'MP à soi-même refusé');

carl.online = true;
assert.ok(g.say(alice, 'Psst', 'whisper', 'Carl').ok, 'MP envoyé entre amis');
const whisperMsgs = sent.filter((m) => m.ev === 'chat' && m.data.channel === 'whisper');
assert.ok(whisperMsgs.some((m) => m.id === alice.id) && whisperMsgs.some((m) => m.id === carl.id), 'MP livré aux deux amis');

carl.online = false;
sent.length = 0;
const offlineWhisper = g.say(alice, 'Toujours là ?', 'whisper', 'Carl');
assert.ok(offlineWhisper.ok && offlineWhisper.offline, 'MP vers un ami hors ligne signalé comme non livré');
assert.ok(sent.some((m) => m.id === alice.id) && !sent.some((m) => m.id === carl.id), 'seul l’expéditeur reçoit l’écho si le destinataire est hors ligne');
console.log('Canaux : guilde restreinte aux membres ✔, MP réservés aux amis ✔, statut hors ligne signalé ✔');

// --- Historique de discussion : coordination asynchrone après déconnexion ---
// À ce stade : 1 message de guilde (Faucons : Bob + Carl) et 2 MP (Alice <-> Carl) enregistrés.
const bobHistory = g.chatHistoryFor(bob);
assert.strictEqual(bobHistory.length, 1, 'Bob (membre des Faucons, sans MP) ne revoit que le message de guilde');
assert.strictEqual(bobHistory[0].channel, 'guild', 'entrée bien de type guilde');
assert.strictEqual(typeof bobHistory[0].ts, 'number', 'l’historique conserve aussi l’horodatage réel');

const aliceHistory = g.chatHistoryFor(alice);
assert.strictEqual(aliceHistory.length, 2, 'Alice (hors guilde) ne revoit que ses deux MP avec Carl');
assert.ok(aliceHistory.every((m) => m.channel === 'whisper'), 'aucun message de guilde étranger visible par Alice');

const carlHistory = g.chatHistoryFor(carl);
assert.strictEqual(carlHistory.length, 3, 'Carl (membre + participant des deux MP) revoit tout ce qui le concerne');

assert.deepStrictEqual(g.initPayload(bob).chatHistory, bobHistory, 'initPayload reprend chatHistoryFor à la (re)connexion');

const busyBefore = g.chatLog.length;
for (let i = 0; i < CHAT_LOG_MAX + 10; i++) g.say(bob, 'spam ' + i, 'general');
assert.ok(g.chatLog.length <= CHAT_LOG_MAX, 'l’historique reste borné (plafond ' + CHAT_LOG_MAX + ')');
assert.ok(g.chatLog.length > busyBefore, 'les nouveaux messages remplacent bien les plus anciens');
console.log('Historique : filtrage par destinataire ✔, plafond respecté ✔');

// --- Châteaux de guilde : territoire, renfort/réparation, siège, bonus de zone ---
// À ce stade : Bob et Carl sont dans « Faucons » (Carl chef) ; Alice n'est dans aucune guilde.
const foretCastleTile = g.castleTileFor('FORET');
assert.ok(foretCastleTile, 'un château existe bien en Forêt');

bob.mapId = 'world'; bob.gold = 999999; bob.status = 'IDLE'; bob.pa = 50;
bob.pos = { x: foretCastleTile.x - 1, y: foretCastleTile.y };
assert.ok(!g.claimCastle(bob, 'FORET').ok, 'revendication refusée hors de la tuile du château');

bob.pos = { x: foretCastleTile.x, y: foretCastleTile.y };
const goldBeforeClaim = bob.gold;
assert.ok(g.claimCastle(bob, 'FORET').ok, 'revendication acceptée sur place, par un simple membre');
assert.strictEqual(bob.gold, goldBeforeClaim - CASTLE_CLAIM_COST_GOLD, 'coût de fondation prélevé');
let foretCastle = g.castleOf('FORET');
assert.strictEqual(foretCastle.ownerGuildId, bob.guildId, 'le château appartient à la guilde de Bob (Faucons)');
assert.strictEqual(foretCastle.level, 1, 'niveau 1 à la fondation');
assert.strictEqual(foretCastle.hp, CASTLE_BASE_HP, 'PS pleins à la fondation');
assert.ok(!g.claimCastle(bob, 'FORET').ok, 'un château déjà fondé ne peut pas l’être deux fois');

assert.ok(!g.reinforceCastle(alice, 'FORET').ok, 'un non-membre ne peut pas renforcer le château des Faucons');
assert.ok(!g.repairCastle(alice, 'FORET', 999).ok, 'un non-membre ne peut pas le réparer non plus');

assert.ok(!g.reinforceCastle(bob, 'FORET').ok, 'renfort refusé sans le bois requis');
bob.inventory.BOIS_1 = 60;   // Forêt -> BOIS, niveau 2 -> tier 1 × 60 (voir CASTLE_REINFORCE_RESOURCES)
const goldBeforeReinforce = bob.gold;
assert.ok(g.reinforceCastle(bob, 'FORET').ok, 'renfort par un membre (or + ressources)');
foretCastle = g.castleOf('FORET');
assert.strictEqual(foretCastle.level, 2, 'niveau augmenté');
assert.strictEqual(foretCastle.hpMax, CASTLE_BASE_HP + CASTLE_HP_PER_LEVEL, 'PS max augmentés');
assert.strictEqual(bob.gold, goldBeforeReinforce - CASTLE_REINFORCE_COST_GOLD, 'coût de renfort en or prélevé');
assert.ok(!bob.inventory.BOIS_1, 'le bois requis est bien consommé');

foretCastle.hp -= 120;   // simule des dégâts subis précédemment
assert.ok(!g.repairCastle(bob, 'FORET', 999999).ok, 'réparation refusée sans bois en stock');
// Château niveau 2 : la réparation suit désormais le niveau actuel (T2), pas un tier fixe.
bob.inventory.BOIS_2 = 20;   // 120 PS / 10 PS-par-unité (CASTLE_REPAIR_HP_PER_RESOURCE) = 12 unités requises
const goldBeforeRepair = bob.gold;
const repairRes = g.repairCastle(bob, 'FORET', 999999);
assert.ok(repairRes.ok && repairRes.healed === 120, 'réparation jusqu’à pleine structure');
assert.strictEqual(g.castleOf('FORET').hp, g.castleOf('FORET').hpMax, 'structure pleinement restaurée');
assert.strictEqual(bob.gold, goldBeforeRepair - repairRes.cost, 'coût de réparation en or prélevé');
assert.strictEqual(repairRes.resourceCost, 12, 'coût en ressources proportionnel aux PS rendus');
assert.strictEqual(repairRes.resourceTier, 2, 'le tier de réparation suit le niveau actuel du château (2)');
assert.strictEqual(bob.inventory.BOIS_2, 8, 'seul le bois du bon tier est consommé (20 - 12)');
assert.ok(!g.repairCastle(bob, 'FORET', 999999).ok, 'réparer une structure déjà pleine échoue');

// --- Siège : Alice fonde sa propre guilde et assiège le château des Faucons ---
// Depuis ce fix, l'assaut ouvre un lobby de 30 s (comme un raid de monstre)
// au lieu de résoudre instantanément un combat 1 contre le château.
// Bob s'écarte de la tuile : cette séquence teste un château non défendu
// (la défense active est testée séparément plus bas, sur un autre château).
bob.pos = { x: foretCastleTile.x - 1, y: foretCastleTile.y };
assert.ok(g.createGuild(alice, 'Loups').ok, 'Alice fonde sa propre guilde pour assiéger');
alice.mapId = 'world'; alice.status = 'IDLE';
alice.pos = { x: foretCastleTile.x, y: foretCastleTile.y };

assert.ok(!g.createSiege(bob, 'FORET').ok, 'impossible d’assiéger le château de sa propre guilde');

// --- Aperçu du jet nécessaire AVANT de lancer un siège (siegePreview, lecture
// seule) : même calcul de défense que resolveSiege (garnison + défenseurs
// présents), sans créer de lobby — Alice seule (aucun engin) contre la
// garnison des Faucons.
const siegePreview1 = g.siegePreview(alice, 'FORET');
assert.ok(siegePreview1.ok, 'aperçu de siège accepté');
assert.strictEqual(typeof siegePreview1.chance, 'number', 'aperçu de siège : chance numérique');
assert.ok(siegePreview1.chance > 0 && siegePreview1.chance < 1, 'aperçu de siège : chance bornée entre 0 et 1');
assert.ok(!g.siegePreview(bob, 'FORET').ok, 'aperçu refusé : château de sa propre guilde');
assert.ok(!g.siegePreview(alice, 'PLAINE').ok, 'aperçu refusé : château non revendiqué');
assert.ok(!g.siegePreview(alice, 'ZONE_INVALIDE').ok, 'aperçu refusé : terrain invalide');
const aliceGuildBackup = alice.guildId;
alice.guildId = null;
assert.ok(!g.siegePreview(alice, 'FORET').ok, 'aperçu refusé : hors de toute guilde');
alice.guildId = aliceGuildBackup;
assert.ok(!g.raids.has('siege:FORET'), 'siegePreview ne crée aucun lobby (lecture seule)');

const siegeKey = 'siege:FORET';
alice.pa = 50; alice.hp = maxHp(alice);
assert.ok(g.createSiege(alice, 'FORET').ok, 'lobby de siège créé');
assert.strictEqual(alice.status, 'LOBBY_COMBAT', 'Alice passe en lobby le temps du siège');
assert.strictEqual(alice.raidKey, siegeKey, 'la clé de siège est bien celle attendue');
assert.ok(g.raids.has(siegeKey), 'le lobby de siège existe dans this.raids');
assert.ok(!g.joinRaid(bob, siegeKey).ok, 'un membre de la guilde défenseuse ne peut pas rejoindre le siège adverse');
assert.ok(!g.startRaidNow(bob, siegeKey).ok, 'seule la meneuse du siège peut le lancer');

g.rng = () => 0;   // assaut repoussé à coup sûr (jet 1)
const beforeFailHp = g.castleOf('FORET').hp;
sent.length = 0;
assert.ok(g.startRaidNow(alice, siegeKey).ok, 'la meneuse lance l’assaut');
g.tick(300);
assert.ok(!g.raids.has(siegeKey), 'lobby de siège résolu et retiré');
let siegeResults = sent.filter((m) => m.ev === 'siegeResult').map((m) => m.data);
assert.strictEqual(siegeResults.length, 1, 'rapport de siège envoyé à l’assaillante');
assert.ok(!siegeResults[0].victory, 'assaut repoussé');
assert.strictEqual(g.castleOf('FORET').hp, beforeFailHp, 'PS inchangés après un assaut repoussé');
assert.strictEqual(alice.hp, Math.ceil(maxHp(alice) * CONFIG.COMBAT.DEATH_HP_PCT), 'attaquants repoussés = rapatriés à 25 % des PV');
assert.deepStrictEqual(alice.pos, { x: 0, y: 0 }, 'rapatriement à la Capitale après un assaut repoussé');
assert.strictEqual(alice.status, 'IDLE', 'Alice repasse IDLE après la résolution du siège');

// Délai anti-enchaînement (voir CASTLE_SIEGE_COOLDOWN_MS) : un nouveau siège sur
// CE château, juste après la résolution du précédent, est refusé — sans quoi
// une guilde pourrait grinder les PS jusqu'à la capture en quelques minutes,
// sans laisser aux défenseurs le temps de réagir. Alice repositionnée sur
// place, PA/statut au vert : seul le cooldown peut expliquer le refus.
alice.pos = { x: foretCastleTile.x, y: foretCastleTile.y };
alice.pa = 50; alice.hp = maxHp(alice); alice.status = 'IDLE';
assert.ok(!g.createSiege(alice, 'FORET').ok, 'siège immédiat sur le même château refusé (cooldown)');
g.castleOf('FORET').nextSiegeAt = 0;   // simule l'expiration du délai pour la suite du test

// Fenêtre de vulnérabilité (CASTLE_SIEGE_WINDOWS) : réactivée ponctuellement
// (elle est stubbée à `true` pour le reste de la suite, voir plus haut) pour
// vérifier que hors plage, même sans cooldown ni raison de refus, le siège
// est bloqué avec un message clair — et repasse en dedans de la plage.
g.isSiegeWindowOpen = () => false;
const outOfWindow = g.createSiege(alice, 'FORET');
assert.ok(!outOfWindow.ok, 'siège refusé hors de la fenêtre de vulnérabilité');
assert.ok(/assiégeable/i.test(outOfWindow.error), 'message explicite sur la fenêtre horaire');
g.isSiegeWindowOpen = () => true;

g.rng = () => 0.999;   // assaut réussi à coup sûr (jet 100)
const beforeHitHp = g.castleOf('FORET').hp;
sent.length = 0;
assert.ok(g.createSiege(alice, 'FORET').ok, 'second lobby de siège créé (cooldown expiré)');
assert.ok(g.startRaidNow(alice, siegeKey).ok);
g.tick(300);
siegeResults = sent.filter((m) => m.ev === 'siegeResult').map((m) => m.data);
assert.ok(siegeResults[0].victory && !siegeResults[0].captured, 'assaut réussi mais château pas encore pris');
assert.strictEqual(g.castleOf('FORET').hp, beforeHitHp - CASTLE_DAMAGE_PER_ASSAULT, 'PS réduits du montant par assaut');
// Jet de dé (issue collective, comme un raid) : jet forcé au max, réussite
// critique, lanceur tiré au sort parmi les participants (ici, Alice seule
// sur la tuile, aucun défenseur présent).
assert.strictEqual(siegeResults[0].roll, 100, 'jet de siège forcé au maximum');
assert.strictEqual(siegeResults[0].critical, 'success', 'jet 100 = réussite critique');
assert.strictEqual(siegeResults[0].rollerUsername, 'Alice', 'seule assaillante présente : lanceur = Alice');
assert.ok(!g.createSiege(alice, 'FORET').ok, 'cooldown de nouveau actif après ce second siège');

// Assauts répétés (lobby → lancement → résolution) jusqu'à la capture complète
// — cooldown expiré manuellement à chaque tour : ce test grinde volontairement
// pour vérifier la progression jusqu'à la capture, le cooldown lui-même est
// déjà couvert par les deux assertions ci-dessus.
let guard = 0;
while (g.castleOf('FORET').ownerGuildId !== alice.guildId && guard < 20) {
  g.castleOf('FORET').nextSiegeAt = 0;
  alice.pos = { x: foretCastleTile.x, y: foretCastleTile.y };
  alice.pa = 50; alice.hp = maxHp(alice); alice.status = 'IDLE';
  g.createSiege(alice, 'FORET');
  g.startRaidNow(alice, siegeKey);
  g.tick(300);
  guard++;
}
assert.strictEqual(g.castleOf('FORET').ownerGuildId, alice.guildId, 'château finalement conquis par les Loups');
assert.ok(g.castleOf('FORET').hp > 0, 'le château conquis conserve une partie de sa structure (pas remis à 0)');
g.rng = Math.random;
console.log('Châteaux : fondation/renfort/réparation ✔, siège (lobby 30 s, comme un raid) ✔, conquête ✔');

// --- Défense active : des défenseurs présents renforcent la garnison ---
// Faucons (Carl, Bob) fondent le château de Plaine ; Loups (Alice) l'assiège
// pendant que Bob se tient sur la tuile et que Carl reste en ligne ailleurs.
const plaineCastleTile = g.castleTileFor('PLAINE');
assert.ok(plaineCastleTile, 'un château existe bien en Plaine');
carl.gold = 999999; carl.online = true;
carl.mapId = 'world'; carl.pos = { x: plaineCastleTile.x, y: plaineCastleTile.y }; carl.status = 'IDLE';
assert.ok(g.claimCastle(carl, 'PLAINE').ok, 'Carl (chef des Faucons) fonde le château de Plaine');

// Un membre des Faucons hors ligne au moment de la résolution — pour vérifier
// la notification push (Bob et Carl sont en ligne, déjà couverts par
// toast/rapport détaillé ci-dessous ; seul un membre absent a besoin du push).
const rDaveOff = g.register({ username: 'DaveOff', password: 'secret1', speciesClass: 'OURS_GUERRIER', email: 'daveoff@test.dev' });
const daveOff = rDaveOff.player;
skipQuestsFor(daveOff);
assert.ok(g.inviteToGuild(carl, 'DaveOff').ok, 'Carl invite DaveOff dans les Faucons');
assert.ok(g.respondGuildInvite(daveOff, true).ok, 'DaveOff rejoint les Faucons');
daveOff.online = false;

bob.mapId = 'world'; bob.pos = { x: plaineCastleTile.x, y: plaineCastleTile.y }; bob.status = 'IDLE'; bob.pa = 50;
carl.pos = { x: plaineCastleTile.x - 1, y: plaineCastleTile.y };   // Carl : en ligne, mais absent de la tuile

alice.mapId = 'world'; alice.pos = { x: plaineCastleTile.x, y: plaineCastleTile.y }; alice.pa = 50; alice.hp = maxHp(alice); alice.status = 'IDLE';
sent.length = 0;
const plaineSiegeKey = 'siege:PLAINE';
assert.ok(g.createSiege(alice, 'PLAINE').ok, 'Loups assiège le château de Plaine');
const siegeAlerts = sent.filter((m) => m.ev === 'toast' && /assiégé/i.test(m.data.text));
assert.ok(siegeAlerts.some((m) => m.id === bob.id) && siegeAlerts.some((m) => m.id === carl.id),
  'les deux membres en ligne des Faucons sont alertés de l’assaut, présents ou non');

const garrisonAlone = g.castleDefenseForce(g.castleOf('PLAINE'));
g.rng = () => 0;   // assaut repoussé à coup sûr, jet 1 (issue forcée, seule la puissance de défense nous intéresse ici)
sent.length = 0;
pushed.length = 0;
assert.ok(g.startRaidNow(alice, plaineSiegeKey).ok);
g.tick(300);
const bobReportEntry = sent.find((m) => m.ev === 'siegeResult' && m.id === bob.id);
assert.ok(bobReportEntry, 'Bob (présent sur la tuile) reçoit un rapport de siège');
assert.strictEqual(bobReportEntry.data.role, 'defender', 'le rapport de Bob est bien du point de vue défenseur');
assert.ok(bobReportEntry.data.defenseBonus > 0, 'la présence de Bob apporte un bonus de défense non nul');
assert.strictEqual(bobReportEntry.data.garrison, Math.round(garrisonAlone), 'la garnison seule correspond à castleDefenseForce');
assert.strictEqual(bobReportEntry.data.defenseForce, bobReportEntry.data.garrison + bobReportEntry.data.defenseBonus,
  'la défense totale = garnison + bonus des défenseurs présents');
assert.ok(!bobReportEntry.data.victory, 'assaut repoussé (forcé)');
assert.ok(!sent.find((m) => m.ev === 'siegeResult' && m.id === carl.id),
  'Carl (en ligne mais absent de la tuile) ne reçoit pas de rapport détaillé');
const carlToastAfter = sent.find((m) => m.ev === 'toast' && m.id === carl.id);
assert.ok(carlToastAfter, 'Carl reçoit malgré tout un message d’issue simple');
const aliceReportEntry = sent.find((m) => m.ev === 'siegeResult' && m.id === alice.id);
assert.strictEqual(aliceReportEntry.data.role, 'attacker', 'Alice reçoit le rapport côté assaillante');
assert.strictEqual(aliceReportEntry.data.defenseForce, bobReportEntry.data.defenseForce, 'les deux rapports reflètent la même force de défense');
g.rng = Math.random;
console.log('Défense active : alerte des défenseurs ✔, bonus de présence ✔, rapport différencié attaquant/défenseur ✔');

// Notification push : seul le membre HORS LIGNE des Faucons en reçoit une
// (Bob et Carl sont en ligne, déjà couverts par toast/rapport ci-dessus).
assert.strictEqual(pushed.length, 1, 'un seul push envoyé (le membre hors ligne, pas les deux en ligne)');
assert.strictEqual(pushed[0].id, daveOff.id, 'push adressé au membre hors ligne des Faucons');
assert.ok(/repoussé/i.test(pushed[0].body), 'le push reflète bien l’issue (assaut repoussé)');
console.log('Notifications push : siège (membre hors ligne uniquement) ✔');

// --- Fortifications : investissement défensif séparé du renfort, sans joueurs présents ---
const montagneCastleTile = g.castleTileFor('MONTAGNE');
assert.ok(montagneCastleTile, 'un château existe bien en Montagne');
bob.gold = 999999;
bob.mapId = 'world'; bob.pos = { x: montagneCastleTile.x, y: montagneCastleTile.y }; bob.status = 'IDLE';
assert.ok(g.claimCastle(bob, 'MONTAGNE').ok, 'Bob fonde le château de Montagne');

assert.ok(!g.fortifyCastle(bob, 'MONTAGNE').ok, 'fortification refusée sans minerai en stock');
bob.inventory.MINERAI_1 = 60;   // Montagne -> MINERAI, fortification niveau 1 -> tier 1 × 60
const garrisonBeforeFortify = g.castleDefenseForce(g.castleOf('MONTAGNE'));
const goldBeforeFortify = bob.gold;
const fortRes = g.fortifyCastle(bob, 'MONTAGNE');
assert.ok(fortRes.ok && fortRes.fortLevel === 1, 'première fortification acceptée');
assert.strictEqual(bob.gold, goldBeforeFortify - CASTLE_FORTIFY_COST_GOLD, 'coût en or prélevé');
assert.ok(!bob.inventory.MINERAI_1, 'le minerai requis est bien consommé');
const garrisonAfterFortify = g.castleDefenseForce(g.castleOf('MONTAGNE'));
assert.strictEqual(Math.round(garrisonAfterFortify - garrisonBeforeFortify), CASTLE_FORTIFY_BONUS_PER_LEVEL,
  'la fortification augmente la garnison sans joueurs présents');
console.log('Fortifications : coût ressources + or ✔, bonus de garnison passif ✔');

// --- Engins de siège : fabrication à la Capitale, déploiement en siège (1/personne) ---
alice.gold = 999999;
alice.mapId = 'world'; alice.pos = { x: 5, y: 5 }; alice.status = 'IDLE';   // pas à la Capitale
assert.ok(!g.craftSiegeEngine(alice, 1).ok, 'fabrication refusée hors de la Capitale');
alice.pos = { x: 0, y: 0 };
assert.ok(!g.craftSiegeEngine(alice, 99).ok, 'tier d’engin invalide refusé');
assert.ok(!g.craftSiegeEngine(alice, 1).ok, 'fabrication refusée sans les ressources');
alice.inventory.BOIS_1 = 25; alice.inventory.MINERAI_1 = 15; alice.inventory.PLANTE_1 = 10;
const goldBeforeCraft = alice.gold;
const craftRes = g.craftSiegeEngine(alice, 1);
assert.ok(craftRes.ok, 'engin T1 fabriqué');
assert.strictEqual(alice.inventory[stackKey(SIEGE_ENGINE_ITEM, 1)], 1, 'engin en inventaire');
assert.ok(!alice.inventory.BOIS_1 && !alice.inventory.MINERAI_1 && !alice.inventory.PLANTE_1, 'ressources de la recette consommées');
assert.strictEqual(alice.gold, goldBeforeCraft - SIEGE_ENGINE_RECIPES[1].gold, 'or de la recette débité');
console.log('Engins de siège : fabrication à la Capitale ✔, recette bois/minerai/plante/or ✔');

const montagneSiegeKey = 'siege:MONTAGNE';
assert.ok(!g.deploySiegeEngine(carl, montagneSiegeKey, 1).ok, 'déploiement refusé : le siège n’existe pas encore');
alice.pos = { x: montagneCastleTile.x, y: montagneCastleTile.y }; alice.pa = 50; alice.hp = maxHp(alice); alice.status = 'IDLE';
assert.ok(g.createSiege(alice, 'MONTAGNE').ok, 'Loups assiège le château (fortifié) de Montagne');

assert.ok(!g.deploySiegeEngine(carl, montagneSiegeKey, 1).ok, 'déploiement refusé : Carl n’a pas rejoint ce siège');
const forceBeforeEngine = g.teamForce(g.raids.get(montagneSiegeKey));
const deployRes = g.deploySiegeEngine(alice, montagneSiegeKey, 1);
assert.ok(deployRes.ok && deployRes.tier === 1, 'engin T1 déployé par Alice');
assert.ok(!alice.inventory[stackKey(SIEGE_ENGINE_ITEM, 1)], 'l’engin déployé est consommé du stock');
assert.ok(!g.deploySiegeEngine(alice, montagneSiegeKey, 1).ok, 'un second engin par la même personne est refusé (1/personne max)');
const forceAfterEngine = g.teamForce(g.raids.get(montagneSiegeKey));
assert.strictEqual(forceAfterEngine - forceBeforeEngine, SIEGE_ENGINE_FORCE[1], 'l’engin ajoute sa force au calcul en direct (pas 1 pour 1 avec un joueur)');
console.log('Engins de siège : 1 par personne maximum ✔, force ajoutée au calcul de bataille ✔');

// Résolution perdue : les dégâts d'engin s'appliquent quand même, mais ne peuvent
// jamais, à eux seuls, faire tomber le château (plancher à 1 PS).
g.castleOf('MONTAGNE').hp = SIEGE_ENGINE_DAMAGE[1];
g.rng = () => 0;   // assaut repoussé à coup sûr (jet 1)
sent.length = 0;
assert.ok(g.startRaidNow(alice, montagneSiegeKey).ok);
g.tick(300);
let montagneResult = sent.find((m) => m.ev === 'siegeResult' && m.id === alice.id).data;
assert.ok(!montagneResult.victory, 'assaut repoussé (forcé)');
assert.strictEqual(montagneResult.engineCount, 1, 'un engin comptabilisé dans le rapport');
assert.strictEqual(montagneResult.engineDamage, SIEGE_ENGINE_DAMAGE[1], 'dégâts garantis de l’engin reportés');
assert.strictEqual(g.castleOf('MONTAGNE').hp, 1, 'dégâts d’engin appliqués malgré l’échec, plancher à 1 PS (jamais 0)');
assert.strictEqual(g.castleOf('MONTAGNE').ownerGuildId, bob.guildId, 'pas de prise du château sur un échec, même au plancher de PS');
console.log('Engins de siège : dégâts garantis même en cas d’échec ✔, jamais de prise sans victoire au combat ✔');

// Résolution gagnée : dégâts de combat + engin cumulés, et la prise remet la fortification à 0
alice.pos = { x: 0, y: 0 }; alice.status = 'IDLE';
alice.inventory.BOIS_1 = 25; alice.inventory.MINERAI_1 = 15; alice.inventory.PLANTE_1 = 10;
assert.ok(g.craftSiegeEngine(alice, 1).ok, 'second engin fabriqué à la Capitale');
alice.pos = { x: montagneCastleTile.x, y: montagneCastleTile.y }; alice.pa = 50; alice.hp = maxHp(alice); alice.status = 'IDLE';
g.castleOf('MONTAGNE').nextSiegeAt = 0;   // cooldown déjà couvert par le test dédié sur FORET
assert.ok(g.createSiege(alice, 'MONTAGNE').ok, 'second lobby de siège');
assert.ok(g.deploySiegeEngine(alice, montagneSiegeKey, 1).ok, 'engin redéployé pour ce nouveau siège');
g.castleOf('MONTAGNE').hp = CASTLE_DAMAGE_PER_ASSAULT + SIEGE_ENGINE_DAMAGE[1];   // pile de quoi tomber à 0
g.rng = () => 0.999;   // assaut réussi à coup sûr (jet 100)
sent.length = 0;
assert.ok(g.startRaidNow(alice, montagneSiegeKey).ok);
g.tick(300);
montagneResult = sent.find((m) => m.ev === 'siegeResult' && m.id === alice.id).data;
assert.ok(montagneResult.victory && montagneResult.captured, 'assaut gagné : dégâts combat + engin cumulés font tomber le château');
assert.strictEqual(g.castleOf('MONTAGNE').ownerGuildId, alice.guildId, 'château conquis par les Loups');
assert.strictEqual(g.castleOf('MONTAGNE').fortLevel, 0, 'les fortifications de l’ancien propriétaire tombent avec lui');
g.rng = Math.random;
console.log('Engins de siège : dégâts combat + engin cumulés à la victoire ✔, fortification remise à 0 à la conquête ✔');

// --- Bonus de zone : l'or looté en Forêt est bonifié pour la guilde propriétaire ---
let foretMob = null;
for (const t of g.tiles.values()) {
  if (t.terrain === 'FORET' && t.content && t.content.kind === 'monster' &&
      t.content.inactiveUntil <= g.now && Math.hypot(t.x, t.y) > CONFIG.SAFE_RADIUS + 1) { foretMob = t; break; }
}
assert.ok(foretMob, 'un monstre de Forêt est disponible pour vérifier le bonus de zone');
alice.pos = { x: foretMob.x - 1, y: foretMob.y };
alice.pa = 50; alice.hp = maxHp(alice); alice.status = 'IDLE';
const savedRandom = Math.random;
Math.random = () => 0;   // rollGoldLoot déterministe (minimum de la fourchette)
sent.length = 0;
g.rng = () => 0.999;   // victoire garantie (jet 100)
assert.ok(g.createRaid(alice, foretMob.x, foretMob.y).ok, 'raid forêt pour vérifier le bonus de zone');
assert.ok(g.startRaidNow(alice, foretMob.x + ',' + foretMob.y).ok);
g.tick(300);
Math.random = savedRandom;   // avant g.rng = Math.random ci-dessous : sinon g.rng capture le Math.random encore figé à 0
g.rng = Math.random;
const zoneResult = sent.filter((m) => m.ev === 'result' && m.id === alice.id).map((m) => m.data)[0];
const expectedGold = Math.ceil((3 + foretMob.content.tier * 4) * CASTLE_ZONE_GOLD_BONUS);
assert.strictEqual(zoneResult.gold, expectedGold, 'or bonifié de +' + Math.round((CASTLE_ZONE_GOLD_BONUS - 1) * 100) + ' % pour la guilde propriétaire de la zone');
console.log('Bonus de zone : or bonifié pour la guilde propriétaire ✔');

// --- Regain (ex-PA) : ne bloque plus jamais récolte/raid, double juste l'XP ---
// Récolte : Regain disponible → XP doublée, coût prélevé comme avant.
let boostNode = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'resource' && t.content.tier === 1 &&
      t.content.inactiveUntil <= g.now && (t.x !== node.x || t.y !== node.y)) { boostNode = t; break; }
}
assert.ok(boostNode, 'un second gisement T1 est disponible pour le test de Regain');
alice.pos = { x: boostNode.x - 1, y: boostNode.y };
alice.pa = 10;
let xpBefore = alice.harvestXp;
assert.ok(g.harvest(alice, boostNode.x, boostNode.y).ok, 'récolte toujours acceptée avec du Regain');
g.tick(CONFIG.HARVEST_MS + 200);
const baseHarvestXp = 8 + Math.min(6, boostNode.content.tier) * 6;
assert.strictEqual(alice.harvestXp - xpBefore, baseHarvestXp * 2, 'XP de récolte doublée quand du Regain est disponible');
assert.strictEqual(alice.pa, 10 - CONFIG.COSTS.HARVEST, 'Regain consommé pour le bonus');

// Récolte : Regain à 0 → récolte quand même acceptée, XP normale, PA inchangé.
let dryNode = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'resource' && t.content.tier === 1 &&
      t.content.inactiveUntil <= g.now && (t.x !== node.x || t.y !== node.y) && (t.x !== boostNode.x || t.y !== boostNode.y)) { dryNode = t; break; }
}
assert.ok(dryNode, 'un troisième gisement T1 est disponible pour le test sans Regain');
alice.pos = { x: dryNode.x - 1, y: dryNode.y };
alice.pa = 0;
xpBefore = alice.harvestXp;
assert.ok(g.harvest(alice, dryNode.x, dryNode.y).ok, 'récolte acceptée même sans Regain (jamais bloquée)');
g.tick(CONFIG.HARVEST_MS + 200);
assert.strictEqual(alice.harvestXp - xpBefore, 8 + Math.min(6, dryNode.content.tier) * 6, 'XP de récolte normale (non doublée) sans Regain');
assert.strictEqual(alice.pa, 0, 'Regain toujours à 0 (rien à consommer)');

// Raid : même principe, sur le gain de maîtrise (weaponXp).
let boostMob = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'monster' && t.content.tier === 2 &&
      t.content.inactiveUntil <= g.now && Math.max(Math.abs(t.x + 45), Math.abs(t.y + 45)) > 12) { boostMob = t; break; }
}
assert.ok(boostMob, 'un monstre T2 est disponible pour le test de Regain en raid');
alice.pos = { x: boostMob.x - 1, y: boostMob.y };
alice.pa = 50; alice.hp = maxHp(alice); alice.status = 'IDLE';
let weaponXpBefore = alice.weaponXp;
sent.length = 0;
g.rng = () => 0.999;   // victoire garantie (jet 100)
assert.ok(g.createRaid(alice, boostMob.x, boostMob.y).ok, 'raid toujours accepté avec du Regain');
assert.ok(g.startRaidNow(alice, boostMob.x + ',' + boostMob.y).ok);
g.tick(300);
g.rng = Math.random;
let boostResult = sent.filter((m) => m.ev === 'result' && m.id === alice.id).map((m) => m.data)[0];
const baseRaidXp = 15 + Math.min(6, boostMob.content.tier) * 15;
assert.strictEqual(boostResult.regainBoosted, true, 'rapport de raid signale le bonus de Regain');
assert.strictEqual(boostResult.xp, baseRaidXp * 2, 'XP de maîtrise doublée quand du Regain est disponible');
assert.strictEqual(alice.weaponXp - weaponXpBefore, baseRaidXp * 2, 'gain de maîtrise reflété sur le compte');
assert.strictEqual(alice.pa, 50 - CONFIG.COSTS.RAID, 'Regain consommé pour le bonus de raid');
console.log('Regain : ne bloque jamais récolte/raid ✔, double l’XP si disponible ✔, XP normale sinon ✔');

// --- Packs d'or : conversion atomique des Écailles Lunaires en or ---
const goldPack = GOLD_PACKS[1];
const goldBeforePack = alice.gold;
alice[PREMIUM_CURRENCY.key] = goldPack.moonstones - 1;
let goldPackRes = g.buyGoldPack(alice, goldPack.id);
assert.ok(!goldPackRes.ok, 'pack d’or refusé sans assez d’Écailles Lunaires');
assert.strictEqual(alice.gold, goldBeforePack, 'aucun or crédité après un refus');
alice[PREMIUM_CURRENCY.key] = goldPack.moonstones + 4;
goldPackRes = g.buyGoldPack(alice, goldPack.id);
assert.ok(goldPackRes.ok, 'pack d’or acheté');
assert.strictEqual(alice[PREMIUM_CURRENCY.key], 4, 'coût premium débité exactement');
assert.strictEqual(alice.gold, goldBeforePack + goldPack.gold, 'or crédité immédiatement');
assert.ok(!g.buyGoldPack(alice, 'pack_inconnu').ok, 'pack d’or inconnu refusé');
console.log('Packs d’or : débit Écailles Lunaires + crédit or atomiques ✔');

// --- Emplacement de personnage (boutique) : payé en Écailles Lunaires,
// plafonné aux classes réellement accessibles (jamais Séraphin Royal) ---
const slotsBeforeBuy = alice.charSlots;
alice[PREMIUM_CURRENCY.key] = CHAR_SLOT_COST_MOONSTONES - 1;
let slotRes = g.buyCharSlot(alice);
assert.ok(!slotRes.ok, 'achat refusé sans assez d’Écailles Lunaires');
assert.strictEqual(alice.charSlots, slotsBeforeBuy, 'aucun emplacement accordé après un refus');
alice[PREMIUM_CURRENCY.key] = CHAR_SLOT_COST_MOONSTONES + 3;
slotRes = g.buyCharSlot(alice);
assert.ok(slotRes.ok, 'emplacement acheté');
assert.strictEqual(alice[PREMIUM_CURRENCY.key], 3, 'coût premium débité exactement');
assert.strictEqual(alice.charSlots, slotsBeforeBuy + 1, 'emplacement supplémentaire accordé');
// Carl (voir plus haut) a déjà MAX_CHAR_SLOTS (7, via don admin) — au-delà du
// plafond ACHETABLE (6, sans le slot admin-only de Séraphin Royal).
assert.ok(MAX_PLAYER_CHAR_SLOTS < MAX_CHAR_SLOTS, 'plafond achetable strictement sous le plafond admin (exclut Séraphin Royal)');
carl[PREMIUM_CURRENCY.key] = CHAR_SLOT_COST_MOONSTONES * 5;
assert.ok(!g.buyCharSlot(carl).ok, 'achat refusé une fois le plafond joueur atteint');
console.log('Emplacement de personnage : achat en Écailles Lunaires ✔, plafonné hors classe admin-only ✔');

// --- Monture cosmétique : possession obligatoire, équipement indépendant du skin ---
const wyrmMountId = 'wyrm_ancestral_hatchling';
alice.ownedMounts = [];
alice.mountId = null;
assert.ok(MOUNT_ITEMS[wyrmMountId], 'la monture du Wyrm est configurée');
assert.ok(!g.equipMount(alice, wyrmMountId).ok, 'monture refusée avant obtention');
alice.ownedMounts.push(wyrmMountId);
assert.ok(g.equipMount(alice, wyrmMountId).ok, 'monture possédée équipée');
assert.strictEqual(alice.mountId, wyrmMountId, 'monture active enregistrée sur le compte');
assert.strictEqual(g.publicPlayer(alice).mountId, wyrmMountId, 'monture transmise aux autres joueurs');
assert.ok(g.equipMount(alice, null).ok && !alice.mountId, 'retour à pied possible');
console.log('Montures : possession contrôlée ✔, équipement public indépendant du skin ✔');

// --- Montures « simples » en boutique (or) : rare (sans .shop) jamais achetable ---
assert.ok(!g.buyMount(alice, wyrmMountId).ok, 'monture rare non listée en boutique refusée à l’achat');
assert.ok(!g.buyMount(alice, 'monture_inconnue').ok, 'monture inconnue refusée');
for (const mountId of ['mount_cheval', 'mount_loup', 'mount_tigre', 'mount_panthere']) {
  assert.ok(MOUNT_ITEMS[mountId], mountId + ' configurée');
  assert.ok(MOUNT_ITEMS[mountId].shop, mountId + ' prix de boutique défini');
}
const cheval = MOUNT_ITEMS.mount_cheval;
alice.gold = cheval.shop.price - 1;
assert.ok(!g.buyMount(alice, 'mount_cheval').ok, 'achat de monture refusé sans assez d’or');
assert.ok(!alice.ownedMounts.includes('mount_cheval'), 'rien débité/ajouté après un refus');
alice.gold = cheval.shop.price + 50;
const buyMountRes = g.buyMount(alice, 'mount_cheval');
assert.ok(buyMountRes.ok, 'monture simple achetée avec assez d’or');
assert.strictEqual(alice.gold, 50, 'prix de la monture débité exactement');
assert.ok(alice.ownedMounts.includes('mount_cheval'), 'monture ajoutée à la possession');
assert.ok(!g.buyMount(alice, 'mount_cheval').ok, 'rachat de la même monture refusé');
console.log('Montures en boutique : rares non listées ✔, achat or (débit exact, anti-double achat) ✔');

// --- Montures premium (Écailles Lunaires) : licorne, araignée, phénix, cerf magique ---
for (const mountId of ['mount_licorne', 'mount_araignee', 'mount_phenix', 'mount_cerf_magique']) {
  assert.ok(MOUNT_ITEMS[mountId], mountId + ' configurée');
  assert.strictEqual(MOUNT_ITEMS[mountId].shop.currency, PREMIUM_CURRENCY.key, mountId + ' payable en Écailles Lunaires');
}
const licorne = MOUNT_ITEMS.mount_licorne;
alice[PREMIUM_CURRENCY.key] = licorne.shop.price - 1;
assert.ok(!g.buyMount(alice, 'mount_licorne').ok, 'achat refusé sans assez d’Écailles Lunaires');
assert.ok(!alice.ownedMounts.includes('mount_licorne'), 'rien débité/ajouté après un refus');
alice[PREMIUM_CURRENCY.key] = licorne.shop.price + 7;
const buyPremiumMountRes = g.buyMount(alice, 'mount_licorne');
assert.ok(buyPremiumMountRes.ok, 'monture premium achetée avec assez d’Écailles Lunaires');
assert.strictEqual(alice[PREMIUM_CURRENCY.key], 7, 'prix en Écailles Lunaires débité exactement (pas d’or touché)');
assert.ok(alice.ownedMounts.includes('mount_licorne'), 'monture premium ajoutée à la possession');
assert.ok(!g.buyMount(alice, 'mount_licorne').ok, 'rachat de la même monture premium refusé');
console.log('Montures premium : configuration ✔, achat Écailles Lunaires (débit exact, anti-double achat) ✔');

// --- Dés cosmétiques : boutique Écailles Lunaires uniquement, indépendants de la classe ---
for (const item of DICE_SKIN_ITEMS) {
  assert.strictEqual(item.currency, PREMIUM_CURRENCY.key, item.id + ' payable en Écailles Lunaires');
}
assert.ok(!g.equipDiceSkin(alice, 'dice_voile_lunaire').ok, 'dé refusé avant obtention');
const voileLunaire = DICE_SKIN_BY_ID.dice_voile_lunaire;
alice[PREMIUM_CURRENCY.key] = voileLunaire.price - 1;
assert.ok(!g.buyDiceSkin(alice, 'dice_voile_lunaire').ok, 'achat refusé sans assez d’Écailles Lunaires');
assert.ok(!alice.ownedDice.includes('dice_voile_lunaire'), 'rien débité/ajouté après un refus');
alice[PREMIUM_CURRENCY.key] = voileLunaire.price + 5;
const buyDiceRes = g.buyDiceSkin(alice, 'dice_voile_lunaire');
assert.ok(buyDiceRes.ok, 'dé acheté avec assez d’Écailles Lunaires');
assert.strictEqual(alice[PREMIUM_CURRENCY.key], 5, 'prix débité exactement');
assert.ok(alice.ownedDice.includes('dice_voile_lunaire'), 'dé ajouté à la possession');
assert.ok(!g.buyDiceSkin(alice, 'dice_voile_lunaire').ok, 'rachat du même dé refusé');
assert.ok(!g.equipDiceSkin(alice, 'dice_inconnu').ok, 'dé inconnu refusé à l’équipement');
assert.ok(g.equipDiceSkin(alice, 'dice_voile_lunaire').ok && alice.diceId === 'dice_voile_lunaire', 'dé possédé équipé');
assert.ok(g.equipDiceSkin(alice, null).ok && !alice.diceId, 'retour au dé par défaut possible');
console.log('Dés cosmétiques : boutique Écailles Lunaires ✔, possession/équipement indépendants de la classe ✔');

// --- Quartier résidentiel : carte fixe, portails, parcelles, une maison par compte ---
const housingMap = g.maps.get(HOUSING_MAP_ID);
assert.ok(housingMap, 'carte du quartier générée au démarrage');
const parcelTiles = [...housingMap.tiles.values()].filter((t) => t.content && t.content.kind === 'parcel');
assert.strictEqual(parcelTiles.length, HOUSING_GRID_COORDS.length * HOUSING_GRID_COORDS.length, 'grille complète de parcelles');
// Régression : isWalkable() a une liste blanche de types de contenu franchissables
// (château, portail, ressource…) — 'parcel' en était absent, rendant chaque
// parcelle visible mais IMPOSSIBLE à atteindre à pied (move() refusait avec
// "Case bloquée"), donc jamais achetable en pratique malgré un achat qui
// fonctionnait très bien une fois "téléporté" dessus en test.
for (const t of parcelTiles) {
  assert.ok(isWalkable(housingMap.tiles, t.x, t.y), 'parcelle praticable à pied (' + t.content.id + ')');
}
// Chebyshev >= 5 entre deux parcelles quelconques : aucune maison ne peut
// visuellement en chevaucher une autre (voir le design retenu).
for (const a of parcelTiles) {
  for (const b of parcelTiles) {
    if (a === b) continue;
    assert.ok(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) >= 5, 'parcelles jamais trop proches (' + a.content.id + '/' + b.content.id + ')');
  }
}
const plazaTile = housingMap.tiles.get(tileKey(HOUSING_PLAZA_POS.x, HOUSING_PLAZA_POS.y));
assert.ok(plazaTile.content && plazaTile.content.kind === 'portal' && plazaTile.content.targetMapId === 'world', 'portail de retour à la Capitale sur la place');
const worldPortalTile = g.maps.get('world').tiles.get(tileKey(HOUSING_PORTAL_WORLD_POS.x, HOUSING_PORTAL_WORLD_POS.y));
assert.ok(worldPortalTile.content && worldPortalTile.content.kind === 'portal' && worldPortalTile.content.targetMapId === HOUSING_MAP_ID, 'portail vers le quartier près de la Capitale');

const parcelA = housingParcelId(0, 0);
const parcelB = housingParcelId(1, 0);
const model = HOUSE_MODELS[0];
assert.ok(!g.claimParcel(alice, 'parcelle_inconnue', model.id).ok, 'parcelle inconnue refusée');
alice.gold = model.price - 1;
assert.ok(!g.claimParcel(alice, parcelA, model.id).ok, 'achat refusé sans assez d’or');
assert.ok(!alice.parcelId, 'aucune parcelle attribuée après un refus');
alice.gold = model.price + 50;
const claimRes = g.claimParcel(alice, parcelA, model.id);
assert.ok(claimRes.ok, 'parcelle achetée avec assez d’or');
assert.strictEqual(alice.gold, 50, 'prix débité exactement');
assert.strictEqual(alice.parcelId, parcelA, 'parcelle attribuée au compte');
assert.strictEqual(g.houses.get(parcelA).ownerId, alice.id, 'propriétaire enregistré côté maison');
assert.ok(!g.claimParcel(bob, parcelA, model.id).ok, 'parcelle déjà occupée refusée à un autre joueur');
bob.gold = model.price + 50;
assert.ok(!g.claimParcel(alice, parcelB, model.id).ok, 'une seule maison par compte : deuxième achat refusé');
const bobClaim = g.claimParcel(bob, parcelB, model.id);
assert.ok(bobClaim.ok, 'un autre joueur peut acheter une parcelle différente');
const housingList = g.housingInfo();
assert.ok(housingList.some((h) => h.parcelId === parcelA && h.ownerUsername === 'Alice' && h.modelId === model.id), 'maison d’Alice listée');
assert.ok(housingList.some((h) => h.parcelId === parcelB && h.ownerUsername === 'Bob'), 'maison de Bob listée');
assert.strictEqual(housingList.length, 2, 'seules les parcelles réclamées apparaissent');
assert.ok(!g.enterHouse(carl, parcelA).ok, 'entrée refusée pour un joueur sans maison');
assert.ok(!g.enterHouse(bob, parcelA).ok, 'entrée refusée dans la maison d’un autre joueur');
const enterHome = g.enterHouse(alice, parcelA);
assert.ok(enterHome.ok, 'le propriétaire peut entrer dans sa maison');
assert.strictEqual(alice.mapId, houseInteriorMapId(parcelA), 'carte intérieure dédiée par parcelle');
const interiorMap = g.mapOf(alice.mapId);
assert.ok(interiorMap && interiorMap.kind === 'houseInterior', 'carte intérieure générée à la demande');
assert.strictEqual(interiorMap.terrain, 'PARQUET', 'terrain intérieur en parquet');
const exitTile = interiorMap.tiles.get(tileKey(interiorMap.entry.x, interiorMap.entry.y));
assert.ok(!exitTile || !exitTile.content, 'point d’entrée libre pour laisser respirer la caméra');
const exitDoorPos = houseInteriorLayoutFor(model.id).door;
const exitDoorTile = interiorMap.tiles.get(tileKey(exitDoorPos.x, exitDoorPos.y));
assert.ok(!exitDoorTile || !exitDoorTile.content, 'aucune porte ni portail dans l interieur');
assert.ok(!g.craftFurniture(alice, 'lit_simple').ok, 'fabrication refusée sans ressources');
alice.inventory.BOIS_2 = 40;
alice.inventory.PLANTE_1 = 20;
const craftedFurniture = g.craftFurniture(alice, 'lit_simple');
assert.ok(craftedFurniture.ok, 'fabrication du meuble autorisée avec les ressources');
assert.strictEqual(alice.furnitureInventory.lit_simple, 1, 'stock de meuble crédité après fabrication');
assert.ok(!g.placeFurniture(carl, 'lit_simple', 0, 0).ok, 'placement refusé hors de sa maison');
assert.ok(!g.placeFurniture(alice, 'meuble_inconnu', 0, 0).ok, 'meuble inconnu refusé');
assert.ok(g.placeFurniture(alice, 'lit_simple', exitDoorPos.x, exitDoorPos.y).ok, 'ancienne zone de porte désormais libre pour le mobilier');
assert.ok(!alice.furnitureInventory.lit_simple, 'poser consomme le stock disponible');
g.removeFurniture(alice, exitDoorPos.x, exitDoorPos.y);
assert.strictEqual(alice.furnitureInventory.lit_simple, 1, 'retirer remet le meuble dans le stock');
const placedFurniture = g.placeFurniture(alice, 'lit_simple', 1, 1);
assert.ok(placedFurniture.ok, 'placement d’un meuble autorisé dans la maison');
assert.strictEqual(g.houses.get(parcelA).furniture.length, 1, 'meuble stocké côté maison');
assert.strictEqual(g.housingInfo().find((h) => h.parcelId === parcelA).furniture.length, 1, 'mobilier exposé dans l’état public');
assert.ok(!g.placeFurniture(alice, 'lit_simple', 2, 2).ok, 'impossible de reposer sans stock restant');
assert.ok(!g.placeFurniture(alice, 'table_ronde', 1, 1).ok, 'double placement refusé sur la même case');
const removedFurniture = g.removeFurniture(alice, 1, 1);
assert.ok(removedFurniture.ok, 'retrait du meuble autorisé');
assert.strictEqual(g.houses.get(parcelA).furniture.length, 0, 'meuble retiré du stockage');
assert.strictEqual(alice.furnitureInventory.lit_simple, 1, 'retirer rembourse à nouveau le stock');
assert.ok(!g.removeFurniture(alice, 1, 1).ok, 'retrait refusé si aucune déco sur la case');
for (const houseModel of HOUSE_MODELS) {
  const sampleMap = generateHouseInteriorMap('sample_' + houseModel.id, houseModel.id, { x: 1, y: 2 });
  const layout = houseInteriorLayoutFor(houseModel.id);
  assert.strictEqual(sampleMap.min, layout.min, 'borne min correcte pour ' + houseModel.id);
  assert.strictEqual(sampleMap.max, layout.max, 'borne max correcte pour ' + houseModel.id);
  assert.strictEqual(sampleMap.entry.y, layout.entry.y, 'point d’entrée correct pour ' + houseModel.id);
  assert.ok(!sampleMap.tiles.get(tileKey(layout.door.x, layout.door.y)).content, 'aucune porte interieure pour ' + houseModel.id);
  const parquetTiles = [...sampleMap.tiles.values()].filter((t) => t.terrain === 'PARQUET');
  assert.ok(parquetTiles.length > 0, 'parquet présent pour ' + houseModel.id);
}
assert.ok(!g.usePortal(alice).ok, 'aucun portail utilisable dans la maison');
const leaveViaDedicatedAction = g.leaveHouse(alice);
assert.ok(leaveViaDedicatedAction.ok, 'sortie dédiée de maison disponible');
assert.strictEqual(alice.mapId, HOUSING_MAP_ID, 'sortie dédiée renvoie au quartier');
assert.ok(!g.leaveHouse(alice).ok, 'sortie dédiée refusée hors maison');

// Persistance : sérialisation/rechargement (comme les châteaux).
const housingSnapshot = g.serialize();
const reloaded = new Game(CONFIG.WORLD.SEED, null);
reloaded.send = () => {};
reloaded.broadcast = () => {};
reloaded.load(housingSnapshot);
assert.strictEqual(reloaded.houses.get(parcelA).ownerUsername, 'Alice', 'maison restaurée après rechargement');
assert.strictEqual(reloaded.players.get(alice.id).parcelId, parcelA, 'parcelId du joueur restauré après rechargement');

// Support/modération : libérer la parcelle d'un joueur bloqué (une seule
// maison par compte, voir plus haut) — Alice est admin (premier compte créé).
assert.ok(!g.adminResetHouse(bob, 'Alice').ok, 'reset refusé à un non-admin');
assert.ok(!g.adminResetHouse(alice, 'Compte_Inconnu').ok, 'reset refusé sur un joueur introuvable');
const resetRes = g.adminResetHouse(alice, 'Alice');
assert.ok(resetRes.ok, 'admin libère la parcelle d’Alice');
assert.ok(!alice.parcelId, 'parcelId d’Alice effacé');
assert.ok(!g.houses.get(parcelA).ownerId, 'maison marquée libre côté serveur');
assert.ok(!g.housingInfo().some((h) => h.parcelId === parcelA), 'parcelle disparaît de la liste publique');
assert.ok(!g.adminResetHouse(alice, 'Alice').ok, 'reset refusé si déjà sans maison');
alice.gold = model.price + 10;
const reclaim = g.claimParcel(alice, parcelA, model.id);
assert.ok(reclaim.ok, 'Alice peut racheter une parcelle après le reset');
const hugeModel = HOUSE_MODELS.find((m) => m.id === 'house_tres_grande');
if (hugeModel) {
  g.adminResetHouse(alice, 'Alice');
  if (hugeModel.currency === PREMIUM_CURRENCY.key) alice[PREMIUM_CURRENCY.key] = hugeModel.price + 10;
  else alice.gold = hugeModel.price + 10;
  const reclaimHuge = g.claimParcel(alice, parcelA, hugeModel.id);
  assert.ok(reclaimHuge.ok, 'Alice peut racheter en tres grand modele');
  const reEnterHuge = g.enterHouse(alice, parcelA);
  assert.ok(reEnterHuge.ok, 'Alice peut re-rentrer apres le rachat');
  assert.strictEqual(g.mapOf(alice.mapId).max, houseInteriorLayoutFor(hugeModel.id).max, 'la nouvelle taille interieure remplace bien l ancien cache');
}
console.log('Quartier résidentiel : grille espacée ✔, portails aller/retour ✔, une maison par compte ✔, persistance ✔, reset admin ✔');

// --- Admin : attribution de fragments d'artefact / d'artefacts complets ---
{
  const artifactId = ARTIFACT_ORDER[0];
  const item = ARTIFACT_ITEMS[artifactId];
  assert.ok(!g.adminGrantArtifactFragment(bob, 'Alice', artifactId, 1).ok, 'fragment refusé à un non-admin');
  assert.ok(!g.adminGrantArtifactFragment(alice, 'Compte_Inconnu', artifactId, 1).ok, 'fragment refusé sur un joueur introuvable');
  assert.ok(!g.adminGrantArtifactFragment(alice, 'Alice', 'artefact_inconnu', 1).ok, 'fragment refusé pour un artefact inconnu');
  const before = Number(bob.inventory[item.fragmentKey] || 0);
  const partial = item.fragmentsRequired - before - 1;
  if (partial > 0) {
    assert.ok(g.adminGrantArtifactFragment(alice, 'Bob', artifactId, partial).ok, 'fragments attribués un par un');
    assert.strictEqual(Number(bob.inventory[item.fragmentKey] || 0), before + partial, 'quantité de fragments exacte, pas encore assemblé');
    assert.ok(!bob.ownedArtifacts.includes(item.id), 'artefact pas encore assemblé avant d’avoir le compte requis');
  }
  assert.ok(g.adminGrantArtifactFragment(alice, 'Bob', artifactId, 99).ok, 'dernier(s) fragment(s) attribué(s) (quantité plafonnée à 99)');
  assert.ok(bob.ownedArtifacts.includes(item.id), 'artefact assemblé automatiquement une fois le seuil atteint');

  assert.ok(!g.adminGrantArtifact(bob, 'Alice', artifactId).ok, 'artefact complet refusé à un non-admin');
  assert.ok(!g.adminGrantArtifact(alice, 'Compte_Inconnu', artifactId).ok, 'artefact complet refusé sur un joueur introuvable');
  assert.ok(!g.adminGrantArtifact(alice, 'Alice', 'artefact_inconnu').ok, 'artefact complet refusé pour un id inconnu');
  assert.ok(!alice.ownedArtifacts.includes(artifactId), 'Alice ne possède pas encore cet artefact');
  const grantFull = g.adminGrantArtifact(alice, 'Alice', artifactId);
  assert.ok(grantFull.ok, 'artefact complet attribué directement, sans passer par les fragments');
  assert.ok(alice.ownedArtifacts.includes(artifactId), 'artefact ajouté à la collection d’Alice');
  assert.strictEqual(alice.artifactId, artifactId, 'artefact reçu équipé automatiquement (aucun autre équipé)');
  console.log('Admin : attribution de fragments d’artefact ✔, artefact complet direct ✔');
}

// --- Stat "armor" d'un artefact : ajoute des PV max (visibles dans le
// profil comme la puissance), n'affecte jamais la puissance de combat. ---
{
  const rFinn = g.register({ username: 'Finn', password: 'secret9', speciesClass: 'RENARD_VOLEUR', email: 'finn@test.dev' });
  const finn = rFinn.player;
  const bogHeart = ARTIFACT_ITEMS.artifact_bog_heart; // { power: 0, armor: 18 }
  finn.hp = maxHp(finn); // pleine vie des deux côtés : isole la formule de la puissance de tout effet de blessure (woundFactor)
  const hpBefore = maxHp(finn);
  const powerBefore = combatPower(finn);
  assert.ok(g.adminGrantArtifact(alice, 'Finn', bogHeart.id).ok, 'artefact "armor" attribué pour le test');
  finn.hp = maxHp(finn);
  assert.strictEqual(maxHp(finn), hpBefore + bogHeart.stats.armor, 'PV max augmentés exactement du bonus "armor" de l’artefact');
  assert.strictEqual(combatPower(finn), powerBefore, 'la puissance de combat n’est pas affectée par le bonus "armor" (0 de puissance sur cet artefact)');
  // Retirer l'artefact ne doit jamais laisser des PV courants > PV max affichés.
  finn.hp = maxHp(finn);
  assert.ok(g.equipArtifact(finn, null).ok, 'artefact retiré');
  assert.ok(finn.hp <= maxHp(finn), 'PV courants jamais supérieurs aux PV max après le retrait de l’artefact');
  console.log('Artefacts : bonus "armor" ajoute des PV max ✔, sans effet sur la puissance ✔, PV bornés au retrait ✔');

  // maxPower() (affiché au profil comme "Puissance") doit refléter l'ajout
  // d'un artefact intégralement, même blessé — contrairement à combatPower(),
  // volontairement réduit par le facteur de blessure pour les vraies batailles.
  const dragonScale = ARTIFACT_ITEMS.artifact_dragon_scale; // { power: 20, armor: 20 }
  finn.artifactId = null;
  finn.hp = Math.max(1, Math.round(maxHp(finn) * 0.5)); // blessé à 50 %
  const maxPowerBefore = maxPower(finn);
  const combatPowerBefore = combatPower(finn);
  assert.ok(g.adminGrantArtifact(alice, 'Finn', dragonScale.id).ok, 'écaille du dragon attribuée, joueur blessé');
  assert.strictEqual(maxPower(finn), maxPowerBefore + dragonScale.stats.power, 'maxPower augmente exactement du bonus de puissance de l’artefact, peu importe l’état de santé');
  assert.ok(combatPower(finn) - combatPowerBefore < dragonScale.stats.power, 'combatPower (réelle, utilisée en bataille) reste réduite par la blessure, contrairement à maxPower');
  console.log('Puissance affichée au profil (maxPower) : ajout intégral d’un artefact même blessé ✔, combatPower réelle toujours réduite par la blessure ✔');
}

// --- Crédit Stripe (webhook) : appliqué même hors ligne, comptes/montants invalides refusés ---
alice.online = false;
const balanceBefore = alice[PREMIUM_CURRENCY.key];
const creditRes = g.creditMoonstones(alice.id, 45);
assert.ok(creditRes.ok && creditRes.total === balanceBefore + 45, 'crédit appliqué même hors ligne');
assert.strictEqual(alice[PREMIUM_CURRENCY.key], balanceBefore + 45, 'solde mis à jour');
assert.ok(!g.creditMoonstones('p_inconnu', 10).ok, 'compte introuvable refusé');
assert.ok(!g.creditMoonstones(alice.id, 0).ok, 'montant nul refusé');
assert.ok(!g.creditMoonstones(alice.id, -5).ok, 'montant négatif refusé');
alice.online = true;
console.log('Crédit Stripe (webhook) : appliqué même hors ligne ✔, compte/montant invalides refusés ✔');

// --- Notifications push : demande d'ami + MP, seulement si le destinataire est hors ligne ---
const rPushE = g.register({ username: 'PushE', password: 'secret1', speciesClass: 'LION_PALADIN', email: 'pushe@test.dev' });
const pushE = rPushE.player;
skipQuestsFor(pushE);
const rPushF = g.register({ username: 'PushF', password: 'secret1', speciesClass: 'CHAT_MAGICIEN', email: 'pushf@test.dev' });
const pushF = rPushF.player;
skipQuestsFor(pushF);
pushE.online = true;
pushF.online = false;

pushed.length = 0;
assert.ok(g.sendFriendRequest(pushE, 'PushF').ok, 'demande d’ami envoyée');
assert.strictEqual(pushed.length, 1, 'push envoyé pour une demande d’ami reçue hors ligne');
assert.strictEqual(pushed[0].id, pushF.id, 'push adressé au bon destinataire');

pushE.online = false;   // simule une déconnexion d'Ami E entre-temps
pushed.length = 0;
assert.ok(g.sendFriendRequest(pushF, 'PushE').ok, 'PushF (hors ligne) réciproque -> amitié auto-acceptée');
assert.strictEqual(pushed.length, 1, 'push envoyé pour une amitié auto-acceptée alors que l’autre est hors ligne');
assert.strictEqual(pushed[0].id, pushE.id, 'push adressé au membre hors ligne au moment de l’auto-acceptation');

pushE.online = true;
pushF.online = false;
pushed.length = 0;
const whisperOffline = g.say(pushE, 'Salut, tu es là ?', 'whisper', 'PushF');
assert.ok(whisperOffline.ok && whisperOffline.offline, 'MP envoyé, destinataire hors ligne');
assert.strictEqual(pushed.length, 1, 'push envoyé pour un MP reçu hors ligne');
assert.strictEqual(pushed[0].id, pushF.id, 'push adressé au destinataire hors ligne');
assert.ok(pushed[0].body.includes('Salut'), 'le push reprend le texte du message');

pushF.online = true;
pushed.length = 0;
const whisperOnline = g.say(pushE, 'Encore là ?', 'whisper', 'PushF');
assert.ok(whisperOnline.ok && !whisperOnline.offline, 'MP envoyé, destinataire en ligne');
assert.strictEqual(pushed.length, 0, 'pas de push si le destinataire est déjà en ligne (reçu en direct)');
console.log('Notifications push : demande d’ami ✔, amitié auto-acceptée ✔, MP hors ligne uniquement ✔');

// --- Notification push « Regain au maximum » : programmée à la déconnexion, ---
// --- déclenchée une seule fois, seulement une fois vraiment échue ---
pushF.pa = CONFIG.PA.MAX;
g.schedulePaFullNotify(pushF);
assert.strictEqual(pushF.pushPaFullAt, null, 'déjà pleine : rien à programmer');

pushF.pa = CONFIG.PA.MAX - 5;
const beforeSchedule = Date.now();
g.schedulePaFullNotify(pushF);
assert.ok(pushF.pushPaFullAt > beforeSchedule, 'échéance programmée dans le futur');
assert.strictEqual(pushF.pushPaFullSent, false, 'pas encore envoyé');

pushed.length = 0;
pushF.online = false;
g.checkPaFullNotifications();
assert.strictEqual(pushed.length, 0, 'aucun push avant l’échéance');

pushF.pushPaFullAt = Date.now() - 1;   // simule l'échéance atteinte
g.checkPaFullNotifications();
assert.strictEqual(pushed.length, 1, 'push envoyé une fois l’échéance atteinte, compte hors ligne');
assert.strictEqual(pushed[0].id, pushF.id);
assert.ok(pushF.pushPaFullSent, 'marqué comme envoyé');

pushed.length = 0;
g.checkPaFullNotifications();
assert.strictEqual(pushed.length, 0, 'pas de second envoi (déjà marqué envoyé)');

pushF.pushPaFullAt = Date.now() - 1;   // échéance de nouveau atteinte
pushF.pushPaFullSent = false;
pushF.online = true;
pushed.length = 0;
g.checkPaFullNotifications();
assert.strictEqual(pushed.length, 0, 'aucun push pour un compte désormais en ligne, même échéance atteinte');
console.log('Notifications push : Regain au maximum programmée à la déconnexion ✔, envoyée une seule fois ✔');

// --- Brouillard de guerre (compte) : même carte explorée quel que soit l'appareil ---
assert.deepStrictEqual(alice.exploredWorld, [], 'aucune tuile explorée par défaut');
let expRes = g.exploreTiles(alice, ['3,4', '-12,7']);
assert.ok(expRes.ok && expRes.added === 2, 'deux nouvelles tuiles ajoutées');
assert.strictEqual(alice.exploredWorld.length, 2, 'les tuiles sont bien mémorisées sur le compte');
expRes = g.exploreTiles(alice, ['3,4', '9,9']);
assert.strictEqual(expRes.added, 1, 'les doublons ne comptent pas, seule la nouveauté est ajoutée');
assert.strictEqual(alice.exploredWorld.length, 3, 'pas de doublon stocké');
expRes = g.exploreTiles(alice, ['<script>', 'foo', '', null, 42, '999,999,1']);
assert.strictEqual(expRes.added, 0, 'entrées invalides ignorées sans erreur');
assert.strictEqual(alice.exploredWorld.length, 3, 'aucune entrée invalide n’a été stockée');
assert.deepStrictEqual(g.exploreTiles(alice, []), { ok: true, added: 0 }, 'liste vide sans effet');
console.log('Brouillard de guerre : ajout ✔, déduplication ✔, entrées invalides filtrées ✔');

// --- Redistribution nocturne de la faune sauvage : ressources ET monstres,
// jamais les repères (capitale/villages/donjons/château) ---
const poiKinds = new Set(['capital', 'village', 'dungeon', 'castle']);
const poiSnapshot = [];
for (const t of g.tiles.values()) {
  if (t.content && poiKinds.has(t.content.kind)) poiSnapshot.push({ key: t.x + ',' + t.y, content: { ...t.content } });
}
assert.ok(poiSnapshot.length > 0, 'des repères (capitale/villages/donjons/châteaux) existent avant redistribution');

function wildKeysOf(tiles, kind) {
  return new Set([...tiles.values()].filter((t) => t.content && t.content.kind === kind).map((t) => t.x + ',' + t.y));
}
const resourceKeysBefore = wildKeysOf(g.tiles, 'resource');
const monsterKeysBefore = wildKeysOf(g.tiles, 'monster');
assert.ok(resourceKeysBefore.size > 0, 'des ressources existent avant toute redistribution');
assert.ok(monsterKeysBefore.size > 0, 'des monstres existent avant toute redistribution');
assert.strictEqual(g.wildSalt, 0, 'aucune redistribution n’a encore eu lieu');

const redist = g.redistributeWildlife();
assert.ok(redist.ok && redist.salt === 1, 'première redistribution : salt incrémenté à 1');
assert.strictEqual(g.wildSalt, 1);

for (const poi of poiSnapshot) {
  assert.deepStrictEqual(g.tiles.get(poi.key).content, poi.content, 'repère intact après redistribution : ' + poi.key);
}
const resourceKeysAfter = wildKeysOf(g.tiles, 'resource');
const monsterKeysAfter = wildKeysOf(g.tiles, 'monster');
assert.ok(resourceKeysAfter.size > 0, 'des ressources existent toujours après redistribution');
assert.ok(monsterKeysAfter.size > 0, 'des monstres existent toujours après redistribution');

function countSame(before, after) {
  let n = 0;
  for (const k of after) if (before.has(k)) n++;
  return n;
}
const sameResource = countSame(resourceKeysBefore, resourceKeysAfter);
const sameMonster = countSame(monsterKeysBefore, monsterKeysAfter);
assert.ok(sameResource < resourceKeysAfter.size, 'au moins une partie des ressources a changé de case (' + sameResource + '/' + resourceKeysAfter.size + ' inchangées)');
assert.ok(sameMonster < monsterKeysAfter.size, 'au moins une partie des monstres a changé de case (' + sameMonster + '/' + monsterKeysAfter.size + ' inchangés)');
for (const poi of poiSnapshot) {
  assert.ok(!resourceKeysAfter.has(poi.key), 'aucune ressource posée sur une case repère : ' + poi.key);
  assert.ok(!monsterKeysAfter.has(poi.key), 'aucun monstre posé sur une case repère : ' + poi.key);
}
for (const t of g.tiles.values()) {
  if (t.content && (t.content.kind === 'resource' || t.content.kind === 'monster')) {
    assert.strictEqual(t.content.inactiveUntil, 0, 'faune redistribuée immédiatement disponible : ' + t.content.kind);
  }
}
console.log('Redistribution nocturne : repères intacts ✔, ressources déplacées (' + (resourceKeysAfter.size - sameResource) + '/' + resourceKeysAfter.size +
  ') ✔, monstres déplacés (' + (monsterKeysAfter.size - sameMonster) + '/' + monsterKeysAfter.size + ') ✔, jamais sur une case spéciale ✔');

// Persistance : la disposition post-redistribution se reconstruit après un redémarrage
// à partir du seul salt (pas besoin de stocker la carte entière).
const snapWorld = JSON.parse(JSON.stringify(g.serialize()));
const gWorld2 = new Game(snapWorld.seed, snapWorld);
assert.strictEqual(gWorld2.wildSalt, g.wildSalt, 'salt de redistribution restauré après redémarrage');
for (const [key, t] of g.tiles) {
  assert.deepStrictEqual(gWorld2.tiles.get(key).content, t.content, 'disposition identique après redémarrage : ' + key);
}
console.log('Redistribution nocturne : disposition reconstruite après redémarrage à partir du seul salt ✔');

// --- OTP de connexion par email + mot de passe oublié ---
const rOtp = g.register({ username: 'OtpTester', password: 'secret1', speciesClass: 'LION_PALADIN', email: 'otp@test.dev' });
assert.ok(rOtp.ok, 'inscription OtpTester');
const otpUser = rOtp.player;
skipQuestsFor(otpUser);

// Connexion normale (register()/login() restent immédiats, sans OTP intégré —
// c'est l'appelant socket qui orchestre, voir server/index.js) puis OTP.
const { code: otpCode1 } = g.beginLoginOtp(otpUser);
assert.ok(!g.verifyLoginOtp(otpUser.id, '000000').ok, 'mauvais code OTP refusé');
assert.ok(!g.verifyLoginOtp('compte_inconnu', otpCode1).ok, 'compte inconnu refusé');
const rVerify = g.verifyLoginOtp(otpUser.id, otpCode1);
assert.ok(rVerify.ok && rVerify.player === otpUser, 'bon code OTP accepté');
assert.ok(!g.verifyLoginOtp(otpUser.id, otpCode1).ok, 'code déjà utilisé/expiré refusé à la deuxième tentative');

// Code expiré
g.beginLoginOtp(otpUser);
g.pendingLoginOtps.get(otpUser.id).expiresAt = Date.now() - 1000;
assert.ok(!g.verifyLoginOtp(otpUser.id, g.pendingLoginOtps.get(otpUser.id).code).ok, 'code expiré refusé');

// Trop de tentatives : invalide la session d'OTP en cours
g.beginLoginOtp(otpUser);
for (let i = 0; i < 5; i++) g.verifyLoginOtp(otpUser.id, '000000');
assert.ok(!g.pendingLoginOtps.has(otpUser.id), 'trop de tentatives invalide la session OTP');

// Renvoi : bloqué par le cooldown juste après un envoi, débloqué une fois passé
const { code: otpCode2 } = g.beginLoginOtp(otpUser);
assert.ok(!g.resendLoginOtp(otpUser.id).ok, 'renvoi refusé pendant le cooldown');
g.pendingLoginOtps.get(otpUser.id).lastSentAt = Date.now() - 60000;
const rResend = g.resendLoginOtp(otpUser.id);
assert.ok(rResend.ok && rResend.code !== otpCode2, 'renvoi accepté hors cooldown, nouveau code généré');
console.log('OTP de connexion : bon/mauvais code ✔, expiration ✔, anti-brute-force ✔, cooldown de renvoi ✔');

// Compte créé avant l'ajout de l'OTP (pas d'email) : ajout forcé
otpUser.email = null;
assert.ok(!g.setAccountEmail(otpUser.id, 'pas-un-email').ok, 'email invalide refusé (ajout forcé)');
assert.ok(g.setAccountEmail(otpUser.id, 'otp2@test.dev').ok, 'email ajouté rétroactivement');
assert.strictEqual(otpUser.email, 'otp2@test.dev', 'email mis à jour sur le compte');

// Mot de passe oublié
assert.strictEqual(g.requestPasswordReset('compte_inconnu').found, false, 'compte inconnu : found=false (pas d’énumération dans le message)');
otpUser.email = null;
assert.strictEqual(g.requestPasswordReset('OtpTester').hasEmail, false, 'compte sans email : hasEmail=false');
otpUser.email = 'otp2@test.dev';
const rReset = g.requestPasswordReset('OtpTester');
assert.ok(rReset.found && rReset.hasEmail && rReset.code, 'demande de réinitialisation avec email : code généré');
assert.ok(!g.resetPassword('OtpTester', '000000', 'nouveauMdp1').ok, 'mauvais code de réinitialisation refusé');
assert.ok(!g.resetPassword('OtpTester', rReset.code, 'x').ok, 'nouveau mot de passe trop court refusé');
const oldOtpToken = otpUser.token;
assert.ok(g.resetPassword('OtpTester', rReset.code, 'nouveauMdp1').ok, 'réinitialisation acceptée avec bon code');
assert.ok(!g.authToken(oldOtpToken).ok, 'ancien token invalidé après réinitialisation');
assert.ok(!g.login({ username: 'OtpTester', password: 'secret1' }).ok, 'ancien mot de passe refusé après réinitialisation');
assert.ok(g.login({ username: 'OtpTester', password: 'nouveauMdp1' }).ok, 'nouveau mot de passe accepté');
console.log('Mot de passe oublié : email requis ✔, code vérifié ✔, mot de passe changé + session invalidée ✔');

// --- Persistance aller-retour (token, état ET mot de passe) ---
const snap = JSON.parse(JSON.stringify(g.serialize()));
const g2 = new Game(snap.seed, snap);
assert.strictEqual(g2.chatLog.length, g.chatLog.length, 'historique de discussion restauré après redémarrage');
const rTok = g2.authToken(alice.token);
assert.ok(rTok.ok && rTok.player.weapon.tier === 1, 'état restauré via token');
assert.strictEqual(rTok.player.characters.length, 2, 'les deux formes survivent à la persistance');
assert.strictEqual(rTok.player.characters[1].speciesClass, 'CERF_DRUIDE', 'forme secondaire intacte');
assert.deepStrictEqual(rTok.player.exploredWorld.slice().sort(), alice.exploredWorld.slice().sort(),
  'brouillard de guerre du compte restauré après redémarrage (même carte sur tout appareil)');
assert.ok(g2.login({ username: 'Alice', password: 'secret1' }).ok, 'mot de passe conservé après restauration');
assert.ok(!g2.login({ username: 'Alice', password: 'faux' }).ok, 'mauvais mot de passe refusé après restauration');

// --- Reset DEV ---
const r4 = g2.dev(rTok.player, { reset: true });
assert.ok(r4.ok && r4.reset, 'reset de compte');
assert.ok(!g2.authToken(rTok.player.token).ok, 'token invalidé');
assert.ok(!g2.login({ username: 'Alice', password: 'secret1' }).ok, 'connexion impossible après reset');

// --- Quêtes : chaîne guidée (js/quests.js) ---
const rQuestor = g.register({ username: 'Questor', password: 'secret1', speciesClass: 'OURS_GUERRIER', email: 'questor@test.dev' });
assert.ok(rQuestor.ok, 'compte de test pour les quêtes');
const questor = rQuestor.player;
questor.online = true;
questor.pos = { x: 0, y: 0 }; questor.mapId = 'world';

// 1) intro_move : la toute première quête, jusqu'à s'être éloigné de 5 cases
// de la Capitale (pas exploredWorld.length : le brouillard de guerre révèle
// déjà ~60 cases rien qu'en apparaissant à (0,0), sans le moindre mouvement).
assert.strictEqual(currentQuestFor(questor).quest.id, 'intro_move', 'première quête de la chaîne');
assert.deepStrictEqual(checkQuests(questor), [], 'intro_move pas encore complétée (encore à la Capitale)');
questor.pos = { x: 5, y: 0 };
let done = checkQuests(questor);
assert.strictEqual(done.length, 1, 'intro_move se complète après 5 cases de mouvement réel');
assert.strictEqual(done[0].id, 'intro_move');
assert.strictEqual(questor.gold, 10, 'récompense intro_move créditée (10 or)');
assert.deepStrictEqual(checkQuests(questor), [], 'intro_move ne se recomplète pas une deuxième fois');
questor.pos = { x: 0, y: 0 };   // retour à la Capitale pour forger (upgrade() l'exige)

// 2) gear_tier_1 : seule quête détaillant la récolte, 4 étapes dans l'ordre —
// testée avec le vrai flux (upgrade()), pas une simulation, pour couvrir le
// mécanisme que la quête est censée enseigner.
assert.strictEqual(currentQuestFor(questor).quest.id, 'gear_tier_1', 'avance à la quête d’équipement T1');
assert.strictEqual(currentQuestFor(questor).step.key, 'gather_weapon', 'première étape : récolter pour l’arme');
const w1 = require('../js/config.js').UPGRADE_RECIPES.weapon[1];
for (const [k, n] of Object.entries(w1)) questor.inventory[k] = n;
assert.strictEqual(currentQuestFor(questor).step.key, 'craft_weapon', 'ressources d’arme réunies → étape suivante');
assert.ok(g.upgrade(questor, 'weapon').ok, 'forge de l’arme T1');
assert.strictEqual(currentQuestFor(questor).step.key, 'gather_armor', 'arme forgée → étape suivante (récolter l’armure)');
const a1 = require('../js/config.js').UPGRADE_RECIPES.armor[1];
for (const [k, n] of Object.entries(a1)) questor.inventory[k] = n;
assert.strictEqual(currentQuestFor(questor).step.key, 'craft_armor', 'ressources d’armure réunies → dernière étape');
assert.ok(g.upgrade(questor, 'armor').ok, 'forge de l’armure T1');
assert.ok(questor.completedQuests.includes('gear_tier_1'), 'gear_tier_1 complétée par upgrade() lui-même (notifyQuests déjà câblé)');

// 3) first_kill : se valide automatiquement si déjà acquis avant de devenir active.
assert.strictEqual(currentQuestFor(questor).quest.id, 'first_kill');
questor.stats.monsterKills = 1;   // « déjà tué un monstre avant » — pas une nouvelle action après coup
done = checkQuests(questor);
assert.strictEqual(done.length, 1, 'first_kill se valide dès le prochain checkQuests, sans nouveau kill');
assert.strictEqual(done[0].id, 'first_kill');

// 4) gear_tier_2..6 : un seul objectif (arme + armure), aucune sous-étape de récolte.
assert.strictEqual(currentQuestFor(questor).quest.id, 'gear_tier_2');
assert.strictEqual(currentQuestFor(questor).quest.steps.length, 1, 'gear_tier_2 : un objectif unique, pas de récolte');
questor.weapon.tier = 2;
assert.deepStrictEqual(checkQuests(questor), [], 'gear_tier_2 attend AUSSI l’armure');
questor.armor.tier = 2;
done = checkQuests(questor);
assert.strictEqual(done[0].id, 'gear_tier_2', 'gear_tier_2 complétée une fois arme ET armure au tier');

// 5) join_guild s'intercale après gear_tier_3.
questor.weapon.tier = 3; questor.armor.tier = 3;
checkQuests(questor);
assert.strictEqual(currentQuestFor(questor).quest.id, 'join_guild');
assert.ok(g.createGuild(questor, 'GuildeQuestor').ok, 'fonder une guilde valide join_guild');
assert.ok(questor.completedQuests.includes('join_guild'));

// 6) first_duel, puis fin de la chaîne à gear_tier_6.
assert.strictEqual(currentQuestFor(questor).quest.id, 'gear_tier_4');
questor.weapon.tier = 4; questor.armor.tier = 4;
checkQuests(questor);
assert.strictEqual(currentQuestFor(questor).quest.id, 'first_duel');
questor.duels.losses = 1;   // PERDU le duel — la quête doit valider quand même (participer suffit)
checkQuests(questor);
assert.strictEqual(currentQuestFor(questor).quest.id, 'gear_tier_5', 'first_duel validée même en cas de défaite');
questor.weapon.tier = 5; questor.armor.tier = 5;
checkQuests(questor);
assert.strictEqual(currentQuestFor(questor).quest.id, 'gear_tier_6');
questor.weapon.tier = 6; questor.armor.tier = 6;
checkQuests(questor);
assert.strictEqual(currentQuestFor(questor), null, 'chaîne principale entièrement terminée');

// 7) Quêtes parallèles : indépendantes de la position dans la chaîne, se
// débloquent par seuil de maîtrise d'arme, pas par avancement de la chaîne.
const rParallel = g.register({ username: 'QuestorParallel', password: 'secret1', speciesClass: 'OURS_GUERRIER', email: 'qp@test.dev' });
const parallel = rParallel.player;
parallel.online = true;
assert.strictEqual(activeParallelQuestsFor(parallel).length, 0, 'aucune quête parallèle sous maîtrise 4');
parallel.weaponMastery = 4;
const active4 = activeParallelQuestsFor(parallel);
assert.strictEqual(active4.length, 1, 'first_boss se débloque à maîtrise 4');
assert.strictEqual(active4[0].id, 'first_boss');
// La chaîne principale de "parallel" n'a même pas commencé (intro_move pas
// fait) : first_boss doit pouvoir se compléter quand même, sans lien avec elle.
assert.strictEqual(currentQuestFor(parallel).quest.id, 'intro_move', 'chaîne principale indépendante, toujours au début');
parallel.stats.bossKills = 1;
done = checkQuests(parallel);
assert.ok(done.some((q) => q.id === 'first_boss'), 'first_boss se complète malgré une chaîne principale non entamée');
assert.strictEqual(parallel.gold, 60, 'récompense first_boss créditée');
parallel.weaponMastery = 6;
assert.strictEqual(activeParallelQuestsFor(parallel).length, 1, 'world_boss_intro se débloque à maîtrise 6 (first_boss déjà acquise)');
parallel.stats.worldBossKills = 1;
done = checkQuests(parallel);
assert.ok(done.some((q) => q.id === 'world_boss_intro'), 'world_boss_intro se complète');
assert.ok(parallel.titles.includes('Légende en devenir'), 'titre capstone accordé');

// 8) Rattrapage : un joueur déjà bien avancé (ou un octroi admin) avant même
// le premier checkQuests complète plusieurs quêtes d'un coup, pas une par une.
const rCatchup = g.register({ username: 'QuestorCatchup', password: 'secret1', speciesClass: 'OURS_GUERRIER', email: 'qc@test.dev' });
const catchup = rCatchup.player;
catchup.online = true;
catchup.pos = { x: 5, y: 0 };
catchup.weapon.tier = 6; catchup.armor.tier = 6;
catchup.stats.monsterKills = 1;
catchup.guildId = 'g_fake_for_test';
catchup.duels.wins = 1;
done = checkQuests(catchup);
assert.strictEqual(done.length, QUESTS.length, 'toutes les quêtes de la chaîne principale rattrapées en un seul appel');
assert.strictEqual(currentQuestFor(catchup), null, 'chaîne principale terminée d’un coup');
catchup.guildId = null;   // restaure un état cohérent pour le reste du test

// 9) Changer de personnage réinitialise completedQuests sans lever d'exception
// (le slot vierge n'a pas la progression de gear de l'ancien personnage).
assert.ok(g.createCharacter(questor, 'CERF_DRUIDE').ok, 'nouveau personnage pour Questor');
assert.ok(g.switchCharacter(questor, 1).ok, 'bascule vers le nouveau slot');
assert.deepStrictEqual(questor.completedQuests, [], 'nouveau slot : chaîne de quêtes repartie de zéro');
assert.ok(g.switchCharacter(questor, 0).ok, 'retour au premier personnage');
assert.ok(questor.completedQuests.includes('gear_tier_6'), 'progression de l’ancien slot restaurée après rebascule');

// 10) Une étape dont check() lève une exception ne fait pas planter checkQuests
// (retourne juste false pour cette étape) — filet nécessaire car les steps
// lisent des champs dynamiques qui pourraient être malformés. Doit cibler une
// quête réellement EN COURS (unlock=true côté parallèle, ou première étape non
// complétée côté chaîne) : sinon le check court-circuite avant même d'être
// appelé et le test ne prouverait rien.
const rThrow = g.register({ username: 'QuestorThrow', password: 'secret1', speciesClass: 'OURS_GUERRIER', email: 'qt@test.dev' });
const throwPlayer = rThrow.player;
throwPlayer.online = true;
assert.strictEqual(currentQuestFor(throwPlayer).quest.id, 'intro_move', 'première quête, forcément en cours pour un compte neuf');
const introMoveQuest = QUESTS.find((q) => q.id === 'intro_move');
const originalCheck = introMoveQuest.steps[0].check;
introMoveQuest.steps[0].check = () => { throw new Error('check défaillant (simulation de test)'); };
assert.doesNotThrow(() => checkQuests(throwPlayer), 'une étape qui lève une exception ne fait pas planter checkQuests');
assert.ok(!throwPlayer.completedQuests.includes('intro_move'), 'l’étape en échec (exception) n’est pas comptée comme réussie');
introMoveQuest.steps[0].check = originalCheck;
assert.deepStrictEqual(checkQuests(throwPlayer), [], 'check restauré : la quête reste incomplète (0 case explorée)');

console.log('Quêtes : chaîne principale ✔ (intro, équipement T1-T6, combat, guilde, duel), quêtes parallèles indépendantes ✔, rattrapage ✔, changement de personnage ✔');

console.log('\ntest-game : tous les tests passent ✔');

function tileKeyOf(t) { return t.x + ',' + t.y; }
