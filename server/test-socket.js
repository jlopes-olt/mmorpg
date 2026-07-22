'use strict';

/* Test de bout en bout : serveur réel (SQLite) + client socket.io.
 * Cycle : inscription → init → action → chat, puis nouvelle session :
 * mauvais mot de passe refusé, bon mot de passe → init. */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const ioc = require('socket.io-client');

const PORT = 3123;
const URL = 'http://localhost:' + PORT;
const DB_FILE = path.join(os.tmpdir(), 'wildrift-test-' + process.pid + '.db');
const NAME = 'Sock' + Math.floor(Math.random() * 10000);
const PASSWORD = 'test1234';

const child = spawn(process.execPath, ['index.js'], {
  cwd: __dirname,
  env: {
    ...process.env, PORT: String(PORT), SPEED: '30', DB_FILE,
    // Fichier inexistant : le test ne doit jamais migrer les vraies données
    STATE_FILE: DB_FILE + '.nomigration.json',
  },
  stdio: 'ignore',
});

function cleanup() {
  child.kill();
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

function waitForHealth(tries) {
  if (tries <= 0) return fail('le serveur ne démarre pas');
  http.get(URL + '/health', (res) => {
    if (res.statusCode === 200) phase1();
    else setTimeout(() => waitForHealth(tries - 1), 400);
  }).on('error', () => setTimeout(() => waitForHealth(tries - 1), 400));
}

/* Phase 1 : inscription + OTP (email non configuré → code renvoyé dans
 * devCode, voir server/index.js sendOtpEmail) + jeu */
function phase1() {
  const socket = ioc(URL);
  let asked = false;

  socket.on('connect', () => socket.emit('auth', {}));

  socket.on('creation', (d) => {
    if (asked) return fail('inscription refusée : ' + ((d && d.error) || '?'));
    asked = true;
    console.log('→ écran de création demandé (pas de session) ✔');
    socket.emit('register', { username: NAME, password: PASSWORD, speciesClass: 'OURS_GUERRIER', email: NAME + '@test.dev' });
  });

  socket.on('otpRequired', (d) => {
    assert.strictEqual(d.stage, 'otp', 'OTP requis juste après inscription (email fourni)');
    assert.ok(d.devCode, 'code de repli fourni (RESEND_API_KEY absent en test)');
    console.log('→ inscription → OTP requis ✔ (code de repli)');
    socket.emit('auth:verifyOtp', { accountId: d.accountId, code: d.devCode }, (r) => {
      assert.ok(r && r.ok, 'code OTP (repli) accepté : ' + ((r && r.error) || '?'));
      console.log('→ OTP vérifié ✔');
    });
  });

  socket.on('init', (d) => {
    assert.ok(d.token && d.selfId && d.self && d.seed, 'payload init complet');
    assert.strictEqual(d.self.username, NAME);
    console.log('→ inscription + init ✔ (' + d.players.length + ' joueurs/bots)');

    socket.emit('move', { dx: 1, dy: 0 }, (r1) => {
      const retry = r1.ok ? Promise.resolve(r1) : new Promise((res) => socket.emit('move', { dx: 0, dy: 1 }, res));
      Promise.resolve(retry).then((r) => {
        assert.ok(r.ok, 'déplacement accepté : ' + (r.error || ''));
        console.log('→ move ack ✔');
        socket.emit('chat', { text: 'test de bout en bout' });
      });
    });
  });

  socket.on('chat', (m) => {
    if (m.type === 'chat' && m.from === NAME) {
      console.log('→ chat rediffusé ✔');
      socket.close();
      setTimeout(phase2, 300);
    }
  });
}

/* Phase 2 : reconnexion par mot de passe (l'état vient de SQLite) */
function phase2() {
  const socket = ioc(URL);
  let triedWrong = false;

  socket.on('connect', () => socket.emit('login', { username: NAME, password: 'MAUVAIS' }));

  socket.on('creation', (d) => {
    if (!triedWrong) {
      triedWrong = true;
      assert.ok(d && d.error, 'erreur explicite attendue');
      console.log('→ mauvais mot de passe refusé ✔ (' + d.error + ')');
      socket.emit('login', { username: NAME, password: PASSWORD });
    } else {
      fail('connexion refusée avec le bon mot de passe : ' + ((d && d.error) || '?'));
    }
  });

  // L'OTP ne doit plus être redemandé à la reconnexion (mot de passe) —
  // seule l'inscription (phase 1 ci-dessus) le requiert désormais.
  socket.on('otpRequired', () => {
    fail('OTP ne devrait plus être requis à la reconnexion par mot de passe');
  });

  socket.on('init', (d) => {
    assert.strictEqual(d.self.username, NAME, 'compte retrouvé');
    // Le déplacement est gratuit désormais (voir Regain) : la preuve de
    // persistance passe par la position atteinte en phase 1 (plus par le PA
    // consommé, qui n'existe plus pour ce genre d'action).
    assert.ok(d.self.pos.x !== 0 || d.self.pos.y !== 0, 'état du personnage restauré (position du déplacement conservée)');
    console.log('→ connexion mot de passe + état restauré, sans OTP ✔');
    clearTimeout(guard);
    socket.close();
    cleanup();
    console.log('\ntest-socket : tous les tests passent ✔');
    process.exit(0);
  });
}

waitForHealth(25);
