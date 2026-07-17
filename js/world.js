'use strict';

/* ============================================================
 * world.js -- generation deterministe de la carte (seed)
 * Grille 2D iso, capitale en (0,0), tiers en anneaux concentriques
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

/* Valeur pseudo-aleatoire deterministe par case (x, y, salt) */
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

function tierAtDistance(dist) {
  if (dist <= CONFIG.SAFE_RADIUS) return 1;
  return Math.min(5, 1 + Math.floor((dist - CONFIG.SAFE_RADIUS) / 10));
}

/* 4 grands biomes cardinaux avec une legere irregularite de frontiere :
 * nord = montagne, sud = marecage, est = plaine, ouest = foret */
function terrainAt(x, y, seed) {
  const dist = Math.hypot(x, y);
  if (dist <= 2) return 'PLAINE';

  const jitterX = x + (hash2(x, y, seed, 11) - 0.5) * 6;
  const jitterY = y + (hash2(x, y, seed, 12) - 0.5) * 6;

  if (Math.abs(jitterX) > Math.abs(jitterY)) {
    return jitterX > 0 ? 'PLAINE' : 'FORET';
  }
  return jitterY > 0 ? 'MARECAGE' : 'MONTAGNE';
}

function resourceTypeAt(x, y, seed, terrain) {
  if (terrain === 'FORET') return 'BOIS';
  if (terrain === 'MONTAGNE') return 'MINERAI';
  if (terrain === 'PLAINE') return 'PLANTE';
  if (terrain === 'MARECAGE') {
    const all = ['BOIS', 'MINERAI', 'PLANTE'];
    return all[Math.floor(hash2(x, y, seed, 2) * all.length) % all.length];
  }
  return 'MINERAI';
}

function villageNameFor(terrain, index, seed) {
  const pools = {
    FORET: ['Bois-Mousse', 'Feuillebrune', 'Claireracine', 'Lanterneverte', 'Écorcevieille', 'Sylveclaire'],
    PLAINE: ['Champdor', 'Aube-Froment', 'Venteblé', 'Bellemoisson', 'Soleval', 'Pailleterre'],
    MONTAGNE: ['Rochebrune', 'Haut-Foyer', 'Picombre', 'Grisepierre', 'Cornecrête', 'Montfer'],
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
    };
    if (kind === 'village') tile.content.name = villageNameFor(terrain, index, seed);
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
  }
}

function generateWorld(seed) {
  const tiles = new Map();
  const { MIN, MAX } = CONFIG.WORLD;

  for (let y = MIN; y <= MAX; y++) {
    for (let x = MIN; x <= MAX; x++) {
      const terrain = terrainAt(x, y, seed);
      const dist = Math.hypot(x, y);
      let content = null;

      if (x === 0 && y === 0) {
        content = { kind: 'capital' };
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

      tiles.set(tileKey(x, y), { x, y, terrain, content });
    }
  }

  placeBiomePois(tiles, seed);
  return tiles;
}

function inBounds(x, y) {
  const { MIN, MAX } = CONFIG.WORLD;
  return x >= MIN && x <= MAX && y >= MIN && y <= MAX;
}

function isWalkable(tiles, x, y) {
  if (!inBounds(x, y)) return false;
  const t = tiles.get(tileKey(x, y));
  return !t.content
    || t.content.kind === 'capital'
    || t.content.kind === 'village'
    || t.content.kind === 'dungeon'
    || t.content.kind === 'resource'
    || t.content.kind === 'monster';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mulberry32, hash2, tileKey, tierAtDistance, terrainAt, resourceTypeAt,
    villageNameFor,
    generateWorld, inBounds, isWalkable,
  };
}
