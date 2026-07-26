'use strict';

/* Régression : Game.houses (parcelles/maisons du quartier résidentiel) doit
 * survivre à un VRAI redémarrage du processus serveur, pas seulement à un
 * cycle serialize()/load() en mémoire (voir server/test-game.js, qui teste
 * Game directement et ne peut PAS attraper ce bug : la persistance réelle
 * passe par server/index.js, qui reconstruit `initialState` à la main à
 * partir d'une liste explicite de clés SQLite (store.getMeta) — `houses`
 * en avait été oubliée, donc `this.houses` repartait vide à chaque
 * redémarrage alors que le `parcelId` sur le compte du joueur, lui, était
 * bien sauvé (JSON complet du joueur) : une maison "fantôme", invisible
 * mais bloquant tout nouvel achat. Ce test relance un VRAI second processus
 * sur le même fichier SQLite pour attraper exactement cette classe de bug. */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const ioc = require('socket.io-client');

const PORT = 3124;
const URL = 'http://localhost:' + PORT;
const DB_FILE = path.join(os.tmpdir(), 'wildrift-housing-test-' + process.pid + '.db');
// Max 16 caractères (voir server/game.js register(): username tronqué à 16) —
// un nom plus long serait silencieusement raccourci côté serveur, désynchronisant
// ce script (qui, lui, continuerait à utiliser le nom complet non tronqué).
const NAME = 'HPersist' + Math.floor(Math.random() * 100000);
const PASSWORD = 'test1234';

function spawnServer() {
  return spawn(process.execPath, ['index.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), SPEED: '30', DB_FILE, STATE_FILE: DB_FILE + '.nomigration.json' },
    stdio: 'ignore',
  });
}

let currentChild = null;
function cleanup() {
  if (currentChild) currentChild.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch (e) { /* absent */ }
  }
}

function fail(msg) {
  console.error('ÉCHEC :', msg);
  cleanup();
  process.exit(1);
}

const guard = setTimeout(() => fail('timeout global (30 s)'), 30000);

function waitForHealth(tries, cb) {
  if (tries <= 0) return fail('le serveur ne démarre pas');
  http.get(URL + '/health', (res) => {
    if (res.statusCode === 200) cb();
    else setTimeout(() => waitForHealth(tries - 1, cb), 400);
  }).on('error', () => setTimeout(() => waitForHealth(tries - 1, cb), 400));
}

async function adminLoginAndGrantGold() {
  const loginRes = await fetch(URL + '/admin/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: NAME, password: PASSWORD }),
  }).then((r) => r.json());
  if (!loginRes.ok) return fail('connexion admin refusée : ' + loginRes.error);
  const grantRes = await fetch(URL + '/admin/api/players/' + NAME + '/gold', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + loginRes.token },
    body: JSON.stringify({ amount: 1000 }),
  }).then((r) => r.json());
  if (!grantRes.ok) return fail('don d’or refusé : ' + grantRes.error);
}

// --- Phase 1 : premier processus — inscription (devient admin, 1er compte), don d'or, achat d'une parcelle ---
currentChild = spawnServer();
waitForHealth(30, () => {
  const socket = ioc(URL);
  socket.on('connect', () => socket.emit('auth', {}));
  socket.on('creation', (d) => {
    socket.emit('register', { username: NAME, password: PASSWORD, speciesClass: 'OURS_GUERRIER', email: NAME + '@test.dev' });
  });
  socket.on('otpRequired', (d) => {
    socket.emit('auth:verifyOtp', { accountId: d.accountId, code: d.devCode }, (r) => {
      assert.ok(r && r.ok, 'OTP accepté');
    });
  });
  socket.on('init', async (d) => {
    assert.strictEqual(d.self.role, 'admin', 'premier compte créé = admin');
    console.log('→ inscription (admin, 1er compte) ✔');
    await adminLoginAndGrantGold();
    console.log('→ don d’or admin ✔');
    socket.emit('housing:claim', { parcelId: 'parcel_0_0', modelId: 'house_petite' }, (r) => {
      assert.ok(r && r.ok, 'achat de parcelle accepté : ' + ((r && r.error) || '?'));
      console.log('→ parcelle achetée ✔');
      socket.emit('housing:info', {}, (info) => {
        assert.ok(info.ok && info.list.some((h) => h.parcelId === 'parcel_0_0'), 'maison visible juste après achat');
        console.log('→ maison visible immédiatement après achat ✔');
        // Laisse le temps à saveWorld() (onHousingDirty) d'écrire sur disque
        // avant de couper le processus — sans ça on testerait juste que le
        // process reste en vie, pas que ça a été flushé en SQLite.
        setTimeout(() => {
          socket.close();
          currentChild.kill();
          setTimeout(phase2, 500);
        }, 500);
      });
    });
  });
});

// --- Phase 2 : second processus, MÊME fichier SQLite — la maison doit avoir survécu ---
function phase2() {
  currentChild = spawnServer();
  waitForHealth(30, () => {
    const socket = ioc(URL);
    socket.on('connect', () => socket.emit('login', { username: NAME, password: PASSWORD }));
    socket.on('init', (d) => {
      assert.ok(d.self.parcelId, 'parcelId toujours sur le compte après redémarrage (ceci passait déjà avant le correctif)');
      socket.emit('housing:info', {}, (info) => {
        assert.ok(info.ok, 'housing:info répond');
        const mine = info.list.find((h) => h.parcelId === d.self.parcelId);
        assert.ok(mine, 'RÉGRESSION : la maison a disparu après un vrai redémarrage du processus (this.houses non persisté)');
        assert.strictEqual(mine.ownerUsername, NAME, 'propriétaire correct après redémarrage');
        console.log('→ maison retrouvée après un vrai redémarrage du processus ✔');
        clearTimeout(guard);
        socket.close();
        cleanup();
        console.log('\ntest-housing-persistence : tous les tests passent ✔');
        process.exit(0);
      });
    });
  });
}
