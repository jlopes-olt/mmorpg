# WildRift RPG — Prototype

MMORPG casual sur grille isométrique, mobile first (portrait, une main).
Monde persistant, backend temps réel, habillage sprites/tuiles.

## Lancer

### Mode multijoueur (backend réel, données persistantes)

```bash
cd server
npm install
npm start           # http://localhost:3000
```

- **Inscription / connexion** : compte par nom + mot de passe (hash scrypt +
  sel, comparaison à temps constant). La session est reprise automatiquement
  par un token stocké dans le localStorage, régénéré à chaque connexion.
  Bouton « Se déconnecter » dans le Profil.
- **Persistance SQLite** (`server/data/wildrift.db`, module natif
  `node:sqlite`, WAL) : chaque compte est écrit immédiatement après un
  événement important (action réussie, fin de récolte, raid, déconnexion) —
  plus l'horloge et les respawns toutes les 30 s. Un ancien
  `server/data/state.json` est migré automatiquement au premier démarrage
  (puis archivé en `.imported`) ; les comptes d'avant les mots de passe
  définissent le leur à la première connexion.
- Variables utiles : `PORT=8080`, `SPEED=10` (accélère tout le serveur pour
  tester), `DB_FILE=...` (chemin de la base), `STATE_FILE=...` (JSON legacy à
  migrer).
- **PWA installable** : manifest + service worker (`manifest.webmanifest`,
  `sw.js`, icônes générées par `server/tools/make-icons.js`). Sur mobile,
  « Ajouter à l'écran d'accueil » installe le jeu en plein écran portrait.
  La coquille est précachée (stale-while-revalidate) ; `/socket.io/` n'est
  jamais caché : hors-ligne, le jeu bascule automatiquement en mode solo.
  Incrémenter `VERSION` dans `sw.js` pour forcer un rafraîchissement.
- Ouvrir plusieurs navigateurs/onglets = plusieurs joueurs en temps réel.

### Mode solo (sans backend)

Ouvrir `index.html` directement (`file://`) : le jeu bascule automatiquement
sur la simulation locale (`ServerSim`, bots inclus, sauvegarde localStorage).
C'est aussi le mode utilisé par l'artifact publié.

Panneau **DEV** (⚙ en haut à droite) : vitesse x10/x60 (en multi : vitesse
globale du serveur), +50 PA, révéler la carte, réinitialiser le compte.

## Boucles de jeu

- **Monde 100×100** généré par seed, Capitale en (0,0), tiers T1→T5 en anneaux.
- **Déplacement** : tap → confirmation « Aller sur la case (x, y) ? (n PA) » →
  pathfinding BFS, 1 PA/case validé pas à pas par le serveur.
- **Récolte** : 2 PA, 3 s, gate `harvestLevel`, respawn 90 s.
- **Raids** : lobby 30 s rejoignable à ≤ 6 cases (5 PA) — le **chef peut lancer
  le combat immédiatement** depuis la bannière. Résolution instantanée
  ForceÉquipe vs ForceMonstre, butin/XP/PV, KO → Capitale.
- **Forgeron** (Capitale) : arme + armure uniques évolutives T1→T5.
- **6 combos espèce/classe** à bonus uniques.

## Habillage

- **Personnages** : `assets/personnages.png` (6 classes, grille 3×2), détourée
  par `server/tools/strip-bg.js` (chroma-key + suppression des bandeaux) →
  `personnages_alpha.png` (pleine résolution) et `personnages_small.png`
  (768×512, utilisée par le jeu et embarquée dans l'artifact).
- **Carte** : tuiles iso pré-rendues (atlas offscreen : dégradé, grain, décor
  par terrain), arêtes éclairées/ombrées.
- **Points d'intérêt** : socle circulaire + icône (🌳 bois, 🪨 minerai,
  🌿 plante ; 🐺→🐉 monstres par tier). Le **tier se lit sur le skin** :
  anneau + pastille de la couleur du tier (gris → vert → bleu → violet → or)
  et taille croissante ; le détail complet s'affiche au tap (pop-up).

## Architecture

```
index.html            client (charge /socket.io/socket.io.js si servi par le backend)
css/style.css         thème sombre, tokens CSS
js/config.js          équilibrage + données statiques  ← partagé client/serveur
js/world.js           génération du monde par seed     ← partagé client/serveur
js/server.js          ServerSim : simulation locale (mode solo/artifact)
js/net.js             RemoteServer : client Socket.io (même API que ServerSim)
js/render.js          canvas iso (atlas, POI, sprites) + minimap
js/ui.js              HUD, bottom-sheets, popups, création de perso
js/main.js            boucle, entrées, pathfinding, choix du mode, persistance
server/index.js       Express + Socket.io + branchement persistance
server/store.js       persistance SQLite (node:sqlite, WAL)
server/game.js        logique autoritaire + comptes (scrypt)
server/game.js        logique autoritaire multijoueur (mêmes règles que ServerSim)
server/tools/         strip-bg.js (détourage sprites)
server/test-game.js   test logique multijoueur    (npm test)
server/test-socket.js test socket de bout en bout (npm test)
build.js              artifact monofichier (sprites inlinés en data URI)
```

Le client ne contient **aucune logique de jeu** : `RemoteServer` et `ServerSim`
exposent la même API (`move`, `harvest`, `createRaid`, `joinRaid`,
`startRaidNow`, `upgrade`, `rest`, `say` + événements `self/chat/result/toast`) ;
render/ui/main ne voient pas la différence.

### Protocole socket

| Client → serveur (ack `{ok, error?}`) | Serveur → client |
| --- | --- |
| `auth {token}` / `register {username, password, speciesClass}` / `login {username, password}` | `init`, `creation {error?}`, `self` |
| `move {dx, dy}` | `players` (500 ms), `time` (2 s) |
| `harvest {x, y}` | `world {key, inactiveUntil}` |
| `raid:create {x,y}` / `raid:join {key}` / `raid:start {key}` | `raids` (liste complète, `teamForce` pré-calculée) |
| `upgrade {slot}` / `rest` / `dev {...}` | `result` (participants), `toast` |
| `chat {text}` | `chat` |

## Équilibrage (v0)

- Force joueur = base classe (14–26) + tier d'arme × 15 + maîtrise × 5
- Force monstres : T1 30 (soloable), T2 90, T3 180, T4 320, T5 550
- XP paliers : 100 / 300 / 700 / 1500 — Coûts PA : bouger 1, récolter 2,
  raid 5, forge 10/25/50/100

## Limites connues / suite

- Auth nom + mot de passe (scrypt) : pas d'e-mail ni de récupération de
  compte, et pas de limitation de tentatives — à ajouter avant une mise en
  ligne publique. Servir en HTTPS (reverse proxy) pour protéger les mots de
  passe en transit.
- L'armure est gatée par la maîtrise d'arme (pas de maîtrise dédiée au spec).
- Diffusion `players` globale (pas de partitionnement spatial) — à optimiser
  au-delà de quelques dizaines de joueurs simultanés.
- Pas encore : PvP, guildes, échanges entre joueurs.
