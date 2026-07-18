'use strict';

/* Test de la logique multijoueur (Game), sans réseau. */

process.env.SPEED = '1';

const assert = require('assert');
const { Game } = require('./game.js');
const {
  CONFIG, CLASSES, MONSTER_FORCE, playerForce, maxHp,
  combatPower, teamPowerOf, winChance, BUFF_COMBATS,
} = require('../js/config.js');

const g = new Game(CONFIG.WORLD.SEED, null);
const sent = [];
g.send = (id, ev, data) => sent.push({ id, ev, data });
g.broadcast = () => {};

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
      hp: 100 + (tier - 1) * 15,
    };
    const pParity = winChance(teamPowerOf([parity]), MONSTER_FORCE[tier]);
    assert.ok(pParity >= 0.5 && pParity <= 0.92,
      speciesClass + ' à parité vs T' + tier + ' : ' + Math.round(pParity * 100) + ' % (attendu 50-92)');

    const geared = { ...parity, weapon: { tier }, armor: { tier }, hp: 100 + tier * 15 };
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

// --- Voyage village ---
let village = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'village') { village = t; break; }
}
assert.ok(village, 'village trouvé');
alice.pos = { x: village.x, y: village.y };
assert.ok(g.teleportVillage(alice, 0, 0).ok, 'téléportation vers la capitale');
assert.deepStrictEqual(alice.pos, { x: 0, y: 0 }, 'arrivée à la capitale');

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
assert.strictEqual(alice.hp, 50 - 13 + 15, 'Sève : +15 % des PV max (100) après victoire');
assert.strictEqual(cara.hp, 50 - 13 + 15, 'Rempart + Sève profitent aussi à l’Ours');
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
const t5p = (cls) => ({ speciesClass: cls || 'RENARD_VOLEUR', weapon: { tier: 5 }, armor: { tier: 5 }, weaponMastery: 5, hp: 175 });
const t6p = (cls) => ({ speciesClass: cls || 'RENARD_VOLEUR', weapon: { tier: 6 }, armor: { tier: 6 }, weaponMastery: 5, hp: 190 });
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
alice.armor.tier = 2;                                    // Lion : 130 PV max
alice.hp = 65;                                           // 50 %
const paBefore = alice.pa;
const invBefore = JSON.stringify(alice.inventory);
const lionMastery = alice.weaponMastery;
assert.ok(g.switchCharacter(alice, 1).ok, 'métamorphose à la Capitale');
assert.strictEqual(alice.speciesClass, 'CERF_DRUIDE', 'forme active changée');
assert.strictEqual(alice.hp, 50, 'PV en pourcentage : 50 % de 100 (armure T0)');
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

// --- Persistance aller-retour (token, état ET mot de passe) ---
const snap = JSON.parse(JSON.stringify(g.serialize()));
const g2 = new Game(snap.seed, snap);
const rTok = g2.authToken(alice.token);
assert.ok(rTok.ok && rTok.player.weapon.tier === 1, 'état restauré via token');
assert.strictEqual(rTok.player.characters.length, 2, 'les deux formes survivent à la persistance');
assert.strictEqual(rTok.player.characters[1].speciesClass, 'CERF_DRUIDE', 'forme secondaire intacte');
assert.ok(g2.login({ username: 'Alice', password: 'secret1' }).ok, 'mot de passe conservé après restauration');
assert.ok(!g2.login({ username: 'Alice', password: 'faux' }).ok, 'mauvais mot de passe refusé après restauration');

// --- Reset DEV ---
const r4 = g2.dev(rTok.player, { reset: true });
assert.ok(r4.ok && r4.reset, 'reset de compte');
assert.ok(!g2.authToken(rTok.player.token).ok, 'token invalidé');
assert.ok(!g2.login({ username: 'Alice', password: 'secret1' }).ok, 'connexion impossible après reset');

console.log('\ntest-game : tous les tests passent ✔');

function tileKeyOf(t) { return t.x + ',' + t.y; }
