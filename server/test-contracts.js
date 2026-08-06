'use strict';

/* Tests des deux systèmes de déblocage du contenu solo :
 *   - les mercenaires (contrats, activation, plafonds, puissance, usure)
 *   - le Tableau des contrats (quotidiens, hebdo, sceaux, boutique)
 * Sans réseau, comme test-game.js. */

process.env.SPEED = '1';

const assert = require('assert');
const { Game } = require('./game.js');
const {
  CONFIG, CLASSES, MONSTER_FORCE, stackKey, parseStackKey, maxHp, teamPowerOf,
  combatPower, mercCombatPower, winChance, PREMIUM_CURRENCY,
  MERC_CONTRACT_COMBATS, MERC_MAX_ACTIVE_PER_PLAYER, MERC_MAX_PER_RAID, MERC_POWER_RATIO,
  MERC_MIN_MASTERY, MERC_TIERS, MERC_PRICE_GOLD, MERC_CONTRACT_TYPES, mercContractKey,
  SEAL_CURRENCY, ARTIFACT_ITEMS, WORLD_BOSS,
} = require('../js/config.js');
const {
  DAILY_CONTRACTS, DAILY_BY_ID, DAILY_SEALS, DAILY_COUNT, WEEKLY_CONTRACTS,
  SEAL_SHOP_BY_ID, dailyBoardFor, checkDailies, ensureDailyState, gameDayKey, gameWeekKey,
} = require('../js/dailies.js');

const g = new Game(CONFIG.WORLD.SEED, null);
const sent = [];
g.send = (id, ev, data) => sent.push({ id, ev, data });
g.broadcast = () => {};
g.sendPush = () => {};

let n = 0;
function ok(label) { n++; console.log('  ✔ ' + label); }
function section(title) { console.log('\n' + title); }

function mkPlayer(username, speciesClass, tier) {
  const r = g.register({ username, password: 'motdepasse', speciesClass, email: username.toLowerCase() + '@test.dev' });
  assert.ok(r.ok, 'création de ' + username + ' : ' + (r.error || ''));
  const p = r.player;
  p.weaponMastery = tier;
  p.harvestLevel = tier;
  p.weapon.tier = tier;
  p.armor.tier = tier;
  p.hp = maxHp(p);
  p.online = true;
  p.mapId = 'world';
  p.pos = { x: 0, y: 0 };   // Capitale : comptoir de la Compagnie Franche
  return p;
}

/* ============================================================
 * Mercenaires
 * ============================================================ */
section('Mercenaires — achat du contrat');

const a = mkPlayer('Alpha', 'OURS_GUERRIER', 6);

const tooEarly = mkPlayer('Novice', 'CHAT_MAGICIEN', 3);
tooEarly.gold = 10000;
assert.ok(!g.buyMercContract(tooEarly, 'LION_PALADIN', 6).ok, 'maîtrise insuffisante refusée');
ok('maîtrise < ' + MERC_MIN_MASTERY + ' : achat refusé');

a.gold = 0;
assert.ok(!g.buyMercContract(a, 'LION_PALADIN', 6).ok, 'sans or, achat refusé');
ok('or insuffisant : achat refusé');

a.gold = MERC_PRICE_GOLD[6];
assert.ok(!g.buyMercContract(a, 'PAS_UNE_CLASSE', 6).ok);
assert.ok(!g.buyMercContract(a, 'LION_PALADIN', 3).ok, 'tier hors MERC_TIERS refusé');
ok('classe inconnue et tier hors ' + JSON.stringify(MERC_TIERS) + ' refusés');

a.pos = { x: 12, y: 12 };
assert.ok(!g.buyMercContract(a, 'LION_PALADIN', 6).ok, 'hors sanctuaire, achat refusé');
a.pos = { x: 0, y: 0 };
ok('achat réservé au comptoir (Capitale/village)');

assert.ok(g.buyMercContract(a, 'LION_PALADIN', 6).ok);
assert.strictEqual(a.gold, 0, 'or débité exactement');
assert.strictEqual(a.inventory[mercContractKey('LION_PALADIN', 6)], 1);
ok('achat réussi : ' + MERC_PRICE_GOLD[6] + ' 🪙 débités, contrat en inventaire');

section('Mercenaires — activation et plafonds');

assert.ok(!g.activateMerc(a, 'CERF_DRUIDE', 6).ok, 'contrat non possédé refusé');
ok('activer un contrat qu’on ne possède pas est refusé');

assert.ok(g.activateMerc(a, 'LION_PALADIN', 6).ok);
assert.strictEqual(a.mercs.length, 1);
assert.strictEqual(a.mercs[0].combatsLeft, MERC_CONTRACT_COMBATS);
assert.ok(!a.inventory[mercContractKey('LION_PALADIN', 6)], 'contrat consommé de l’inventaire');
ok('activation : la lame rejoint l’escouade avec ' + MERC_CONTRACT_COMBATS + ' combats');

// On remplit jusqu'au plafond, puis un de trop
a.gold = MERC_PRICE_GOLD[6] * 3;
g.buyMercContract(a, 'CORBEAU_NECROMANCIEN', 6);
g.buyMercContract(a, 'CHAT_MAGICIEN', 6);
assert.ok(g.activateMerc(a, 'CORBEAU_NECROMANCIEN', 6).ok);
assert.strictEqual(a.mercs.length, MERC_MAX_ACTIVE_PER_PLAYER);
assert.ok(!g.activateMerc(a, 'CHAT_MAGICIEN', 6).ok, 'plafond par joueur respecté');
assert.strictEqual(a.inventory[mercContractKey('CHAT_MAGICIEN', 6)], 1, 'contrat refusé non consommé');
ok('plafond de ' + MERC_MAX_ACTIVE_PER_PLAYER + ' lames actives par joueur');

// Deux contrats IDENTIQUES doivent rester distinguables (ids propres)
assert.notStrictEqual(a.mercs[0].id, a.mercs[1].id, 'ids distincts');
ok('chaque lame a un identifiant propre');

section('Mercenaires — puissance apportée');

const soloPower = teamPowerOf([a]);
const withMercs = teamPowerOf([a], a.mercs);
assert.ok(withMercs > soloPower, 'les mercenaires ajoutent de la puissance');
// Un mercenaire vaut MERC_POWER_RATIO de la puissance brute d'un joueur du même tier
const refPlayer = { speciesClass: 'LION_PALADIN', weapon: { tier: 6 }, armor: { tier: 6 }, weaponMastery: 6, artifactId: null, buff: null, hp: 0 };
refPlayer.hp = maxHp(refPlayer);
const expected = combatPower(refPlayer) * MERC_POWER_RATIO;
assert.ok(Math.abs(mercCombatPower({ speciesClass: 'LION_PALADIN', tier: 6 }) - expected) < 1e-9);
ok('un mercenaire vaut ' + Math.round(MERC_POWER_RATIO * 100) + ' % de la puissance brute d’un joueur de son tier');

// Le bonus de rôle du mercenaire profite bien à l'équipe : l'Ours seul n'a que
// Rempart, l'ajout d'un Paladin engagé doit faire apparaître Aura (+10 %).
const ours = teamPowerOf([a]);
const oursPlusPaladin = teamPowerOf([a], [{ speciesClass: 'LION_PALADIN', tier: 6 }]);
const rawSum = combatPower(a) + mercCombatPower({ speciesClass: 'LION_PALADIN', tier: 6 });
assert.ok(oursPlusPaladin > Math.round(rawSum * (1 + CONFIG.COMBAT.ROLE_BONUS.OURS)), 'Aura appliquée');
ok('le bonus de rôle d’un mercenaire profite à toute l’équipe');
void ours;

section('Mercenaires — engagement dans un raid');

// Un mob de donjon T6 (force 400) : hors de portée en solo, atteignable avec
// deux lames — c'est exactement le déblocage visé.
const soloChance = winChance(teamPowerOf([a]), MONSTER_FORCE[6]);
const mercChance = winChance(teamPowerOf([a], a.mercs), MONSTER_FORCE[6]);
assert.ok(soloChance < 0.10, 'solo quasi impossible (' + Math.round(soloChance * 100) + ' %)');
assert.ok(mercChance > 0.90, 'avec 2 lames, le couloir devient farmable (' + Math.round(mercChance * 100) + ' %)');
ok('mob de donjon T6 : ' + Math.round(soloChance * 100) + ' % seul → ' + Math.round(mercChance * 100) + ' % avec 2 mercenaires');

// Plafond PAR COMBAT, tous joueurs confondus
const b = mkPlayer('Beta', 'CERF_DRUIDE', 6);
b.gold = MERC_PRICE_GOLD[6] * 2;
b.pos = { x: 0, y: 0 };
g.buyMercContract(b, 'RENARD_VOLEUR', 6);
g.activateMerc(b, 'RENARD_VOLEUR', 6);
const fakeRaid = { siege: false, leaderId: a.id, participants: [a.id, b.id] };
const engaged = g.raidMercsOf(fakeRaid);
assert.strictEqual(engaged.length, MERC_MAX_PER_RAID, 'plafond par combat respecté');
assert.ok(engaged.every((e) => e.ownerId === a.id), 'priorité au chef de raid');
ok('plafond de ' + MERC_MAX_PER_RAID + ' mercenaires par combat, chef de raid prioritaire');

assert.deepStrictEqual(g.raidMercsOf({ siege: true, leaderId: a.id, participants: [a.id] }), []);
ok('un siège de château n’accepte aucun mercenaire');

// La banniere de lobby lit raid.mercs : le client ne peut pas les recalculer,
// il ne connait pas les escouades des autres joueurs.
const realRaid = Object.assign({ key: 'k', tileKey: '1|1', mapId: 'world', tier: 6,
  label: 'Test', monsterForce: MONSTER_FORCE[6], endsAt: g.now + 30000 }, fakeRaid);
g.raids.set('k', realRaid);
const payload = g.raidsPayload().find((r) => r.key === 'k');
assert.strictEqual(payload.mercs.length, MERC_MAX_PER_RAID, 'mercenaires exposés au client');
assert.ok(payload.mercs.every((m) => m.speciesClass && m.tier), 'classe et tier transmis');
// Le jet affiche doit refleter les mercenaires, sinon la banniere mentirait.
assert.strictEqual(payload.teamForce, teamPowerOf([a, b], g.raidMercsOf(realRaid)));
assert.ok(payload.winChance > winChance(teamPowerOf([a, b]), MONSTER_FORCE[6]));
g.raids.delete('k');
ok('la charge utile du raid expose les mercenaires et le jet en tient compte');

section('Mercenaires — usure des contrats');

const before = a.mercs.map((m) => m.combatsLeft);
g.consumeRaidMercs(engaged);
assert.deepStrictEqual(a.mercs.map((m) => m.combatsLeft), before.map((c) => c - 1));
const betaMerc = b.mercs[0];
assert.strictEqual(betaMerc.combatsLeft, MERC_CONTRACT_COMBATS, 'la lame restée sur le banc ne perd rien');
ok('seuls les mercenaires engagés perdent une charge');

// Épuisement : le contrat disparaît de l'escouade
a.mercs[0].combatsLeft = 1;
g.consumeRaidMercs([{ ownerId: a.id, mercId: a.mercs[0].id }]);
assert.strictEqual(a.mercs.length, 1, 'lame épuisée retirée');
ok('à 0 combat restant, la lame quitte l’escouade');

assert.ok(g.dismissMerc(a, a.mercs[0].id).ok);
assert.strictEqual(a.mercs.length, 0);
assert.ok(!g.dismissMerc(a, 'inexistant').ok);
ok('congédier libère une place ; un id inconnu est refusé');

/* ============================================================
 * Tableau des contrats
 * ============================================================ */
section('Contrats — tirage et réinitialisation');

const c = mkPlayer('Gamma', 'RENARD_VOLEUR', 6);
const board = dailyBoardFor(c);
assert.strictEqual(board.daily.length, DAILY_COUNT, DAILY_COUNT + ' contrats tirés');
assert.ok(board.weekly, 'un contrat hebdomadaire est actif');
assert.strictEqual(new Set(board.daily.map((x) => x.id)).size, DAILY_COUNT, 'pas de doublon');
ok(DAILY_COUNT + ' contrats distincts du jour + 1 hebdomadaire');

const again = dailyBoardFor(c);
assert.deepStrictEqual(again.daily.map((x) => x.id), board.daily.map((x) => x.id));
ok('tirage stable dans la journée (deux lectures = mêmes contrats)');

// Deux joueurs différents ne doivent pas forcément avoir les mêmes contrats,
// mais TOUS doivent avoir le même hebdomadaire (objectif commun).
const d2 = mkPlayer('Delta', 'CHAT_MAGICIEN', 6);
assert.strictEqual(dailyBoardFor(d2).weekly.id, board.weekly.id);
ok('le contrat hebdomadaire est le même pour tout le monde');

// Un joueur bas niveau ne doit jamais tirer un contrat verrouillé
const low = mkPlayer('Bleu', 'CERF_DRUIDE', 2);
const lockedIds = DAILY_CONTRACTS.filter((x) => x.unlock && !x.unlock(low)).map((x) => x.id);
assert.ok(dailyBoardFor(low).daily.every((x) => !lockedIds.includes(x.id)));
ok('les contrats verrouillés (maîtrise ' + MERC_MIN_MASTERY + '+) ne sont pas tirés trop tôt');

section('Contrats — progression et récompense');

// On force un contrat connu pour tester la mécanique de delta de bout en bout
const dstate = ensureDailyState(c);
dstate.ids = ['harvest_any'];
dstate.params = { harvest_any: {} };
dstate.done = [];
dstate.baseline = { kills: {}, killsByTier: {}, harvest: { BOIS: 10 }, monsterKills: 0, bossKills: 0, worldBossKills: 0, cookedT3Plus: 0, coopFights: 0 };
c.stats.harvest = { BOIS: 10 };
c.gold = 0; c.seals = 0;

assert.strictEqual(checkDailies(c).length, 0, 'rien sans progression');
assert.strictEqual(dailyBoardFor(c).daily[0].progress, 0, 'le baseline neutralise l’acquis');
ok('la progression se mesure en delta : l’inventaire déjà récolté ne compte pas');

c.stats.harvest.BOIS = 10 + DAILY_BY_ID.harvest_any.target(c) - 1;
assert.strictEqual(checkDailies(c).length, 0, 'objectif pas encore atteint');
c.stats.harvest.BOIS += 1;
const done = checkDailies(c);
assert.strictEqual(done.length, 1);
assert.strictEqual(c.gold, DAILY_BY_ID.harvest_any.gold);
assert.strictEqual(c.seals, DAILY_SEALS);
ok('contrat rempli : ' + DAILY_BY_ID.harvest_any.gold + ' 🪙 et ' + DAILY_SEALS + ' ' + SEAL_CURRENCY.icon + ' crédités');

c.stats.harvest.BOIS += 500;
assert.strictEqual(checkDailies(c).length, 0, 'pas de double récompense');
assert.strictEqual(c.gold, DAILY_BY_ID.harvest_any.gold);
ok('un contrat déjà rempli ne repaie jamais');

section('Contrats — boutique aux sceaux');

c.pos = { x: 0, y: 0 };
c.seals = 0;
assert.ok(!g.buySealItem(c, 'fragment', 'artifact_dragon_scale').ok, 'sans sceaux, refusé');
c.seals = SEAL_SHOP_BY_ID.fragment.cost;
c.pos = { x: 20, y: 20 };
assert.ok(!g.buySealItem(c, 'fragment', 'artifact_dragon_scale').ok, 'hors comptoir, refusé');
c.pos = { x: 0, y: 0 };
assert.ok(!g.buySealItem(c, 'fragment', '').ok, 'sans choix d’artefact, refusé');
assert.strictEqual(c.seals, SEAL_SHOP_BY_ID.fragment.cost, 'aucun sceau débité sur un refus');
ok('achat refusé sans sceaux, hors comptoir, ou sans choix — et rien n’est débité');

const frag = ARTIFACT_ITEMS.artifact_dragon_scale.fragmentKey;
const fragBefore = c.inventory[frag] || 0;
assert.ok(g.buySealItem(c, 'fragment', 'artifact_dragon_scale').ok);
assert.strictEqual(c.seals, 0, 'sceaux débités');
assert.strictEqual(c.inventory[frag] || 0, fragBefore + 1, 'fragment reçu');
ok('fragment d’artefact acheté pour ' + SEAL_SHOP_BY_ID.fragment.cost + ' sceaux — la voie solo vers les artefacts');

c.seals = SEAL_SHOP_BY_ID.merc_t6.cost;
assert.ok(g.buySealItem(c, 'merc_t6', 'LION_PALADIN').ok);
assert.strictEqual(c.inventory[mercContractKey('LION_PALADIN', 6)], 1);
ok('contrat de mercenaire achetable aux sceaux');

c.seals = SEAL_SHOP_BY_ID.moonstones.cost;
const msBefore = c[PREMIUM_CURRENCY.key] || 0;
assert.ok(g.buySealItem(c, 'moonstones').ok);
assert.strictEqual(c[PREMIUM_CURRENCY.key], msBefore + SEAL_SHOP_BY_ID.moonstones.grant.moonstones);
ok(PREMIUM_CURRENCY.label + ' obtenables sans payer');

c.seals = SEAL_SHOP_BY_ID.title.cost * 2;
assert.ok(g.buySealItem(c, 'title').ok);
assert.ok(c.titles.includes(SEAL_SHOP_BY_ID.title.grant.title));
assert.ok(!g.buySealItem(c, 'title').ok, 'titre non rachetable');
ok('titre débloqué une seule fois');

section('Contrats — économie');

/* La promesse de design : la journee moyenne finance les deux lames T6 qui
 * ouvrent le donjon. Le plancher, lui, ne les couvre pas tout a fait (430
 * contre 500) — et c'est acceptable : un contrat dure MERC_CONTRACT_COMBATS
 * combats, soit une descente entiere, donc on n'en rachete pas deux chaque
 * jour. Ce qui doit tenir tous les jours, c'est de pouvoir en financer UNE. */
const sorted = DAILY_CONTRACTS.slice().sort((x, y) => x.gold - y.gold);
const worst = sorted.slice(0, DAILY_COUNT).reduce((s, x) => s + x.gold, 0);
const best = sorted.slice(-DAILY_COUNT).reduce((s, x) => s + x.gold, 0);
const average = Math.round(DAILY_CONTRACTS.reduce((s, x) => s + x.gold, 0) / DAILY_CONTRACTS.length * DAILY_COUNT);
const twoMercs = MERC_PRICE_GOLD[6] * 2;
assert.ok(average >= twoMercs, 'la journee moyenne (' + average + ') couvre deux lames T6 (' + twoMercs + ')');
assert.ok(worst >= MERC_PRICE_GOLD[6], 'meme le pire tirage (' + worst + ') couvre une lame T6');
ok('journee : ' + worst + ' a ' + best + ' 🪙 (moyenne ' + average + ') pour ' + twoMercs + ' 🪙 de deux lames T6');
ok('meme le pire tirage finance une lame T6 (' + MERC_PRICE_GOLD[6] + ' 🪙)');

// Un contrat couvre une descente complete : c'est ce qui rend le prix tenable.
assert.strictEqual(MERC_CONTRACT_COMBATS, CONFIG.DUNGEON.BOSS_KILLS_REQUIRED + 1,
  'un contrat doit couvrir les ' + CONFIG.DUNGEON.BOSS_KILLS_REQUIRED + ' mobs du couloir + le boss');
ok('un contrat = ' + MERC_CONTRACT_COMBATS + ' combats = une descente complete (' +
   CONFIG.DUNGEON.BOSS_KILLS_REQUIRED + ' mobs + le boss)');

section('Persistance');

const snapshot = JSON.parse(JSON.stringify(g.serialize()));
const g2 = new Game(CONFIG.WORLD.SEED, null);
g2.send = () => {}; g2.broadcast = () => {}; g2.sendPush = () => {};
g2.load(snapshot);
const reloaded = g2.players.get(c.id);
assert.ok(reloaded, 'joueur rechargé');
assert.strictEqual(reloaded.seals, c.seals, 'sceaux persistés');
assert.ok(Array.isArray(reloaded.mercs), 'escouade persistée');
assert.ok(reloaded.daily && reloaded.daily.day === gameDayKey(), 'tableau des contrats persisté');
ok('sceaux, escouade et tableau des contrats survivent à un redémarrage');

// Un compte d'avant la mise à jour ne doit pas planter au chargement
const legacy = JSON.parse(JSON.stringify(snapshot));
for (const p of legacy.players) { delete p.seals; delete p.mercs; delete p.daily; }
const g3 = new Game(CONFIG.WORLD.SEED, null);
g3.send = () => {}; g3.broadcast = () => {}; g3.sendPush = () => {};
g3.load(legacy);
const migrated = g3.players.get(c.id);
assert.strictEqual(migrated.seals, 0);
assert.deepStrictEqual(migrated.mercs, []);
assert.strictEqual(migrated.daily.day, gameDayKey());
ok('migration d’un compte antérieur : sceaux à 0, escouade vide, contrats tirés');

// Contrats épuisés purgés au chargement
const stale = JSON.parse(JSON.stringify(snapshot));
for (const p of stale.players) {
  if (p.id === c.id) p.mercs = [{ id: 'x', speciesClass: 'LION_PALADIN', tier: 6, combatsLeft: 0 }];
}
const g4 = new Game(CONFIG.WORLD.SEED, null);
g4.send = () => {}; g4.broadcast = () => {}; g4.sendPush = () => {};
g4.load(stale);
assert.deepStrictEqual(g4.players.get(c.id).mercs, []);
ok('un contrat figé à 0 combat est purgé au chargement');

section('Boss mondial — fenêtre horaire');

assert.ok(WORLD_BOSS.spawnWindow, 'fenêtre définie');
assert.ok(WORLD_BOSS.spawnWindow.startHour < WORLD_BOSS.spawnWindow.endHour);
ok('le Wyrm ne se réveille qu’entre ' + WORLD_BOSS.spawnWindow.startHour + ' h et ' +
   WORLD_BOSS.spawnWindow.endHour + ' h (heure de Paris)');

console.log('\n✅ ' + n + ' vérifications passées.');
