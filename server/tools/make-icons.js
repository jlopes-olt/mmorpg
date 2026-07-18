'use strict';

/* ============================================================
 * make-icons.js — icônes PWA à partir du logo Feralia Online.
 *
 * Recadre l'écusson (couronne + bouclier + patte) dans le logo grand
 * format, retire la frange verte laissée par le détourage chroma-key,
 * puis compose sur un fond bois sombre en plusieurs tailles :
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

const logo = PNG.sync.read(fs.readFileSync(path.join(ASSETS, 'feralia_online_logo.png')));

/* Écusson (couronne + bouclier + patte) : bande carrée recadrée à la main,
 * dense et symétrique, sans déborder sur les lettres du bandeau. */
const SRC = { x: 555, y: 15, w: 420, h: 420 };

/* Le logo source a déjà un canal alpha correct, mais les pixels de bord
 * anti-aliasés gardent une teinte verte héritée du fond chroma-key (vert
 * dominant, bleu quasi nul). On la neutralise pour éviter un liseré vert
 * autour de l'écusson une fois posé sur un fond sombre. */
function despill(r, g, b, a) {
  if (a > 0 && a < 255 && g > r + 15 && g > b + 30) {
    const n = Math.max(r, b);
    return [r, n, b];
  }
  return [r, g, b];
}

/* Échantillonnage bilinéaire (couleurs pondérées par l'alpha) */
function sampleLogo(fx, fy) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (const [dx, dy, w] of [
    [0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)],
    [0, 1, (1 - tx) * ty], [1, 1, tx * ty],
  ]) {
    const xx = Math.min(SRC.x + SRC.w - 1, Math.max(SRC.x, x0 + dx));
    const yy = Math.min(SRC.y + SRC.h - 1, Math.max(SRC.y, y0 + dy));
    const o = (yy * logo.width + xx) * 4;
    const [dr, dg, db] = despill(logo.data[o], logo.data[o + 1], logo.data[o + 2], logo.data[o + 3]);
    const pa = logo.data[o + 3] * w;
    r += dr * pa; g += dg * pa; b += db * pa;
    a += pa;
  }
  return a > 0 ? [r / a, g / a, b / a, a] : [0, 0, 0, 0];
}

/**
 * size       taille du canevas
 * markFrac   hauteur de l'écusson en fraction du canevas
 */
function renderIcon(size, markFrac, file) {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2, cy = size / 2;
  const maxD = Math.hypot(cx, cy);

  // Fond : dégradé radial bois sombre (assorti à la planche du logo)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.hypot(x - cx, y - cy) / maxD;
      const o = (y * size + x) * 4;
      png.data[o] = Math.round(46 - 22 * t);
      png.data[o + 1] = Math.round(28 - 14 * t);
      png.data[o + 2] = Math.round(16 - 10 * t);
      png.data[o + 3] = 255;
    }
  }

  // Écusson centré
  const dh = size * markFrac;
  const dw = dh * (SRC.w / SRC.h);
  const dx0 = (size - dw) / 2;
  const dy0 = (size - dh) / 2;
  for (let y = Math.floor(dy0); y < dy0 + dh; y++) {
    for (let x = Math.floor(dx0); x < dx0 + dw; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const [r, g, b, a] = sampleLogo(
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

renderIcon(512, 0.86, 'icon-512.png');
renderIcon(192, 0.86, 'icon-192.png');
renderIcon(512, 0.62, 'icon-maskable-512.png');   // zone sûre : cercle interne 80%
renderIcon(180, 0.84, 'apple-touch-icon.png');
