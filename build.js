/* Build : concatène le prototype en un seul fichier HTML autonome
 * (utilisé pour publier la version jouable en artifact).
 * Usage : node build.js [chemin/de/sortie.html]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const body = html
  .match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/[ \t]*<script src=[^>]+><\/script>\s*/g, '');

// net.js exclu : pas de réseau dans l'artifact (mode simulation locale)
const js = ['config', 'world', 'server', 'render', 'ui', 'main']
  .map((n) => fs.readFileSync(path.join(root, 'js', n + '.js'), 'utf8'))
  .join('\n');

// Feuille de sprites embarquée (CSP artifact : aucune requête externe)
const spriteB64 = fs.readFileSync(path.join(root, 'assets', 'personnages_small.png')).toString('base64');

const out =
  '<title>FERALIA Online</title>\n' +
  '<style>\n' + css + '</style>\n' +
  body + '\n' +
  '<script>window.WILDRIFT_SPRITE = "data:image/png;base64,' + spriteB64 + '";</script>\n' +
  '<script>\n' + js + '\n</script>\n';

const target = process.argv[2] || path.join(root, 'dist', 'artifact.html');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);
console.log('Écrit :', target, '(' + out.length + ' octets)');

