'use strict';

/* ============================================================
 * main.js — bootstrap, boucle de jeu, entrées tactiles,
 * pathfinding client (déplacement gratuit) et persistance locale.
 *
 * Deux modes :
 *  - REMOTE : la page est servie par le backend Node (socket.io
 *    chargé) → RemoteServer, état autoritatif côté serveur.
 *  - LOCAL  : file:// ou artifact → ServerSim (solo + bots),
 *    sauvegarde localStorage.
 * ============================================================ */

(function () {
  const remote = typeof io !== 'undefined' && location.protocol.indexOf('http') === 0;
  const SHELL_REV = '20260723-achievements-per-biome';

  // PWA : service worker (cache + installation sur l'écran d'accueil).
  // Échec silencieux en file:// / artifact.
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    const lastRev = localStorage.getItem('feralia_shell_rev') || '';
    const resetCaches = lastRev !== SHELL_REV
      ? navigator.serviceWorker.getRegistrations()
        .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
        .then(() => ('caches' in window ? caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))) : null))
        .catch(() => null)
      : Promise.resolve();
    resetCaches.finally(() => {
      localStorage.setItem('feralia_shell_rev', SHELL_REV);
      navigator.serviceWorker.register('/sw.js?v=' + SHELL_REV)
        .then((reg) => {
          // Une app installée est souvent « reprise » depuis l'arrière-plan par
          // l'OS plutôt que rechargée — ça ne redéclenche pas de requête réseau
          // pour sw.js. On vérifie donc activement une nouvelle version à
          // chaque lancement/retour au premier plan.
          reg.update().catch(() => {});
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reg.update().catch(() => {});
          });
        })
        .catch(() => { /* indisponible */ });
    });

    // Dès qu'un nouveau service worker prend le contrôle (skipWaiting + claim
    // dans sw.js), on recharge la page pour exécuter le code à jour tout de
    // suite — sinon l'onglet/l'app déjà ouvert(e) continue de tourner avec
    // l'ancien JS jusqu'à la prochaine fermeture complète.
    let swRefreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swRefreshing) return;
      swRefreshing = true;
      location.reload();
    });
  }

  // --- Bannière d'installation PWA (Android : invite native ; iOS : instructions
  // manuelles, Safari ne propose pas d'API programmatique d'installation). ---
  (function setupInstallBanner() {
    const banner = document.getElementById('installBanner');
    if (!banner) return;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) return;   // déjà installée : rien à proposer

    const DISMISS_KEY = 'feralia_install_dismissed_at';
    const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return;

    const textEl = document.getElementById('installBannerText');
    const actionBtn = document.getElementById('installBannerAction');
    const closeBtn = document.getElementById('installBannerClose');
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    let deferredPrompt = null;

    const show = () => banner.classList.remove('hidden');
    const hide = () => banner.classList.add('hidden');
    const dismiss = () => { localStorage.setItem(DISMISS_KEY, String(Date.now())); hide(); };
    closeBtn.addEventListener('click', dismiss);

    if (isIOS) {
      textEl.textContent = 'Appuyez sur Partager (📤) puis « Sur l’écran d’accueil » pour l’installer.';
      show();
      return;
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      textEl.textContent = 'Accès plus rapide, plein écran, jouable même hors ligne.';
      actionBtn.classList.remove('hidden');
      show();
    });

    actionBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      hide();
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
    });

    window.addEventListener('appinstalled', () => {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
      hide();
    });
  })();

  const server = remote ? new RemoteServer() : new ServerSim(CONFIG.WORLD.SEED);
  const canvas = document.getElementById('map');
  const splash = document.getElementById('splash');
  const explored = new Set();
  const renderer = new Renderer(canvas, server, explored);
  const ui = new UI(server, renderer);
  ui.onApproachPlayer = (player) => {
    if (!player || !player.pos) return;
    walkTo(player.pos.x, player.pos.y);
  };
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
  const splashStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  let splashDismissed = false;

  function hideSplash(minVisibleMs) {
    if (!splash || splashDismissed) return;
    splashDismissed = true;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const wait = Math.max(0, (minVisibleMs || 0) - (now - splashStartedAt));
    setTimeout(() => splash.classList.add('hidden'), wait);
  }

  /* ---------- Brouillard de guerre : mémoire d'exploration ---------- */
  // Tuiles du monde découvertes depuis le dernier envoi au serveur (brouillard
  // de guerre partagé entre appareils — voir flushExploreSync).
  const pendingExploreSync = new Set();

  function updateExploredAt(x, y) {
    const R = CONFIG.VIEW_RADIUS;
    const onWorld = (server.currentMapId || 'world') === 'world';
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (Math.hypot(dx, dy) <= R + 0.5 && inBounds(x + dx, y + dy, server.tiles)) {
          const k = tileKey(x + dx, y + dy);
          if (!explored.has(k)) {
            explored.add(k);
            if (remote && onWorld) pendingExploreSync.add(k);
          }
        }
      }
    }
  }
  function updateExplored() {
    if (server.me) updateExploredAt(server.me.pos.x, server.me.pos.y);
  }
  function flushExploreSync() {
    if (!remote || !pendingExploreSync.size) return;
    const keys = [...pendingExploreSync];
    pendingExploreSync.clear();
    Promise.resolve(server.exploreTiles(keys)).catch(() => {});
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

  /* Déplacement immédiat : le mouvement ne coûte plus de Regain, une
   * confirmation n'aurait donc plus rien à montrer (elle ne servait qu'à
   * afficher le coût en PA et tronquer le trajet en cas de PA insuffisants). */
  function walkTo(x, y) {
    const path = pathTo(x, y);
    if (!path) { ui.toast('Aucun chemin praticable.'); return; }
    if (!path.length) return;
    moveQueue = path;
    stepFrom = { x: server.me.pos.x, y: server.me.pos.y };
  }

  /* ---------- Interactions sur la carte ---------- */
  function handleTap(tx, ty) {
    const me = server.me;
    if (!me || me.status === 'LOBBY_COMBAT') return;
    if (!inBounds(tx, ty, server.tiles)) return;
    const key = tileKey(tx, ty);
    const tile = server.tiles.get(key);
    if (!tile || tile.blocked) return;   // vide de donjon : inerte
    const c = tile.content;
    const adjacent = server.chebyshev(me.pos, tile) <= 1;
    moveQueue = [];

    if (c && c.kind === 'capital') {
      if (me.pos.x === 0 && me.pos.y === 0) ui.showSheet('capital');
      else walkTo(0, 0);
      return;
    }

    if (c && c.kind === 'village') {
      if (me.pos.x === tx && me.pos.y === ty) ui.showVillagePopup(tile);
      else walkTo(tx, ty);
      return;
    }

    if (c && c.kind === 'dungeon') {
      if (me.pos.x === tx && me.pos.y === ty) ui.showDungeonPopup(tile, async () => {
        const r = await Promise.resolve(server.enterDungeon(c.mapId));
        if (!r.ok) ui.toast(r.error);
      });
      else walkTo(tx, ty);
      return;
    }

    if (c && c.kind === 'castle') {
      if (me.pos.x === tx && me.pos.y === ty) ui.showCastlePopup(tile);
      else walkTo(tx, ty);
      return;
    }

    if (c && c.kind === 'portal') {
      if (me.pos.x === tx && me.pos.y === ty) {
        ui.confirmAction({
          title: 'Quitter le donjon ?',
          bodyHtml: '<p>Voulez-vous emprunter le portail de sortie ?</p>',
          okLabel: 'Sortir',
          cb: async () => {
            const r = await Promise.resolve(server.usePortal());
            if (!r.ok) ui.toast(r.error);
          },
          kicker: 'Portail',
          tone: 'travel',
        });
      } else {
        walkTo(tx, ty);
      }
      return;
    }

    if (c && c.kind === 'resource') {
      const rl = resourceLabel(c.type, c.tier);
      if (!adjacent) {
        walkTo(tx, ty);
        return;
      }
      if (server.now < c.inactiveUntil) {
        ui.toast('Gisement épuisé — repousse dans ' + Math.ceil((c.inactiveUntil - server.now) / 1000) + ' s.');
        return;
      }
      const lvlOk = me.harvestLevel >= c.tier;
      const regainOk = me.pa >= CONFIG.COSTS.HARVEST;
      ui.confirmAction({
        title: 'Récolter ' + rl + ' ?',
        bodyHtml: '<p>Récolte en <b>3 secondes</b>.</p>' +
          '<p class="' + (lvlOk ? 'ok-c' : 'hp-c') + '">Niveau de récolte requis : T' + c.tier +
          ' <span class="dim">(vous : T' + me.harvestLevel + ')</span></p>' +
          (regainOk ? '<p class="ok-c small">✨ Regain disponible : XP doublée !</p>' : ''),
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
        badge: resourceLabel(c.type, c.tier),
      });
      return;
    }

    if (c && c.kind === 'monster') {
      const ml = c.label + ' T' + c.tier;
      if (server.now < c.inactiveUntil) {
        if (adjacent) ui.toast(ml + ' vaincu — réapparition dans ' + Math.ceil((c.inactiveUntil - server.now) / 1000) + ' s.');
        else walkTo(tx, ty);
        return;
      }
      const raid = server.raids.get(raidKey(server.currentMapId || (server.me && server.me.mapId) || 'world', tx, ty));
      if (raid) {
        const dist = server.chebyshev(me.pos, tile);
        if (dist > CONFIG.JOIN_RADIUS) {
          walkTo(tx, ty);
          return;
        }
        const nowChance = server.raidChance(raid);
        const withMeChance = winChance(server.teamForce(raid) + combatPower(me), raid.monsterForce);
        const regainOk = me.pa >= CONFIG.COSTS.RAID;
        ui.confirmAction({
          title: 'Rejoindre le raid ' + ml + ' ?',
          bodyHtml: '<p>' + raid.participants.length + ' participant(s) — ' +
            ui.chanceHtml(nowChance) + ' de victoire, <b>≈ ' + Math.round(withMeChance * 100) + ' %</b> avec vous.</p>' +
            '<p class="dim">Résolution dans ' + Math.max(0, Math.ceil((raid.endsAt - server.now) / 1000)) + ' s.</p>' +
            (regainOk ? '<p class="ok-c small">✨ Regain disponible : XP doublée en cas de victoire !</p>' : ''),
          okLabel: 'Rejoindre',
          cb: async () => {
            const r = await Promise.resolve(server.joinRaid(raidKey(server.currentMapId || (server.me && server.me.mapId) || 'world', tx, ty)));
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
        walkTo(tx, ty);
        return;
      }
      const soloChance = winChance(teamPowerOf([me]), c.force);
      const soloRegainOk = me.pa >= CONFIG.COSTS.RAID;
      ui.confirmAction({
        title: 'Lancer Raid ' + ml + ' ?',
        bodyHtml: '<p>Seul, vous avez ' + ui.chanceHtml(soloChance) + ' de chances de victoire.</p>' +
          '<p class="dim hp-c">⚠ Une défaite est mortelle : retour à la Capitale.</p>' +
          '<p class="dim">Le lobby reste ouvert 30 s — chaque allié qui rejoint fait grimper vos chances (visibles en direct dans la bannière).</p>' +
          (soloRegainOk ? '<p class="ok-c small">✨ Regain disponible : XP doublée en cas de victoire !</p>' : ''),
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

    walkTo(tx, ty);
  }

  /* ---------- Entrées : tap (drag toléré) + clavier desktop ---------- */
  // Glisser la caméra loin du héros (CONFIG.CAMERA_PAN_ENABLED) : réutilise le
  // même seuil de 12 px que la distinction tap/drag ci-dessous, pour ne rien
  // changer au comportement existant tant qu'on reste sous ce seuil.
  const recenterBtn = document.getElementById('recenterBtn');
  document.getElementById('helpBtn').addEventListener('click', () => ui.showGuide());
  let downPos = null;
  let lastPos = null;
  let isPanning = false;
  canvas.addEventListener('pointerdown', (e) => {
    downPos = { x: e.clientX, y: e.clientY };
    lastPos = downPos;
    isPanning = false;
  });
  if (CONFIG.CAMERA_PAN_ENABLED) {
    canvas.addEventListener('pointermove', (e) => {
      if (!downPos) return;
      const totalMoved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      if (!isPanning && totalMoved > 12) {
        isPanning = true;
        renderer.camPanned = true;
        recenterBtn.classList.remove('hidden');
      }
      if (isPanning) {
        renderer.cam.x -= e.clientX - lastPos.x;
        renderer.cam.y -= e.clientY - lastPos.y;
      }
      lastPos = { x: e.clientX, y: e.clientY };
    });
    recenterBtn.addEventListener('click', () => {
      renderer.camPanned = false;
      recenterBtn.classList.add('hidden');
    });

    // Taper la minicarte (feuille "Carte" mobile ou panneau desktop persistant)
    // déplace directement la caméra monde à cet endroit — pas besoin de glisser
    // à la main sur toute la distance. #minimap est recréé à chaque ouverture
    // de la feuille (innerHTML), donc on écoute sur #sheetBody (stable) plutôt
    // que sur le canvas lui-même.
    const jumpFromMinimap = (canvas2, e, closeAfter) => {
      const tile = renderer.minimapTileAt(canvas2, e.clientX, e.clientY);
      if (!tile) return;
      renderer.jumpCameraTo(tile.x, tile.y);
      recenterBtn.classList.remove('hidden');
      if (closeAfter) ui.closeSheet();
    };
    document.getElementById('sheetBody').addEventListener('click', (e) => {
      if (e.target && e.target.id === 'minimap') jumpFromMinimap(e.target, e, true);
    });
    const desktopMinimapEl = document.getElementById('desktopMinimap');
    if (desktopMinimapEl) {
      desktopMinimapEl.addEventListener('click', (e) => jumpFromMinimap(desktopMinimapEl, e, false));
    }
  }
  canvas.addEventListener('pointerup', (e) => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    const wasPanning = isPanning;
    downPos = null;
    lastPos = null;
    isPanning = false;
    if (moved > 12 || wasPanning) return;
    if (!server.me) return;
    const rect = canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    // Sur sa propre case, un repère (château, village…) rivalise avec la
    // présence d'autres joueurs — sinon un château défendu ne serait jamais
    // cliquable (le clic tomberait toujours sur le popup du défenseur posté
    // dessus). Si les deux s'appliquent, on laisse choisir plutôt que de
    // trancher silencieusement (voir le popup de choix ci-dessous).
    const tappedTile = renderer.screenToTile(localX, localY);
    const ownTileContent = server.tiles.get(tileKey(tappedTile.x, tappedTile.y));
    const onOwnLandmark = server.me.pos.x === tappedTile.x && server.me.pos.y === tappedTile.y &&
      ownTileContent && ownTileContent.content &&
      ['castle', 'village', 'capital', 'dungeon', 'portal'].includes(ownTileContent.content.kind);
    const playersOnTappedTile = renderer.pickPlayersAtScreen(localX, localY).filter((p) => p.id !== server.me.id);

    if (onOwnLandmark && playersOnTappedTile.length > 0) {
      const landmarkLabels = { castle: '🏰 Château', village: '🏘 Village', capital: '⚒ Capitale', dungeon: '🕳 Donjon', portal: '🌀 Portail' };
      const landmarkLabel = landmarkLabels[ownTileContent.content.kind] || 'Repère';
      ui.popup(
        'Que faire ici ?',
        '<p class="dim small">' + playersOnTappedTile.length + ' autre' + (playersOnTappedTile.length > 1 ? 's aventuriers partagent' : ' aventurier partage') + ' cette case.</p>',
        [
          { label: 'Fermer' },
          {
            label: playersOnTappedTile.length === 1 ? 'Voir ' + esc(playersOnTappedTile[0].username) : 'Voir les joueurs (' + playersOnTappedTile.length + ')',
            cb: () => {
              if (playersOnTappedTile.length === 1) ui.showPlayerInteraction(playersOnTappedTile[0]);
              else ui.showPlayerPicker(playersOnTappedTile, { tile: tappedTile });
            },
          },
          { label: landmarkLabel, primary: true, cb: () => handleTap(tappedTile.x, tappedTile.y) },
        ],
        { mode: 'generic' }
      );
      return;
    }

    const players = onOwnLandmark ? [] : playersOnTappedTile;
    if (players.length === 1) {
      ui.showPlayerInteraction(players[0]);
      return;
    }
    if (players.length > 1) {
      ui.showPlayerPicker(players, {
        tile: { x: players[0].pos.x, y: players[0].pos.y },
        moveLabel: 'Aller sur la case',
        moveCb: () => walkTo(players[0].pos.x, players[0].pos.y),
      });
      return;
    }
    handleTap(tappedTile.x, tappedTile.y);
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
    document.getElementById('devBtn').classList.toggle('hidden', remote && p.role !== 'admin');
  });
  server.on('map', () => {
    moveQueue = [];
    stepFrom = null;
    // Changement de carte (donjon, capitale…) : une caméra glissée sur l'ancienne
    // carte n'a plus de sens sur la nouvelle, on retombe sur le héros.
    renderer.camPanned = false;
    document.getElementById('recenterBtn').classList.add('hidden');
    explored.clear();
    try {
      const exp = JSON.parse(localStorage.getItem(exploredKey()) || '[]');
      for (const k of exp) explored.add(k);
    } catch (e) { /* ignore */ }
    if ((server.currentMapId || 'world') === 'world') {
      for (const k of ((server.me && server.me.exploredWorld) || [])) explored.add(k);
    }
    updateExplored();
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
      ui.toast(r.ok ? '+50 Regain (DEV)' : r.error);
    } else {
      server.me.pa = Math.min(CONFIG.PA.MAX, server.me.pa + 50);
      ui.toast('+50 Regain (DEV)');
    }
  });
  document.getElementById('devReveal').addEventListener('click', () => {
    for (const key of server.tiles.keys()) explored.add(key);
    ui.toast('Carte révélée (DEV)');
  });
  document.getElementById('devResourceReset').addEventListener('click', async () => {
    if (!remote) { ui.toast('Disponible en multijoueur réel.'); return; }
    const r = await Promise.resolve(server.dev({ wildReset: true }));
    ui.toast(r.ok ? ('🌱 Faune & ressources redistribuées (salt ' + r.salt + ')') : r.error);
  });
  document.getElementById('devReset').addEventListener('click', () => {
    ui.onAdminReset();
  });

  /* ---------- Persistance ---------- */
  function exploredKey() {
    return CONFIG.SAVE_KEY + '_exp_' + (server.me ? server.me.username : '') + '_' + (server.currentMapId || 'world');
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
          exploredByMap: { [(server.currentMapId || 'world')]: [...explored] },
        }));
      }
    } catch (e) { /* stockage indisponible (iframe privée…) : on joue sans save */ }
  }
  window.addEventListener('pagehide', () => { save(); flushExploreSync(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); flushExploreSync(); } });

  function loadSave() {
    try {
      const raw = localStorage.getItem(CONFIG.SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.version !== CONFIG.VERSION) return null;
      if (!data.exploredByMap && data.explored) data.exploredByMap = { world: data.explored };
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
      renderer.draw(dt);
      if (renderer.justExplored.length) {
        const onWorld = (server.currentMapId || 'world') === 'world';
        if (remote && onWorld) for (const k of renderer.justExplored) pendingExploreSync.add(k);
        renderer.justExplored.length = 0;
      }

      if (t - lastMini > 600 && (ui.openSheet === 'map' || ui.desktopPanelsActive())) {
        lastMini = t;
        const mini = document.getElementById('minimap');
        if (mini) renderer.drawMinimap(mini);
        const desktopMini = document.getElementById('desktopMinimap');
        if (desktopMini && ui.desktopPanelsActive()) renderer.drawMinimap(desktopMini);
      }
      if (t - lastSave > 5000) { lastSave = t; save(); flushExploreSync(); }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- Démarrage ---------- */
  if (remote) {
    // Se déconnecter = oublier le token de session local (le compte reste en base)
    ui.onLogout = () => {
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* stockage indisponible */ }
      location.reload();
    };
    server.on('creation', () => {
      hideSplash(1100);
      ui.showAuth({
        login: (username, password) => server.login(username, password),
        register: (username, password, cls, email) => server.register(username, password, cls, email),
      });
    });
    server.on('otpRequired', (d) => {
      hideSplash(1100);
      ui.showOtpStep(d || {});
    });
    // Compte supprimé par un administrateur pendant la session : le serveur
    // a déjà coupé la socket côté back-end juste après cet évènement (voir
    // Game.adminDeleteAccount) — on ramène simplement ce client à l'écran de
    // connexion, comme une déconnexion volontaire.
    server.on('accountDeleted', () => {
      ui.toast('Votre compte a été supprimé par un administrateur.');
      setTimeout(() => ui.onLogout(), 1500);
    });
    server.on('ready', () => {
      document.getElementById('creation').classList.add('hidden');
      hideSplash(1100);
      try {
        localStorage.setItem(TOKEN_KEY, server.token);
        const exp = JSON.parse(localStorage.getItem(exploredKey()) || '[]');
        for (const k of exp) explored.add(k);
      } catch (e) { /* stockage indisponible */ }
      // Brouillard de guerre du compte (côté serveur) : fusionné avec la copie
      // locale pour retrouver la même carte explorée depuis un autre
      // navigateur/appareil (ex. site web ↔ PWA installée).
      for (const k of ((server.me && server.me.exploredWorld) || [])) explored.add(k);
      updateExplored();
      // Retour depuis Stripe après paiement : confirmation immédiate à
      // l'écran — le crédit réel vient du webhook (asynchrone), donc ce
      // n'est qu'un accusé de réception, pas la preuve que c'est déjà fait.
      if (new URLSearchParams(location.search).get('purchase') === 'success') {
        ui.toast('✦ Paiement reçu — vos Écailles Lunaires arrivent dans quelques instants.');
        history.replaceState(null, '', location.pathname);
      }
      // Personnage tout juste créé (pas une reconnexion) : guide du débutant,
      // après la disparition du splash pour ne pas se superposer à l'animation.
      if (server.justCreated) setTimeout(() => ui.showGuide(), 1200);
    });
    let token = null;
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    server.connect(token);
  } else {
    const saved = loadSave();
    if (saved) {
      server.restore(saved.server);
      for (const k of ((saved.exploredByMap && saved.exploredByMap[server.currentMapId || 'world']) || [])) explored.add(k);
      updateExplored();
      hideSplash(1100);
    } else {
      hideSplash(1100);
      ui.showCreation((name, cls) => {
        server.join(name, cls);
        updateExplored();
        save();
        setTimeout(() => ui.showGuide(), 1200);
      });
    }
  }
  requestAnimationFrame(frame);
})();
