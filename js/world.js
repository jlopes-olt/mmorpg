'use strict';

/* ============================================================
 * world.js -- generation deterministe des cartes (monde + donjons)
 * ============================================================ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed, salt) {
  let h = (seed + salt * 0x9E3779B9) | 0;
  h = Math.imul(h ^ Math.imul(x, 374761393), 668265263);
  h = Math.imul(h ^ Math.imul(y, 1274126177), 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function tileKey(x, y) { return x + ',' + y; }
function raidKey(mapId, x, y) { return mapId + '|' + tileKey(x, y); }

function attachBounds(tiles, min, max, mapId) {
  tiles._min = min;
  tiles._max = max;
  tiles._mapId = mapId;
  return tiles;
}

function boundsOf(tiles) {
  if (!tiles) return { min: CONFIG.WORLD.MIN, max: CONFIG.WORLD.MAX };
  return {
    min: Number.isFinite(tiles._min) ? tiles._min : CONFIG.WORLD.MIN,
    max: Number.isFinite(tiles._max) ? tiles._max : CONFIG.WORLD.MAX,
  };
}

function tierAtDistance(dist) {
  if (dist <= CONFIG.SAFE_RADIUS) return 1;
  return Math.min(5, 1 + Math.floor((dist - CONFIG.SAFE_RADIUS) / 10));
}

function terrainAt(x, y, seed) {
  const dist = Math.hypot(x, y);
  if (dist <= 2) return 'PLAINE';

  const jitterX = x + (hash2(x, y, seed, 11) - 0.5) * 6;
  const jitterY = y + (hash2(x, y, seed, 12) - 0.5) * 6;

  if (Math.abs(jitterX) > Math.abs(jitterY)) return jitterX > 0 ? 'PLAINE' : 'FORET';
  return jitterY > 0 ? 'MARECAGE' : 'MONTAGNE';
}

function resourceTypeAt(x, y, seed, terrain) {
  if (terrain === 'FORET') return 'BOIS';
  if (terrain === 'MONTAGNE') return 'MINERAI';
  if (terrain === 'PLAINE') return 'PLANTE';
  if (terrain === 'MARECAGE') return 'INGREDIENT';   // cuisine (buffs)
  return 'MINERAI';
}

function villageNameFor(terrain, index, seed) {
  const pools = {
    FORET: ['Bois-Mousse', 'Feuillebrune', 'Claireracine', 'Lanterneverte', 'Ecorcevieille', 'Sylveclaire'],
    PLAINE: ['Champdor', 'Aube-Froment', 'Venteble', 'Bellemoisson', 'Soleval', 'Pailleterre'],
    MONTAGNE: ['Rochebrune', 'Haut-Foyer', 'Picombre', 'Grisepierre', 'Cornecrete', 'Montfer'],
    MARECAGE: ['Brumebourbe', 'Tourbefeuille', 'Lancreed', 'Vaseclaire', 'Suintesaule', 'Mousse-Noire'],
  };
  const list = pools[terrain] || pools.PLAINE;
  const pick = Math.floor(hash2(index, list.length, seed, 131) * list.length) % list.length;
  return list[pick];
}

function biomeBasis(terrain) {
  if (terrain === 'PLAINE') return { axis: [1, 0], tangent: [0, 1] };
  if (terrain === 'FORET') return { axis: [-1, 0], tangent: [0, 1] };
  if (terrain === 'MONTAGNE') return { axis: [0, -1], tangent: [1, 0] };
  return { axis: [0, 1], tangent: [1, 0] };
}

/* Boss de donjon : calibrés pour ~5 joueurs équipés T5 (~92 % à cinq,
 * ~57 % à quatre) — en équipement T6, quatre suffisent (~82 %). */
function dungeonBossFor(terrain) {
  return {
    FORET: { type: 'BOSS_FORET', label: 'Roi Roncier', force: 670 },
    PLAINE: { type: 'BOSS_PLAINE', label: 'Cerf-Orage', force: 660 },
    MONTAGNE: { type: 'BOSS_MONTAGNE', label: 'Golem Couronne', force: 700 },
    MARECAGE: { type: 'BOSS_MARECAGE', label: 'Hydre de Vase', force: 685 },
  }[terrain] || { type: 'BOSS', label: 'Seigneur du Donjon', force: 680 };
}

function dungeonResourceFor(terrain) {
  return {
    FORET: 'BOIS_ANCIEN',
    PLAINE: 'FLEUR_ASTRALE',
    MONTAGNE: 'MINERAI_RUNIQUE',
    MARECAGE: 'FLEUR_ASTRALE',
  }[terrain] || 'MINERAI_RUNIQUE';
}

function dungeonResourcePoolFor(terrain) {
  if (terrain === 'MARECAGE') return ['BOIS_ANCIEN', 'MINERAI_RUNIQUE', 'FLEUR_ASTRALE'];
  return [dungeonResourceFor(terrain)];
}

function tryPlacePoi(tiles, seed, terrain, kind, index, radius, tangentOffset) {
  const basis = biomeBasis(terrain);
  const cx = basis.axis[0] * radius + basis.tangent[0] * tangentOffset;
  const cy = basis.axis[1] * radius + basis.tangent[1] * tangentOffset;
  const spiral = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2],
  ];

  for (let i = 0; i < spiral.length; i++) {
    const x = Math.round(cx + spiral[i][0]);
    const y = Math.round(cy + spiral[i][1]);
    if (!inBounds(x, y)) continue;
    const key = tileKey(x, y);
    const tile = tiles.get(key);
    if (!tile || tile.terrain !== terrain || tile.content || Math.hypot(x, y) <= CONFIG.SAFE_RADIUS + 2) continue;
    tile.content = {
      kind,
      terrain,
      tier: tierAtDistance(Math.hypot(x, y)),
      id: terrain + '_' + kind + '_' + index,
      killsRequired: kind === 'dungeon' ? CONFIG.DUNGEON.BOSS_KILLS_REQUIRED : undefined,
    };
    if (kind === 'village') tile.content.name = villageNameFor(terrain, index, seed);
    if (kind === 'dungeon') tile.content.mapId = 'dungeon:' + tile.content.id;
    return true;
  }
  return false;
}

function placeBiomePois(tiles, seed) {
  const terrains = ['FORET', 'PLAINE', 'MONTAGNE', 'MARECAGE'];
  const villageRadii = [16, 31];
  const villageTangents = [-6, 7];

  for (const terrain of terrains) {
    for (let i = 0; i < villageRadii.length; i++) {
      tryPlacePoi(tiles, seed, terrain, 'village', i, villageRadii[i], villageTangents[i]);
    }

    const dungeonCount = 2 + (hash2(terrains.indexOf(terrain), 0, seed, 91) < 0.5 ? 1 : 0);
    for (let i = 0; i < dungeonCount; i++) {
      const radius = 22 + i * 9 + Math.floor(hash2(i, terrains.indexOf(terrain), seed, 92) * 6);
      const tangent = Math.round((hash2(i, terrains.indexOf(terrain), seed, 93) - 0.5) * 18);
      tryPlacePoi(tiles, seed, terrain, 'dungeon', i, radius, tangent);
    }

    // Un château par biome — territoire de guilde, proche du donjon T6 de la zone.
    tryPlacePoi(tiles, seed, terrain, 'castle', 0, 24, -14);
  }
}

function generateWorldMap(seed) {
  const tiles = attachBounds(new Map(), CONFIG.WORLD.MIN, CONFIG.WORLD.MAX, 'world');
  const { MIN, MAX } = CONFIG.WORLD;

  for (let y = MIN; y <= MAX; y++) {
    for (let x = MIN; x <= MAX; x++) {
      const terrain = terrainAt(x, y, seed);
      const dist = Math.hypot(x, y);
      let content = null;

      if (x === 0 && y === 0) {
        content = { kind: 'capital' };
      } else if (x === WORLD_BOSS.pos.x && y === WORLD_BOSS.pos.y) {
        // Repaire du boss de raid mondial : point fixe unique, pas un par
        // biome comme les châteaux — l'état vivant/endormi se pilote côté
        // serveur (Game.worldBossAlive), pas ici (la génération doit rester
        // pure et déterministe, sans horloge murale).
        content = {
          kind: 'monster',
          type: WORLD_BOSS.type,
          label: WORLD_BOSS.label,
          tier: WORLD_BOSS.tier,
          force: WORLD_BOSS.force,
          inactiveUntil: 0,
          worldBoss: true,
        };
      } else if (dist > 1.5) {
        const r = hash2(x, y, seed, 3);
        const tier = tierAtDistance(dist);

        if (r < 0.085) {
          content = {
            kind: 'resource',
            type: resourceTypeAt(x, y, seed, terrain),
            tier,
            inactiveUntil: 0,
          };
        } else if (r < 0.145 && dist > CONFIG.SAFE_RADIUS + 1) {
          content = {
            kind: 'monster',
            type: MONSTERS[tier].type,
            label: MONSTERS[tier].label,
            tier,
            force: MONSTER_FORCE[tier],
            inactiveUntil: 0,
          };
        }
      }

      tiles.set(tileKey(x, y), { x, y, terrain, content, blocked: false });
    }
  }

  placeBiomePois(tiles, seed);
  return {
    id: 'world',
    kind: 'world',
    terrain: 'PLAINE',
    min: MIN,
    max: MAX,
    tiles,
  };
}

/* Rejoue la couche de FAUNE SAUVAGE du monde (ressources ET monstres — jamais
 * les repères villages/donjons/château/capitale) — utilisé pour la
 * redistribution nocturne, afin qu'un joueur ne puisse pas camper la même
 * case indéfiniment. Fonction pure et déterministe : mêmes (seed, salt) =
 * même disposition, sur le serveur comme chez chaque client (voir net.js) —
 * pas besoin d'envoyer la carte complète sur le réseau. Un seul jet par
 * tuile (comme à la génération d'origine) : ressource et monstre restent
 * mutuellement exclusifs, jamais superposés. salt=0 reproduit exactement la
 * disposition posée par generateWorldMap. */
function applyWildLayer(tiles, seed, salt) {
  const saltInput = 3 + (salt || 0) * 7919;
  for (const tile of tiles.values()) {
    const isWild = !tile.content || ((tile.content.kind === 'resource' || tile.content.kind === 'monster') && !tile.content.worldBoss);
    if (!isWild) continue;   // repère (village/donjon/château/capitale/boss mondial) : jamais touché
    const dist = Math.hypot(tile.x, tile.y);
    if (dist <= 1.5) { tile.content = null; continue; }   // abords de la Capitale : toujours dégagés
    const r = hash2(tile.x, tile.y, seed, saltInput);
    const tier = tierAtDistance(dist);
    if (r < 0.085) {
      tile.content = {
        kind: 'resource',
        type: resourceTypeAt(tile.x, tile.y, seed, tile.terrain),
        tier,
        inactiveUntil: 0,
      };
    } else if (r < 0.145 && dist > CONFIG.SAFE_RADIUS + 1) {
      tile.content = {
        kind: 'monster',
        type: MONSTERS[tier].type,
        label: MONSTERS[tier].label,
        tier,
        force: MONSTER_FORCE[tier],
        inactiveUntil: 0,
      };
    } else {
      tile.content = null;
    }
  }
}

function carveDungeon(set, x1, y1, x2, y2) {
  let x = x1, y = y1;
  set.add(tileKey(x, y));
  while (x !== x2) {
    x += Math.sign(x2 - x);
    set.add(tileKey(x, y));
    if (y + 1 <= CONFIG.DUNGEON.MAX) set.add(tileKey(x, y + 1));
  }
  while (y !== y2) {
    y += Math.sign(y2 - y);
    set.add(tileKey(x, y));
    if (x + 1 <= CONFIG.DUNGEON.MAX) set.add(tileKey(x + 1, y));
  }
}

function carveRoom(set, cx, cy, rx, ry, min, max) {
  for (let y = cy - ry; y <= cy + ry; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      if (x < min || x > max || y < min || y > max) continue;
      set.add(tileKey(x, y));
    }
  }
}

function generateDungeonMap(seed, terrain, mapId, worldX, worldY) {
  const min = CONFIG.DUNGEON.MIN;
  const max = CONFIG.DUNGEON.MAX;
  const walkable = new Set();
  const branches = [
    { x: 0, y: -6, rx: 3, ry: 2 },
    { x: -8, y: -5, rx: 4, ry: 3 },
    { x: 8, y: -8, rx: 4, ry: 3 },
    { x: -10, y: 4, rx: 3, ry: 3 },
    { x: 10, y: 6, rx: 3, ry: 3 },
    { x: 0, y: -14, rx: 5, ry: 3 },
  ];

  carveRoom(walkable, 0, 0, 3, 3, min, max);
  carveDungeon(walkable, 0, 0, 0, -6);
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    const dx = Math.round((hash2(i, worldX, seed, 301) - 0.5) * 4);
    const dy = Math.round((hash2(i, worldY, seed, 302) - 0.5) * 4);
    const tx = b.x + dx;
    const ty = b.y + dy;
    carveDungeon(walkable, 0, -6, tx, ty);
    carveRoom(
      walkable,
      tx,
      ty,
      b.rx + Math.floor(hash2(i, worldX, seed, 351) * 2),
      b.ry + Math.floor(hash2(i, worldY, seed, 352) * 2),
      min,
      max
    );
  }

  for (let i = 0; i < 7; i++) {
    const px = Math.round((hash2(i, worldX, seed, 401) - 0.5) * 22);
    const py = Math.round((hash2(i, worldY, seed, 402) - 0.25) * 22);
    const tx = px + Math.round((hash2(i, worldY, seed, 403) - 0.5) * 4);
    carveDungeon(walkable, px, py, tx, py);
    carveRoom(
      walkable,
      px,
      py,
      2 + Math.floor(hash2(i, worldX, seed, 411) * 3),
      2 + Math.floor(hash2(i, worldY, seed, 412) * 3),
      min,
      max
    );
  }

  carveRoom(walkable, 0, min + 4, 5, 3, min, max);

  const boss = dungeonBossFor(terrain);
  const specialResource = dungeonResourceFor(terrain);
  const resourcePool = dungeonResourcePoolFor(terrain);
  const tiles = attachBounds(new Map(), min, max, mapId);
  const monsterSpots = [];
  const resourceSpots = [];
  let bossSpot = { x: 0, y: min + 2 };

  for (let y = min; y <= max; y++) {
    for (let x = min; x <= max; x++) {
      const key = tileKey(x, y);
      const floor = walkable.has(key);
      const dist = Math.hypot(x, y);
      let content = null;

      if (floor) {
        if (x === 0 && y === 0) {
          content = { kind: 'portal', label: 'Sortie du donjon', targetMapId: 'world', targetPos: { x: worldX, y: worldY } };
        } else if (y <= min + 4 && Math.abs(x) <= 2) {
          bossSpot = { x, y };
        } else {
          const r = hash2(x, y, seed, 404);
          if (r < 0.18) monsterSpots.push({ x, y });
          else if (r < 0.24) resourceSpots.push({ x, y });
        }
      }

      tiles.set(key, {
        x, y,
        terrain: floor ? terrain : 'RUINES',
        content,
        blocked: !floor,
      });
    }
  }

  const bossTileKey = tileKey(bossSpot.x, bossSpot.y);
  const bossTile = tiles.get(bossTileKey);
  const bossTemplate = {
    kind: 'monster',
    type: boss.type,
    label: boss.label,
    tier: 6,
    force: boss.force,
    inactiveUntil: 0,
    boss: true,
  };
  if (bossTile) bossTile.content = null;

  for (let i = 0; i < monsterSpots.length && i < 10; i++) {
    const spot = monsterSpots[i];
    const tile = tiles.get(tileKey(spot.x, spot.y));
    if (!tile || tile.content) continue;
    tile.content = {
      kind: 'monster',
      type: MONSTERS[6].type,
      label: MONSTERS[6].label,
      tier: 6,
      force: MONSTER_FORCE[6],
      inactiveUntil: 0,
      dungeonMob: true,
    };
  }

  for (let i = 0; i < resourceSpots.length && i < 6; i++) {
    const spot = resourceSpots[i];
    const tile = tiles.get(tileKey(spot.x, spot.y));
    if (!tile || tile.content) continue;
    const resourceType = terrain === 'MARECAGE' && i < resourcePool.length
      ? resourcePool[i]
      : resourcePool[Math.floor(hash2(spot.x, spot.y, seed, 451) * resourcePool.length) % resourcePool.length];
    tile.content = {
      kind: 'resource',
      type: resourceType,
      tier: 6,
      inactiveUntil: 0,
      dungeonResource: true,
    };
  }

  return {
    id: mapId,
    kind: 'dungeon',
    terrain,
    min,
    max,
    entry: { x: 0, y: 0 },
    worldPos: { x: worldX, y: worldY },
    boss,
    dungeon: {
      killsRequired: CONFIG.DUNGEON.BOSS_KILLS_REQUIRED,
      kills: 0,
      bossAlive: false,
      bossTileKey,
      bossTemplate,
    },
    resourceType: terrain === 'MARECAGE' ? resourcePool.slice() : specialResource,
    tiles,
  };
}

function generateGameMaps(seed) {
  const world = generateWorldMap(seed);
  const maps = new Map([[world.id, world]]);

  for (const tile of world.tiles.values()) {
    if (!tile.content || tile.content.kind !== 'dungeon' || !tile.content.mapId) continue;
    maps.set(
      tile.content.mapId,
      generateDungeonMap(seed, tile.terrain, tile.content.mapId, tile.x, tile.y)
    );
  }
  return maps;
}

function generateWorld(seed) {
  return generateWorldMap(seed).tiles;
}

function inBounds(x, y, tiles) {
  const b = tiles ? boundsOf(tiles) : { min: CONFIG.WORLD.MIN, max: CONFIG.WORLD.MAX };
  return x >= b.min && x <= b.max && y >= b.min && y <= b.max;
}

function isWalkable(tiles, x, y) {
  if (!inBounds(x, y, tiles)) return false;
  const t = tiles.get(tileKey(x, y));
  if (!t || t.blocked) return false;
  return !t.content
    || t.content.kind === 'capital'
    || t.content.kind === 'village'
    || t.content.kind === 'dungeon'
    || t.content.kind === 'portal'
    || t.content.kind === 'resource'
    || t.content.kind === 'monster'
    || t.content.kind === 'castle';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mulberry32, hash2, tileKey, raidKey, tierAtDistance, terrainAt, resourceTypeAt,
    villageNameFor, dungeonBossFor, dungeonResourceFor, dungeonResourcePoolFor,
    generateWorld, generateWorldMap, generateDungeonMap, generateGameMaps,
    inBounds, isWalkable, boundsOf, attachBounds, applyWildLayer,
  };
}
