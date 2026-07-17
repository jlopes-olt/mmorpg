'use strict';

/* ============================================================
 * strip-bg.js — détoure la feuille de sprites.
 *
 * assets/personnages.png (fond beige opaque)
 *   → assets/personnages_alpha.png  (pleine résolution, fond alpha)
 *   → assets/personnages_small.png  (1/2 résolution, utilisée par le jeu)
 *
 * Usage : node tools/strip-bg.js   (depuis server/)
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const src = path.join(ASSETS, 'personnages.png');

const png = PNG.sync.read(fs.readFileSync(src));
const { width, height, data } = png;
console.log('Source :', width + 'x' + height);

// Couleur de fond échantillonnée dans un coin
const o0 = (2 * width + 2) * 4;
const bg = [data[o0], data[o0 + 1], data[o0 + 2]];

// Chroma-key avec lissage : transparent < D1, opaque > D2
const D1 = 26, D2 = 58;
for (let i = 0; i < width * height; i++) {
  const o = i * 4;
  const dr = data[o] - bg[0], dg = data[o + 1] - bg[1], db = data[o + 2] - bg[2];
  const d = Math.sqrt(dr * dr + dg * dg + db * db);
  if (d < D1) data[o + 3] = 0;
  else if (d < D2) data[o + 3] = Math.round(255 * (d - D1) / (D2 - D1));
}

// Efface les bandeaux de labels en bas de chaque case (grille 3x2).
// Coupes mesurées sur le profil de densité de cette planche :
//   rangée 0 : perso+ombre ≤ 0.87, bandeau 0.88–0.96
//   rangée 1 : perso        ≤ 0.80, bandeau 0.82–0.90
// (voir SPRITE_ROW_CROP dans js/render.js, à garder synchronisé)
const CUTS = [0.875, 0.81];
const cellW = width / 3, cellH = height / 2;
for (let row = 0; row < 2; row++) {
  const cutY = Math.round(CUTS[row] * cellH);
  for (let y = cutY; y < cellH; y++) {
    for (let x = 0; x < width; x++) {
      data[((row * cellH + y) * width + x) * 4 + 3] = 0;
    }
  }
  console.log('Rangée ' + row + ' : bandeaux effacés sous ' + CUTS[row]);
}

fs.writeFileSync(path.join(ASSETS, 'personnages_alpha.png'), PNG.sync.write(png));
console.log('Écrit : personnages_alpha.png');

// Réduction 1/2 (filtre boîte, couleurs pondérées par l'alpha)
const w2 = Math.floor(width / 2), h2 = Math.floor(height / 2);
const out = new PNG({ width: w2, height: h2 });
for (let y = 0; y < h2; y++) {
  for (let x = 0; x < w2; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const o = ((y * 2 + dy) * width + (x * 2 + dx)) * 4;
        const pa = data[o + 3];
        r += data[o] * pa; g += data[o + 1] * pa; b += data[o + 2] * pa;
        a += pa;
      }
    }
    const oo = (y * w2 + x) * 4;
    out.data[oo] = a ? Math.round(r / a) : 0;
    out.data[oo + 1] = a ? Math.round(g / a) : 0;
    out.data[oo + 2] = a ? Math.round(b / a) : 0;
    out.data[oo + 3] = Math.round(a / 4);
  }
}
fs.writeFileSync(path.join(ASSETS, 'personnages_small.png'), PNG.sync.write(out));
console.log('Écrit : personnages_small.png (' + w2 + 'x' + h2 + ')');
