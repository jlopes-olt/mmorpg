'use strict';

/* Test de la logique multijoueur (Game), sans réseau. */

process.env.SPEED = '1';

const assert = require('assert');
const { Game, CHAT_LOG_MAX } = require('./game.js');
const {
  CONFIG, CLASSES, MAX_CHAR_SLOTS, MONSTER_FORCE, playerForce, maxHp,
  combatPower, teamPowerOf, winChance, BUFF_COMBATS,
  CASTLE_TERRAINS, CASTLE_BASE_HP, CASTLE_HP_PER_LEVEL, CASTLE_MAX_LEVEL,
  CASTLE_CLAIM_COST_GOLD, CASTLE_REINFORCE_COST_GOLD, CASTLE_REPAIR_GOLD_PER_HP,
  CASTLE_DAMAGE_PER_ASSAULT, CASTLE_ZONE_GOLD_BONUS,
  SIEGE_ENGINE_ITEM, SIEGE_ENGINE_RECIPES, SIEGE_ENGINE_FORCE, SIEGE_ENGINE_DAMAGE,
  CASTLE_FORTIFY_COST_GOLD, CASTLE_FORTIFY_BONUS_PER_LEVEL, stackKey,
  PREMIUM_CURRENCY, GOLD_PACKS, PA_SCROLL_COST_MOONSTONES, PA_SCROLL_COOLDOWN_MS,
  MOUNT_ITEMS,
} = require('../js/config.js');
const { ACHIEVEMENTS } = require('../js/achievements.js');

const g = new Game(CONFIG.WORLD.SEED, null);
const sent = [];
g.send = (id, ev, data) => sent.push({ id, ev, data });
g.broadcast = () => {};
const pushed = [];
g.sendPush = (id, title, body) => pushed.push({ id, title, body });

// --- Comptes : inscription / connexion / token ---
let r = g.register({ username: 'Alice', password: 'secret1', speciesClass: 'LION_PALADIN' });
assert.ok(r.ok && r.created, 'inscription');
const alice = r.player;
alice.online = true;

assert.ok(!g.register({ username: 'Al', password: 'secret1', speciesClass: 'LION_PALADIN' }).ok, 'nom trop court refusé');
assert.ok(!g.register({ username: 'Zoe', password: '123', speciesClass: 'LION_PALADIN' }).ok, 'mot de passe trop court refusé');
assert.ok(!g.register({ username: 'alice', password: 'autre', speciesClass: 'CHAT_MAGICIEN' }).ok, 'nom déjà pris (insensible à la casse)');

const r2 = g.authToken(alice.token);
assert.strictEqual(r2.player, alice, 'reprise de session par token');
assert.ok(!g.authToken('mauvais-token').ok, 'token invalide refusé');

assert.ok(!g.login({ username: 'Alice', password: 'mauvais' }).ok, 'mauvais mot de passe refusé');
const oldToken = alice.token;
const rLogin = g.login({ username: 'ALICE', password: 'secret1' });
assert.ok(rLogin.ok, 'connexion (insensible à la casse)');
assert.notStrictEqual(alice.token, oldToken, 'token de session régénéré à la connexion');
assert.ok(!g.authToken(oldToken).ok, 'ancien token invalidé');

r = g.register({ username: 'Bob', password: 'secret2', speciesClass: 'CERF_DRUIDE' });
assert.ok(r.ok, 'second compte');
const bob = r.player;
bob.online = true;

// --- Déplacement ---
let moved = false;
for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
  if (g.move(alice, dx, dy).ok) { moved = true; break; }
}
assert.ok(moved, 'déplacement');
assert.strictEqual(alice.pa, CONFIG.PA.START - 1, '1 PA par case');

// --- Progression T0 -> T5 cohérente ---
assert.strictEqual(alice.weapon.tier, 0, 'arme de départ T0');
assert.strictEqual(alice.armor.tier, 0, 'armure de départ T0');
assert.ok(Object.keys(CONFIG.COSTS.UPGRADE).includes('1'), 'craft T1 disponible');
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
  for (const speciesClass of Object.keys(CLASSES)) {
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

assert.ok(g.createRaid(alice, mon.x, mon.y).ok, 'lobby créé');
assert.ok(g.joinRaid(bob, tileKeyOf(mon)).ok, 'Bob rejoint');
g.tick(5000);   // le temps que les bots rejoignent

const key = 'world|' + tileKeyOf(mon);   // clé de raid multi-cartes
const raid = g.raids.get(key);
assert.ok(raid, 'lobby encore ouvert (30 s non écoulées)');
assert.ok(raid.participants.length >= 2, 'participants présents : ' + raid.participants.length);

assert.ok(!g.startRaidNow(bob, key).ok, 'seul le chef peut lancer');
g.rng = () => 0;   // victoire forcée pour tester les récompenses
assert.ok(g.startRaidNow(alice, key).ok, 'lancement immédiat par le chef');
g.tick(300);
g.rng = Math.random;
assert.ok(!g.raids.has(key), 'raid résolu');

const results = sent.filter((m) => m.ev === 'result');
assert.strictEqual(results.length, 2, 'résultat envoyé aux deux humains');
assert.ok(results[0].data.victory, 'victoire attendue');
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

// 1) Défaite forcée (rng → 0,999) : MORT, retour Capitale, or intact
alice.pos = { x: boss.x - 1, y: boss.y };
bob.pos = { x: boss.x + 1, y: boss.y };
alice.pa = 50; bob.pa = 50;
alice.hp = 100; bob.hp = 100;
const goldBeforeDeath = alice.gold;
sent.length = 0;
g.rng = () => 0.999;
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
assert.strictEqual(alice.hp, Math.ceil(maxHp(alice) * CONFIG.COMBAT.DEATH_HP_PCT), 'réveil à 25 % des PV');
assert.strictEqual(alice.gold, goldBeforeDeath, 'aucune perte d’or à la mort');

// 2) Victoire forcée (rng → 0) : Rempart d'équipe + Sève en % des PV max
let rr = g.register({ username: 'Cara', password: 'secret3', speciesClass: 'OURS_GUERRIER' });
assert.ok(rr.ok, 'troisième compte');
const cara = rr.player;
cara.online = true;
alice.pos = { x: boss.x - 1, y: boss.y };
bob.pos = { x: boss.x + 1, y: boss.y };
cara.pos = { x: boss.x, y: boss.y + 1 };
cara.pa = 50; alice.pa = 50; bob.pa = 50;
alice.hp = 50; bob.hp = 50; cara.hp = 50;
sent.length = 0;
g.rng = () => 0;
assert.ok(g.createRaid(alice, boss.x, boss.y).ok, 'second lobby T5');
assert.ok(g.joinRaid(bob, boss.x + ',' + boss.y).ok);
assert.ok(g.joinRaid(cara, boss.x + ',' + boss.y).ok);
assert.ok(g.startRaidNow(alice, boss.x + ',' + boss.y).ok);
g.tick(300);
res = sent.filter((m) => m.ev === 'result').map((m) => m.data);
assert.strictEqual(res.length, 3, 'résultats envoyés aux trois');
assert.ok(res[0].victory, 'victoire forcée');
assert.strictEqual(res[0].hpLoss, 13, 'Rempart : usure réduite de 30 % (19 → 13)');
const aliceHeal = Math.round(maxHp(alice) * CONFIG.COMBAT.DRUID_HEAL_PCT);
const caraHeal = Math.round(maxHp(cara) * CONFIG.COMBAT.DRUID_HEAL_PCT);
assert.strictEqual(alice.hp, 50 - 13 + aliceHeal, 'Sève : +15 % des PV max après victoire');
assert.strictEqual(cara.hp, 50 - 13 + caraHeal, 'Rempart + Sève profitent aussi à l’Ours');
g.rng = Math.random;
console.log('Combat : mort en défaite ✔, Sève % ✔, Rempart ✔');

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
g.rng = () => 0;   // victoire ET drop garantis
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

const rCarl = g.register({ username: 'Carl', password: 'secret3', speciesClass: 'RENARD_VOLEUR' });
assert.ok(rCarl.ok, 'troisième compte');
const carl = rCarl.player;
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
assert.ok(g.adminSetRole(alice, 'Carl', 'user').ok, 'admin : rétrogradation');
assert.strictEqual(carl.role, 'user', 'compte cible rétrogradé');
assert.ok(!g.adminSetRole(alice, 'Carl', 'superadmin').ok, 'rôle invalide refusé');

const stats = g.adminStats();
assert.ok(stats.total >= 3 && stats.admins >= 1, 'stats globales cohérentes');
const carlRow = g.adminPlayerList().find((row) => row.username === 'Carl');
assert.ok(carlRow && carlRow.gold === carl.gold && carlRow.role === 'user', 'liste des comptes à jour');
console.log('Administration : rôles ✔, triche gatée ✔, dashboard ✔');

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
g.rng = () => 0;   // Bob l'emporte à coup sûr
assert.ok(g.respondDuelInvite(carl, bob.id, true).ok, 'duel accepté');
g.rng = Math.random;

const duelResults = sent.filter((m) => m.ev === 'duelResult');
assert.strictEqual(duelResults.length, 2, 'résultat envoyé aux deux duellistes');
const bobResult = duelResults.find((m) => m.id === bob.id).data;
const carlResult = duelResults.find((m) => m.id === carl.id).data;
assert.ok(bobResult.won && !carlResult.won, 'Bob remporte le duel forcé');
assert.strictEqual(bobResult.opponent, 'Carl', 'adversaire de Bob correctement identifié');
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

const siegeKey = 'siege:FORET';
alice.pa = 50; alice.hp = maxHp(alice);
assert.ok(g.createSiege(alice, 'FORET').ok, 'lobby de siège créé');
assert.strictEqual(alice.status, 'LOBBY_COMBAT', 'Alice passe en lobby le temps du siège');
assert.strictEqual(alice.raidKey, siegeKey, 'la clé de siège est bien celle attendue');
assert.ok(g.raids.has(siegeKey), 'le lobby de siège existe dans this.raids');
assert.ok(!g.joinRaid(bob, siegeKey).ok, 'un membre de la guilde défenseuse ne peut pas rejoindre le siège adverse');
assert.ok(!g.startRaidNow(bob, siegeKey).ok, 'seule la meneuse du siège peut le lancer');

g.rng = () => 0.999;   // assaut repoussé à coup sûr
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

alice.pos = { x: foretCastleTile.x, y: foretCastleTile.y };
alice.pa = 50; alice.hp = maxHp(alice); alice.status = 'IDLE';
g.rng = () => 0;   // assaut réussi à coup sûr
const beforeHitHp = g.castleOf('FORET').hp;
sent.length = 0;
assert.ok(g.createSiege(alice, 'FORET').ok, 'second lobby de siège créé');
assert.ok(g.startRaidNow(alice, siegeKey).ok);
g.tick(300);
siegeResults = sent.filter((m) => m.ev === 'siegeResult').map((m) => m.data);
assert.ok(siegeResults[0].victory && !siegeResults[0].captured, 'assaut réussi mais château pas encore pris');
assert.strictEqual(g.castleOf('FORET').hp, beforeHitHp - CASTLE_DAMAGE_PER_ASSAULT, 'PS réduits du montant par assaut');

// Assauts répétés (lobby → lancement → résolution) jusqu'à la capture complète
let guard = 0;
while (g.castleOf('FORET').ownerGuildId !== alice.guildId && guard < 20) {
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
const rDaveOff = g.register({ username: 'DaveOff', password: 'secret1', speciesClass: 'OURS_GUERRIER' });
const daveOff = rDaveOff.player;
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
g.rng = () => 0.999;   // assaut repoussé à coup sûr (issue forcée, seule la puissance de défense nous intéresse ici)
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
g.rng = () => 0.999;   // assaut repoussé à coup sûr
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
assert.ok(g.createSiege(alice, 'MONTAGNE').ok, 'second lobby de siège');
assert.ok(g.deploySiegeEngine(alice, montagneSiegeKey, 1).ok, 'engin redéployé pour ce nouveau siège');
g.castleOf('MONTAGNE').hp = CASTLE_DAMAGE_PER_ASSAULT + SIEGE_ENGINE_DAMAGE[1];   // pile de quoi tomber à 0
g.rng = () => 0;   // assaut réussi à coup sûr
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
g.rng = () => 0;   // victoire garantie
assert.ok(g.createRaid(alice, foretMob.x, foretMob.y).ok, 'raid forêt pour vérifier le bonus de zone');
assert.ok(g.startRaidNow(alice, foretMob.x + ',' + foretMob.y).ok);
g.tick(300);
g.rng = Math.random;
Math.random = savedRandom;
const zoneResult = sent.filter((m) => m.ev === 'result' && m.id === alice.id).map((m) => m.data)[0];
const expectedGold = Math.ceil((3 + foretMob.content.tier * 4) * CASTLE_ZONE_GOLD_BONUS);
assert.strictEqual(zoneResult.gold, expectedGold, 'or bonifié de +' + Math.round((CASTLE_ZONE_GOLD_BONUS - 1) * 100) + ' % pour la guilde propriétaire de la zone');
console.log('Bonus de zone : or bonifié pour la guilde propriétaire ✔');

// --- Parchemin d'Endurance : achat en inventaire (sans limite), utilisation cooldownée 1-2/jour ---
alice.status = 'IDLE';
alice.pa = 10;
alice[PREMIUM_CURRENCY.key] = 2;
const scrollKey = stackKey('PARCHEMIN_ENDURANCE', 1);
delete alice.inventory[scrollKey];
let paScrollRes = g.buyPaScroll(alice);
assert.ok(!paScrollRes.ok, 'achat refusé sans assez de monnaie premium');
alice[PREMIUM_CURRENCY.key] = PA_SCROLL_COST_MOONSTONES * 3;
paScrollRes = g.buyPaScroll(alice);
assert.ok(paScrollRes.ok, 'achat réussi avec assez de monnaie premium');
assert.strictEqual(alice.inventory[scrollKey], 1, 'le parchemin est stocké en inventaire, pas utilisé immédiatement');
assert.strictEqual(alice.pa, 10, 'l’achat seul ne recharge pas l’endurance');
paScrollRes = g.buyPaScroll(alice);
assert.ok(paScrollRes.ok && alice.inventory[scrollKey] === 2, 'on peut en acheter plusieurs d’avance, sans limite à l’achat');

alice.lastPaScrollAt = -PA_SCROLL_COOLDOWN_MS;   // hors cooldown, quel que soit g.now
let useRes = g.consume(alice, scrollKey);
assert.ok(useRes.ok, 'utilisation réussie hors cooldown');
assert.strictEqual(alice.pa, CONFIG.PA.MAX, 'endurance rechargée au maximum à l’utilisation');
assert.strictEqual(alice.inventory[scrollKey], 1, 'un seul parchemin consommé');

alice.pa = 5;   // redescend l'endurance pour isoler le test de cooldown
useRes = g.consume(alice, scrollKey);
assert.ok(!useRes.ok, 'refuse en plein cooldown malgré endurance basse et parchemin en stock');
assert.strictEqual(alice.inventory[scrollKey], 1, 'le parchemin n’est pas consommé sur un essai refusé');
g.now += PA_SCROLL_COOLDOWN_MS + 1;
useRes = g.consume(alice, scrollKey);
assert.ok(useRes.ok, 'de nouveau disponible une fois le cooldown écoulé');
assert.strictEqual(alice.inventory[scrollKey], undefined, 'dernier parchemin consommé, la pile est retirée de l’inventaire');

g.now += PA_SCROLL_COOLDOWN_MS + 1;
assert.ok(!g.consume(alice, scrollKey).ok, 'refuse sans parchemin en stock');
alice[PREMIUM_CURRENCY.key] = PA_SCROLL_COST_MOONSTONES;
g.buyPaScroll(alice);
useRes = g.consume(alice, scrollKey);
assert.ok(!useRes.ok, 'refuse d’utiliser si l’endurance est déjà au maximum');
assert.strictEqual(alice.inventory[scrollKey], 1, 'le parchemin n’est pas consommé si l’endurance était déjà pleine');
console.log('Parchemin d’Endurance : achat en inventaire sans limite ✔, utilisation recharge au maximum ✔, cooldown 1-2/jour à l’usage ✔, jamais consommé sur un refus ✔');

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
const rPushE = g.register({ username: 'PushE', password: 'secret1', speciesClass: 'LION_PALADIN' });
const pushE = rPushE.player;
const rPushF = g.register({ username: 'PushF', password: 'secret1', speciesClass: 'CHAT_MAGICIEN' });
const pushF = rPushF.player;
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

// --- Notification push « Endurance pleine » : programmée à la déconnexion, ---
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
console.log('Notifications push : Endurance pleine programmée à la déconnexion ✔, envoyée une seule fois ✔');

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

console.log('\ntest-game : tous les tests passent ✔');

function tileKeyOf(t) { return t.x + ',' + t.y; }
