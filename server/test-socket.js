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
const { CONFIG } = require('../js/config.js');

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

/* Phase 1 : inscription + jeu */
function phase1() {
  const socket = ioc(URL);
  let asked = false;

  socket.on('connect', () => socket.emit('auth', {}));

  socket.on('creation', (d) => {
    if (asked) return fail('inscription refusée : ' + ((d && d.error) || '?'));
    asked = true;
    console.log('→ écran de création demandé (pas de session) ✔');
    socket.emit('register', { username: NAME, password: PASSWORD, speciesClass: 'OURS_GUERRIER' });
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

  socket.on('init', (d) => {
    assert.strictEqual(d.self.username, NAME, 'compte retrouvé');
    assert.ok(d.self.pa < CONFIG.PA.START, 'état du personnage restauré');
    console.log('→ connexion mot de passe + état restauré ✔');
    clearTimeout(guard);
    socket.close();
    cleanup();
    console.log('\ntest-socket : tous les tests passent ✔');
    process.exit(0);
  });
}

waitForHealth(25);
