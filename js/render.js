'use strict';

/* ============================================================
 * render.js -- rendu habille : carte iso (canvas 2D) + minimap
 * - tuiles artistiques chargees depuis assets/terrain_generated
 * - quadrillage lisible et brouillard leger
 * - ressources / monstres / capitale via vrais assets PNG
 * - personnages : sprites de assets/personnages_small.png
 * ============================================================ */

const TILE_W = 76, TILE_H = 38;
const TW2 = TILE_W / 2, TH2 = TILE_H / 2;
const TOP_FACE_CROP = 0.74;

const TERRAIN_TILE_FILES = {
  PLAINE: [
    'assets/terrain_generated/plaine_01.png', 'assets/terrain_generated/plaine_02.png',
    'assets/terrain_generated/plaine_03.png', 'assets/terrain_generated/plaine_04.png',
    'assets/terrain_generated/plaine_05.png', 'assets/terrain_generated/plaine_06.png',
    'assets/terrain_generated/plaine_07.png', 'assets/terrain_generated/plaine_08.png',
    'assets/terrain_generated/plaine_09.png', 'assets/terrain_generated/plaine_10.png',
  ],
  FORET: [
    'assets/terrain_generated/foret_01.png', 'assets/terrain_generated/foret_02.png',
    'assets/terrain_generated/foret_03.png', 'assets/terrain_generated/foret_04.png',
    'assets/terrain_generated/foret_05.png', 'assets/terrain_generated/foret_06.png',
    'assets/terrain_generated/foret_07.png', 'assets/terrain_generated/foret_08.png',
    'assets/terrain_generated/foret_09.png', 'assets/terrain_generated/foret_10.png',
  ],
  MONTAGNE: [
    'assets/terrain_generated/montagne_01.png', 'assets/terrain_generated/montagne_02.png',
    'assets/terrain_generated/montagne_03.png', 'assets/terrain_generated/montagne_04.png',
    'assets/terrain_generated/montagne_05.png', 'assets/terrain_generated/montagne_06.png',
    'assets/terrain_generated/montagne_07.png', 'assets/terrain_generated/montagne_08.png',
    'assets/terrain_generated/montagne_09.png', 'assets/terrain_generated/montagne_10.png',
  ],
  MARECAGE: [
    'assets/terrain_generated/marais_01.png', 'assets/terrain_generated/marais_02.png',
    'assets/terrain_generated/marais_03.png', 'assets/terrain_generated/marais_04.png',
    'assets/terrain_generated/marais_05.png', 'assets/terrain_generated/marais_06.png',
    'assets/terrain_generated/marais_07.png', 'assets/terrain_generated/marais_08.png',
    'assets/terrain_generated/marais_09.png', 'assets/terrain_generated/marais_10.png',
  ],
  RUINES: [
    'assets/terrain_generated/montagne_01.png', 'assets/terrain_generated/montagne_02.png',
    'assets/terrain_generated/montagne_03.png', 'assets/terrain_generated/montagne_04.png',
    'assets/terrain_generated/montagne_05.png', 'assets/terrain_generated/montagne_06.png',
    'assets/terrain_generated/montagne_07.png', 'assets/terrain_generated/montagne_08.png',
    'assets/terrain_generated/montagne_09.png', 'assets/terrain_generated/montagne_10.png',
  ],
};

const WORLD_ICON_FILES = {
  resource: {
    BOIS: {
      1: 'assets/bois_01_chene.png',
      2: 'assets/bois_02_sapin.png',
      3: 'assets/bois_03_bouleau.png',
      4: 'assets/bois_04_acacia.png',
      5: 'assets/bois_05_arbre_mort.png',
    },
    BOIS_ANCIEN: {
      6: 'assets/bois_ancien_t6.png',
    },
    MINERAI: {
      1: 'assets/minerai_01_cuivre.png',
      2: 'assets/minerai_02_fer.png',
      3: 'assets/minerai_03_argent.png',
      4: 'assets/minerai_04_or.png',
      5: 'assets/minerai_05_cristal.png',
    },
    MINERAI_RUNIQUE: {
      6: 'assets/minerai_runique_t6.png',
    },
    PLANTE: {
      1: 'assets/plante_01_menthe.png',
      2: 'assets/plante_02_lavande.png',
      3: 'assets/plante_03_camomille.png',
      4: 'assets/plante_04_aloe_vera.png',
      5: 'assets/plante_05_fougere.png',
    },
    // Assets à générer — repli emoji 🍄 tant qu'ils n'existent pas
    INGREDIENT: {
      1: 'assets/ingredient_01_champignon.png',
      2: 'assets/ingredient_02_baie.png',
      3: 'assets/ingredient_03_racine.png',
      4: 'assets/ingredient_04_oeuf.png',
      5: 'assets/ingredient_05_miel.png',
    },
    FLEUR_ASTRALE: {
      6: 'assets/fleur_astrale_t6.png',
    },
    TOURBE_VIVANTE: {
      6: 'assets/tourbe_vivante_t6.png',
    },
  },
  monster: {
    LUPUS: 'assets/monstre_01_lupus.png',
    OURS_PIERRE: 'assets/monstre_02_ours.png',
    SPECTRE: 'assets/monstre_03_spectre.png',
    BASILIC: 'assets/monstre_04_basilic.png',
    WYRM: 'assets/monstre_05_wyrm.png',
    SQUELETTE: 'assets/monstre_t6_squelette.png',
    BOSS_FORET: 'assets/boss_foret_t6.png',
    BOSS_PLAINE: 'assets/boss_plaine_t6.png',
    BOSS_MONTAGNE: 'assets/boss_montagne_t6.png',
    BOSS_MARECAGE: 'assets/boss_marecage_t6.png',
  },
  capital: 'assets/capitale_chibi_src.png',
  village: {
    FORET: 'assets/village_foret.png',
    PLAINE: 'assets/village_plaine.png',
    MONTAGNE: 'assets/village_montagne.png',
    MARECAGE: 'assets/village_marais.png',
  },
  dungeon: {
    FORET: 'assets/donjon_foret.png',
    PLAINE: 'assets/donjon_plaine.png',
    MONTAGNE: 'assets/donjon_montagne.png',
    MARECAGE: 'assets/donjon_marais.png',
  },
};

/* Bas utile de chaque rangee de la planche de sprites */
const SPRITE_ROW_CROP = [0.875, 0.81];

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  const r = c(n >> 16), g = c((n >> 8) & 255), b = c(n & 255);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function mixColors(hexA, hexB, ratio) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const t = Math.max(0, Math.min(1, ratio));
  const blend = (av, bv) => Math.round(av + (bv - av) * t);
  const ar = a >> 16, ag = (a >> 8) & 255, ab = a & 255;
  const br = b >> 16, bg = (b >> 8) & 255, bb = b & 255;
  return 'rgb(' + blend(ar, br) + ',' + blend(ag, bg) + ',' + blend(ab, bb) + ')';
}

function terrainBaseColor(name) {
  const terrain = TERRAINS[name] || TERRAINS.MONTAGNE;
  return terrain.color;
}

function contentSpriteSize(kind, type, tier) {
  if (kind === 'capital') return { w: 96, h: 100, groundOffset: 16, shadowW: 24, shadowH: 7 };
  if (kind === 'village') return { w: 98, h: 82, groundOffset: 14, shadowW: 22, shadowH: 7 };
  if (kind === 'dungeon') return { w: 84, h: 76, groundOffset: 12, shadowW: 20, shadowH: 6 };
  if (kind === 'monster') return { w: 66 + tier * 2, h: 52 + tier * 2, groundOffset: 10, shadowW: 18 + tier * 2, shadowH: 7 + tier * 0.4 };
  if (type === 'BOIS' || type === 'BOIS_ANCIEN') return { w: 62 + tier * 3, h: 74 + tier * 3, groundOffset: 8, shadowW: 16 + tier * 2, shadowH: 6 + tier * 0.5 };
  if (type === 'MINERAI' || type === 'MINERAI_RUNIQUE') return { w: 50 + tier * 2, h: 42 + tier * 2, groundOffset: 8, shadowW: 15 + tier * 1.5, shadowH: 5 + tier * 0.4 };
  return { w: 46 + tier * 2, h: 46 + tier * 2, groundOffset: 8, shadowW: 14 + tier * 1.2, shadowH: 5 + tier * 0.4 };
}

class Renderer {
  constructor(canvas, server, explored) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.server = server;
    this.explored = explored;
    this.cam = { x: 0, y: 0 };
    this.camInit = false;

    this.sprites = new Image();
    this.spritesReady = false;
    this.sprites.onload = () => { this.spritesReady = true; };
    this.sprites.onerror = () => { this.spritesReady = false; };
    this.sprites.src = (typeof window !== 'undefined' && window.WILDRIFT_SPRITE) || 'assets/personnages_small.png';

    this.worldIcons = { resource: {}, monster: {}, capital: null, village: {}, dungeon: {} };
    this.terrainTiles = {};
    this.loadWorldIcons();
    this.loadTerrainTiles();
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buildFallbackAtlas();
  }

  loadWorldIcons() {
    for (const [type, entries] of Object.entries(WORLD_ICON_FILES.resource)) {
      this.worldIcons.resource[type] = {};
      for (const [tier, src] of Object.entries(entries)) {
        const profile = type === 'MINERAI' ? 'mineral' : 'resource';
        this.worldIcons.resource[type][tier] = this.loadSimpleImage(src, profile);
      }
    }
    for (const [type, src] of Object.entries(WORLD_ICON_FILES.monster)) {
      this.worldIcons.monster[type] = this.loadSimpleImage(src, 'monster');
    }
    this.worldIcons.capital = this.loadSimpleImage(WORLD_ICON_FILES.capital, 'structure');
    for (const [terrain, src] of Object.entries(WORLD_ICON_FILES.village)) {
      this.worldIcons.village[terrain] = this.loadSimpleImage(src, 'structure');
    }
    for (const [terrain, src] of Object.entries(WORLD_ICON_FILES.dungeon)) {
      this.worldIcons.dungeon[terrain] = this.loadSimpleImage(src, 'structure');
    }
  }

  loadSimpleImage(src, profile) {
    const image = new Image();
    image.ready = false;
    image.bounds = null;
    image.processed = null;
    image.contentProfile = profile || 'default';
    image.onload = () => {
      const processed = this.prepareContentImage(image);
      image.processed = processed.canvas;
      image.bounds = processed.bounds;
      image.ready = true;
    };
    image.onerror = () => { image.ready = false; };
    image.src = src;
    return image;
  }

  loadTerrainTiles() {
    for (const [terrain, files] of Object.entries(TERRAIN_TILE_FILES)) {
      this.terrainTiles[terrain] = files.map((src) => {
        const image = new Image();
        image.ready = false;
        image.bounds = null;
        image.processed = null;
        image.onload = () => {
          const processed = this.prepareTerrainImage(image);
          image.processed = processed.canvas;
          image.bounds = processed.bounds;
          image.ready = true;
        };
        image.onerror = () => { image.ready = false; };
        image.src = src;
        return image;
      });
    }
  }

  prepareTerrainImage(image) {
    const c = document.createElement('canvas');
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    const data = img.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const gg = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a === 0) continue;

      if (gg > 220 && r < 40 && b < 40) {
        data[i + 3] = 0;
        continue;
      }
      if (gg > r + 35 && gg > b + 35) {
        data[i] = Math.min(255, r + 10);
        data[i + 1] = Math.max(0, gg - 28);
        data[i + 2] = Math.min(255, b + 10);
      }
    }
    g.putImageData(img, 0, 0);

    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX || maxY < minY) {
      return {
        canvas: c,
        bounds: { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight },
      };
    }
    return {
      canvas: c,
      bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    };
  }

  prepareContentImage(image) {
    const c = document.createElement('canvas');
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    const data = img.data;

    this.stripContentBackground(data, c.width, c.height, image.contentProfile || 'default');

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const gg = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a === 0) continue;

      if (gg > r + 28 && gg > b + 28) {
        data[i] = Math.min(255, r + 8);
        data[i + 1] = Math.max(0, gg - 20);
        data[i + 2] = Math.min(255, b + 8);
      }
    }
    this.keepLargestAlphaComponent(data, c.width, c.height);
    g.putImageData(img, 0, 0);
    return this.measureProcessedCanvas(c);
  }

  stripContentBackground(data, width, height, profile) {
    const seen = new Uint8Array(width * height);
    const stack = [];
    const tryPush = (idx) => {
      if (idx < 0 || idx >= width * height || seen[idx]) return;
      if (!this.isRemovableBackgroundPixel(data, idx * 4, profile)) return;
      seen[idx] = 1;
      stack.push(idx);
    };

    for (let x = 0; x < width; x++) {
      tryPush(x);
      tryPush((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      tryPush(y * width);
      tryPush(y * width + (width - 1));
    }

    while (stack.length) {
      const idx = stack.pop();
      data[idx * 4 + 3] = 0;
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x > 0) tryPush(idx - 1);
      if (x < width - 1) tryPush(idx + 1);
      if (y > 0) tryPush(idx - width);
      if (y < height - 1) tryPush(idx + width);
    }
  }

  isRemovableBackgroundPixel(data, offset, profile) {
    const r = data[offset];
    const gg = data[offset + 1];
    const b = data[offset + 2];
    const a = data[offset + 3];
    if (a === 0) return false;
    const isChromaMagenta = r > 220 && b > 220 && gg < 80;
    if (isChromaMagenta) return true;

    if (profile === 'mineral' || profile === 'monster') {
      const isVeryDark = r < 24 && gg < 24 && b < 28;
      const isDarkNeutral = r < 30 && gg < 30 && b < 34 && Math.abs(r - gg) < 6 && Math.abs(gg - b) < 8;
      return isVeryDark || isDarkNeutral;
    }

    const isVeryDark = r < 34 && gg < 34 && b < 40;
    const isDarkNeutral = r < 44 && gg < 44 && b < 48 && Math.abs(r - gg) < 8 && Math.abs(gg - b) < 10;
    return isVeryDark || isDarkNeutral;
  }

  keepLargestAlphaComponent(data, width, height) {
    const seen = new Uint8Array(width * height);
    const dirs = [-1, 1, -width, width];
    let best = null;

    for (let i = 0; i < width * height; i++) {
      if (seen[i] || data[i * 4 + 3] === 0) continue;
      const stack = [i];
      const pixels = [];
      seen[i] = 1;
      while (stack.length) {
        const idx = stack.pop();
        pixels.push(idx);
        const x = idx % width;
        for (const d of dirs) {
          const ni = idx + d;
          if (ni < 0 || ni >= width * height || seen[ni]) continue;
          const nx = ni % width;
          if ((d === -1 || d === 1) && Math.abs(nx - x) !== 1) continue;
          if (data[ni * 4 + 3] === 0) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      if (!best || pixels.length > best.length) best = pixels;
    }

    if (!best) return;
    const keep = new Uint8Array(width * height);
    for (const idx of best) keep[idx] = 1;
    for (let i = 0; i < width * height; i++) {
      if (!keep[i]) data[i * 4 + 3] = 0;
    }
  }

  measureProcessedCanvas(c) {
    const g = c.getContext('2d', { willReadFrequently: true });
    const data = g.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) {
      return { canvas: c, bounds: { x: 0, y: 0, w: c.width, h: c.height } };
    }
    return { canvas: c, bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
  }

  buildFallbackAtlas() {
    this.fallbackAtlas = {};
    for (const name of Object.keys(TERRAINS)) {
      const base = TERRAINS[name].color;
      this.fallbackAtlas[name] = [];
      for (let v = 0; v < 3; v++) {
        const c = document.createElement('canvas');
        c.width = Math.round(TILE_W * this.dpr);
        c.height = Math.round(TILE_H * this.dpr);
        const g = c.getContext('2d');
        g.scale(this.dpr, this.dpr);
        g.beginPath();
        g.moveTo(TW2, 0.5);
        g.lineTo(TILE_W - 0.5, TH2);
        g.lineTo(TW2, TILE_H - 0.5);
        g.lineTo(0.5, TH2);
        g.closePath();
        g.save();
        g.clip();
        const grad = g.createLinearGradient(0, 0, 0, TILE_H);
        grad.addColorStop(0, shade(base, 18));
        grad.addColorStop(1, shade(base, -18));
        g.fillStyle = grad;
        g.fillRect(0, 0, TILE_W, TILE_H);
        g.restore();
        g.strokeStyle = 'rgba(255,255,255,0.1)';
        g.beginPath();
        g.moveTo(0.5, TH2);
        g.lineTo(TW2, 0.5);
        g.lineTo(TILE_W - 0.5, TH2);
        g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.24)';
        g.beginPath();
        g.moveTo(TILE_W - 0.5, TH2);
        g.lineTo(TW2, TILE_H - 0.5);
        g.lineTo(0.5, TH2);
        g.stroke();
        this.fallbackAtlas[name].push(c);
      }
    }
  }

  isoX(x, y) { return (x - y) * TW2; }
  isoY(x, y) { return (x + y) * TH2; }

  drawTerrainUnderlay(tile, cx, cy) {
    const ctx = this.ctx;
    const base = terrainBaseColor(tile.terrain);
    const grad = ctx.createLinearGradient(cx, cy - TH2, cx, cy + TH2);
    grad.addColorStop(0, shade(base, 18));
    grad.addColorStop(1, shade(base, -10));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy - TH2);
    ctx.lineTo(cx + TW2, cy);
    ctx.lineTo(cx, cy + TH2);
    ctx.lineTo(cx - TW2, cy);
    ctx.closePath();
    ctx.fill();
  }

  drawTileGrid(cx, cy, visible) {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    ctx.strokeStyle = visible ? 'rgba(12,16,20,0.42)' : 'rgba(12,16,20,0.26)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - TH2);
    ctx.lineTo(cx + TW2, cy);
    ctx.lineTo(cx, cy + TH2);
    ctx.lineTo(cx - TW2, cy);
    ctx.closePath();
    ctx.stroke();

    ctx.strokeStyle = visible ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.moveTo(cx - TW2, cy);
    ctx.lineTo(cx, cy - TH2);
    ctx.lineTo(cx + TW2, cy);
    ctx.stroke();
  }

  drawCapitalBase(cx, cy) {
    const ctx = this.ctx;
    const grad = ctx.createRadialGradient(cx, cy + 2, 6, cx, cy + 2, 30);
    grad.addColorStop(0, 'rgba(244,205,110,0.30)');
    grad.addColorStop(1, 'rgba(244,205,110,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 2, 30, 14, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(250,223,138,0.22)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - TH2 + 1);
    ctx.lineTo(cx + TW2 - 1, cy);
    ctx.lineTo(cx, cy + TH2 - 1);
    ctx.lineTo(cx - TW2 + 1, cy);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(244,205,110,0.52)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - TH2 + 1);
    ctx.lineTo(cx + TW2 - 1, cy);
    ctx.lineTo(cx, cy + TH2 - 1);
    ctx.lineTo(cx - TW2 + 1, cy);
    ctx.closePath();
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  drawPoiBase(cx, cy, palette) {
    const ctx = this.ctx;
    const glow = ctx.createRadialGradient(cx, cy + 3, 5, cx, cy + 3, 26);
    glow.addColorStop(0, palette.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 3, 26, 11, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = palette.fill;
    ctx.beginPath();
    ctx.moveTo(cx, cy - TH2 + 2);
    ctx.lineTo(cx + TW2 - 2, cy);
    ctx.lineTo(cx, cy + TH2 - 2);
    ctx.lineTo(cx - TW2 + 2, cy);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = palette.stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - TH2 + 2);
    ctx.lineTo(cx + TW2 - 2, cy);
    ctx.lineTo(cx, cy + TH2 - 2);
    ctx.lineTo(cx - TW2 + 2, cy);
    ctx.closePath();
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  drawWorldSprite(image, cx, groundY, maxW, maxH, shadowW, shadowH) {
    if (!image || !image.ready || !image.processed || !image.bounds) return null;
    const b = image.bounds;
    const scale = Math.min(maxW / b.w, maxH / b.h);
    const dw = b.w * scale;
    const dh = b.h * scale;
    if (shadowW && shadowH) {
      this.ctx.fillStyle = 'rgba(0,0,0,0.28)';
      this.ctx.beginPath();
      this.ctx.ellipse(cx, groundY - 2, shadowW, shadowH, 0, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.drawImage(image.processed, b.x, b.y, b.w, b.h, cx - dw / 2, groundY - dh, dw, dh);
    return { dw, dh, topY: groundY - dh };
  }

  /* Case vide de donjon : losange quasi noir, plus sombre que le fond */
  drawVoidTile(cx, cy) {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - TH2);
    ctx.lineTo(cx + TW2, cy);
    ctx.lineTo(cx, cy + TH2);
    ctx.lineTo(cx - TW2, cy);
    ctx.closePath();
    ctx.fillStyle = '#06080b';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.stroke();
  }

  drawTerrainTile(tile, cx, cy, visible) {
    const ctx = this.ctx;
    const variants = this.terrainTiles[tile.terrain] || this.terrainTiles.MONTAGNE || [];
    const index = variants.length
      ? Math.floor(hash2(tile.x, tile.y, this.server.seed, 7) * variants.length) % variants.length
      : 0;
    const sprite = variants[index];

    ctx.globalAlpha = 1;
    this.drawTerrainUnderlay(tile, cx, cy);
    if (sprite && sprite.ready && sprite.bounds && sprite.processed) {
      const b = sprite.bounds;
      const sw = b.w;
      const sh = Math.max(1, Math.floor(b.h * TOP_FACE_CROP));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy - TH2);
      ctx.lineTo(cx + TW2, cy);
      ctx.lineTo(cx, cy + TH2);
      ctx.lineTo(cx - TW2, cy);
      ctx.closePath();
      ctx.clip();
      ctx.globalAlpha = visible ? 1 : 0.42;
      ctx.drawImage(sprite.processed, b.x, b.y, sw, sh, cx - TW2, cy - TH2, TILE_W, TILE_H);
      ctx.restore();
    } else {
      const fallback = this.fallbackAtlas[tile.terrain] || this.fallbackAtlas.MONTAGNE;
      const v = Math.floor(hash2(tile.x, tile.y, this.server.seed, 7) * fallback.length) % fallback.length;
      ctx.globalAlpha = visible ? 1 : 0.42;
      ctx.drawImage(fallback[v], cx - TW2, cy - TH2, TILE_W, TILE_H);
    }

    if (!visible) {
      ctx.fillStyle = 'rgba(8,10,14,0.18)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - TH2);
      ctx.lineTo(cx + TW2, cy);
      ctx.lineTo(cx, cy + TH2);
      ctx.lineTo(cx - TW2, cy);
      ctx.closePath();
      ctx.fill();
    }
    this.drawTileGrid(cx, cy, visible);
    ctx.globalAlpha = 1;
  }

  screenToTile(sx, sy) {
    const ix = sx - this.w / 2 + this.cam.x;
    const iy = sy - this.h / 2 + this.cam.y;
    return {
      x: Math.round((ix / TW2 + iy / TH2) / 2),
      y: Math.round((iy / TH2 - ix / TW2) / 2),
    };
  }

  draw() {
    const s = this.server, me = s.me, ctx = this.ctx;
    if (!me) return;

    const tx = this.isoX(me.pos.x, me.pos.y);
    const ty = this.isoY(me.pos.x, me.pos.y);
    if (!this.camInit) {
      this.cam.x = tx;
      this.cam.y = ty;
      this.camInit = true;
    }
    this.cam.x += (tx - this.cam.x) * 0.15;
    this.cam.y += (ty - this.cam.y) * 0.15;

    ctx.fillStyle = '#101318';
    ctx.fillRect(0, 0, this.w, this.h);

    const R = Math.min(30, Math.ceil(Math.max(this.w / TILE_W, this.h / TILE_H)) + 3);
    const px = me.pos.x, py = me.pos.y;

    const poi = [];
    for (let y = py - R; y <= py + R; y++) {
      for (let x = px - R; x <= px + R; x++) {
        if (!inBounds(x, y, s.tiles)) continue;
        const key = tileKey(x, y);
        const visible = Math.hypot(x - px, y - py) <= CONFIG.VIEW_RADIUS + 0.5;
        const tile = s.tiles.get(key);
        // Repères permanents : visibles même à travers le brouillard
        const landmark = tile.content &&
          (tile.content.kind === 'capital' || tile.content.kind === 'village' || tile.content.kind === 'dungeon');
        const known = visible || this.explored.has(key);
        // Donjon : zones vides (non praticables) en noir profond, dessinées
        // même sous brouillard — on lit la silhouette des couloirs d'un
        // coup d'œil et on comprend que ce n'est pas du sol
        if (!known && !landmark && !tile.blocked) continue;
        const cx = this.isoX(x, y) - this.cam.x + this.w / 2;
        const cy = this.isoY(x, y) - this.cam.y + this.h / 2;
        if (cx < -TILE_W * 2 || cx > this.w + TILE_W * 2 || cy < -TILE_H * 4 || cy > this.h + TILE_H * 3) continue;

        if (tile.blocked) {
          this.drawVoidTile(cx, cy);
          continue;
        }

        if (known) {
          this.drawTerrainTile(tile, cx, cy, visible);
        } else {
          // Îlot de terrain fantôme sous le repère non exploré
          ctx.globalAlpha = 0.5;
          this.drawTerrainTile(tile, cx, cy, false);
          ctx.globalAlpha = 1;
        }

        if (landmark) poi.push({ tile, cx, cy, visible, fogged: !known });
        else if (tile.content && visible) poi.push({ tile, cx, cy, visible, fogged: false });
      }
    }

    poi.sort((a, b) => a.cy - b.cy);
    for (const p of poi) this.drawContent(p.tile, p.cx, p.cy, p.visible, p.fogged);

    const others = [...s.players.values()]
      .filter((p) => p.id !== me.id && p.mapId === (me.mapId || 'world') && p.pos && Math.hypot(p.pos.x - px, p.pos.y - py) <= CONFIG.VIEW_RADIUS + 0.5)
      .sort((a, b) => (a.pos.x + a.pos.y) - (b.pos.x + b.pos.y));
    for (const p of others) this.drawPlayer(p, false);
    this.drawPlayer(me, true);
  }

  drawContent(tile, cx, cy, visible, fogged) {
    const ctx = this.ctx, c = tile.content, s = this.server;

    // Repère aperçu à travers le brouillard : rendu fantôme
    const isLandmark = c.kind === 'capital' || c.kind === 'village' || c.kind === 'dungeon';
    if (isLandmark && fogged) ctx.globalAlpha = 0.62;

    if (c.kind === 'capital') {
      this.drawCapitalBase(cx, cy);
      const size = contentSpriteSize('capital');
      const drawn = this.drawWorldSprite(
        this.worldIcons.capital,
        cx,
        cy + size.groundOffset,
        size.w,
        size.h,
        size.shadowW,
        size.shadowH
      );
      if (!drawn) {
        const grad = ctx.createLinearGradient(cx, cy - TH2, cx, cy + TH2);
        grad.addColorStop(0, '#f4cd6e');
        grad.addColorStop(1, '#c8922c');
        ctx.beginPath();
        ctx.moveTo(cx, cy - TH2 + 4);
        ctx.lineTo(cx + TW2 - 8, cy);
        ctx.lineTo(cx, cy + TH2 - 4);
        ctx.lineTo(cx - TW2 + 8, cy);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.stroke();
        ctx.font = '22px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('C', cx, cy - 6);
      }
      this.label(cx, cy + TH2 + 14, 'CAPITALE', '#f4cd6e', 10);
      ctx.globalAlpha = 1;
      return;
    }

    if (c.kind === 'village') {
      const size = contentSpriteSize('village');
      const sprite = this.worldIcons.village[c.terrain || tile.terrain];
      this.drawPoiBase(cx, cy, {
        fill: 'rgba(241, 225, 173, 0.16)',
        stroke: 'rgba(241, 225, 173, 0.5)',
        glow: 'rgba(241, 225, 173, 0.24)',
      });
      this.drawWorldSprite(
        sprite,
        cx,
        cy + size.groundOffset,
        size.w,
        size.h,
        size.shadowW,
        size.shadowH
      );
      this.label(cx, cy + TH2 + 12, 'VILLAGE', '#f1e1ad', 9);
      ctx.globalAlpha = 1;
      return;
    }

if (c.kind === 'dungeon') {
      const size = contentSpriteSize('dungeon');
      const sprite = this.worldIcons.dungeon[c.terrain || tile.terrain];
      this.drawPoiBase(cx, cy, {
        fill: 'rgba(149, 193, 214, 0.14)',
        stroke: 'rgba(149, 193, 214, 0.45)',
        glow: 'rgba(149, 193, 214, 0.20)',
      });
      this.drawWorldSprite(
        sprite,
        cx,
        cy + size.groundOffset,
        size.w,
        size.h,
        size.shadowW,
        size.shadowH
      );
      this.label(cx, cy + TH2 + 12, 'DONJON', '#b8d8e6', 9);
      ctx.globalAlpha = 1;
      return;
    }

    if (c.kind === 'portal') {
      this.drawPoiBase(cx, cy, {
        fill: 'rgba(244, 205, 110, 0.16)',
        stroke: 'rgba(244, 205, 110, 0.5)',
        glow: 'rgba(244, 205, 110, 0.22)',
      });
      ctx.beginPath();
      ctx.arc(cx, cy - 6, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(36, 47, 72, 0.88)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#f4cd6e';
      ctx.stroke();
      this.label(cx, cy + TH2 + 10, 'SORTIE', '#f4cd6e', 9);
      ctx.globalAlpha = 1;
      return;
    }

    const inactive = s.now < c.inactiveUntil;
    ctx.globalAlpha = (visible ? 1 : 0.35) * (inactive ? 0.4 : 1);

    if (c.kind === 'resource') {
      const sprite = this.worldIcons.resource[c.type] && this.worldIcons.resource[c.type][c.tier];
      const size = contentSpriteSize('resource', c.type, c.tier);
      if (c.tier >= 6) {
        size.w = Math.round(size.w * 1.12);
        size.h = Math.round(size.h * 1.12);
        size.shadowW = Math.round(size.shadowW * 1.08);
      }
      const drawInfo = this.drawWorldSprite(
        sprite,
        cx,
        cy + size.groundOffset,
        size.w,
        size.h,
        size.shadowW,
        size.shadowH
      );
      if (!drawInfo) {
        const r = 10 + c.tier * 1.6;
        ctx.beginPath();
        ctx.arc(cx, cy - 2, r, 0, Math.PI * 2);
        ctx.fillStyle = inactive ? 'rgba(120,128,138,0.55)' : 'rgba(238,242,246,0.92)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = TIER_COLORS[c.tier];
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.font = Math.round(r * 1.15) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(RESOURCE_EMOJI[c.type], cx, cy - 2);
      }
      if (inactive) {
        this.label(cx, cy + 26, 'REP ' + Math.ceil((c.inactiveUntil - s.now) / 1000) + ' s', '#c8d0da', 9);
      } else {
        this.badge(cx, cy + 26, 'T' + c.tier, TIER_COLORS[c.tier]);
      }
    } else if (c.kind === 'monster') {
      const sprite = this.worldIcons.monster[c.type] || this.worldIcons.monster[MONSTERS[c.tier] && MONSTERS[c.tier].type];
      const size = contentSpriteSize('monster', '', c.tier);
      if (c.boss) {
        size.w = Math.round(size.w * 1.55);
        size.h = Math.round(size.h * 1.55);
        size.groundOffset += 4;
        size.shadowW = Math.round(size.shadowW * 1.45);
        size.shadowH = Math.round(size.shadowH * 1.2);
      } else if (c.tier >= 6) {
        size.w = Math.round(size.w * 1.15);
        size.h = Math.round(size.h * 1.15);
      }
      const drawInfo = this.drawWorldSprite(
        sprite,
        cx,
        cy + size.groundOffset,
        size.w,
        size.h,
        size.shadowW,
        size.shadowH
      );
      const pulseBase = drawInfo ? 24 : 17;
      if (!drawInfo) {
        const r = 12 + c.tier * 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy - 2, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(44,20,24,0.88)';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = inactive ? 'rgba(209,87,87,0.4)' : '#d15757';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.font = Math.round(r * 1.2) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(MONSTER_EMOJI[c.tier], cx, cy - 2);
      }
      if (inactive) {
        this.label(cx, cy + 28, 'REP ' + Math.ceil((c.inactiveUntil - s.now) / 1000) + ' s', '#c8d0da', 9);
      } else {
        this.badge(cx, cy + 28, 'T' + c.tier, TIER_COLORS[c.tier]);
      }

      const raid = s.raids.get(raidKey((s.currentMapId || (s.me && s.me.mapId) || 'world'), tile.x, tile.y));
      if (raid) {
        const pulse = pulseBase + Math.sin(performance.now() / 180) * 3;
        ctx.beginPath();
        ctx.arc(cx, cy - 2, pulse, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff7b6b';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.lineWidth = 1;
        this.label(
          cx,
          cy - pulseBase - 16,
          Math.max(0, Math.ceil((raid.endsAt - s.now) / 1000)) + 's · ' + raid.participants.length + ' RAID',
          '#ffd9d3',
          11
        );
      }
    }
    ctx.globalAlpha = 1;
  }

  label(cx, cy, text, color, size) {
    const ctx = this.ctx;
    ctx.font = '700 ' + size + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,12,16,0.75)';
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = color;
    ctx.fillText(text, cx, cy);
    ctx.lineWidth = 1;
  }

  badge(cx, cy, text, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    this.roundRect(cx - 11, cy - 6, 22, 12, 6);
    ctx.fill();
    ctx.fillStyle = '#14181d';
    ctx.font = '800 8px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 0.5);
  }

  drawPlayer(p, isMe) {
    const ctx = this.ctx;
    const cx = this.isoX(p.pos.x, p.pos.y) - this.cam.x + this.w / 2;
    const cy = this.isoY(p.pos.x, p.pos.y) - this.cam.y + this.h / 2;
    const cls = CLASSES[p.speciesClass];

    ctx.beginPath();
    ctx.ellipse(cx, cy + 6, 14, 5.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();
    if (isMe) {
      ctx.beginPath();
      ctx.ellipse(cx, cy + 6, 18, 7.5, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(244,205,110,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    let topY = cy - 34;
    const cell = SPRITE_CELLS[p.speciesClass];
    if (this.spritesReady && cell) {
      const cw = this.sprites.width / 3, ch = this.sprites.height / 2;
      const sx = cell[0] * cw + cw * 0.06, sy = cell[1] * ch;
      const sw = cw * 0.88, sh = ch * SPRITE_ROW_CROP[cell[1]];
      const dh = isMe ? 58 : 46;
      const dw = dh * (sw / sh);
      ctx.drawImage(this.sprites, sx, sy, sw, sh, cx - dw / 2, cy + 8 - dh, dw, dh);
      topY = cy + 8 - dh;
    } else {
      const size = isMe ? 20 : 16;
      ctx.fillStyle = cls.color;
      ctx.strokeStyle = isMe ? '#e8ecf1' : 'rgba(232,236,241,0.35)';
      ctx.lineWidth = isMe ? 2 : 1;
      this.roundRect(cx - size / 2, cy - size / 2 - 6, size, size, 4);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = '#14181d';
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cls.icon, cx, cy - 5.5);
      topY = cy - size - 6;
    }

    this.label(cx, topY - 7, p.username, isMe ? '#f4cd6e' : '#dfe5ec', 9);

    if (p.status === 'LOBBY_COMBAT') {
      this.label(cx, topY - 18, 'RAID', '#ff7b6b', 11);
    }

    if (isMe && p.status === 'HARVESTING') {
      const frac = 1 - (p.harvestEndsAt - this.server.now) / CONFIG.HARVEST_MS;
      ctx.fillStyle = 'rgba(20,24,29,0.85)';
      ctx.fillRect(cx - 20, topY - 30, 40, 7);
      ctx.fillStyle = '#58b368';
      ctx.fillRect(cx - 19, topY - 29, 38 * Math.max(0, Math.min(1, frac)), 5);
    }
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  drawMinimapMarker(ctx, x, y, kind, scale) {
    const size = Math.max(3, Math.round(scale * 1.6));

    if (kind === 'capital') {
      ctx.fillStyle = '#f4cd6e';
      ctx.strokeStyle = 'rgba(20,24,29,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      return;
    }

    if (kind === 'village') {
      ctx.fillStyle = '#f1e1ad';
      ctx.strokeStyle = 'rgba(20,24,29,0.9)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      return;
    }

    if (kind === 'dungeon') {
      ctx.fillStyle = '#b8d8e6';
      ctx.strokeStyle = 'rgba(20,24,29,0.9)';
      ctx.lineWidth = 1.25;
      ctx.fillRect(x - size * 0.75, y - size * 0.75, size * 1.5, size * 1.5);
      ctx.strokeRect(x - size * 0.75, y - size * 0.75, size * 1.5, size * 1.5);
    }
  }

  drawMinimapLegend(ctx, size) {
    const entries = [
      ['T1', TIER_COLORS[1]],
      ['T2', TIER_COLORS[2]],
      ['T3', TIER_COLORS[3]],
      ['T4', TIER_COLORS[4]],
      ['T5', TIER_COLORS[5]],
    ];
    const boxW = 22;
    const gap = 4;
    const totalW = entries.length * boxW + (entries.length - 1) * gap;
    const x0 = Math.round((size - totalW) / 2);
    const y = size - 18;

    ctx.font = '700 8px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < entries.length; i++) {
      const x = x0 + i * (boxW + gap);
      const [label, color] = entries[i];
      ctx.fillStyle = color;
      this.roundRect(x, y, boxW, 10, 4);
      ctx.fill();
      ctx.fillStyle = '#101318';
      ctx.fillText(label, x + boxW / 2, y + 5.5);
    }
  }

  drawMinimap(canvas) {
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const b = boundsOf(this.server.tiles);
    const scale = size / (b.max - b.min + 1);
    const toPx = (v) => (v - b.min) * scale;
    const markers = [];

    ctx.fillStyle = '#101318';
    ctx.fillRect(0, 0, size, size);

    for (const key of this.explored) {
      const tile = this.server.tiles.get(key);
      if (!tile || tile.blocked) continue;   // les vides du donjon restent noirs
      const tier = tile.content && tile.content.tier ? tile.content.tier : Math.min(5, tierAtDistance(Math.hypot(tile.x, tile.y)));
      ctx.fillStyle = mixColors(TERRAINS[tile.terrain].color, TIER_COLORS[tier], 0.22);
      ctx.fillRect(toPx(tile.x), toPx(tile.y), Math.ceil(scale), Math.ceil(scale));
    }

    // Repères permanents : cartographiés sur tout le monde, brouillard compris
    for (const tile of this.server.tiles.values()) {
      if (tile.content && (tile.content.kind === 'capital' || tile.content.kind === 'village' || tile.content.kind === 'dungeon' || tile.content.kind === 'portal')) {
        markers.push({
          kind: tile.content.kind === 'portal' ? 'capital' : tile.content.kind,
          x: toPx(tile.x) + scale / 2,
          y: toPx(tile.y) + scale / 2,
        });
      }
    }

    for (const marker of markers) {
      this.drawMinimapMarker(ctx, marker.x, marker.y, marker.kind, scale);
    }

    this.drawMinimapLegend(ctx, size);

    const me = this.server.me;
    if (!me) return;
    const mx = toPx(me.pos.x) + scale / 2;
    const my = toPx(me.pos.y) + scale / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.arc(mx, my, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#101318';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(mx, my - 8);
    ctx.lineTo(mx + 8, my);
    ctx.lineTo(mx, my + 8);
    ctx.lineTo(mx - 8, my);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(mx, my - 6);
    ctx.lineTo(mx + 6, my);
    ctx.lineTo(mx, my + 6);
    ctx.lineTo(mx - 6, my);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#4a9fd8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, my - 6);
    ctx.lineTo(mx + 6, my);
    ctx.lineTo(mx, my + 6);
    ctx.lineTo(mx - 6, my);
    ctx.closePath();
    ctx.stroke();
  }
}
