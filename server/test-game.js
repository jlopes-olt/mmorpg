'use strict';

/* Test de la logique multijoueur (Game), sans réseau. */

process.env.SPEED = '1';

const assert = require('assert');
const { Game } = require('./game.js');
const { CONFIG, CLASSES, MONSTER_FORCE, playerForce } = require('../js/config.js');

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

for (let tier = 1; tier <= 5; tier++) {
  let minSoloForce = Infinity;
  for (const speciesClass of Object.keys(CLASSES)) {
    const sample = {
      speciesClass,
      weapon: { tier: tier - 1 },
      armor: { tier: Math.max(0, tier - 1) },
      weaponMastery: tier,
    };
    let force = playerForce(sample);
    if (speciesClass === 'CORBEAU_NECROMANCIEN') force *= 1.08;
    if (speciesClass === 'LION_PALADIN') force *= 1.10;
    minSoloForce = Math.min(minSoloForce, Math.round(force));
  }
  assert.ok(minSoloForce >= MONSTER_FORCE[tier], 'monstre T' + tier + ' battable avec équipement T' + (tier - 1));
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

const key = tileKeyOf(mon);
const raid = g.raids.get(key);
assert.ok(raid, 'lobby encore ouvert (30 s non écoulées)');
assert.ok(raid.participants.length >= 2, 'participants présents : ' + raid.participants.length);

assert.ok(!g.startRaidNow(bob, key).ok, 'seul le chef peut lancer');
assert.ok(g.startRaidNow(alice, key).ok, 'lancement immédiat par le chef');
g.tick(300);
assert.ok(!g.raids.has(key), 'raid résolu');

const results = sent.filter((m) => m.ev === 'result');
assert.strictEqual(results.length, 2, 'résultat envoyé aux deux humains');
assert.ok(results[0].data.victory, 'victoire attendue');
console.log('Raid T2 : équipe ' + results[0].data.teamForce + ' vs ' + results[0].data.monsterForce +
  ' (' + results[0].data.participants.length + ' participants)');
assert.strictEqual(alice.status, 'IDLE');

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

// --- Talents de groupe : Sève (soin même en défaite) & Rempart ---
// Bots éloignés pour un combat 100 % déterministe
for (const b of g.bots.values()) { b.pos = { x: -45, y: -45 }; b.home = b.pos; }
let boss = null;
for (const t of g.tiles.values()) {
  if (t.content && t.content.kind === 'monster' && t.content.tier === 5 &&
      Math.max(Math.abs(t.x + 45), Math.abs(t.y + 45)) > 12) { boss = t; break; }
}

// 1) Défaite Alice (Lion) + Bob (Cerf Druide) contre un T5 : Sève soigne quand même
alice.pos = { x: boss.x - 1, y: boss.y };
bob.pos = { x: boss.x + 1, y: boss.y };
alice.pa = 50; bob.pa = 50;
alice.hp = 100; bob.hp = 100;
sent.length = 0;
assert.ok(g.createRaid(alice, boss.x, boss.y).ok, 'lobby T5 créé');
assert.ok(g.joinRaid(bob, boss.x + ',' + boss.y).ok, 'Bob rejoint le T5');
assert.ok(g.startRaidNow(alice, boss.x + ',' + boss.y).ok);
g.tick(300);
let res = sent.filter((m) => m.ev === 'result').map((m) => m.data);
assert.strictEqual(res.length, 2, 'résultats envoyés');
assert.ok(!res[0].victory, 'défaite attendue contre le T5');
assert.strictEqual(res[0].hpLoss, 52, 'perte pleine sans Rempart (22 + 5×6)');
assert.strictEqual(alice.hp, 100 - 52 + 15, 'Sève soigne aussi en défaite');
assert.strictEqual(bob.hp, 100 - 52 + 15, 'Sève soigne toute l’équipe');

// 2) Ajout de Cara (Ours Guerrier) : victoire, et Rempart réduit la perte de tous
let rr = g.register({ username: 'Cara', password: 'secret3', speciesClass: 'OURS_GUERRIER' });
assert.ok(rr.ok, 'troisième compte');
const cara = rr.player;
cara.online = true;
cara.pos = { x: boss.x, y: boss.y + 1 };
cara.pa = 50;
alice.pa = 50; bob.pa = 50;
alice.hp = 50; bob.hp = 50; cara.hp = 50;
sent.length = 0;
assert.ok(g.createRaid(alice, boss.x, boss.y).ok, 'second lobby T5');
assert.ok(g.joinRaid(bob, boss.x + ',' + boss.y).ok);
assert.ok(g.joinRaid(cara, boss.x + ',' + boss.y).ok);
assert.ok(g.startRaidNow(alice, boss.x + ',' + boss.y).ok);
g.tick(300);
res = sent.filter((m) => m.ev === 'result').map((m) => m.data);
assert.strictEqual(res.length, 3, 'résultats envoyés aux trois');
assert.ok(res[0].victory, 'victoire à trois avec Aura');
assert.strictEqual(res[0].hpLoss, 13, 'Rempart : perte réduite de 30 % (19 → 13)');
assert.strictEqual(alice.hp, 50 - 13 + 15, 'Rempart profite à Alice + Sève');
assert.strictEqual(cara.hp, 50 - 13 + 15, 'Rempart profite aussi à l’Ours');
console.log('Talents de groupe : Sève en défaite ✔, Rempart d’équipe ✔');

// --- Persistance aller-retour (token, état ET mot de passe) ---
const snap = JSON.parse(JSON.stringify(g.serialize()));
const g2 = new Game(snap.seed, snap);
const rTok = g2.authToken(alice.token);
assert.ok(rTok.ok && rTok.player.weapon.tier === 1, 'état restauré via token');
assert.ok(g2.login({ username: 'Alice', password: 'secret1' }).ok, 'mot de passe conservé après restauration');
assert.ok(!g2.login({ username: 'Alice', password: 'faux' }).ok, 'mauvais mot de passe refusé après restauration');

// --- Reset DEV ---
const r4 = g2.dev(rTok.player, { reset: true });
assert.ok(r4.ok && r4.reset, 'reset de compte');
assert.ok(!g2.authToken(rTok.player.token).ok, 'token invalidé');
assert.ok(!g2.login({ username: 'Alice', password: 'secret1' }).ok, 'connexion impossible après reset');

console.log('\ntest-game : tous les tests passent ✔');

function tileKeyOf(t) { return t.x + ',' + t.y; }
