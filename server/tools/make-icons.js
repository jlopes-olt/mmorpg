'use strict';

/* ============================================================
 * make-icons.js — icônes PWA depuis la planche de personnages.
 *
 * Compose le Lion Paladin (case [1,1] de personnages_alpha.png)
 * sur un fond radial sombre du thème, en plusieurs tailles :
 *   assets/icons/icon-512.png            (icône standard)
 *   assets/icons/icon-192.png
 *   assets/icons/icon-maskable-512.png   (marge zone sûre Android)
 *   assets/icons/apple-touch-icon.png    (180, fond opaque iOS)
 *
 * Usage : node tools/make-icons.js   (depuis server/)
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const OUT = path.join(ASSETS, 'icons');
fs.mkdirSync(OUT, { recursive: true });

const sheet = PNG.sync.read(fs.readFileSync(path.join(ASSETS, 'personnages_alpha.png')));

/* Case du Lion Paladin : colonne 1, rangée 1 (bas utile 0.81 — cf. strip-bg) */
const cellW = sheet.width / 3, cellH = sheet.height / 2;
const SRC = {
  x: 1 * cellW + cellW * 0.06,
  y: 1 * cellH,
  w: cellW * 0.88,
  h: cellH * 0.81,
};

/* Échantillonnage bilinéaire (couleurs pondérées par l'alpha) */
function sampleSheet(fx, fy) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (const [dx, dy, w] of [
    [0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)],
    [0, 1, (1 - tx) * ty], [1, 1, tx * ty],
  ]) {
    const xx = Math.min(sheet.width - 1, x0 + dx);
    const yy = Math.min(sheet.height - 1, y0 + dy);
    const o = (yy * sheet.width + xx) * 4;
    const pa = sheet.data[o + 3] * w;
    r += sheet.data[o] * pa; g += sheet.data[o + 1] * pa; b += sheet.data[o + 2] * pa;
    a += pa;
  }
  return a > 0 ? [r / a, g / a, b / a, a] : [0, 0, 0, 0];
}

/**
 * size        taille du canevas
 * spriteFrac  hauteur du personnage en fraction du canevas
 */
function renderIcon(size, spriteFrac, file) {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2, cy = size / 2;
  const maxD = Math.hypot(cx, cy);

  // Fond : dégradé radial sombre (thème)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.hypot(x - cx, y - cy) / maxD;
      const o = (y * size + x) * 4;
      png.data[o] = Math.round(26 - 8 * t);
      png.data[o + 1] = Math.round(31 - 10 * t);
      png.data[o + 2] = Math.round(38 - 12 * t);
      png.data[o + 3] = 255;
    }
  }

  // Personnage centré (léger décalage vers le bas, comme posé)
  const dh = size * spriteFrac;
  const dw = dh * (SRC.w / SRC.h);
  const dx0 = (size - dw) / 2;
  const dy0 = (size - dh) / 2 + size * 0.02;
  for (let y = Math.floor(dy0); y < dy0 + dh; y++) {
    for (let x = Math.floor(dx0); x < dx0 + dw; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const [r, g, b, a] = sampleSheet(
        SRC.x + ((x - dx0) / dw) * SRC.w,
        SRC.y + ((y - dy0) / dh) * SRC.h
      );
      if (a <= 0) continue;
      const o = (y * size + x) * 4;
      const na = a / 255;
      png.data[o] = Math.round(r * na + png.data[o] * (1 - na));
      png.data[o + 1] = Math.round(g * na + png.data[o + 1] * (1 - na));
      png.data[o + 2] = Math.round(b * na + png.data[o + 2] * (1 - na));
    }
  }

  fs.writeFileSync(path.join(OUT, file), PNG.sync.write(png));
  console.log('Écrit : icons/' + file);
}

renderIcon(512, 0.80, 'icon-512.png');
renderIcon(192, 0.80, 'icon-192.png');
renderIcon(512, 0.62, 'icon-maskable-512.png');   // zone sûre : cercle interne 80%
renderIcon(180, 0.78, 'apple-touch-icon.png');
