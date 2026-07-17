'use strict';

/* ============================================================
 * main.js — bootstrap, boucle de jeu, entrées tactiles,
 * pathfinding client (1 PA / case) et persistance locale.
 *
 * Deux modes :
 *  - REMOTE : la page est servie par le backend Node (socket.io
 *    chargé) → RemoteServer, état autoritatif côté serveur.
 *  - LOCAL  : file:// ou artifact → ServerSim (solo + bots),
 *    sauvegarde localStorage.
 * ============================================================ */

(function () {
  const remote = typeof io !== 'undefined' && location.protocol.indexOf('http') === 0;
  const server = remote ? new RemoteServer() : new ServerSim(CONFIG.WORLD.SEED);
  const canvas = document.getElementById('map');
  const explored = new Set();
  const renderer = new Renderer(canvas, server, explored);
  const ui = new UI(server, renderer);
  ui.onAdminReset = () => {
    ui.confirm('Réinitialiser ?', '<p>Personnage et progression seront effacés.</p>', 'Tout effacer', async () => {
      try {
        if (remote) {
          await server.dev({ reset: true });
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(exploredKey());
        } else {
          localStorage.removeItem(CONFIG.SAVE_KEY);
        }
      } catch (e) { /* stockage indisponible */ }
      location.reload();
    });
  };

  const TOKEN_KEY = CONFIG.SAVE_KEY + '_token';
  let speed = 1;              // multiplicateur DEV (mode local uniquement)
  let moveQueue = [];         // chemin en cours (liste de {x,y})
  let stepFrom = null;        // dernière case dispatchée (référence des pas)
  let lastFrame = 0, lastStep = 0, lastSave = 0, lastMini = 0;

  /* ---------- Brouillard de guerre : mémoire d'exploration ---------- */
  function updateExploredAt(x, y) {
    const R = CONFIG.VIEW_RADIUS;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (Math.hypot(dx, dy) <= R + 0.5 && inBounds(x + dx, y + dy)) {
          explored.add(tileKey(x + dx, y + dy));
        }
      }
    }
  }
  function updateExplored() {
    if (server.me) updateExploredAt(server.me.pos.x, server.me.pos.y);
  }

  /* ---------- Pathfinding BFS (8 directions, cases traversables) ---------- */
  function findPath(from, to, maxLen) {
    if (from.x === to.x && from.y === to.y) return [];
    const start = tileKey(from.x, from.y);
    const goal = tileKey(to.x, to.y);
    const prev = new Map([[start, null]]);
    let frontier = [from];
    for (let depth = 0; depth < maxLen && frontier.length; depth++) {
      const next = [];
      for (const cur of frontier) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cur.x + dx, ny = cur.y + dy;
            const nk = tileKey(nx, ny);
            if (prev.has(nk) || !isWalkable(server.tiles, nx, ny)) continue;
            prev.set(nk, tileKey(cur.x, cur.y));
            if (nk === goal) {
              const path = [];
              let k = nk;
              while (k !== start) {
                const [x, y] = k.split(',').map(Number);
                path.unshift({ x, y });
                k = prev.get(k);
              }
              return path;
            }
            next.push({ x: nx, y: ny });
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  function pathTo(x, y) {
    const me = server.me;
    if (isWalkable(server.tiles, x, y)) return findPath(me.pos, { x, y }, 40);
    let best = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (!isWalkable(server.tiles, x + dx, y + dy)) continue;
        const p = findPath(me.pos, { x: x + dx, y: y + dy }, 40);
        if (p && (!best || p.length < best.length)) best = p;
      }
    }
    return best;
  }

  /* Confirmation de déplacement : "Aller sur la case (x, y) ?" */
  function confirmWalk(x, y, opts) {
    const me = server.me;
    const path = pathTo(x, y);
    if (!path) { ui.toast('Aucun chemin praticable.'); return; }
    if (!path.length) return;
    const short = path.length > me.pa;
    const tile = server.tiles.get(tileKey(x, y));
    const title = typeof opts === 'string' ? opts : (opts && opts.title);
    const mediaSrc = opts && Object.prototype.hasOwnProperty.call(opts, 'mediaSrc') ? opts.mediaSrc : '';
    const mediaClass = opts && opts.mediaClass ? opts.mediaClass : 'travel';
    const kicker = opts && opts.kicker ? opts.kicker : 'Déplacement';
    const badge = opts && opts.badge ? opts.badge : (ui.terrainLabel(tile.terrain) + ' · (' + x + ', ' + y + ')');
    const hasVisual = !!(opts && (opts.mediaSrc || opts.emblem));
    ui.confirm(
      title || 'Se déplacer ?',
      '<p>Voulez-vous aller sur la case <b>(' + x + ', ' + y + ')</b> ?</p>' +
      '<p>Terrain : <b>' + ui.terrainLabel(tile.terrain) + '</b></p>' +
      '<p>Coût : <b>' + path.length + ' PA</b> <span class="dim">(' + me.pa + ' disponibles)</span></p>' +
      (short ? '<p class="hp-c">PA insuffisants : vous vous arrêterez en chemin.</p>' : ''),
      'Confirmer',
      () => {
        moveQueue = path.length > server.me.pa ? path.slice(0, server.me.pa) : path;
        stepFrom = { x: server.me.pos.x, y: server.me.pos.y };
      },
      {
        className: 'popup-card action-popup tone-travel',
        decorated: true,
        kicker,
        heroHtml: hasVisual ? ui.buildActionHero({
          mediaSrc,
          mediaClass,
          badge,
          emblem: opts && opts.emblem ? opts.emblem : '',
        }) : '',
      }
    );
  }

  /* ---------- Interactions sur la carte ---------- */
  function handleTap(tx, ty) {
    const me = server.me;
    if (!me || me.status === 'LOBBY_COMBAT') return;
    if (!inBounds(tx, ty)) return;
    const key = tileKey(tx, ty);
    const visible = Math.hypot(tx - me.pos.x, ty - me.pos.y) <= CONFIG.VIEW_RADIUS + 0.5;
    if (!explored.has(key) && !visible) return;   // hors brouillard : inerte

    const tile = server.tiles.get(key);
    const c = tile.content;
    const adjacent = server.chebyshev(me.pos, tile) <= 1;
    moveQueue = [];

    if (c && c.kind === 'capital') {
      if (me.pos.x === 0 && me.pos.y === 0) ui.showSheet('capital');
      else confirmWalk(0, 0, {
        title: 'Aller à la Capitale ?',
        kicker: 'Voyage',
        mediaSrc: ui.getSpriteSrc(renderer.worldIcons.capital),
        mediaClass: 'structure',
        badge: 'Capitale',
      });
      return;
    }

    if (c && c.kind === 'village') {
      if (me.pos.x === tx && me.pos.y === ty) ui.showVillagePopup(tile);
      else confirmWalk(tx, ty, {
        title: 'Aller au village ?',
        kicker: 'Voyage',
        mediaSrc: ui.getSpriteSrc(renderer.worldIcons.village[tile.terrain]),
        mediaClass: 'structure',
        badge: 'Village',
      });
      return;
    }

    if (c && c.kind === 'dungeon') {
      if (me.pos.x === tx && me.pos.y === ty) ui.showDungeonPopup(tile);
      else confirmWalk(tx, ty, {
        title: 'Aller au donjon ?',
        kicker: 'Voyage',
        mediaSrc: ui.getSpriteSrc(renderer.worldIcons.dungeon[tile.terrain]),
        mediaClass: 'structure',
        badge: 'Donjon',
      });
      return;
    }

    if (c && c.kind === 'resource') {
      const rl = RESOURCES[c.type].label + ' T' + c.tier;
      if (!adjacent) {
        confirmWalk(tx, ty, {
          title: 'S’approcher de ' + rl + ' ?',
          kicker: 'Approche',
          mediaSrc: ui.getHarvestTargetSrc(c),
          mediaClass: 'resource',
          badge: 'T' + c.tier,
        });
        return;
      }
      if (server.now < c.inactiveUntil) {
        ui.toast('Gisement épuisé — repousse dans ' + Math.ceil((c.inactiveUntil - server.now) / 1000) + ' s.');
        return;
      }
      const lvlOk = me.harvestLevel >= c.tier;
      ui.confirmAction({
        title: 'Récolter ' + rl + ' ? (2 PA)',
        bodyHtml: '<p>Récolte en <b>3 secondes</b>.</p>' +
          '<p class="' + (lvlOk ? 'ok-c' : 'hp-c') + '">Niveau de récolte requis : T' + c.tier +
          ' <span class="dim">(vous : T' + me.harvestLevel + ')</span></p>',
        okLabel: 'Récolter',
        cb: async () => {
          const r = await Promise.resolve(server.harvest(tx, ty));
          if (!r.ok) ui.toast(r.error);
          else ui.playHarvestFx(c, r.duration || CONFIG.HARVEST_MS);
        },
        kicker: 'Récolte',
        tone: lvlOk ? 'harvest' : 'danger',
        mediaSrc: ui.getHarvestTargetSrc(c),
        mediaClass: 'resource',
        badge: RESOURCES[c.type].label + ' · T' + c.tier,
      });
      return;
    }

    if (c && c.kind === 'monster') {
      const ml = c.label + ' T' + c.tier;
      if (server.now < c.inactiveUntil) {
        if (adjacent) ui.toast(ml + ' vaincu — réapparition dans ' + Math.ceil((c.inactiveUntil - server.now) / 1000) + ' s.');
        else {
          confirmWalk(tx, ty, {
            title: 'S’approcher de ' + ml + ' ?',
            kicker: 'Approche',
            mediaSrc: ui.getMonsterTargetSrc(c),
            mediaClass: 'monster',
            badge: 'T' + c.tier,
          });
        }
        return;
      }
      const raid = server.raids.get(key);
      if (raid) {
        const dist = server.chebyshev(me.pos, tile);
        if (dist > CONFIG.JOIN_RADIUS) {
          confirmWalk(tx, ty, {
            title: 'S’approcher du raid ?',
            kicker: 'Approche',
            mediaSrc: ui.getMonsterTargetSrc(c),
            mediaClass: 'monster',
            badge: 'Raid T' + c.tier,
          });
          return;
        }
        ui.confirmAction({
          title: 'Rejoindre le raid ' + ml + ' ? (5 PA)',
          bodyHtml: '<p>' + raid.participants.length + ' participant(s) — force actuelle <b>' +
            server.teamForce(raid) + '</b> vs <b>' + raid.monsterForce + '</b>.</p>' +
            '<p class="dim">Résolution dans ' + Math.max(0, Math.ceil((raid.endsAt - server.now) / 1000)) + ' s.</p>',
          okLabel: 'Rejoindre',
          cb: async () => {
            const r = await Promise.resolve(server.joinRaid(key));
            if (!r.ok) ui.toast(r.error);
          },
          kicker: 'Raid',
          tone: 'combat',
          mediaSrc: ui.getMonsterTargetSrc(c),
          mediaClass: 'monster',
          badge: c.label + ' · T' + c.tier,
        });
        return;
      }
      if (!adjacent) {
        confirmWalk(tx, ty, {
          title: 'S’approcher de ' + ml + ' ?',
          kicker: 'Approche',
          mediaSrc: ui.getMonsterTargetSrc(c),
          mediaClass: 'monster',
          badge: 'T' + c.tier,
        });
        return;
      }
      ui.confirmAction({
        title: 'Lancer Raid ' + ml + ' ? (5 PA)',
        bodyHtml: '<p>Force du monstre : <b>' + c.force + '</b> — votre force : <b>' + playerForce(me) + '</b>.</p>' +
          '<p class="dim">Le lobby reste ouvert 30 s (les joueurs proches peuvent rejoindre), ou lancez le combat immédiatement depuis la bannière.</p>',
        okLabel: 'Créer Lobby',
        cb: async () => {
          const r = await Promise.resolve(server.createRaid(tx, ty));
          if (!r.ok) ui.toast(r.error);
        },
        kicker: 'Combat',
        tone: 'combat',
        mediaSrc: ui.getMonsterTargetSrc(c),
        mediaClass: 'monster',
        badge: c.label + ' · T' + c.tier,
      });
      return;
    }

    confirmWalk(tx, ty);
  }

  /* ---------- Entrées : tap (drag toléré) + clavier desktop ---------- */
  let downPos = null;
  canvas.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 12) return;
    const rect = canvas.getBoundingClientRect();
    const t = renderer.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
    handleTap(t.x, t.y);
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const dirs = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      z: [0, -1], s: [0, 1], q: [-1, 0], d: [1, 0],
    };
    const d = dirs[e.key];
    if (!d || !server.me) return;
    moveQueue = [];
    Promise.resolve(server.move(d[0], d[1])).then((r) => {
      if (!r.ok) ui.toast(r.error); else updateExplored();
    });
  });
  window.addEventListener('resize', () => renderer.resize());

  document.getElementById('ctxAction').addEventListener('click', () => ui.showSheet('capital'));

  // Téléportation serveur (KO → Capitale) : on abandonne le chemin en cours
  server.on('self', (p) => {
    if (moveQueue.length && stepFrom && server.chebyshev(p.pos, stepFrom) > 2) moveQueue = [];
    updateExploredAt(p.pos.x, p.pos.y);
  });

  /* ---------- Panneau DEV ---------- */
  document.getElementById('devBtn').addEventListener('click', () => {
    document.getElementById('devPanel').classList.toggle('hidden');
  });
  document.querySelectorAll('[data-speed]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const v = Number(btn.dataset.speed);
      if (remote) {
        const r = await server.dev({ speed: v });
        if (!r.ok) { ui.toast(r.error); return; }
      } else {
        speed = v;
      }
      document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', b === btn));
      ui.toast('Vitesse x' + v);
    });
  });
  document.getElementById('devPa').addEventListener('click', async () => {
    if (remote) {
      const r = await server.dev({ pa: 50 });
      ui.toast(r.ok ? '+50 PA (DEV)' : r.error);
    } else {
      server.me.pa = Math.min(CONFIG.PA.MAX, server.me.pa + 50);
      ui.toast('+50 PA (DEV)');
    }
  });
  document.getElementById('devReveal').addEventListener('click', () => {
    for (const key of server.tiles.keys()) explored.add(key);
    ui.toast('Carte révélée (DEV)');
  });
  document.getElementById('devReset').addEventListener('click', () => {
    ui.onAdminReset();
  });

  /* ---------- Persistance ---------- */
  function exploredKey() {
    return CONFIG.SAVE_KEY + '_exp_' + (server.me ? server.me.username : '');
  }

  function save() {
    if (!server.me) return;
    try {
      if (remote) {
        // Le serveur détient l'état du jeu ; on ne garde que le brouillard
        localStorage.setItem(exploredKey(), JSON.stringify([...explored]));
      } else {
        localStorage.setItem(CONFIG.SAVE_KEY, JSON.stringify({
          version: CONFIG.VERSION,
          server: server.serialize(),
          explored: [...explored],
        }));
      }
    } catch (e) { /* stockage indisponible (iframe privée…) : on joue sans save */ }
  }
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

  function loadSave() {
    try {
      const raw = localStorage.getItem(CONFIG.SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.version !== CONFIG.VERSION) return null;
      return data;
    } catch (e) { return null; }
  }

  /* ---------- Boucle de jeu ---------- */
  function frame(t) {
    const dt = Math.min(300, t - lastFrame);
    lastFrame = t;

    if (server.me) {
      server.tick(remote ? dt : dt * speed);

      // Exécution du chemin : un pas toutes les 140 ms
      if (moveQueue.length && t - lastStep > 140 && server.me.status === 'IDLE') {
        lastStep = t;
        const next = moveQueue.shift();
        const from = stepFrom || server.me.pos;
        stepFrom = next;
        Promise.resolve(server.move(next.x - from.x, next.y - from.y)).then((r) => {
          if (!r.ok) { moveQueue = []; ui.toast(r.error); }
          else updateExploredAt(next.x, next.y);
        });
      }

      ui.updateHud();
      renderer.draw();

      if (ui.openSheet === 'map' && t - lastMini > 600) {
        lastMini = t;
        const mini = document.getElementById('minimap');
        if (mini) renderer.drawMinimap(mini);
      }
      if (t - lastSave > 5000) { lastSave = t; save(); }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- Démarrage ---------- */
  if (remote) {
    server.on('creation', () => {
      ui.showCreation((name, cls) => server.join(name, cls));
    });
    server.on('ready', () => {
      document.getElementById('creation').classList.add('hidden');
      try {
        localStorage.setItem(TOKEN_KEY, server.token);
        const exp = JSON.parse(localStorage.getItem(exploredKey()) || '[]');
        for (const k of exp) explored.add(k);
      } catch (e) { /* stockage indisponible */ }
      updateExplored();
    });
    let token = null;
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    server.connect(token);
  } else {
    const saved = loadSave();
    if (saved) {
      server.restore(saved.server);
      for (const k of saved.explored || []) explored.add(k);
      updateExplored();
    } else {
      ui.showCreation((name, cls) => {
        server.join(name, cls);
        updateExplored();
        save();
      });
    }
  }
  requestAnimationFrame(frame);
})();
