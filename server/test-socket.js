'use strict';

/* Test de bout en bout : serveur réel + client socket.io.
 * Vérifie le cycle auth/création → init → action avec ack → chat. */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const assert = require('assert');
const ioc = require('socket.io-client');

const PORT = 3123;
const URL = 'http://localhost:' + PORT;

const child = spawn(process.execPath, ['index.js'], {
  cwd: __dirname,
  env: {
    ...process.env,
    PORT: String(PORT),
    SPEED: '30',
    STATE_FILE: path.join(os.tmpdir(), 'wildrift-test-state.json'),
  },
  stdio: 'ignore',
});

function fail(msg) {
  console.error('ÉCHEC :', msg);
  child.kill();
  process.exit(1);
}

const guard = setTimeout(() => fail('timeout global (30 s)'), 30000);

function waitForHealth(tries) {
  if (tries <= 0) return fail('le serveur ne démarre pas');
  http.get(URL + '/health', (res) => {
    if (res.statusCode === 200) run();
    else setTimeout(() => waitForHealth(tries - 1), 400);
  }).on('error', () => setTimeout(() => waitForHealth(tries - 1), 400));
}

function run() {
  const socket = ioc(URL);
  const name = 'Sock' + Math.floor(Math.random() * 10000);
  let gotCreation = false;

  socket.on('connect', () => socket.emit('auth', {}));

  socket.on('creation', () => {
    if (gotCreation) return;
    gotCreation = true;
    console.log('→ création demandée (aucun token) ✔');
    socket.emit('auth', { username: name, speciesClass: 'OURS_GUERRIER' });
  });

  socket.on('init', (d) => {
    assert.ok(d.token && d.selfId && d.self && d.seed, 'payload init complet');
    assert.strictEqual(d.self.username, name);
    assert.ok(Array.isArray(d.players), 'liste des joueurs (bots inclus) : ' + d.players.length);
    console.log('→ init reçu : seed ' + d.seed + ', ' + d.players.length + ' joueurs/bots ✔');

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
    if (m.type === 'chat' && m.from === name) {
      console.log('→ chat rediffusé ✔');
      clearTimeout(guard);
      socket.close();
      child.kill();
      console.log('\ntest-socket : tous les tests passent ✔');
      process.exit(0);
    }
  });
}

waitForHealth(25);
