'use strict';

/* ============================================================
 * game.js — logique de jeu autoritaire, multijoueur
 * Version multi-cartes : monde + donjons partagés
 * ============================================================ */

const crypto = require('crypto');

Object.assign(globalThis, require('../js/config.js'));
Object.assign(globalThis, require('../js/achievements.js'));
Object.assign(globalThis, require('../js/world.js'));

const MAX_GUILD_MEMBERS = 20;
const CHAT_LOG_MAX = 300;

// Volontairement permissive (pas de RFC 5322 complet) : on veut juste écarter
// les fautes de frappe grossières, pas rejeter une adresse valide mais inhabituelle.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MS = 10 * 60 * 1000;          // connexion : 10 min
const OTP_RESET_TTL_MS = 15 * 60 * 1000;    // réinitialisation : 15 min
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 45 * 1000;

// ADMIN_USERNAMES (variable d'environnement, pseudos séparés par des virgules) :
// filet de secours pour garantir l'accès admin. Vérifié ici à l'inscription
// (pas seulement au démarrage dans index.js) — sinon, un compte créé APRÈS
// avoir positionné la variable ne serait promu qu'au redémarrage suivant.
function isForcedAdminUsername(username) {
  const list = (process.env.ADMIN_USERNAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(username || '').toLowerCase());
}
// Constantes de château (CASTLE_*) : partagées via js/config.js (Object.assign
// ci-dessous), au même titre que CLASSES/RESOURCES — l'UI en a besoin pour
// afficher les coûts, donc elles ne peuvent pas rester locales à ce fichier.
const BOT_NAMES = ['Kaelith', 'Brumm', 'Sylvane', 'Orzo', 'Nyra', 'Fenwick', 'Malko', 'Isha', 'Torvald', 'Lupa'];
const BOT_CHAT = [
  'quelqu’un pour le Basilic au nord ?',
  'je farm du minerai T2 vers l’est si besoin',
  'gg pour le raid !',
  'le Wyrm du sud-ouest est re-up',
  'échange plante T3 contre bois T3',
  'premier jour ici, c’est grand…',
  'les Ruines à l’ouest sont pleines de spectres',
];

class Game {
  constructor(seed, persisted) {
    this.seed = seed;
    this.now = 0;
    this.speed = Math.max(1, Number(process.env.SPEED) || 1);
    this.maps = generateGameMaps(seed);
    this.worldMap = this.maps.get('world');
    this.currentMapId = 'world';
    this.tiles = this.worldMap.tiles;
    // Incrémenté à chaque redistribution nocturne de la faune sauvage (voir
    // redistributeWildlife) — persisté pour reconstruire la même disposition
    // après un redémarrage, sans avoir à stocker la carte entière.
    this.wildSalt = 0;
    // Boss de raid mondial : état sur l'instance (pas sur la tuile), sur une
    // vraie horloge murale — voir tick() et resolveRaid(). Disponible dès le
    // 1er démarrage d'un monde neuf ; écrasé par load() si état persisté.
    this.worldBossAlive = false;
    this.worldBossNextSpawnAt = Date.now();
    this.onWorldBossDirty = () => {};
    this.players = new Map();
    this.credentials = new Map();
    this.bots = new Map();
    this.tokens = new Map();
    // OTP par email (connexion) et réinitialisation de mot de passe : état
    // éphémère, JAMAIS persisté (perdu au redémarrage — l'utilisateur
    // redemande un code, ce qui est très bien pour un flux court de quelques
    // minutes). Clé = accountId pour les OTP de connexion, username en
    // minuscules pour la réinitialisation (pas encore de session/accountId
    // connu à ce stade).
    this.pendingLoginOtps = new Map();
    this.pendingPasswordResets = new Map();
    this.raids = new Map();
    this.tradeInvites = new Map();
    this.trades = new Map();
    this.duelInvites = new Map();
    this.guilds = new Map();
    this.castles = new Map();   // terrain -> { terrain, ownerGuildId, hp, hpMax, level }
    this.chatLog = [];   // historique borné : reprend vie à la reconnexion (coordination async)
    this.pendingReplies = [];
    this.send = () => {};
    this.broadcast = () => {};
    this.onDirty = () => {};
    this.onGuildsDirty = () => {};
    this.onChatDirty = () => {};
    // Suppression de compte (admin) : câblé dans index.js pour effacer la
    // ligne SQLite (store.deleteAccount) et couper la socket live éventuelle
    // — game.js ne détient ni l'un ni l'autre directement (voir onDirty pour
    // le même principe côté sauvegarde).
    this.onAccountDeleted = () => {};
    this.sendPush = () => {};   // notif push (accountId, title, body) — câblé dans index.js
    this.rng = Math.random;   // injectable pour des tests déterministes
    if (persisted) this.load(persisted);
    this.spawnBots();
  }

  mapOf(id) { return this.maps.get(id) || this.worldMap; }
  tilesOf(p) { return this.mapOf((p && p.mapId) || 'world').tiles; }
  raidId(mapId, x, y) { return raidKey(mapId || 'world', x, y); }
  normalizeRaidKey(p, key) {
    if (this.raids.has(key)) return key;
    if (typeof key === 'string' && key.indexOf('|') < 0 && key.indexOf(',') > 0) {
      const [x, y] = key.split(',').map(Number);
      return this.raidId((p && p.mapId) || 'world', x, y);
    }
    return key;
  }

  skinStateOf(p) {
    if (!p) return;
    if (!Array.isArray(p.ownedSkins)) p.ownedSkins = [];
    if (!Array.isArray(p.ownedAccessories)) p.ownedAccessories = [];
    if (!Array.isArray(p.ownedMounts)) p.ownedMounts = [];
    if (typeof p.accessoryId === 'undefined') p.accessoryId = null;
    if (typeof p.mountId === 'undefined') p.mountId = null;
    if (typeof p[PREMIUM_CURRENCY.key] !== 'number') p[PREMIUM_CURRENCY.key] = 0;
    if (typeof p.skinId === 'undefined') p.skinId = null;
    if (!Array.isArray(p.characters) || !p.characters.length) return;
    for (const c of p.characters) {
      if (typeof c.skinId === 'undefined') c.skinId = null;
    }
  }
  memberById(id) { return this.players.get(id) || this.bots.get(id); }
  chebyshev(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

  log(text) { this.broadcast('chat', { from: null, text, type: 'event' }); }
  plog(p, text) { this.send(p.id, 'chat', { from: null, text, type: 'event' }); }
  toast(p, text) { this.send(p.id, 'toast', { text }); }
  // Notification mondiale : toast éphémère à tout le monde en plus de
  // l'entrée de chat (this.log) — pour les évènements globaux qui méritent
  // d'être vus tout de suite (siège de château, réveil du boss mondial),
  // pas juste retrouvés en faisant défiler le chat après coup. Jamais de
  // push ici : c'est réservé aux joueurs hors ligne (voir sendPush).
  worldNotify(text) { this.broadcast('toast', { text }); this.log(text); }
  // Regain (ex-PA) : ne bloque plus jamais récolte/raid, il ne fait plus que
  // doubler l'XP gagnée quand il y en a en réserve — voir finishHarvest() et
  // resolveRaid(). Consommé au moment du gain d'XP (résolution), pas au
  // lancement de l'action, pour que le bonus reflète l'état à l'instant T.
  consumeRegainBonus(p, cost) {
    if (p.pa >= cost) { p.pa -= cost; return true; }
    return false;
  }
  pushSelf(p) { this.send(p.id, 'self', p); this.onDirty(p); }
  notifyAchievements(p, list) {
    for (const a of list) {
      this.send(p.id, 'achievementUnlocked', { id: a.id, label: a.label, category: a.category, reward: a.reward || {} });
    }
  }
  setActiveTitle(p, title) {
    const t = title ? String(title).slice(0, 40) : null;
    if (t && !p.titles.includes(t)) return { ok: false, error: 'Titre non débloqué.' };
    p.activeTitle = t;
    this.pushSelf(p);
    return { ok: true };
  }
  pushMap(p) {
    this.send(p.id, 'map', {
      mapId: p.mapId || 'world',
      bounds: boundsOf(this.tilesOf(p)),
      mapDiffs: this.mapDiffs(),
      mapStates: this.mapStates(),
    });
  }

  resetTravelState(p) {
    p.status = 'IDLE';
    p.harvestKey = null;
    p.harvestEndsAt = 0;
    p.raidKey = null;
  }

  nearestWalkablePos(map, pos) {
    const origin = { x: Number(pos.x) || 0, y: Number(pos.y) || 0 };
    if (isWalkable(map.tiles, origin.x, origin.y)) return origin;
    for (let radius = 1; radius <= 6; radius++) {
      for (let y = origin.y - radius; y <= origin.y + radius; y++) {
        for (let x = origin.x - radius; x <= origin.x + radius; x++) {
          if (Math.max(Math.abs(x - origin.x), Math.abs(y - origin.y)) !== radius) continue;
          if (isWalkable(map.tiles, x, y)) return { x, y };
        }
      }
    }
    return origin;
  }

  mapStates() {
    const out = {};
    for (const [mapId, map] of this.maps) {
      if (!map || map.kind !== 'dungeon' || !map.dungeon) continue;
      out[mapId] = {
        killsRequired: map.dungeon.killsRequired,
        kills: map.dungeon.kills,
        bossAlive: map.dungeon.bossAlive,
      };
    }
    return out;
  }

  pushMapState(mapId) {
    const map = this.mapOf(mapId);
    if (!map) return;
    const payload = {
      mapId,
      bounds: boundsOf(map.tiles),
      mapDiffs: this.mapDiffs(),
      mapStates: this.mapStates(),
    };
    for (const p of this.players.values()) {
      if (p.online && (p.mapId || 'world') === mapId) this.send(p.id, 'map', payload);
    }
  }

  updateDungeonProgress(mapId, monster, victory) {
    const map = this.mapOf(mapId);
    if (!map || map.kind !== 'dungeon' || !map.dungeon || !victory || !monster) return;
    const state = map.dungeon;
    const bossTile = map.tiles.get(state.bossTileKey);

    if (monster.boss) {
      state.kills = 0;
      state.bossAlive = false;
      if (bossTile) bossTile.content = null;
      this.log('Le boss du donjon a été vaincu. Il faudra terrasser ' + state.killsRequired + ' squelettes pour le faire revenir.');
      this.pushMapState(mapId);
      return;
    }

    if (!monster.dungeonMob || state.bossAlive) return;
    state.kills = Math.min(state.killsRequired, state.kills + 1);
    if (state.kills >= state.killsRequired && bossTile && !bossTile.content) {
      bossTile.content = { ...state.bossTemplate };
      state.bossAlive = true;
      this.log('Le boss du donjon est apparu !');
    }
    this.pushMapState(mapId);
  }

  hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
  }

  resumePlayer(p) {
    const away = Math.max(0, Date.now() - (p.lastSeen || Date.now()));
    p.pa = Math.min(CONFIG.PA.MAX, p.pa + Math.floor(away / CONFIG.PA.REGEN_MS));
    p.hp = Math.min(maxHp(p), p.hp + Math.floor(away / CONFIG.HP.REGEN_MS));
    p.lastSeen = Date.now();
    p.pushPaFullAt = null;
    p.pushPaFullSent = false;
    // Vérification complète (toutes catégories, pas de filtre) à chaque
    // connexion : rattrape les hauts faits déjà mérités par une progression
    // antérieure à leur ajout (ou à un correctif de branchement) — sans ça,
    // un joueur qui a déjà 500 cases explorées ne serait crédité qu'à la
    // PROCHAINE case explorée, jamais pour les 500 déjà acquises.
    this.notifyAchievements(p, checkAchievements(p));
  }

  // Programme (à la déconnexion) l'instant réel où le Regain hors ligne
  // atteindra son plafond, pour la notification push — même hypothèse que
  // resumePlayer() (temps réel écoulé / REGEN_MS, sans le multiplicateur
  // SPEED de dev, qui ne vaut de toute façon que 1 en production).
  schedulePaFullNotify(p) {
    if (p.pa >= CONFIG.PA.MAX) { p.pushPaFullAt = null; p.pushPaFullSent = false; return; }
    const paNeeded = CONFIG.PA.MAX - p.pa;
    p.pushPaFullAt = Date.now() + paNeeded * CONFIG.PA.REGEN_MS;
    p.pushPaFullSent = false;
  }

  // Balayage périodique (voir index.js) : prévient les comptes hors ligne
  // dont le réservoir vient de se remplir depuis la dernière vérification.
  checkPaFullNotifications() {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (p.bot || p.online || !p.pushPaFullAt || p.pushPaFullSent) continue;
      if (now >= p.pushPaFullAt) {
        p.pushPaFullSent = true;
        this.sendPush(p.id, '⚡ Regain au maximum', 'Votre Regain est au maximum — XP doublée sur votre prochaine récolte ou victoire !');
      }
    }
  }

  authToken(token) {
    if (!token || !this.tokens.has(token)) return { ok: false };
    const p = this.players.get(this.tokens.get(token));
    if (!p) return { ok: false };
    this.resumePlayer(p);
    return { ok: true, player: p };
  }

  register(data) {
    const username = String(data.username || '').trim().slice(0, 16);
    const password = String(data.password || '');
    const email = String(data.email || '').trim().slice(0, 254);
    if (username.length < 3) return { ok: false, error: 'Nom trop court (3 caractères minimum).' };
    if (!/^[\p{L}\p{N} _-]+$/u.test(username)) return { ok: false, error: 'Nom invalide (lettres, chiffres, espaces, - et _).' };
    if (password.length < 4) return { ok: false, error: 'Mot de passe trop court (4 caractères minimum).' };
    if (!CLASSES[data.speciesClass]) return { ok: false, error: 'Classe invalide.' };
    if (!classAvailableToRole(data.speciesClass, 'user')) return { ok: false, error: 'Classe réservée aux administrateurs.' };
    if (!EMAIL_RE.test(email)) return { ok: false, error: 'Adresse email invalide.' };

    const id = 'p_' + username.toLowerCase();
    if (this.players.has(id)) return { ok: false, error: 'Le nom « ' + username + ' » est déjà pris.' };

    const passSalt = crypto.randomBytes(16).toString('hex');
    this.credentials.set(id, {
      passHash: this.hashPassword(password, passSalt),
      passSalt,
      createdAt: Date.now(),
    });

    const p = {
      id, username, email, bot: false,
      token: crypto.randomBytes(16).toString('hex'),
      online: false, lastSeen: Date.now(),
      mapId: 'world',
      pos: { x: 0, y: 0 },
      pa: CONFIG.PA.START, paMs: 0,
      hp: 100, hpMs: 0,
      inventory: {},
      gold: 0,
      [PREMIUM_CURRENCY.key]: 0,
      pushSubscriptions: [],
      pushPaFullAt: null,
      pushPaFullSent: false,
      ownedSkins: [],
      ownedAccessories: [],
      accessoryId: null,
      ownedMounts: [],
      mountId: null,
      status: 'IDLE',
      harvestKey: null, harvestEndsAt: 0,
      raidKey: null,
      tradeId: null,
      duels: { wins: 0, losses: 0 },
      guildId: null,
      guildName: null,
      guildInvite: null,
      friends: [],
      friendRequests: [],
      characters: [newCharacter(data.speciesClass)],
      activeChar: 0,
      charSlots: CONFIG.FREE_CHAR_SLOTS,
      visitedVillages: [],
      // Brouillard de guerre du monde (tuiles découvertes) : côté compte, pas
      // localStorage, pour retrouver la même carte explorée quel que soit
      // l'appareil/navigateur (site web, PWA installée…).
      exploredWorld: [],
      // Le tout premier compte créé sur une base vierge devient administrateur ;
      // ADMIN_USERNAMES force le rôle admin pour les pseudos listés, même hors
      // de ce cas (ex. compte créé après coup, base déjà peuplée).
      role: (this.players.size === 0 || isForcedAdminUsername(username)) ? 'admin' : 'user',
    };
    ensureAchievementState(p);
    this.skinStateOf(p);
    applyCharacter(p, 0);
    p.hp = maxHp(p);
    this.players.set(id, p);
    this.tokens.set(p.token, id);
    this.onDirty(p);
    this.log('🐾 ' + username + ' entre dans les Terres Sauvages !');
    return { ok: true, created: true, player: p };
  }

  login(data) {
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const id = 'p_' + username.toLowerCase();
    const p = this.players.get(id);
    if (!p) return { ok: false, error: 'Compte inconnu.' };

    let cred = this.credentials.get(id);
    if (!cred || !cred.passHash) {
      if (password.length < 4) return { ok: false, error: 'Mot de passe trop court (4 caractères minimum).' };
      const passSalt = crypto.randomBytes(16).toString('hex');
      cred = { passHash: this.hashPassword(password, passSalt), passSalt, createdAt: Date.now() };
      this.credentials.set(id, cred);
    } else {
      const tryHash = Buffer.from(this.hashPassword(password, cred.passSalt), 'hex');
      const goodHash = Buffer.from(cred.passHash, 'hex');
      if (tryHash.length !== goodHash.length || !crypto.timingSafeEqual(tryHash, goodHash)) {
        return { ok: false, error: 'Mot de passe incorrect.' };
      }
    }

    if (p.token) this.tokens.delete(p.token);
    p.token = crypto.randomBytes(16).toString('hex');
    this.tokens.set(p.token, p.id);
    this.resumePlayer(p);
    this.onDirty(p);
    return { ok: true, player: p };
  }

  _generateOtp() {
    return String(Math.floor(100000 + this.rng() * 900000));
  }

  /* ---------- OTP de connexion par email ----------
   * register()/login() restent inchangés (retour immédiat {ok, player}) —
   * l'exigence d'OTP est orchestrée par l'appelant (server/index.js, qui
   * possède le client Resend), pas ici : ces méthodes ne font QUE la
   * logique de génération/vérification, jamais l'envoi d'email. */
  beginLoginOtp(p, opts) {
    const code = this._generateOtp();
    this.pendingLoginOtps.set(p.id, {
      code,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      lastSentAt: Date.now(),
      justRegistered: !!(opts && opts.justRegistered),
    });
    return { code, email: p.email };
  }

  resendLoginOtp(accountId) {
    const pending = this.pendingLoginOtps.get(accountId);
    if (!pending) return { ok: false, error: 'Session de connexion expirée — reconnecte-toi.' };
    if (Date.now() - pending.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
      return { ok: false, error: 'Attends un peu avant de redemander un code.' };
    }
    pending.code = this._generateOtp();
    pending.expiresAt = Date.now() + OTP_TTL_MS;
    pending.attempts = 0;
    pending.lastSentAt = Date.now();
    const p = this.players.get(accountId);
    return { ok: true, code: pending.code, email: p ? p.email : null };
  }

  verifyLoginOtp(accountId, code) {
    const pending = this.pendingLoginOtps.get(accountId);
    if (!pending) return { ok: false, error: 'Session de connexion expirée — reconnecte-toi.' };
    if (Date.now() > pending.expiresAt) {
      this.pendingLoginOtps.delete(accountId);
      return { ok: false, error: 'Code expiré — redemande un code.' };
    }
    if (String(code || '') !== pending.code) {
      pending.attempts++;
      if (pending.attempts >= OTP_MAX_ATTEMPTS) {
        this.pendingLoginOtps.delete(accountId);
        return { ok: false, error: 'Trop de tentatives — reconnecte-toi.' };
      }
      return { ok: false, error: 'Code incorrect.' };
    }
    const p = this.players.get(accountId);
    if (!p) return { ok: false, error: 'Compte introuvable.' };
    const justRegistered = pending.justRegistered;
    this.pendingLoginOtps.delete(accountId);
    return { ok: true, player: p, justRegistered };
  }

  // Compte créé avant l'ajout de l'OTP : pas d'email connu — ajout forcé à
  // la prochaine connexion (voir p.email dans load()), avant de continuer.
  setAccountEmail(accountId, email) {
    const clean = String(email || '').trim().slice(0, 254);
    if (!EMAIL_RE.test(clean)) return { ok: false, error: 'Adresse email invalide.' };
    const p = this.players.get(accountId);
    if (!p) return { ok: false, error: 'Compte introuvable.' };
    p.email = clean;
    this.onDirty(p);
    return { ok: true, player: p };
  }

  /* ---------- Mot de passe oublié ----------
   * Même principe : la logique reste ici, l'envoi d'email est câblé côté
   * index.js. `found`/`hasEmail` distincts du `code` pour que l'appelant
   * sache s'il doit réellement envoyer un email, sans exposer directement
   * si le compte existe au client (message générique côté UI). */
  requestPasswordReset(username) {
    const id = 'p_' + String(username || '').trim().toLowerCase();
    const p = this.players.get(id);
    if (!p) return { ok: true, found: false };
    if (!p.email) return { ok: true, found: true, hasEmail: false };
    const code = this._generateOtp();
    this.pendingPasswordResets.set(id, {
      code,
      expiresAt: Date.now() + OTP_RESET_TTL_MS,
      attempts: 0,
      lastSentAt: Date.now(),
    });
    return { ok: true, found: true, hasEmail: true, email: p.email, code };
  }

  resendPasswordReset(username) {
    const id = 'p_' + String(username || '').trim().toLowerCase();
    const pending = this.pendingPasswordResets.get(id);
    if (!pending) return { ok: false, error: 'Aucune demande en cours pour ce compte.' };
    if (Date.now() - pending.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
      return { ok: false, error: 'Attends un peu avant de redemander un code.' };
    }
    pending.code = this._generateOtp();
    pending.expiresAt = Date.now() + OTP_RESET_TTL_MS;
    pending.attempts = 0;
    pending.lastSentAt = Date.now();
    const p = this.players.get(id);
    return { ok: true, code: pending.code, email: p ? p.email : null };
  }

  resetPassword(username, code, newPassword) {
    const id = 'p_' + String(username || '').trim().toLowerCase();
    const pending = this.pendingPasswordResets.get(id);
    if (!pending) return { ok: false, error: 'Aucune demande en cours pour ce compte.' };
    if (Date.now() > pending.expiresAt) {
      this.pendingPasswordResets.delete(id);
      return { ok: false, error: 'Code expiré — recommence la demande.' };
    }
    if (String(code || '') !== pending.code) {
      pending.attempts++;
      if (pending.attempts >= OTP_MAX_ATTEMPTS) {
        this.pendingPasswordResets.delete(id);
        return { ok: false, error: 'Trop de tentatives — recommence la demande.' };
      }
      return { ok: false, error: 'Code incorrect.' };
    }
    const password = String(newPassword || '');
    if (password.length < 4) return { ok: false, error: 'Mot de passe trop court (4 caractères minimum).' };
    const p = this.players.get(id);
    if (!p) return { ok: false, error: 'Compte introuvable.' };
    const passSalt = crypto.randomBytes(16).toString('hex');
    this.credentials.set(id, {
      passHash: this.hashPassword(password, passSalt),
      passSalt,
      createdAt: (this.credentials.get(id) || {}).createdAt || Date.now(),
    });
    this.pendingPasswordResets.delete(id);
    // Un mot de passe oublié invalide la session existante : accès partagé
    // ou compte potentiellement compromis, mieux vaut une reconnexion propre.
    if (p.token) { this.tokens.delete(p.token); p.token = null; }
    this.onDirty(p);
    return { ok: true };
  }

  initPayload(p) {
    return {
      token: p.token,
      selfId: p.id,
      self: p,
      seed: this.seed,
      now: this.now,
      speed: this.speed,
      wildSalt: this.wildSalt,
      mapId: p.mapId || 'world',
      mapDiffs: this.mapDiffs(),
      mapStates: this.mapStates(),
      bounds: boundsOf(this.tilesOf(p)),
      players: this.publicPlayers(),
      worldBoss: this.worldBossPayload(),
      raids: this.raidsPayload(),
      trade: p.tradeId ? this.tradePayloadFor(p, this.trades.get(p.tradeId)) : null,
      chatHistory: this.chatHistoryFor(p),
    };
  }

  // Repris par initPayload() (connexion) ET par index.js (broadcast à chaud
  // quand onWorldBossDirty se déclenche — mort ou réveil) : mêmes champs des
  // deux côtés, sinon un client déjà connecté ne voit jamais la transition
  // apparaître/disparaître sur la carte tant qu'il ne se reconnecte pas.
  worldBossPayload() {
    return { alive: this.worldBossAlive, nextSpawnAt: this.worldBossNextSpawnAt, pos: WORLD_BOSS.pos, label: WORLD_BOSS.label };
  }

  publicPlayer(p) {
    return {
      id: p.id,
      username: p.username,
      speciesClass: p.speciesClass,
      classLabel: (CLASSES[p.speciesClass] && CLASSES[p.speciesClass].label) || p.speciesClass,
      role: (CLASSES[p.speciesClass] && CLASSES[p.speciesClass].role) || '',
      pos: p.pos,
      status: p.status,
      bot: !!p.bot,
      mapId: p.mapId || 'world',
      weaponTier: p.weapon ? p.weapon.tier : 0,
      armorTier: p.armor ? p.armor.tier : 0,
      weaponType: p.weapon ? p.weapon.type : '',
      armorType: p.armor ? p.armor.type : '',
      skinId: p.skinId || null,
      accessoryId: p.accessoryId || null,
      mountId: p.mountId || null,
      activeTitle: p.activeTitle || null,
      guildName: p.guildName || null,
    };
  }

  buySkin(p, skinId) {
    const item = skinFor(String(skinId || ''));
    if (!item) return { ok: false, error: 'Skin inconnu.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (p.speciesClass !== item.speciesClass) return { ok: false, error: 'Ce skin est réservé à une autre classe.' };
    this.skinStateOf(p);
    if (p.ownedSkins.includes(item.id)) return { ok: false, error: 'Skin déjà possédé.' };
    const walletKey = item.currency === PREMIUM_CURRENCY.key ? PREMIUM_CURRENCY.key : 'gold';
    const balance = Number(p[walletKey] || 0);
    if (balance < item.price) {
      return { ok: false, error: walletKey === 'gold' ? 'Pas assez d’or.' : ('Pas assez de ' + PREMIUM_CURRENCY.label.toLowerCase() + '.') };
    }
    p[walletKey] = balance - item.price;
    p.ownedSkins.push(item.id);
    this.pushSelf(p);
    return { ok: true };
  }

  /* Monture « simple » en vente contre or/Écailles (item.shop) — pas de
   * restriction de classe, contrairement aux skins : une monture est
   * indépendante du personnage actif. Les montures rares (item.shop absent,
   * ex. Rejeton du Wyrm Ancestral) restent hors boutique, loot/admin uniquement. */
  buyMount(p, mountId) {
    const item = MOUNT_ITEMS[String(mountId || '')];
    if (!item || !item.shop) return { ok: false, error: 'Monture inconnue.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (p.ownedMounts.includes(item.id)) return { ok: false, error: 'Monture déjà possédée.' };
    const walletKey = item.shop.currency === PREMIUM_CURRENCY.key ? PREMIUM_CURRENCY.key : 'gold';
    const balance = Number(p[walletKey] || 0);
    if (balance < item.shop.price) {
      return { ok: false, error: walletKey === 'gold' ? 'Pas assez d’or.' : ('Pas assez de ' + PREMIUM_CURRENCY.label.toLowerCase() + '.') };
    }
    p[walletKey] = balance - item.shop.price;
    p.ownedMounts.push(item.id);
    this.pushSelf(p);
    return { ok: true };
  }

  buyGoldPack(p, packId) {
    const pack = GOLD_PACKS.find((item) => item.id === String(packId || ''));
    if (!pack) return { ok: false, error: 'Pack d’or inconnu.' };
    const balance = Number(p[PREMIUM_CURRENCY.key] || 0);
    if (balance < pack.moonstones) return { ok: false, error: 'Pas assez de ' + PREMIUM_CURRENCY.label.toLowerCase() + '.' };
    p[PREMIUM_CURRENCY.key] = balance - pack.moonstones;
    p.gold = Number(p.gold || 0) + pack.gold;
    this.pushSelf(p);
    return { ok: true, gold: pack.gold, cost: pack.moonstones };
  }

  // Emplacement de personnage supplémentaire : payé en monnaie premium,
  // plafonné aux classes réellement accessibles à un joueur normal (voir
  // MAX_PLAYER_CHAR_SLOTS — jamais le slot admin-only de Séraphin Royal,
  // qu'un joueur ne pourrait de toute façon jamais remplir).
  buyCharSlot(p) {
    if ((p.charSlots || 0) >= MAX_PLAYER_CHAR_SLOTS) {
      return { ok: false, error: 'Déjà au maximum d’emplacements disponibles.' };
    }
    const balance = Number(p[PREMIUM_CURRENCY.key] || 0);
    if (balance < CHAR_SLOT_COST_MOONSTONES) {
      return { ok: false, error: 'Il faut ' + CHAR_SLOT_COST_MOONSTONES + ' ' + PREMIUM_CURRENCY.label + '.' };
    }
    p[PREMIUM_CURRENCY.key] = balance - CHAR_SLOT_COST_MOONSTONES;
    p.charSlots = (p.charSlots || 0) + 1;
    this.pushSelf(p);
    return { ok: true, charSlots: p.charSlots };
  }

  // Crédit de monnaie premium après un paiement Stripe confirmé (webhook) —
  // fonctionne même hors ligne : game.players contient TOUS les comptes
  // connus depuis le démarrage (load()), pas seulement les connectés.
  creditMoonstones(accountId, amount) {
    const target = this.players.get(String(accountId || ''));
    if (!target) return { ok: false, error: 'Compte introuvable.' };
    const n = Math.floor(Number(amount)) || 0;
    if (n <= 0) return { ok: false, error: 'Montant invalide.' };
    target[PREMIUM_CURRENCY.key] = (target[PREMIUM_CURRENCY.key] || 0) + n;
    if (target.online) this.pushSelf(target);
    else this.onDirty(target);
    this.log('✦ ' + target.username + ' a reçu ' + n + ' ' + PREMIUM_CURRENCY.label + '.');
    return { ok: true, total: target[PREMIUM_CURRENCY.key] };
  }

  equipSkin(p, skinId) {
    this.skinStateOf(p);
    const desired = skinId ? String(skinId) : null;
    if (!desired) {
      p.skinId = null;
      syncActiveCharacter(p);
      this.pushSelf(p);
      return { ok: true };
    }
    const item = skinFor(desired);
    if (!item) return { ok: false, error: 'Skin inconnu.' };
    if (item.speciesClass !== p.speciesClass) return { ok: false, error: 'Ce skin ne correspond pas à votre forme active.' };
    if (!p.ownedSkins.includes(item.id)) return { ok: false, error: 'Vous ne possédez pas ce skin.' };
    p.skinId = item.id;
    syncActiveCharacter(p);
    this.pushSelf(p);
    return { ok: true };
  }

  /* Accessoire cosmétique (calque additionnel, indépendant de la classe/du
   * skin) : jamais en vente, uniquement obtenu en loot rare ou attribution
   * admin. Un seul actif à la fois. */
  equipAccessory(p, accessoryId) {
    const desired = accessoryId ? String(accessoryId) : null;
    if (!desired) {
      p.accessoryId = null;
      this.pushSelf(p);
      return { ok: true };
    }
    if (!ACCESSORY_ITEMS[desired]) return { ok: false, error: 'Accessoire inconnu.' };
    if (!p.ownedAccessories.includes(desired)) return { ok: false, error: 'Vous ne possédez pas cet accessoire.' };
    p.accessoryId = desired;
    this.pushSelf(p);
    return { ok: true };
  }

  equipMount(p, mountId) {
    const desired = mountId ? String(mountId) : null;
    if (!desired) {
      p.mountId = null;
      this.pushSelf(p);
      return { ok: true };
    }
    if (!MOUNT_ITEMS[desired]) return { ok: false, error: 'Monture inconnue.' };
    if (!p.ownedMounts.includes(desired)) return { ok: false, error: 'Vous ne possédez pas cette monture.' };
    p.mountId = desired;
    this.pushSelf(p);
    return { ok: true };
  }

  publicPlayers() {
    const out = [];
    for (const p of this.players.values()) {
      if (p.online) out.push(this.publicPlayer(p));
    }
    for (const b of this.bots.values()) {
      out.push(this.publicPlayer(b));
    }
    return out;
  }

  isTradeableStack(key) {
    const parsed = parseStackKey(String(key || ''));
    return !!RESOURCES[parsed.type] || !!CONSUMABLES[parsed.type];
  }

  playerNear(a, b, maxDist) {
    return !!(a && b && (a.mapId || 'world') === (b.mapId || 'world') && this.chebyshev(a.pos, b.pos) <= (maxDist || 1));
  }

  tradePayloadFor(viewer, trade) {
    if (!trade || !viewer) return null;
    const meOffer = trade.offers[viewer.id] || { gold: 0, items: {}, accepted: false };
    const otherId = trade.players.find((id) => id !== viewer.id);
    const other = this.players.get(otherId);
    const otherOffer = trade.offers[otherId] || { gold: 0, items: {}, accepted: false };
    return {
      id: trade.id,
      withPlayer: other ? this.publicPlayer(other) : null,
      offers: {
        self: { gold: meOffer.gold, items: { ...meOffer.items }, accepted: !!meOffer.accepted },
        other: { gold: otherOffer.gold, items: { ...otherOffer.items }, accepted: !!otherOffer.accepted },
      },
    };
  }

  pushTrade(trade) {
    if (!trade) return;
    for (const id of trade.players) {
      const p = this.players.get(id);
      if (p && p.online) this.send(id, 'trade', this.tradePayloadFor(p, trade));
    }
  }

  closeTrade(trade, reason) {
    if (!trade) return;
    this.trades.delete(trade.id);
    for (const id of trade.players) {
      const p = this.players.get(id);
      if (!p) continue;
      if (p.tradeId === trade.id) {
        p.tradeId = null;
        if (p.status === 'TRADING') p.status = 'IDLE';
        this.pushSelf(p);
      }
      this.send(id, 'trade', null);
      if (reason) this.toast(p, reason);
    }
  }

  startTrade(a, b) {
    const trade = {
      id: 'trade_' + Date.now() + '_' + Math.floor(this.rng() * 100000),
      players: [a.id, b.id],
      offers: {
        [a.id]: { gold: 0, items: {}, accepted: false },
        [b.id]: { gold: 0, items: {}, accepted: false },
      },
    };
    a.tradeId = trade.id;
    b.tradeId = trade.id;
    a.status = 'TRADING';
    b.status = 'TRADING';
    this.trades.set(trade.id, trade);
    this.pushSelf(a);
    this.pushSelf(b);
    this.pushTrade(trade);
    return trade;
  }

  normalizeTradeOffer(p, raw) {
    const offer = { gold: 0, items: {}, accepted: false };
    if (!p || !raw) return offer;
    offer.gold = Math.max(0, Math.min(p.gold || 0, Math.floor(Number(raw.gold) || 0)));
    for (const [key, qtyRaw] of Object.entries(raw.items || {})) {
      if (!this.isTradeableStack(key)) continue;
      const own = p.inventory[key] || 0;
      if (!own) continue;
      const qty = Math.max(0, Math.min(own, Math.floor(Number(qtyRaw) || 0)));
      if (qty > 0) offer.items[key] = qty;
    }
    return offer;
  }

  sameTradeOffer(a, b) {
    const goldA = Number((a && a.gold) || 0);
    const goldB = Number((b && b.gold) || 0);
    if (goldA !== goldB) return false;
    const itemsA = (a && a.items) || {};
    const itemsB = (b && b.items) || {};
    const keysA = Object.keys(itemsA).filter((k) => Number(itemsA[k]) > 0).sort();
    const keysB = Object.keys(itemsB).filter((k) => Number(itemsB[k]) > 0).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      const key = keysA[i];
      if (key !== keysB[i]) return false;
      if (Number(itemsA[key]) !== Number(itemsB[key])) return false;
    }
    return true;
  }

  requestTrade(p, targetId) {
    const target = this.players.get(String(targetId));
    if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === p.id) return { ok: false, error: 'Impossible d’échanger avec vous-même.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (target.status !== 'IDLE') return { ok: false, error: 'Ce joueur est occupé.' };
    if (!this.playerNear(p, target, 1)) return { ok: false, error: 'Vous devez être au contact pour échanger.' };
    if (p.tradeId || target.tradeId) return { ok: false, error: 'Un échange est déjà en cours.' };
    this.tradeInvites.set(target.id, { fromId: p.id, toId: target.id, at: this.now });
    this.send(target.id, 'tradeInvite', { fromPlayer: this.publicPlayer(p) });
    this.toast(p, 'Demande d’échange envoyée à ' + target.username + '.');
    return { ok: true };
  }

  respondTradeInvite(p, fromId, accept) {
    const invite = this.tradeInvites.get(p.id);
    if (!invite || invite.fromId !== String(fromId)) return { ok: false, error: 'Invitation introuvable.' };
    this.tradeInvites.delete(p.id);
    const from = this.players.get(invite.fromId);
    if (!from) return { ok: false, error: 'Le joueur n’est plus disponible.' };
    if (!accept) {
      this.toast(from, p.username + ' a refusé l’échange.');
      return { ok: true, declined: true };
    }
    if (from.status !== 'IDLE' || p.status !== 'IDLE') return { ok: false, error: 'L’un des joueurs est occupé.' };
    if (!this.playerNear(from, p, 1)) return { ok: false, error: 'Vous devez rester au contact pour échanger.' };
    this.startTrade(from, p);
    return { ok: true };
  }

  updateTradeOffer(p, offerRaw) {
    const trade = this.trades.get(p.tradeId || '');
    if (!trade) return { ok: false, error: 'Aucun échange actif.' };
    if (!trade.players.includes(p.id)) return { ok: false, error: 'Échange invalide.' };
    const nextOffer = this.normalizeTradeOffer(p, offerRaw);
    const prevOffer = trade.offers[p.id] || { gold: 0, items: {}, accepted: false };
    const changed = !this.sameTradeOffer(prevOffer, nextOffer);
    trade.offers[p.id] = nextOffer;
    trade.offers[p.id].accepted = changed ? false : !!prevOffer.accepted;
    const otherId = trade.players.find((id) => id !== p.id);
    if (changed && trade.offers[otherId]) trade.offers[otherId].accepted = false;
    this.pushTrade(trade);
    return { ok: true };
  }

  confirmTrade(p, accepted) {
    const trade = this.trades.get(p.tradeId || '');
    if (!trade) return { ok: false, error: 'Aucun échange actif.' };
    const mine = trade.offers[p.id];
    if (!mine) return { ok: false, error: 'Offre invalide.' };
    mine.accepted = accepted !== false;
    this.pushTrade(trade);
    if (!mine.accepted) return { ok: true };
    const otherId = trade.players.find((id) => id !== p.id);
    const other = this.players.get(otherId);
    if (!other || !trade.offers[otherId] || !trade.offers[otherId].accepted) return { ok: true };

    const a = this.players.get(trade.players[0]);
    const b = this.players.get(trade.players[1]);
    if (!a || !b) {
      this.closeTrade(trade, 'Échange interrompu.');
      return { ok: false, error: 'Échange interrompu.' };
    }
    if (!this.playerNear(a, b, 1)) {
      this.closeTrade(trade, 'Échange annulé : les joueurs se sont éloignés.');
      return { ok: false, error: 'Les joueurs se sont éloignés.' };
    }

    const oa = this.normalizeTradeOffer(a, trade.offers[a.id]);
    const ob = this.normalizeTradeOffer(b, trade.offers[b.id]);
    trade.offers[a.id] = { ...oa, accepted: true };
    trade.offers[b.id] = { ...ob, accepted: true };

    a.gold -= oa.gold;
    b.gold -= ob.gold;
    b.gold += oa.gold;
    a.gold += ob.gold;

    for (const [key, qty] of Object.entries(oa.items)) {
      a.inventory[key] -= qty;
      if (a.inventory[key] <= 0) delete a.inventory[key];
      b.inventory[key] = (b.inventory[key] || 0) + qty;
    }
    for (const [key, qty] of Object.entries(ob.items)) {
      b.inventory[key] -= qty;
      if (b.inventory[key] <= 0) delete b.inventory[key];
      a.inventory[key] = (a.inventory[key] || 0) + qty;
    }

    a.stats.trades = (a.stats.trades || 0) + 1;
    b.stats.trades = (b.stats.trades || 0) + 1;
    this.notifyAchievements(a, checkAchievements(a, ['Commerce']));
    this.notifyAchievements(b, checkAchievements(b, ['Commerce']));
    this.closeTrade(trade, 'Échange terminé.');
    return { ok: true, done: true };
  }

  cancelTrade(p) {
    const trade = this.trades.get(p.tradeId || '');
    if (!trade) return { ok: false, error: 'Aucun échange actif.' };
    const otherId = trade.players.find((id) => id !== p.id);
    const other = this.players.get(otherId);
    this.closeTrade(trade, other ? (p.username + ' a annulé l’échange.') : 'Échange annulé.');
    return { ok: true };
  }

  /* ---------- Duels amicaux (aucune perte de PV, ni d'or) ---------- */
  requestDuel(p, targetId) {
    const target = this.players.get(String(targetId));
    if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === p.id) return { ok: false, error: 'Impossible de se défier soi-même.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (target.status !== 'IDLE') return { ok: false, error: 'Ce joueur est occupé.' };
    if (!this.playerNear(p, target, 1)) return { ok: false, error: 'Vous devez être au contact pour défier.' };
    this.duelInvites.set(target.id, { fromId: p.id, toId: target.id, at: this.now });
    this.send(target.id, 'duelInvite', { fromPlayer: this.publicPlayer(p) });
    this.toast(p, 'Défi envoyé à ' + target.username + '.');
    return { ok: true };
  }

  respondDuelInvite(p, fromId, accept) {
    const invite = this.duelInvites.get(p.id);
    if (!invite || invite.fromId !== String(fromId)) return { ok: false, error: 'Défi introuvable.' };
    this.duelInvites.delete(p.id);
    const from = this.players.get(invite.fromId);
    if (!from) return { ok: false, error: 'Le joueur n’est plus disponible.' };
    if (!accept) {
      this.toast(from, p.username + ' a refusé le duel.');
      return { ok: true, declined: true };
    }
    if (from.status !== 'IDLE' || p.status !== 'IDLE') return { ok: false, error: 'L’un des joueurs est occupé.' };
    if (!this.playerNear(from, p, 1)) return { ok: false, error: 'Vous devez rester au contact pour le duel.' };
    this.resolveDuel(from, p);
    return { ok: true };
  }

  /* Amical : pas de PV perdus, pas d'or en jeu — seul le palmarès évolue. */
  resolveDuel(a, b) {
    const powerA = combatPower(a);
    const powerB = combatPower(b);
    const chance = winChance(powerA, powerB);
    const aWins = this.rng() < chance;
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;
    winner.duels.wins += 1;
    loser.duels.losses += 1;
    winner.stats.duelStreak = (winner.stats.duelStreak || 0) + 1;
    winner.stats.bestDuelStreak = Math.max(winner.stats.bestDuelStreak || 0, winner.stats.duelStreak);
    loser.stats.duelStreak = 0;
    this.notifyAchievements(winner, checkAchievements(winner, ['Duels']));
    this.notifyAchievements(loser, checkAchievements(loser, ['Duels']));
    this.send(a.id, 'duelResult', {
      opponent: b.username, won: aWins,
      chance: Math.round(chance * 100), yourPower: Math.round(powerA), opponentPower: Math.round(powerB),
    });
    this.send(b.id, 'duelResult', {
      opponent: a.username, won: !aWins,
      chance: Math.round((1 - chance) * 100), yourPower: Math.round(powerB), opponentPower: Math.round(powerA),
    });
    this.log('⚔️ ' + winner.username + ' bat ' + loser.username + ' en duel amical.');
    this.pushSelf(a);
    this.pushSelf(b);
  }

  /* ---------- Guildes ---------- */
  findAccountByUsername(username) {
    return this.players.get('p_' + String(username || '').trim().toLowerCase()) || null;
  }

  guildOf(p) {
    return p.guildId ? this.guilds.get(p.guildId) || null : null;
  }

  guildRosterPublic(guild) {
    return guild.members.map((id) => {
      const m = this.players.get(id);
      if (!m) return null;
      return {
        id: m.id,
        username: m.username,
        online: !!m.online,
        classLabel: (CLASSES[m.speciesClass] && CLASSES[m.speciesClass].label) || m.speciesClass,
        isLeader: id === guild.leaderId,
      };
    }).filter(Boolean);
  }

  createGuild(p, name) {
    name = String(name || '').trim().slice(0, 24);
    if (name.length < 3) return { ok: false, error: 'Nom de guilde trop court (3 caractères minimum).' };
    if (!/^[\p{L}\p{N} _-]+$/u.test(name)) return { ok: false, error: 'Nom invalide (lettres, chiffres, espaces, - et _).' };
    if (p.guildId) return { ok: false, error: 'Vous êtes déjà dans une guilde.' };
    if ([...this.guilds.values()].some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: 'Ce nom de guilde est déjà pris.' };
    }
    const id = 'g_' + crypto.randomBytes(6).toString('hex');
    const guild = { id, name, leaderId: p.id, members: [p.id], createdAt: this.now };
    this.guilds.set(id, guild);
    p.guildId = id;
    p.guildName = name;
    p.stats.guildFounded = true;
    this.notifyAchievements(p, checkAchievements(p, ['Guilde']));
    this.pushSelf(p);
    this.onGuildsDirty();
    this.log('🏰 La guilde « ' + name + ' » a été fondée par ' + p.username + '.');
    return { ok: true, guildId: id };
  }

  inviteToGuild(p, targetUsername) {
    const guild = this.guildOf(p);
    if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
    if (guild.leaderId !== p.id) return { ok: false, error: 'Seul le chef de guilde peut inviter.' };
    const target = this.findAccountByUsername(targetUsername);
    if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === p.id) return { ok: false, error: 'Vous êtes déjà dans cette guilde.' };
    if (target.guildId) return { ok: false, error: 'Ce joueur est déjà dans une guilde.' };
    if (guild.members.length >= MAX_GUILD_MEMBERS) return { ok: false, error: 'Guilde complète (' + MAX_GUILD_MEMBERS + ' max).' };
    target.guildInvite = { guildId: guild.id, guildName: guild.name, fromUsername: p.username, at: this.now };
    this.pushSelf(target);
    this.toast(p, 'Invitation envoyée à ' + target.username + '.');
    return { ok: true };
  }

  respondGuildInvite(p, accept) {
    const invite = p.guildInvite;
    if (!invite) return { ok: false, error: 'Aucune invitation en attente.' };
    p.guildInvite = null;
    if (!accept) {
      this.pushSelf(p);
      return { ok: true, declined: true };
    }
    if (p.guildId) {
      this.pushSelf(p);
      return { ok: false, error: 'Vous êtes déjà dans une guilde.' };
    }
    const guild = this.guilds.get(invite.guildId);
    if (!guild) {
      this.pushSelf(p);
      return { ok: false, error: 'Cette guilde n’existe plus.' };
    }
    if (guild.members.length >= MAX_GUILD_MEMBERS) {
      this.pushSelf(p);
      return { ok: false, error: 'Guilde complète.' };
    }
    guild.members.push(p.id);
    p.guildId = guild.id;
    p.guildName = guild.name;
    this.notifyAchievements(p, checkAchievements(p, ['Guilde']));
    if (guild.members.length >= MAX_GUILD_MEMBERS) {
      const leader = this.players.get(guild.leaderId);
      if (leader) {
        leader.stats.guildReachedMax = true;
        this.notifyAchievements(leader, checkAchievements(leader, ['Guilde']));
        this.pushSelf(leader);
      }
    }
    this.pushSelf(p);
    this.onGuildsDirty();
    this.log('🏰 ' + p.username + ' a rejoint la guilde « ' + guild.name + ' ».');
    return { ok: true };
  }

  leaveGuild(p) {
    const guild = this.guildOf(p);
    if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
    guild.members = guild.members.filter((id) => id !== p.id);
    p.guildId = null;
    p.guildName = null;
    if (!guild.members.length) {
      this.guilds.delete(guild.id);
      this.log('🏰 La guilde « ' + guild.name + ' » a été dissoute (plus aucun membre).');
    } else if (guild.leaderId === p.id) {
      guild.leaderId = guild.members[0];
      const newLeader = this.players.get(guild.leaderId);
      if (newLeader) this.pushSelf(newLeader);
      this.log('🏰 ' + (newLeader ? newLeader.username : '?') + ' devient chef de « ' + guild.name + ' ».');
    }
    this.pushSelf(p);
    this.onGuildsDirty();
    return { ok: true };
  }

  kickFromGuild(p, targetUsername) {
    const guild = this.guildOf(p);
    if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
    if (guild.leaderId !== p.id) return { ok: false, error: 'Seul le chef de guilde peut exclure un membre.' };
    const target = this.findAccountByUsername(targetUsername);
    if (!target || !guild.members.includes(target.id)) return { ok: false, error: 'Ce joueur n’est pas dans votre guilde.' };
    if (target.id === p.id) return { ok: false, error: 'Vous ne pouvez pas vous exclure vous-même (quittez la guilde).' };
    guild.members = guild.members.filter((id) => id !== target.id);
    target.guildId = null;
    target.guildName = null;
    this.pushSelf(target);
    this.onGuildsDirty();
    this.toast(p, target.username + ' a été exclu de la guilde.');
    this.log('🏰 ' + target.username + ' a été exclu de « ' + guild.name + ' ».');
    return { ok: true };
  }

  guildInfo(p) {
    const guild = this.guildOf(p);
    if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
    return {
      ok: true,
      guild: {
        id: guild.id, name: guild.name, leaderId: guild.leaderId, maxMembers: MAX_GUILD_MEMBERS,
        members: this.guildRosterPublic(guild),
      },
    };
  }

  /* ---------- Châteaux de guilde (territoire) ---------- */
  castleOf(terrain) {
    let c = this.castles.get(terrain);
    if (!c) {
      c = { terrain, ownerGuildId: null, hp: 0, hpMax: 0, level: 0, fortLevel: 0, nextSiegeAt: 0 };
      this.castles.set(terrain, c);
    }
    if (typeof c.fortLevel !== 'number') c.fortLevel = 0;
    if (typeof c.nextSiegeAt !== 'number') c.nextSiegeAt = 0;
    return c;
  }

  // Isolé en méthode (plutôt qu'un appel direct à isWithinSiegeWindow dans
  // createSiege) pour rester substituable en test — sinon la suite de tests
  // deviendrait non déterministe selon l'heure réelle d'exécution, comme
  // pour g.rng/g.broadcast (voir test-game.js).
  isSiegeWindowOpen(terrain) {
    return isWithinSiegeWindow(CASTLE_SIEGE_WINDOWS[terrain]);
  }

  castleTileFor(terrain) {
    for (const tile of this.worldMap.tiles.values()) {
      if (tile.content && tile.content.kind === 'castle' && tile.terrain === terrain) return tile;
    }
    return null;
  }

  atCastle(p, terrain) {
    if ((p.mapId || 'world') !== 'world') return false;
    const tile = this.castleTileFor(terrain);
    return !!tile && p.pos.x === tile.x && p.pos.y === tile.y;
  }

  castleDefenseForce(c) {
    const base = 300 + c.level * 150 + (c.fortLevel || 0) * CASTLE_FORTIFY_BONUS_PER_LEVEL;
    const ratio = c.hpMax ? Math.max(0, Math.min(1, c.hp / c.hpMax)) : 0;
    const woundFactor = CONFIG.COMBAT.WOUND_FLOOR + (1 - CONFIG.COMBAT.WOUND_FLOOR) * ratio;
    return base * woundFactor;
  }

  castlesInfo(p) {
    return CASTLE_TERRAINS.map((terrain) => {
      const c = this.castleOf(terrain);
      const guild = c.ownerGuildId ? this.guilds.get(c.ownerGuildId) : null;
      const tile = this.castleTileFor(terrain);
      return {
        terrain,
        x: tile ? tile.x : 0,
        y: tile ? tile.y : 0,
        ownerGuildId: c.ownerGuildId,
        ownerGuildName: guild ? guild.name : null,
        hp: c.hp,
        hpMax: c.hpMax,
        level: c.level,
        maxLevel: CASTLE_MAX_LEVEL,
        fortLevel: c.fortLevel || 0,
        maxFortLevel: CASTLE_MAX_FORT_LEVEL,
        isOwnGuild: !!(p.guildId && c.ownerGuildId === p.guildId),
      };
    });
  }

  claimCastle(p, terrain) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    if (!p.guildId) return { ok: false, error: 'Vous devez être dans une guilde.' };
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour le revendiquer.' };
    const c = this.castleOf(terrain);
    if (c.ownerGuildId) return { ok: false, error: 'Ce château appartient déjà à une guilde.' };
    if ((p.gold || 0) < CASTLE_CLAIM_COST_GOLD) {
      return { ok: false, error: 'Il faut ' + CASTLE_CLAIM_COST_GOLD + ' 🪙 (contribution personnelle) pour fonder.' };
    }
    p.gold -= CASTLE_CLAIM_COST_GOLD;
    c.ownerGuildId = p.guildId;
    c.level = 1;
    c.hpMax = CASTLE_BASE_HP;
    c.hp = c.hpMax;
    this.pushSelf(p);
    this.onGuildsDirty();
    const guild = this.guilds.get(p.guildId);
    this.log('🏰 La guilde « ' + guild.name + ' » a fondé un château en ' + terrain + '.');
    return { ok: true };
  }

  reinforceCastle(p, terrain) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    const c = this.castleOf(terrain);
    if (!c.ownerGuildId) return { ok: false, error: 'Ce château n’a pas encore été fondé.' };
    if (c.ownerGuildId !== p.guildId) return { ok: false, error: 'Vous ne pouvez renforcer que le château de votre guilde.' };
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour le renforcer.' };
    if (c.level >= CASTLE_MAX_LEVEL) return { ok: false, error: 'Niveau de renfort maximum atteint.' };
    if ((p.gold || 0) < CASTLE_REINFORCE_COST_GOLD) {
      return { ok: false, error: 'Il faut ' + CASTLE_REINFORCE_COST_GOLD + ' 🪙.' };
    }
    const recipe = CASTLE_REINFORCE_RESOURCES[c.level + 1];
    const resType = CASTLE_TERRAIN_RESOURCE[terrain];
    const resKey = stackKey(resType, recipe.tier);
    if ((p.inventory[resKey] || 0) < recipe.qty) {
      return { ok: false, error: 'Il faut ' + recipe.qty + '× ' + resourceLabel(resType, recipe.tier) + '.' };
    }
    p.gold -= CASTLE_REINFORCE_COST_GOLD;
    p.inventory[resKey] -= recipe.qty;
    if (p.inventory[resKey] <= 0) delete p.inventory[resKey];
    c.level += 1;
    c.hpMax += CASTLE_HP_PER_LEVEL;
    c.hp = Math.min(c.hpMax, c.hp + CASTLE_HP_PER_LEVEL);
    this.pushSelf(p);
    this.onGuildsDirty();
    return { ok: true, level: c.level, hpMax: c.hpMax };
  }

  repairCastle(p, terrain, amountGold) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    const c = this.castleOf(terrain);
    if (!c.ownerGuildId) return { ok: false, error: 'Ce château n’a pas encore été fondé.' };
    if (c.ownerGuildId !== p.guildId) return { ok: false, error: 'Vous ne pouvez réparer que le château de votre guilde.' };
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour le réparer.' };
    if (c.hp >= c.hpMax) return { ok: false, error: 'Déjà à pleine structure.' };
    const resType = CASTLE_TERRAIN_RESOURCE[terrain];
    const resTier = castleRepairResourceTier(c.level);
    const resKey = stackKey(resType, resTier);
    const goldBudget = Math.max(0, Math.min(Math.floor(Number(amountGold) || 0), p.gold || 0));
    const resourceStock = p.inventory[resKey] || 0;
    const healed = Math.min(
      c.hpMax - c.hp,
      Math.floor(goldBudget / CASTLE_REPAIR_GOLD_PER_HP),
      resourceStock * CASTLE_REPAIR_HP_PER_RESOURCE
    );
    if (healed <= 0) {
      return {
        ok: false,
        error: 'Pas assez d’or (' + CASTLE_REPAIR_GOLD_PER_HP + ' 🪙/PS) ou de ' + resourceLabel(resType, resTier) +
          ' (' + CASTLE_REPAIR_HP_PER_RESOURCE + ' PS par unité).',
      };
    }
    const cost = healed * CASTLE_REPAIR_GOLD_PER_HP;
    const resourceCost = Math.ceil(healed / CASTLE_REPAIR_HP_PER_RESOURCE);
    p.gold -= cost;
    p.inventory[resKey] -= resourceCost;
    if (p.inventory[resKey] <= 0) delete p.inventory[resKey];
    c.hp += healed;
    this.pushSelf(p);
    this.onGuildsDirty();
    return { ok: true, healed, cost, resourceCost, resourceType: resType, resourceTier: resTier, hp: c.hp, hpMax: c.hpMax };
  }

  // Fortification : investissement défensif séparé du renfort — augmente la
  // garnison de base sans nécessiter de joueurs présents (voir castleDefenseForce).
  fortifyCastle(p, terrain) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    const c = this.castleOf(terrain);
    if (!c.ownerGuildId) return { ok: false, error: 'Ce château n’a pas encore été fondé.' };
    if (c.ownerGuildId !== p.guildId) return { ok: false, error: 'Vous ne pouvez fortifier que le château de votre guilde.' };
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour le fortifier.' };
    if ((c.fortLevel || 0) >= CASTLE_MAX_FORT_LEVEL) return { ok: false, error: 'Niveau de fortification maximum atteint.' };
    if ((p.gold || 0) < CASTLE_FORTIFY_COST_GOLD) {
      return { ok: false, error: 'Il faut ' + CASTLE_FORTIFY_COST_GOLD + ' 🪙.' };
    }
    const recipe = CASTLE_FORTIFY_RESOURCES[(c.fortLevel || 0) + 1];
    const resType = CASTLE_TERRAIN_RESOURCE[terrain];
    const resKey = stackKey(resType, recipe.tier);
    if ((p.inventory[resKey] || 0) < recipe.qty) {
      return { ok: false, error: 'Il faut ' + recipe.qty + '× ' + resourceLabel(resType, recipe.tier) + '.' };
    }
    p.gold -= CASTLE_FORTIFY_COST_GOLD;
    p.inventory[resKey] -= recipe.qty;
    if (p.inventory[resKey] <= 0) delete p.inventory[resKey];
    c.fortLevel = (c.fortLevel || 0) + 1;
    this.pushSelf(p);
    this.onGuildsDirty();
    return { ok: true, fortLevel: c.fortLevel };
  }

  /* Lance (ou rejoint) un siège : un lobby de 30 s s'ouvre, comme pour un raid
   * de monstre — les autres membres de la guilde assaillante ont le temps
   * de venir grossir les rangs avant la résolution (voir resolveSiege). */
  createSiege(p, terrain) {
    if (!CASTLE_TERRAINS.includes(terrain)) return { ok: false, error: 'Zone invalide.' };
    if (!p.guildId) return { ok: false, error: 'Vous devez être dans une guilde.' };
    const c = this.castleOf(terrain);
    if (!c.ownerGuildId) return { ok: false, error: 'Ce château n’appartient à personne — revendiquez-le plutôt.' };
    if (c.ownerGuildId === p.guildId) return { ok: false, error: 'Vous ne pouvez pas assiéger le château de votre propre guilde.' };
    const key = 'siege:' + terrain;
    if (this.raids.has(key)) return this.joinRaid(p, key);
    // Fenêtre de vulnérabilité (voir CASTLE_SIEGE_WINDOWS) : la défense doit
    // dépendre de la force réelle des deux guildes sur des heures où tout le
    // monde peut légitimement être en ligne, pas d'un horaire nocturne exploité.
    if (!this.isSiegeWindowOpen(terrain)) {
      const siegeWindow = CASTLE_SIEGE_WINDOWS[terrain];
      return { ok: false, error: 'Ce château n’est assiégeable qu’entre ' + siegeWindow.startHour + 'h et ' + siegeWindow.endHour + 'h (heure de Paris).' };
    }
    // Délai entre deux sièges sur le même château (voir CASTLE_SIEGE_COOLDOWN_MS) :
    // sans lui, une guilde peut enchaîner les assauts (chacun avec son propre
    // lobby de 30 s) sans laisser aux défenseurs le temps de rallier ou réparer.
    if (Date.now() < c.nextSiegeAt) {
      const secs = Math.max(1, Math.ceil((c.nextSiegeAt - Date.now()) / 1000));
      const mm = Math.floor(secs / 60), ss = secs % 60;
      return { ok: false, error: 'Ce château a déjà été assiégé récemment — retentez dans ' + (mm > 0 ? mm + ' min ' : '') + ss + ' s.' };
    }
    if (!this.atCastle(p, terrain)) return { ok: false, error: 'Vous devez être au château pour lancer l’assaut.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    const tile = this.castleTileFor(terrain);
    p.status = 'LOBBY_COMBAT';
    p.raidKey = key;
    this.raids.set(key, {
      key,
      siege: true,
      terrain,
      tileKey: tileKey(tile.x, tile.y),
      mapId: 'world',
      tier: c.level,
      label: 'Château (' + (TERRAINS[terrain] ? TERRAINS[terrain].label : terrain) + ')',
      monsterForce: this.castleDefenseForce(c),
      participants: [p.id],
      leaderId: p.id,
      attackerGuildId: p.guildId,
      defenderGuildId: c.ownerGuildId,
      endsAt: this.now + CONFIG.LOBBY_MS,
      engines: [],
    });

    // Alerte la guilde défenseuse : elle a les 30 s du lobby pour se masser
    // sur la tuile du château et renforcer la garnison (voir resolveSiege).
    const guildAtk = this.guilds.get(p.guildId);
    const terrainLabel = TERRAINS[terrain] ? TERRAINS[terrain].label : terrain;
    for (const m of this.players.values()) {
      if (!m.bot && m.online && m.guildId === c.ownerGuildId) {
        this.toast(m, '🏰 Votre château (' + terrainLabel + ') est assiégé par « ' + guildAtk.name + ' » — accourez pour le défendre (30 s) !');
      }
    }
    // Annonce mondiale (toast + chat) : sert surtout à la guilde défenseuse
    // (des membres peuvent avoir manqué le toast ciblé ci-dessus, ou vouloir
    // s'y rendre pour réparer/renforcer après coup), mais reste visible de tous.
    this.worldNotify('⚔ Le château ' + terrainLabel + ' est attaqué par « ' + guildAtk.name + ' » !');
    return { ok: true };
  }

  // Déploie un engin de siège fabriqué à l'avance (Capitale) dans un siège déjà
  // rejoint — 1 par personne maximum, consommé qu'il fasse gagner l'assaut ou non.
  deploySiegeEngine(p, key, tier) {
    key = this.normalizeRaidKey(p, key);
    const raid = this.raids.get(key);
    if (!raid || !raid.siege) return { ok: false, error: 'Ce siège n’existe plus.' };
    if (!raid.participants.includes(p.id)) return { ok: false, error: 'Vous devez d’abord rejoindre le siège.' };
    if ((raid.engines || []).some((e) => e.by === p.id)) return { ok: false, error: 'Vous avez déjà déployé un engin pour ce siège.' };
    const t = Math.floor(Number(tier));
    if (!SIEGE_ENGINE_FORCE[t]) return { ok: false, error: 'Tier d’engin invalide.' };
    const itemKey = stackKey(SIEGE_ENGINE_ITEM, t);
    if ((p.inventory[itemKey] || 0) < 1) return { ok: false, error: 'Vous n’avez pas cet engin en stock.' };
    p.inventory[itemKey] -= 1;
    if (p.inventory[itemKey] <= 0) delete p.inventory[itemKey];
    if (!raid.engines) raid.engines = [];
    raid.engines.push({ by: p.id, tier: t });
    this.pushSelf(p);
    this.toast(p, '⚙ Engin de siège T' + t + ' déployé pour ce siège.');
    return { ok: true, tier: t };
  }

  resolveSiege(key, raid) {
    this.raids.delete(key);
    const c = this.castleOf(raid.terrain);
    const defenderGuildId = c.ownerGuildId;
    const members = raid.participants.map((id) => this.memberById(id)).filter(Boolean);
    const attackers = members.filter((m) => m.guildId === raid.attackerGuildId);
    for (const a of attackers) { a.status = 'IDLE'; a.raidKey = null; }
    const guildAtk = this.guilds.get(raid.attackerGuildId);
    const guildDef = defenderGuildId ? this.guilds.get(defenderGuildId) : null;

    // Le château peut ne plus avoir de propriétaire valide (guilde dissoute
    // pendant le siège) ou appartenir déjà aux assaillants : on annule sans dégâts.
    if (!guildDef || defenderGuildId === raid.attackerGuildId) {
      if (!guildDef) c.ownerGuildId = null;
      for (const a of attackers) {
        if (a.bot) continue;
        this.pushSelf(a);
        this.send(a.id, 'siegeResult', { cancelled: true, terrain: raid.terrain, label: raid.label });
      }
      return;
    }

    // Défense active : tout membre de la guilde propriétaire physiquement
    // présent sur la tuile du château à la résolution renforce la garnison —
    // se rallier à temps pendant les 30 s du lobby change l'issue du combat.
    const tile = this.castleTileFor(raid.terrain);
    const defenders = [...this.players.values()].filter((m) =>
      !m.bot && m.guildId === defenderGuildId && (m.mapId || 'world') === 'world' &&
      tile && m.pos.x === tile.x && m.pos.y === tile.y
    );
    const garrison = this.castleDefenseForce(c);
    const defenseBonus = teamPowerOf(defenders);
    const defense = garrison + defenseBonus;

    // Engins de siège : force d'appoint (une fraction d'un joueur, jamais 1
    // pour 1) ET dégâts de structure garantis, indépendants du jet de combat —
    // une guilde progresse même en cas d'échec, mais ne peut prendre le
    // château QUE sur un assaut effectivement gagné (voir plus bas).
    const engines = raid.engines || [];
    const engineForce = engines.reduce((sum, e) => sum + (SIEGE_ENGINE_FORCE[e.tier] || 0), 0);
    const engineDamage = engines.reduce((sum, e) => sum + (SIEGE_ENGINE_DAMAGE[e.tier] || 0), 0);

    const force = teamPowerOf(attackers) + engineForce;
    const chance = winChance(force, defense);
    const victory = this.rng() < chance;
    let captured = false;

    if (!victory) {
      for (const a of attackers) {
        a.hp = Math.max(1, Math.ceil(maxHp(a) * CONFIG.COMBAT.DEATH_HP_PCT));
        a.mapId = 'world';
        a.pos = { x: 0, y: 0 };
      }
      // Le bombardement laisse des traces même en cas d'échec de l'assaut,
      // mais ne peut jamais faire tomber le château tout seul (plancher à 1 PS) —
      // il faut une victoire au combat pour le prendre.
      if (engineDamage > 0) c.hp = Math.max(1, c.hp - engineDamage);
      this.worldNotify('🏰 L’assaut de « ' + guildAtk.name + ' » contre le château (' + raid.terrain + ') de « ' + guildDef.name + ' » a échoué' +
        (defenders.length ? (' — ' + defenders.length + ' défenseur(s) mobilisé(s)') : '') +
        (engineDamage > 0 ? (' (engins : -' + engineDamage + ' PS malgré tout, ' + c.hp + '/' + c.hpMax + ')') : '') + '.');
    } else {
      const totalDamage = CASTLE_DAMAGE_PER_ASSAULT + engineDamage;
      c.hp = Math.max(0, c.hp - totalDamage);
      if (c.hp <= 0) {
        captured = true;
        c.ownerGuildId = raid.attackerGuildId;
        c.hp = Math.round(c.hpMax * 0.5);
        c.fortLevel = 0;   // les fortifications de l'ancien propriétaire tombent avec lui
        this.worldNotify('🏰 « ' + guildAtk.name + ' » a pris le château (' + raid.terrain + ') à « ' + guildDef.name + ' » !');
      } else {
        this.worldNotify('🏰 « ' + guildAtk.name + ' » entame le château (' + raid.terrain + ') de « ' + guildDef.name + ' » (' + c.hp + '/' + c.hpMax + ' PS restants).');
      }
      this.onGuildsDirty();
    }

    // Quelle que soit l'issue (repoussé, endommagé, ou pris), impose un délai
    // avant le prochain siège sur CE château (voir createSiege) — l'attaquant
    // qui vient de le prendre en profite aussi, le temps pour le nouveau
    // propriétaire de souffler avant une contre-attaque immédiate.
    c.nextSiegeAt = Date.now() + CASTLE_SIEGE_COOLDOWN_MS;

    for (const a of attackers) {
      if (a.bot) continue;
      a.stats.siegeParticipations = (a.stats.siegeParticipations || 0) + 1;
      if (captured) a.stats.siegeWins = (a.stats.siegeWins || 0) + 1;
      this.notifyAchievements(a, checkAchievements(a, ['Château']));
      this.pushSelf(a);
      this.send(a.id, 'siegeResult', {
        role: 'attacker',
        victory, captured, chance,
        terrain: raid.terrain,
        label: raid.label,
        teamForce: Math.round(force),
        defenseForce: Math.round(defense),
        engineForce, engineDamage, engineCount: engines.length,
        hp: c.hp,
        hpMax: c.hpMax,
        attackerGuildName: guildAtk.name,
        defenderGuildName: guildDef.name,
        participants: attackers.map((m) => m.username),
      });
    }

    for (const d of defenders) {
      d.stats.siegeParticipations = (d.stats.siegeParticipations || 0) + 1;
      this.notifyAchievements(d, checkAchievements(d, ['Château']));
      this.pushSelf(d);
      this.send(d.id, 'siegeResult', {
        role: 'defender',
        victory, captured, chance,
        terrain: raid.terrain,
        label: raid.label,
        teamForce: Math.round(force),
        defenseForce: Math.round(defense),
        engineForce, engineDamage, engineCount: engines.length,
        garrison: Math.round(garrison),
        defenseBonus: Math.round(defenseBonus),
        hp: c.hp,
        hpMax: c.hpMax,
        attackerGuildName: guildAtk.name,
        defenderGuildName: guildDef.name,
        participants: defenders.map((m) => m.username),
      });
    }

    // Les autres membres en ligne de la guilde défenseuse (absents de la tuile)
    // reçoivent un simple message d'issue, sans rapport détaillé.
    const defenderIds = new Set(defenders.map((m) => m.id));
    // "Tombé aux mains de" uniquement sur une capture effective (captured) —
    // un assaut gagné qui n'entame que les PS ne change pas le propriétaire,
    // il ne faut pas laisser croire le contraire (voir defenderOutcomeText).
    const defenderOutcomeText = captured
      ? ('🏰 Le château (' + raid.terrain + ') est tombé aux mains de « ' + guildAtk.name + ' ».')
      : victory
        ? ('🏰 Le château (' + raid.terrain + ') a été endommagé par « ' + guildAtk.name + ' » (' + c.hp + '/' + c.hpMax + ' PS restants).')
        : ('🏰 L’assaut de « ' + guildAtk.name + ' » contre votre château (' + raid.terrain + ') a été repoussé.');

    for (const m of this.players.values()) {
      if (m.bot || !m.online || m.guildId !== defenderGuildId || defenderIds.has(m.id)) continue;
      this.toast(m, defenderOutcomeText);
    }

    // Notification push : seulement pour ceux qui n'étaient PAS connectés
    // pour voir le résultat en direct (les autres l'ont déjà via toast/popup
    // ci-dessus) — on prévient d'un siège qu'on ne pouvait de toute façon
    // pas rejoindre à temps, juste son issue.
    for (const m of this.players.values()) {
      if (m.bot || m.online || m.guildId !== defenderGuildId) continue;
      this.sendPush(m.id, '🏰 Siège terminé', defenderOutcomeText);
    }
    for (const a of attackers) {
      if (a.bot || a.online) continue;
      this.sendPush(a.id, '⚔ Résultat du siège', captured
        ? ('Victoire ! Le château (' + raid.terrain + ') de « ' + guildDef.name + ' » est conquis.')
        : victory
          ? ('Le château (' + raid.terrain + ') de « ' + guildDef.name + ' » a été endommagé (' + c.hp + '/' + c.hpMax + ' PS restants).')
          : ('L’assaut contre le château (' + raid.terrain + ') de « ' + guildDef.name + ' » a échoué.'));
    }
  }

  /* ---------- Amis ---------- */
  sendFriendRequest(p, targetUsername) {
    const target = this.findAccountByUsername(targetUsername);
    if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === p.id) return { ok: false, error: 'Impossible de vous ajouter vous-même.' };
    if (p.friends.includes(target.id)) return { ok: false, error: target.username + ' est déjà votre ami.' };
    if (target.friendRequests.some((r) => r.fromId === p.id)) return { ok: false, error: 'Demande déjà envoyée.' };
    // Symétrie : si l'autre nous a déjà envoyé une demande, on l'accepte directement
    const reciprocalIdx = p.friendRequests.findIndex((r) => r.fromId === target.id);
    if (reciprocalIdx >= 0) {
      p.friendRequests.splice(reciprocalIdx, 1);
      p.friends.push(target.id);
      target.friends.push(p.id);
      this.notifyAchievements(p, checkAchievements(p, ['Social']));
      this.notifyAchievements(target, checkAchievements(target, ['Social']));
      this.pushSelf(p);
      this.pushSelf(target);
      this.toast(p, target.username + ' est maintenant votre ami.');
      this.toast(target, p.username + ' est maintenant votre ami.');
      if (!target.online) this.sendPush(target.id, '👥 Nouvel ami', 'Vous êtes maintenant ami avec ' + p.username + '.');
      return { ok: true, addedDirectly: true };
    }
    target.friendRequests.push({ fromId: p.id, fromUsername: p.username, at: this.now });
    this.pushSelf(target);
    this.toast(p, 'Demande d’ami envoyée à ' + target.username + '.');
    if (!target.online) this.sendPush(target.id, '👥 Demande d’ami', p.username + ' souhaite devenir votre ami.');
    return { ok: true };
  }

  respondFriendRequest(p, fromId, accept) {
    const idx = p.friendRequests.findIndex((r) => r.fromId === String(fromId));
    if (idx < 0) return { ok: false, error: 'Demande introuvable.' };
    const req = p.friendRequests[idx];
    p.friendRequests.splice(idx, 1);
    const from = this.players.get(req.fromId);
    if (!accept) {
      this.pushSelf(p);
      if (from) this.toast(from, p.username + ' a refusé votre demande d’ami.');
      return { ok: true, declined: true };
    }
    if (!from) {
      this.pushSelf(p);
      return { ok: false, error: 'Ce joueur n’existe plus.' };
    }
    p.friends.push(from.id);
    from.friends.push(p.id);
    this.notifyAchievements(p, checkAchievements(p, ['Social']));
    this.notifyAchievements(from, checkAchievements(from, ['Social']));
    this.pushSelf(p);
    this.pushSelf(from);
    this.toast(from, p.username + ' a accepté votre demande d’ami.');
    return { ok: true };
  }

  removeFriend(p, targetUsername) {
    const target = this.findAccountByUsername(targetUsername);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    if (!p.friends.includes(target.id)) return { ok: false, error: 'Vous n’êtes pas amis.' };
    p.friends = p.friends.filter((id) => id !== target.id);
    target.friends = target.friends.filter((id) => id !== p.id);
    this.pushSelf(p);
    this.pushSelf(target);
    return { ok: true };
  }

  friendsList(p) {
    return p.friends.map((id) => {
      const f = this.players.get(id);
      if (!f) return null;
      // Localisation affichée seulement si en ligne — la dernière position
      // connue d'un ami hors ligne ne veut rien dire pour « le rejoindre ».
      // En donjon : ni coordonnées (repère local, sans intérêt pour l'appelant)
      // ni bouton rejoindre (on n'y accède qu'en marchant sur son entrée
      // dans le monde — sinon on court-circuite la découverte de ce donjon).
      let location = null;
      if (f.online) {
        const mapId = f.mapId || 'world';
        if (mapId === 'world') {
          const tile = this.worldMap.tiles.get(tileKey(f.pos.x, f.pos.y));
          location = { mapId: 'world', x: f.pos.x, y: f.pos.y, terrain: (tile && tile.terrain) || null };
        } else {
          const map = this.mapOf(mapId);
          location = { mapId, dungeon: true, terrain: (map && map.terrain) || null };
        }
      }
      return {
        id: f.id,
        username: f.username,
        online: !!f.online,
        speciesClass: f.speciesClass,
        classLabel: (CLASSES[f.speciesClass] && CLASSES[f.speciesClass].label) || f.speciesClass,
        location,
      };
    }).filter(Boolean);
  }

  joinFriend(p, targetUsername) {
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    const target = this.findAccountByUsername(targetUsername);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    if (!p.friends.includes(target.id)) return { ok: false, error: 'Vous n’êtes pas amis.' };
    if (!target.online) return { ok: false, error: target.username + ' n’est pas en ligne.' };
    if ((target.mapId || 'world') !== 'world') return { ok: false, error: 'Impossible de rejoindre un ami en donjon.' };
    this.resetTravelState(p);
    p.mapId = 'world';
    p.pos = this.nearestWalkablePos(this.worldMap, target.pos);
    this.pushMap(p);
    this.pushSelf(p);
    this.toast(p, 'Vous avez rejoint ' + target.username + '.');
    return { ok: true };
  }

  /* ---------- Historique de discussion (coordination asynchrone) ---------- */
  recordChat(entry) {
    this.chatLog.push({ ...entry, at: this.now });
    if (this.chatLog.length > CHAT_LOG_MAX) this.chatLog.shift();
    this.onChatDirty();
  }

  /* Ce qu'un joueur a le droit de revoir en se (re)connectant : le général
   * pour tout le monde, la guilde courante, et les MP qui le concernent. */
  chatHistoryFor(p) {
    return this.chatLog
      .filter((m) => {
        if (m.channel === 'guild') return !!p.guildId && m.guildId === p.guildId;
        if (m.channel === 'whisper') return m.fromId === p.id || m.toId === p.id;
        return true;
      })
      .map((m) => ({ from: m.from, to: m.to, text: m.text, type: m.type, channel: m.channel }));
  }

  raidsPayload() {
    return [...this.raids.values()].map((r) => ({
      key: r.key,
      siege: !!r.siege,
      tileKey: r.tileKey,
      mapId: r.mapId,
      tier: r.tier,
      label: r.label,
      monsterForce: r.monsterForce,
      endsAt: r.endsAt,
      leaderId: r.leaderId,
      participants: r.participants,
      engines: r.siege ? (r.engines || []) : undefined,
      teamForce: this.teamForce(r),
      winChance: this.raidChance(r),
    }));
  }

  mapDiffs() {
    const out = {};
    for (const [mapId, map] of this.maps) {
      out[mapId] = [];
      for (const [key, tile] of map.tiles) {
        if (tile.content && tile.content.inactiveUntil > this.now) out[mapId].push([key, tile.content.inactiveUntil]);
      }
    }
    return out;
  }

  // Redistribution nocturne : ressources ET monstres sauvages rejoués à une
  // nouvelle disposition (jamais les villages/donjons/château/capitale — voir
  // applyWildLayer). Les clients connectés rejouent la même fonction pure de
  // leur côté dès qu'ils reçoivent le nouveau salt (aucune carte à
  // transmettre sur le réseau).
  redistributeWildlife() {
    this.wildSalt++;
    applyWildLayer(this.worldMap.tiles, this.seed, this.wildSalt);
    this.broadcast('world:wildSalt', { salt: this.wildSalt });
    this.broadcast('toast', { text: '🌱 La faune sauvage (ressources et monstres) a été redistribuée cette nuit.' });
    this.log('🌱 La faune sauvage (ressources et monstres) a été redistribuée cette nuit.');
    return { ok: true, salt: this.wildSalt };
  }

  worldDiffs() {
    const diffs = [];
    for (const [mapId, map] of this.maps) {
      for (const [key, tile] of map.tiles) {
        if (tile.content && tile.content.inactiveUntil > this.now) diffs.push([mapId + '|' + key, tile.content.inactiveUntil]);
      }
    }
    return diffs;
  }

  spawnBots() {
    const { MIN, MAX } = CONFIG.WORLD;
    for (let i = 0; i < CONFIG.BOT_COUNT; i++) {
      const classes = Object.keys(CLASSES).filter((cls) => classAvailableToRole(cls, 'user'));
      const cls = classes[Math.floor(Math.random() * classes.length)];
      const tier = 1 + Math.floor(Math.random() * 3);
      const skinOptions = [null, ...SKIN_SHOP_ITEMS.filter((s) => s.speciesClass === cls).map((s) => s.id)];
      const skinId = skinOptions[Math.floor(Math.random() * skinOptions.length)];
      // Répartis sur toute la carte (et non plus regroupés près de la Capitale)
      // pour que le monde paraisse habité même loin du point de départ.
      let x = 0, y = 0, tries = 0;
      do {
        x = MIN + Math.floor(Math.random() * (MAX - MIN + 1));
        y = MIN + Math.floor(Math.random() * (MAX - MIN + 1));
        tries++;
      } while (!isWalkable(this.worldMap.tiles, x, y) && tries < 50);
      const bot = {
        id: 'bot' + i, username: BOT_NAMES[i % BOT_NAMES.length], speciesClass: cls, skinId, bot: true,
        mapId: 'world',
        pos: { x, y }, home: { x, y },
        pa: 100,
        harvestLevel: tier, weaponMastery: tier,
        weapon: { tier: Math.max(0, tier - 1), type: CLASS_GEAR[cls].weapon },
        armor: { tier: Math.max(0, tier - 1), type: CLASS_GEAR[cls].armor },
        inventory: {},
        status: 'IDLE', raidKey: null,
        nextThink: Math.random() * CONFIG.BOT_TICK_MS,
      };
      bot.hp = maxHp(bot);
      this.bots.set('bot' + i, bot);
    }
  }

  tick(dtReal) {
    const dt = dtReal * this.speed;
    this.now += dt;

    // Réveil du boss mondial : horloge RÉELLE (Date.now()), jamais this.now
    // (qui accélère avec SPEED en dev) — un évènement à 36h doit rester à 36h
    // même en test accéléré.
    if (!this.worldBossAlive && Date.now() >= this.worldBossNextSpawnAt) {
      this.worldBossAlive = true;
      this.onWorldBossDirty();
      this.worldNotify('🐉 Le Wyrm Ancestral s’est réveillé dans son repaire !');
    }

    for (const p of this.players.values()) {
      if (!p.online) continue;
      p.paMs += dt;
      while (p.paMs >= CONFIG.PA.REGEN_MS) {
        p.paMs -= CONFIG.PA.REGEN_MS;
        if (p.pa < CONFIG.PA.MAX) p.pa++;
      }
      p.hpMs += dt;
      while (p.hpMs >= CONFIG.HP.REGEN_MS) {
        p.hpMs -= CONFIG.HP.REGEN_MS;
        if (p.hp < maxHp(p)) p.hp++;
      }
      if (p.status === 'HARVESTING' && this.now >= p.harvestEndsAt) this.finishHarvest(p);
    }

    for (const [key, raid] of [...this.raids]) {
      if (this.now >= raid.endsAt) {
        if (raid.siege) this.resolveSiege(key, raid);
        else this.resolveRaid(key, raid);
      }
    }

    for (const b of this.bots.values()) {
      if (this.now >= b.nextThink) {
        b.nextThink = this.now + CONFIG.BOT_TICK_MS * (0.7 + Math.random() * 0.6);
        this.botThink(b);
      }
    }

    this.pendingReplies = this.pendingReplies.filter((r) => {
      if (this.now >= r.at) { this.broadcast('chat', r.msg); return false; }
      return true;
    });
  }

  move(p, dx, dy) {
    const tiles = this.tilesOf(p);
    dx = Math.round(Number(dx) || 0);
    dy = Math.round(Number(dy) || 0);
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return { ok: false, error: 'Case non adjacente.' };
    const nx = p.pos.x + dx;
    const ny = p.pos.y + dy;
    if (!isWalkable(tiles, nx, ny)) return { ok: false, error: 'Case bloquée.' };
    p.pos = { x: nx, y: ny };

    // Marcher sur un village le « découvre » : téléporteur débloqué
    const arrived = tiles.get(tileKey(nx, ny));
    if (arrived && arrived.content && arrived.content.kind === 'village') {
      const vk = tileKey(nx, ny);
      if (!p.visitedVillages.includes(vk)) {
        p.visitedVillages.push(vk);
        this.notifyAchievements(p, checkAchievements(p, ['Exploration']));
        this.plog(p, '📍 ' + (arrived.content.name || 'Village') + ' découvert — téléporteur débloqué !');
      }
    }
    return { ok: true };
  }

  // Brouillard de guerre : le client pousse par lots les tuiles du MONDE
  // (donjons exclus, non partagés entre appareils) qu'il vient de découvrir,
  // pour retrouver la même carte explorée sur n'importe quel navigateur/PWA.
  exploreTiles(p, keys) {
    if (!Array.isArray(keys) || !keys.length) return { ok: true, added: 0 };
    const set = new Set(p.exploredWorld);
    const before = set.size;
    for (const k of keys) {
      if (typeof k === 'string' && k.length <= 16 && /^-?\d{1,3},-?\d{1,3}$/.test(k)) set.add(k);
    }
    if (set.size !== before) {
      p.exploredWorld = [...set];
      this.notifyAchievements(p, checkAchievements(p, ['Exploration']));
    }
    return { ok: true, added: set.size - before };
  }

  harvest(p, x, y) {
    const tile = this.tilesOf(p).get(tileKey(x, y));
    const node = tile && tile.content;
    if (!node || node.kind !== 'resource') return { ok: false, error: 'Rien à récolter ici.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(p.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    if (this.now < node.inactiveUntil) return { ok: false, error: 'Gisement épuisé.' };
    const reqTier = Math.min(6, node.tier);
    if (p.harvestLevel < reqTier) return { ok: false, error: 'Niveau de récolte insuffisant (T' + reqTier + ' requis).' };
    p.status = 'HARVESTING';
    p.harvestKey = this.raidId(p.mapId, x, y);
    p.harvestEndsAt = this.now + CONFIG.HARVEST_MS;
    return { ok: true, duration: CONFIG.HARVEST_MS };
  }

  finishHarvest(p) {
    const [mapId, key] = String(p.harvestKey || '').split('|');
    const tile = this.mapOf(mapId || p.mapId).tiles.get(key || '');
    if (!tile || !tile.content) return;
    const node = tile.content;
    p.status = 'IDLE';
    p.harvestKey = null;
    const qty = 3 + Math.floor(Math.random() * 3);
    const invKey = stackKey(node.type, node.tier);
    p.inventory[invKey] = (p.inventory[invKey] || 0) + qty;
    node.inactiveUntil = this.now + (node.dungeonResource ? CONFIG.RESPAWN_DUNGEON_RESOURCE_MS : CONFIG.RESPAWN_RESOURCE_MS);
    // Sans ce broadcast, les clients ne voient jamais le nœud passer en repousse
    this.broadcast('world', { mapId: mapId || p.mapId || 'world', key, inactiveUntil: node.inactiveUntil });
    const boosted = this.consumeRegainBonus(p, CONFIG.COSTS.HARVEST);
    const xpGain = (8 + Math.min(6, node.tier) * 6) * (boosted ? 2 : 1);
    p.harvestXp += xpGain;
    this.checkLevelUp(p, 'harvest');
    p.stats.harvest[node.type] = (p.stats.harvest[node.type] || 0) + qty;
    this.notifyAchievements(p, checkAchievements(p, ['Récolte']));
    this.pushSelf(p);
  }

  createRaid(p, x, y) {
    const tile = this.tilesOf(p).get(tileKey(x, y));
    const monster = tile && tile.content;
    const key = this.raidId(p.mapId, x, y);
    if (!monster || monster.kind !== 'monster') return { ok: false, error: 'Aucun monstre ici.' };
    if (this.now < monster.inactiveUntil) return { ok: false, error: 'Ce groupe est déjà vaincu.' };
    if (monster.worldBoss && !this.worldBossAlive) {
      const totalMin = Math.max(1, Math.ceil((this.worldBossNextSpawnAt - Date.now()) / 60000));
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return { ok: false, error: 'Le Wyrm Ancestral est endormi — revient dans ' + (h > 0 ? h + ' h ' : '') + m + ' min.' };
    }
    if (this.raids.has(key)) return this.joinRaid(p, key);
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (this.chebyshev(p.pos, tile) > 1) return { ok: false, error: 'Trop loin — approchez-vous.' };
    p.status = 'LOBBY_COMBAT';
    p.raidKey = key;
    this.raids.set(key, {
      key,
      tileKey: tileKey(x, y),
      mapId: p.mapId,
      tier: monster.tier,
      label: monster.label,
      monsterForce: monster.force,
      participants: [p.id],
      leaderId: p.id,
      endsAt: this.now + CONFIG.LOBBY_MS,
    });
    return { ok: true };
  }

  joinRaid(p, key) {
    key = this.normalizeRaidKey(p, key);
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.mapId !== p.mapId) return { ok: false, error: 'Ce lobby est sur une autre carte.' };
    if (raid.siege && p.guildId !== raid.attackerGuildId) {
      return { ok: false, error: 'Seuls les membres de la guilde assaillante peuvent rejoindre ce siège.' };
    }
    if (raid.participants.includes(p.id)) return { ok: false, error: 'Vous êtes déjà dans ce lobby.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    const tile = this.tilesOf(p).get(raid.tileKey);
    if (this.chebyshev(p.pos, tile) > CONFIG.JOIN_RADIUS) return { ok: false, error: 'Trop loin pour rejoindre.' };
    p.status = 'LOBBY_COMBAT';
    p.raidKey = key;
    raid.participants.push(p.id);
    return { ok: true };
  }

  startRaidNow(p, key) {
    key = this.normalizeRaidKey(p, key);
    const raid = this.raids.get(key);
    if (!raid) return { ok: false, error: 'Ce lobby n’existe plus.' };
    if (raid.leaderId !== p.id) return { ok: false, error: 'Seul le créateur peut lancer le combat.' };
    raid.endsAt = this.now;
    return { ok: true };
  }

  botJoinRaid(bot, raid) {
    bot.status = 'LOBBY_COMBAT';
    bot.raidKey = raid.key;
    raid.participants.push(bot.id);
  }

  teamForce(raid) {
    const members = raid.participants.map((id) => this.memberById(id)).filter(Boolean);
    let force = teamPowerOf(members);
    if (raid.siege && raid.engines && raid.engines.length) {
      force += raid.engines.reduce((sum, e) => sum + (SIEGE_ENGINE_FORCE[e.tier] || 0), 0);
    }
    return force;
  }

  raidChance(raid) {
    return winChance(this.teamForce(raid), raid.monsterForce);
  }

  resolveRaid(key, raid) {
    this.raids.delete(key);
    const tile = this.mapOf(raid.mapId).tiles.get(raid.tileKey);
    if (!tile || !tile.content) return;
    const monster = tile.content;
    const members = raid.participants.map((id) => this.memberById(id)).filter(Boolean);
    const humans = members.filter((p) => !p.bot);
    const force = this.teamForce(raid);
    // Combat probabiliste : le sort en décide, à hauteur des puissances
    const chance = winChance(force, raid.monsterForce);
    const victory = this.rng() < chance;
    const druid = victory && members.some((p) => p.speciesClass === 'CERF_DRUIDE');
    const rampart = members.some((p) => p.speciesClass === 'OURS_GUERRIER');

    const rewards = new Map();   // accountId -> { loot, gold, xp }
    const lossById = new Map();  // accountId -> PV perdus (victoire)
    const diedById = new Set();  // accountId -> victoire mais blessure mortelle
    for (const p of members) {
      p.status = 'IDLE';
      p.raidKey = null;

      if (!victory) {
        // Défaite = mort : rapatriement à la Capitale, sans autre pénalité
        p.hp = Math.max(1, Math.ceil(maxHp(p) * CONFIG.COMBAT.DEATH_HP_PCT));
        if (p.bot) {
          p.pos = { ...p.home };
        } else {
          p.mapId = 'world';
          p.pos = { x: 0, y: 0 };
          this.pushSelf(p);
        }
        continue;
      }

      // Victoire : usure (réduite par l'armure, le Rempart et le Bouillon),
      // puis soignée par la Sève — dans cet ordre, pour qu'elle puisse encore
      // sauver d'une blessure autrement fatale. Gagner le combat ne protège
      // plus d'une mort par blessure : une victoire trop coûteuse en PV reste
      // mortelle (même traitement qu'une défaite — rapatriement, PV réduits).
      let loss = 4 + monster.tier * 3;
      loss *= hpLossReduction(p);
      if (rampart) loss *= 0.7;
      loss *= buffLossReduction(p);
      loss = Math.max(1, Math.round(loss));
      if (!p.bot) lossById.set(p.id, loss);
      let hpAfterLoss = p.hp - loss;
      if (druid) hpAfterLoss = Math.min(maxHp(p), hpAfterLoss + Math.round(maxHp(p) * CONFIG.COMBAT.DRUID_HEAL_PCT));
      if (hpAfterLoss <= 0) {
        p.hp = Math.max(1, Math.ceil(maxHp(p) * CONFIG.COMBAT.DEATH_HP_PCT));
        if (p.bot) p.pos = { ...p.home };
        else { p.mapId = 'world'; p.pos = { x: 0, y: 0 }; }
        if (!p.bot) diedById.add(p.id);
      } else {
        p.hp = hpAfterLoss;
      }

      if (victory && !p.bot) {
        // Les monstres lâchent de l'or (+ XP) et, parfois, un ingrédient
        // de cuisine de leur tier — les autres ressources viennent de la récolte.
        // Regain (ex-PA) : une seule consommation pour tout le raid (base +
        // bonus boss mondial le cas échéant), pas une par source d'XP.
        const boosted = this.consumeRegainBonus(p, CONFIG.COSTS.RAID);
        const xp = (15 + Math.min(6, monster.tier) * 15) * (boosted ? 2 : 1);
        p.weaponXp += xp;
        // Chapardeur (Renard Voleur) : +50 % d'or pour lui
        const lootMult = p.speciesClass === 'RENARD_VOLEUR' ? 1.5 : 1;
        // Territoire : la guilde propriétaire du château de la zone bonifie l'or de ses membres
        const zoneMult = (p.guildId && tile.terrain && this.castleOf(tile.terrain).ownerGuildId === p.guildId)
          ? CASTLE_ZONE_GOLD_BONUS : 1;
        const gold = Math.ceil(rollGoldLoot(monster.tier) * lootMult * zoneMult);
        p.gold = (p.gold || 0) + gold;
        let food = null;
        if (this.rng() < CONFIG.FOOD_DROP_CHANCE) {
          food = foodDropFor(monster.tier);
          p.inventory[food] = (p.inventory[food] || 0) + 1;
        }
        let bonus = null;
        if (monster.worldBoss) {
          const bonusGold = WORLD_BOSS.goldMin + Math.floor(this.rng() * (WORLD_BOSS.goldMax - WORLD_BOSS.goldMin + 1));
          p.gold += bonusGold;
          const bonusXp = WORLD_BOSS.xp * (boosted ? 2 : 1);
          p.weaponXp += bonusXp;
          let moonstones = 0;
          if (this.rng() < WORLD_BOSS.moonstoneChance) {
            moonstones = WORLD_BOSS.moonstoneMin + Math.floor(this.rng() * (WORLD_BOSS.moonstoneMax - WORLD_BOSS.moonstoneMin + 1));
            p[PREMIUM_CURRENCY.key] = (p[PREMIUM_CURRENCY.key] || 0) + moonstones;
          }
          let accessory = false;
          if (!p.ownedAccessories.includes(WORLD_BOSS.accessoryId) && this.rng() < WORLD_BOSS.accessoryChance) {
            p.ownedAccessories.push(WORLD_BOSS.accessoryId);
            p.accessoryId = WORLD_BOSS.accessoryId;
            accessory = true;
            this.toast(p, '✨ Objet légendaire obtenu : ' + ACCESSORY_ITEMS[WORLD_BOSS.accessoryId].label + ' !');
          }
          let mount = false;
          if (!p.ownedMounts.includes(WORLD_BOSS.mountId) && this.rng() < WORLD_BOSS.mountChance) {
            p.ownedMounts.push(WORLD_BOSS.mountId);
            p.mountId = WORLD_BOSS.mountId;
            mount = true;
            this.toast(p, '🐉 Monture légendaire obtenue : ' + MOUNT_ITEMS[WORLD_BOSS.mountId].label + ' !');
          }
          p.stats.worldBossKills = (p.stats.worldBossKills || 0) + 1;
          bonus = { gold: bonusGold, xp: bonusXp, moonstones, accessory, mount };
        }
        rewards.set(p.id, { gold, xp, food, worldBossBonus: bonus, boosted });
        this.checkLevelUp(p, 'weapon');
        p.stats.monsterKills = (p.stats.monsterKills || 0) + 1;
        p.stats.kills[monster.type] = (p.stats.kills[monster.type] || 0) + 1;
        if (monster.boss) p.stats.bossKills = (p.stats.bossKills || 0) + 1;
        this.notifyAchievements(p, checkAchievements(p, ['Combat', 'Équipement', 'Commerce']));
      }
      if (!p.bot) this.pushSelf(p);
    }

    // Les buffs de cuisine se consument à chaque combat, victoire ou défaite
    for (const p of humans) {
      if (!p.buff) continue;
      p.buff.combats -= 1;
      if (p.buff.combats <= 0) {
        this.plog(p, 'Les effets de votre ' + CONSUMABLES[p.buff.type].label + ' se dissipent.');
        delete p.buff;
      }
    }

    if (victory) {
      if (monster.worldBoss) {
        // Horloge murale, pas this.now (voir tick()) — inactiveUntil ne sert
        // à rien ici, le blocage passe par worldBossAlive (createRaid).
        this.worldBossAlive = false;
        this.worldBossNextSpawnAt = Date.now() + WORLD_BOSS.respawnMs;
        this.onWorldBossDirty();
        const hrs = Math.round(WORLD_BOSS.respawnMs / 3600000);
        this.log('🐉 Le Wyrm Ancestral a été terrassé ! Il se réveillera dans environ ' + hrs + ' h.');
      } else {
        if (monster.boss) monster.inactiveUntil = 0;
        else if (monster.dungeonMob) monster.inactiveUntil = this.now + CONFIG.RESPAWN_DUNGEON_MONSTER_MS;
        else monster.inactiveUntil = this.now + CONFIG.RESPAWN_MONSTER_MS;
        // Diffuse l'état vaincu du monstre à tous les clients
        this.broadcast('world', { mapId: raid.mapId || 'world', key: raid.tileKey, inactiveUntil: monster.inactiveUntil });
        this.updateDungeonProgress(raid.mapId, monster, true);
      }
    }
    this.log('⚔ Raid ' + raid.label + ' T' + raid.tier + ' : ' +
      (victory ? 'VICTOIRE' : 'DEFAITE — l’équipe a péri') +
      ' (' + Math.round(chance * 100) + ' % de chances, équipe ' + force + ' vs ' + raid.monsterForce + ')');

    for (const p of humans) {
      const rw = rewards.get(p.id);
      this.send(p.id, 'result', {
        victory,
        died: !victory || diedById.has(p.id),
        chance,
        label: raid.label,
        monsterType: monster.type,
        tier: raid.tier,
        teamForce: force,
        monsterForce: raid.monsterForce,
        participants: members.map((m) => m.username),
        gold: rw ? rw.gold : 0,
        food: rw ? rw.food : null,
        hpLoss: lossById.get(p.id) || 0,
        xp: rw ? rw.xp : 0,
        regainBoosted: rw ? !!rw.boosted : false,
        worldBoss: !!monster.worldBoss,
        worldBossBonus: rw ? rw.worldBossBonus : null,
        druid,
      });
    }
  }

  atSanctuaryPlayer(p) {
    if (p.mapId !== 'world') return false;
    const tile = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    return !!(tile && tile.content && (tile.content.kind === 'capital' || tile.content.kind === 'village'));
  }

  createCharacter(p, speciesClass) {
    if (!CLASSES[speciesClass]) return { ok: false, error: 'Classe invalide.' };
    if (!classAvailableToRole(speciesClass, p.role)) return { ok: false, error: 'Classe réservée aux administrateurs.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuaryPlayer(p)) return { ok: false, error: 'L’éveil d’une nouvelle forme se fait à la Capitale ou dans un village.' };
    if (p.characters.length >= p.charSlots) return { ok: false, error: 'Tous vos emplacements sont occupés.' };
    if (p.characters.some((c) => c.speciesClass === speciesClass)) return { ok: false, error: 'Vous incarnez déjà cette forme.' };
    syncActiveCharacter(p);
    p.characters.push(newCharacter(speciesClass));
    this.skinStateOf(p);
    this.pushSelf(p);
    return { ok: true, index: p.characters.length - 1 };
  }

  switchCharacter(p, index) {
    index = Math.floor(Number(index));
    if (!(index >= 0 && index < p.characters.length)) return { ok: false, error: 'Forme inconnue.' };
    if (index === p.activeChar) return { ok: false, error: 'Cette forme est déjà active.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuaryPlayer(p)) return { ok: false, error: 'La métamorphose se fait à la Capitale ou dans un village.' };
    const pct = Math.max(0, Math.min(1, p.hp / maxHp(p)));
    syncActiveCharacter(p);
    applyCharacter(p, index);
    p.hp = Math.max(1, Math.round(pct * maxHp(p)));
    this.pushSelf(p);
    return { ok: true };
  }

  enterDungeon(p, mapId) {
    const tile = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    if (!tile || !tile.content || tile.content.kind !== 'dungeon') return { ok: false, error: 'Vous devez être sur une entrée de donjon.' };
    if (tile.content.mapId !== mapId) return { ok: false, error: 'Entrée invalide.' };
    const map = this.mapOf(mapId);
    this.resetTravelState(p);
    p.mapId = map.id;
    p.pos = this.nearestWalkablePos(map, map.entry);
    this.pushMap(p);
    this.pushSelf(p);
    return { ok: true };
  }

  usePortal(p) {
    const tile = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    if (!tile || !tile.content || tile.content.kind !== 'portal') return { ok: false, error: 'Aucun portail ici.' };
    const map = this.mapOf(tile.content.targetMapId || 'world');
    this.resetTravelState(p);
    p.mapId = map.id;
    p.pos = this.nearestWalkablePos(map, tile.content.targetPos);
    this.pushMap(p);
    this.pushSelf(p);
    return { ok: true };
  }

  teleportVillage(p, x, y) {
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (p.mapId !== 'world') return { ok: false, error: 'Vous devez revenir dans le monde pour voyager.' };
    const from = this.tilesOf(p).get(tileKey(p.pos.x, p.pos.y));
    if (!from || !from.content || (from.content.kind !== 'village' && from.content.kind !== 'capital')) {
      return { ok: false, error: 'Vous devez être dans un village ou à la Capitale pour voyager.' };
    }
    const dest = this.worldMap.tiles.get(tileKey(Number(x), Number(y)));
    if (!dest || !dest.content || (dest.content.kind !== 'village' && dest.content.kind !== 'capital')) return { ok: false, error: 'Destination invalide.' };
    // Un village doit avoir été découvert à pied avant d'être une destination
    if (dest.content.kind === 'village' && !p.visitedVillages.includes(tileKey(dest.x, dest.y))) {
      return { ok: false, error: 'Village inconnu — vous devez d’abord le découvrir à pied.' };
    }
    p.pos = { x: dest.x, y: dest.y };
    this.pushSelf(p);
    return { ok: true };
  }

  upgrade(p, slot) {
    if (p.mapId !== 'world' || p.pos.x !== 0 || p.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale (0,0).' };
    const item = p[slot];
    const target = item.tier + 1;
    if (target > 6) return { ok: false, error: 'Tier maximum atteint.' };
    if (p.weaponMastery < target) return { ok: false, error: 'Maîtrise d’arme T' + target + ' requise.' };
    const recipe = UPGRADE_RECIPES[slot][target];
    for (const k in recipe) {
      if ((p.inventory[k] || 0) < recipe[k]) return { ok: false, error: 'Ressources insuffisantes.' };
    }
    for (const k in recipe) {
      p.inventory[k] -= recipe[k];
      if (p.inventory[k] <= 0) delete p.inventory[k];
    }
    item.tier = target;
    if (slot === 'armor') p.hp = Math.min(maxHp(p), p.hp + 15);
    this.notifyAchievements(p, checkAchievements(p, ['Équipement']));
    this.pushSelf(p);
    return { ok: true };
  }

  rest(p) {
    if (p.mapId !== 'world' || p.pos.x !== 0 || p.pos.y !== 0) return { ok: false, error: 'Vous devez être à la Capitale.' };
    p.hp = maxHp(p);
    this.pushSelf(p);
    return { ok: true };
  }

  /* ---------- Cuisine : la Marmite (Capitale + villages) ---------- */
  cook(p, item, tier) {
    tier = Math.floor(Number(tier));
    if (!CONSUMABLES[item]) return { ok: false, error: 'Recette inconnue.' };
    if (!(tier >= 1 && tier <= 6)) return { ok: false, error: 'Tier invalide.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (!this.atSanctuaryPlayer(p)) return { ok: false, error: 'La Marmite se trouve à la Capitale et dans les villages.' };

    const recipe = CONSUMABLE_RECIPES[tier];
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') {
        if ((p.gold || 0) < n) return { ok: false, error: 'Pas assez d’or (' + n + ' 🪙 requis).' };
      } else if ((p.inventory[k] || 0) < n) {
        const r = parseStackKey(k);
        return { ok: false, error: 'Il manque : ' + n + '× ' + resourceLabel(r.type, r.tier) + '.' };
      }
    }
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') p.gold -= n;
      else {
        p.inventory[k] -= n;
        if (p.inventory[k] <= 0) delete p.inventory[k];
      }
    }
    const key = stackKey(item, tier);
    p.inventory[key] = (p.inventory[key] || 0) + 1;
    this.plog(p, CONSUMABLES[item].icon + ' ' + CONSUMABLES[item].label + ' T' + tier + ' cuisiné !');
    return { ok: true };
  }

  /* Ingénierie de siège : fabrication à la Capitale (comme la Forge), avant
   * de partir en guerre — voir deploySiegeEngine pour l'utilisation en siège. */
  craftSiegeEngine(p, tier) {
    tier = Math.floor(Number(tier));
    const recipe = SIEGE_ENGINE_RECIPES[tier];
    if (!recipe) return { ok: false, error: 'Tier d’engin invalide.' };
    if (p.status !== 'IDLE') return { ok: false, error: 'Action en cours…' };
    if (p.mapId !== 'world' || p.pos.x !== 0 || p.pos.y !== 0) return { ok: false, error: 'Les engins de siège se fabriquent à la Capitale.' };
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') {
        if ((p.gold || 0) < n) return { ok: false, error: 'Pas assez d’or (' + n + ' 🪙 requis).' };
      } else if ((p.inventory[k] || 0) < n) {
        const r = parseStackKey(k);
        return { ok: false, error: 'Il manque : ' + n + '× ' + resourceLabel(r.type, r.tier) + '.' };
      }
    }
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') p.gold -= n;
      else {
        p.inventory[k] -= n;
        if (p.inventory[k] <= 0) delete p.inventory[k];
      }
    }
    const key = stackKey(SIEGE_ENGINE_ITEM, tier);
    p.inventory[key] = (p.inventory[key] || 0) + 1;
    this.plog(p, '⚙ Engin de siège T' + tier + ' construit !');
    this.pushSelf(p);
    return { ok: true };
  }

  consume(p, key) {
    const parsed = parseStackKey(String(key));
    const item = CONSUMABLES[parsed.type];
    if (!item) return { ok: false, error: 'Objet inconnu.' };
    if ((p.inventory[key] || 0) < 1) return { ok: false, error: 'Vous n’en avez plus.' };

    p.inventory[key] -= 1;
    if (p.inventory[key] <= 0) delete p.inventory[key];

    if (item.kind === 'instant') {
      const heal = Math.round(maxHp(p) * CONSUMABLE_EFFECTS[parsed.type][parsed.tier]);
      p.hp = Math.min(maxHp(p), p.hp + heal);
      this.toast(p, item.icon + ' +' + heal + ' PV');
    } else {
      p.buff = { type: parsed.type, tier: parsed.tier, combats: BUFF_COMBATS };
      this.toast(p, item.icon + ' ' + item.label + ' T' + parsed.tier + ' actif (' + BUFF_COMBATS + ' combats)');
      // Le % de victoire du lobby en cours (raid ou siège) reflétera le buff au
      // prochain broadcast périodique de raidsPayload() (toutes les 500 ms).
    }
    return { ok: true };
  }

  setAdminTier(p, kind, tier) {
    if (!p || p.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    return this.applyLevelTier(p, kind, tier);
  }

  applyLevelTier(p, kind, tier) {
    const target = Math.max(1, Math.min(6, Number(tier) || 1));
    if (kind === 'harvest') {
      p.harvestLevel = target;
      p.harvestXp = target >= 6 ? XP_LEVELS[XP_LEVELS.length - 1] : XP_LEVELS[target - 1];
      this.pushSelf(p);
      return { ok: true };
    }
    if (kind === 'weapon') {
      p.weaponMastery = target;
      p.weaponXp = target >= 6 ? XP_LEVELS[XP_LEVELS.length - 1] : XP_LEVELS[target - 1];
      this.pushSelf(p);
      return { ok: true };
    }
    return { ok: false, error: 'Catégorie admin inconnue.' };
  }

  setAdminGear(p, slot, tier) {
    if (!p || p.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    return this.applyGearTier(p, slot, tier);
  }

  applyGearTier(p, slot, tier) {
    const target = Math.max(0, Math.min(6, Number(tier) || 0));
    if (slot === 'weapon') {
      p.weapon.tier = target;
      this.pushSelf(p);
      return { ok: true };
    }
    if (slot === 'armor') {
      p.armor.tier = target;
      p.hp = Math.min(p.hp, maxHp(p));
      this.pushSelf(p);
      return { ok: true };
    }
    return { ok: false, error: 'Équipement admin inconnu.' };
  }

  adminSpawnBoss(p) {
    const map = this.mapOf(p.mapId || 'world');
    if (!map || map.kind !== 'dungeon' || !map.dungeon) return { ok: false, error: 'Vous devez être dans un donjon.' };
    const state = map.dungeon;
    const bossTile = map.tiles.get(state.bossTileKey);
    if (!bossTile) return { ok: false, error: 'Boss introuvable.' };
    state.kills = state.killsRequired;
    state.bossAlive = true;
    bossTile.content = { ...state.bossTemplate };
    this.pushMapState(map.id);
    this.pushSelf(p);
    return { ok: true };
  }

  dev(p, action) {
    if (!p || p.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    if (action && action.reset) {
      this.players.delete(p.id);
      if (p.token) this.tokens.delete(p.token);
      return { ok: true, reset: true };
    }
    if (action && action.pa) {
      p.pa = Math.min(CONFIG.PA.MAX, p.pa + Number(action.pa || 0));
      this.pushSelf(p);
      return { ok: true };
    }
    if (action && action.spawnBoss) return this.adminSpawnBoss(p);
    if (action && action.spawnWorldBoss) return this.adminSpawnWorldBoss(p);
    if (action && action.speed) {
      this.speed = Math.max(1, Number(action.speed) || 1);
      return { ok: true };
    }
    if (action && action.wildReset) return this.redistributeWildlife();
    return { ok: false, error: 'Action dev inconnue.' };
  }

  /* ---------- Administration (rôle admin uniquement) ---------- */
  adminFindTarget(username) {
    return this.players.get('p_' + String(username || '').trim().toLowerCase()) || null;
  }

  adminStats() {
    const players = [...this.players.values()];
    const byClass = {};
    for (const p of players) byClass[p.speciesClass] = (byClass[p.speciesClass] || 0) + 1;
    return {
      total: players.length,
      online: players.filter((p) => p.online).length,
      admins: players.filter((p) => p.role === 'admin').length,
      byClass,
    };
  }

  adminPlayerList() {
    return [...this.players.values()].map((p) => ({
      username: p.username,
      role: p.role || 'user',
      online: !!p.online,
      createdAt: (this.credentials.get(p.id) || {}).createdAt || null,
      speciesClass: p.speciesClass,
      classLabel: (CLASSES[p.speciesClass] || {}).label || p.speciesClass,
      harvestLevel: p.harvestLevel,
      weaponMastery: p.weaponMastery,
      weaponTier: p.weapon ? p.weapon.tier : null,
      armorTier: p.armor ? p.armor.tier : null,
      gold: p.gold || 0,
      premium: p[PREMIUM_CURRENCY.key] || 0,
      charSlots: p.charSlots,
      charCount: (p.characters || []).length,
      ownedAccessories: p.ownedAccessories || [],
      accessoryId: p.accessoryId || null,
      ownedMounts: p.ownedMounts || [],
      mountId: p.mountId || null,
    })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  adminDeleteAccount(admin, username) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === admin.id) return { ok: false, error: 'Impossible de supprimer votre propre compte.' };
    if (target.tradeId) this.cancelTrade(target);
    if (target.guildId) this.leaveGuild(target);
    // Prévenu AVANT d'être effacé de this.players — sinon le prochain envoi
    // (pushSelf, toast…) déclenché par leaveGuild plus haut ne trouverait
    // plus personne à qui parler, mais l'évènement de déconnexion forcée,
    // lui, doit bien lui parvenir en dernier pour ramener son client à
    // l'écran de connexion (voir js/net.js + js/main.js).
    if (target.online) this.send(target.id, 'accountDeleted', {});
    if (target.token) this.tokens.delete(target.token);
    this.players.delete(target.id);
    this.credentials.delete(target.id);
    this.onAccountDeleted(target.id);
    return { ok: true };
  }

  // Rejoindre n'importe quel joueur connecté (support/modération) — même
  // principe que joinFriend, en plus permissif : pas besoin d'être amis, et
  // autorisé même si la cible est en donjon (l'admin n'a pas besoin d'avoir
  // découvert ce donjon lui-même, contrairement à un joueur normal).
  adminJoinPlayer(admin, username) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    if (target.id === admin.id) return { ok: false, error: 'Vous êtes déjà ce joueur.' };
    if (!target.online) return { ok: false, error: target.username + ' n’est pas en ligne.' };
    this.resetTravelState(admin);
    const targetMapId = target.mapId || 'world';
    admin.mapId = targetMapId;
    admin.pos = this.nearestWalkablePos(this.mapOf(targetMapId), target.pos);
    this.pushMap(admin);
    this.pushSelf(admin);
    this.toast(admin, 'Vous avez rejoint ' + target.username + '.');
    return { ok: true };
  }

  adminSpawnWorldBoss(p) {
    if (!p || p.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    if (this.worldBossAlive) return { ok: false, error: 'Le Wyrm Ancestral est déjà réveillé.' };
    this.worldBossAlive = true;
    this.onWorldBossDirty();
    this.worldNotify('🐉 Le Wyrm Ancestral a été réveillé (admin).');
    return { ok: true };
  }

  adminSetRole(admin, username, role) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    if (role !== 'user' && role !== 'admin') return { ok: false, error: 'Rôle invalide.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    target.role = role;
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantSlot(admin, username, count) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const current = target.charSlots || CONFIG.FREE_CHAR_SLOTS;
    if (current >= MAX_CHAR_SLOTS) return { ok: false, error: 'Déjà au maximum (' + MAX_CHAR_SLOTS + ' — une par classe).' };
    const n = Math.max(1, Math.min(10, Math.floor(Number(count)) || 1));
    target.charSlots = Math.min(MAX_CHAR_SLOTS, current + n);
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantGold(admin, username, amount) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const n = Math.floor(Number(amount)) || 0;
    target.gold = Math.max(0, (target.gold || 0) + n);
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantPremium(admin, username, amount) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const n = Math.floor(Number(amount)) || 0;
    target[PREMIUM_CURRENCY.key] = Math.max(0, (target[PREMIUM_CURRENCY.key] || 0) + n);
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantItem(admin, username, key, qty) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const parsed = parseStackKey(String(key));
    if (!RESOURCES[parsed.type] && !CONSUMABLES[parsed.type]) return { ok: false, error: 'Objet inconnu.' };
    const n = Math.max(1, Math.min(999, Math.floor(Number(qty)) || 1));
    target.inventory[key] = (target.inventory[key] || 0) + n;
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantAccessory(admin, username, accessoryId) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const id = String(accessoryId || '');
    if (!ACCESSORY_ITEMS[id]) return { ok: false, error: 'Accessoire inconnu.' };
    if (!target.ownedAccessories.includes(id)) target.ownedAccessories.push(id);
    target.accessoryId = id;
    this.pushSelf(target);
    return { ok: true };
  }

  adminGrantMount(admin, username, mountId) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    const id = String(mountId || '');
    if (!MOUNT_ITEMS[id]) return { ok: false, error: 'Monture inconnue.' };
    if (!target.ownedMounts.includes(id)) target.ownedMounts.push(id);
    target.mountId = id;
    this.pushSelf(target);
    return { ok: true };
  }

  adminSetLevel(admin, username, kind, tier) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    return this.applyLevelTier(target, kind, tier);
  }

  adminSetGear(admin, username, slot, tier) {
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé aux administrateurs.' };
    const target = this.adminFindTarget(username);
    if (!target) return { ok: false, error: 'Joueur introuvable.' };
    return this.applyGearTier(target, slot, tier);
  }

  say(p, text, channel, targetUsername) {
    text = String(text || '').trim().slice(0, 120);
    if (!text) return { ok: false, error: 'Message vide.' };
    channel = (channel === 'guild' || channel === 'whisper') ? channel : 'general';

    if (channel === 'guild') {
      const guild = this.guildOf(p);
      if (!guild) return { ok: false, error: 'Vous n’êtes pas dans une guilde.' };
      const payload = { from: p.username, text, type: 'chat', channel: 'guild' };
      this.recordChat({ ...payload, fromId: p.id, guildId: guild.id });
      for (const id of guild.members) {
        const m = this.players.get(id);
        if (m && m.online) this.send(m.id, 'chat', payload);
      }
      return { ok: true };
    }

    if (channel === 'whisper') {
      const target = this.findAccountByUsername(targetUsername);
      if (!target || target.bot) return { ok: false, error: 'Joueur introuvable.' };
      if (target.id === p.id) return { ok: false, error: 'Impossible de vous écrire à vous-même.' };
      if (!p.friends.includes(target.id)) return { ok: false, error: 'Les messages privés sont réservés à vos amis.' };
      const payload = { from: p.username, to: target.username, text, type: 'chat', channel: 'whisper' };
      this.recordChat({ ...payload, fromId: p.id, toId: target.id });
      this.send(p.id, 'chat', payload);
      if (target.online) this.send(target.id, 'chat', payload);
      else this.sendPush(target.id, '💬 ' + p.username, text.length > 120 ? text.slice(0, 117) + '…' : text);
      return { ok: true, offline: !target.online };
    }

    const generalPayload = { from: p.username, text, type: 'chat', channel: 'general' };
    this.recordChat({ ...generalPayload, fromId: p.id });
    this.broadcast('chat', generalPayload);
    if (Math.random() < 0.5) {
      const bots = [...this.bots.values()];
      const bot = bots[Math.floor(Math.random() * bots.length)];
      this.pendingReplies.push({
        at: this.now + 1500 + Math.random() * 3500,
        msg: { from: bot.username, text: BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)], type: 'chat', channel: 'general' },
      });
    }
    return { ok: true };
  }

  checkLevelUp(p, kind) {
    if (kind === 'harvest') {
      const lvl = levelFromXp(p.harvestXp);
      if (lvl > p.harvestLevel) p.harvestLevel = lvl;
    } else {
      const lvl = levelFromXp(p.weaponXp);
      if (lvl > p.weaponMastery) p.weaponMastery = lvl;
    }
  }

  botThink(bot) {
    if (bot.status !== 'IDLE' || bot.mapId !== 'world') return;
    for (const raid of this.raids.values()) {
      if (raid.mapId !== 'world') continue;
      const tile = this.worldMap.tiles.get(raid.tileKey);
      const d = this.chebyshev(bot.pos, tile);
      if (d <= CONFIG.JOIN_RADIUS + 5 && this.teamForce(raid) < raid.monsterForce * 1.15) {
        if (d <= CONFIG.JOIN_RADIUS) { this.botJoinRaid(bot, raid); return; }
        this.botStepToward(bot, tile.x, tile.y);
        return;
      }
    }
    if (Math.random() < 0.25) return;
    const tx = bot.home.x + Math.round((Math.random() - 0.5) * 12);
    const ty = bot.home.y + Math.round((Math.random() - 0.5) * 12);
    this.botStepToward(bot, tx, ty);
  }

  botStepToward(bot, tx, ty) {
    const dx = Math.sign(tx - bot.pos.x);
    const dy = Math.sign(ty - bot.pos.y);
    const options = [[dx, dy], [dx, 0], [0, dy]].filter(([a, b]) => a || b);
    for (const [a, b] of options) {
      if (isWalkable(this.worldMap.tiles, bot.pos.x + a, bot.pos.y + b)) {
        bot.pos = { x: bot.pos.x + a, y: bot.pos.y + b };
        return;
      }
    }
  }

  serialize() {
    const credentials = {};
    for (const [id, cred] of this.credentials) credentials[id] = cred;
    return {
      seed: this.seed,
      now: this.now,
      speed: this.speed,
      players: [...this.players.values()],
      credentials,
      guilds: [...this.guilds.values()],
      castles: [...this.castles.values()],
      chatLog: this.chatLog,
      mapDiffs: this.mapDiffs(),
      mapStates: this.mapStates(),
      worldDiffs: this.worldDiffs(),
      wildSalt: this.wildSalt,
      worldBossAlive: this.worldBossAlive,
      worldBossNextSpawnAt: this.worldBossNextSpawnAt,
      savedAt: Date.now(),
    };
  }

  load(data) {
    this.now = data.now || 0;
    this.speed = data.speed || 1;
    for (const p of data.players || []) {
      p.online = false;
      p.status = 'IDLE';
      p.harvestKey = null;
      p.raidKey = null;
      p.tradeId = null;
      if (!Array.isArray(p.characters) || !p.characters.length) {
        const c = {};
        for (const f of CHARACTER_FIELDS) c[f] = p[f];
        p.characters = [c];
        p.activeChar = 0;
      }
      if (!p.mapId) p.mapId = 'world';
      if (typeof p.charSlots !== 'number') p.charSlots = CONFIG.FREE_CHAR_SLOTS;
      p.charSlots = Math.min(p.charSlots, MAX_CHAR_SLOTS);
      if (typeof p.gold !== 'number') p.gold = 0;
      if (typeof p[PREMIUM_CURRENCY.key] !== 'number') p[PREMIUM_CURRENCY.key] = 0;
      if (!Array.isArray(p.pushSubscriptions)) p.pushSubscriptions = [];
      if (typeof p.pushPaFullAt === 'undefined') p.pushPaFullAt = null;
      if (typeof p.pushPaFullSent !== 'boolean') p.pushPaFullSent = false;
      if (!Array.isArray(p.ownedSkins)) p.ownedSkins = [];
      if (!Array.isArray(p.ownedAccessories)) p.ownedAccessories = [];
      if (typeof p.accessoryId !== 'string') p.accessoryId = null;
      if (!Array.isArray(p.visitedVillages)) p.visitedVillages = [];
      if (!Array.isArray(p.exploredWorld)) p.exploredWorld = [];
      if (p.role !== 'admin' && p.role !== 'user') p.role = 'user';
      if (!p.duels || typeof p.duels.wins !== 'number') p.duels = { wins: 0, losses: 0 };
      if (typeof p.guildId !== 'string') p.guildId = null;
      if (typeof p.guildName !== 'string') p.guildName = null;
      if (!p.guildInvite || typeof p.guildInvite !== 'object') p.guildInvite = null;
      if (!Array.isArray(p.friends)) p.friends = [];
      if (!Array.isArray(p.friendRequests)) p.friendRequests = [];
      // Comptes créés avant l'ajout de l'OTP par email : pas d'email connu —
      // voir setAccountEmail(), demandé à la prochaine connexion.
      if (typeof p.email !== 'string') p.email = null;
      // Parchemin d'Endurance retiré du jeu (voir Regain) : purge les piles
      // restantes des inventaires existants — sinon un objet fantôme, non
      // reconnu par CONSUMABLES, s'affiche mal dans l'inventaire.
      if (p.inventory) {
        for (const k of Object.keys(p.inventory)) {
          if (k.startsWith('PARCHEMIN_ENDURANCE_')) delete p.inventory[k];
        }
      }
      ensureAchievementState(p);
      // Rééquilibrage des PV par classe : évite qu'un compte existant se
      // retrouve avec plus de PV affichés que son nouveau maximum.
      p.hp = Math.min(p.hp, maxHp(p));
      this.skinStateOf(p);
      this.players.set(p.id, p);
      if (p.token) this.tokens.set(p.token, p.id);
    }
    for (const [id, cred] of Object.entries(data.credentials || {})) this.credentials.set(id, cred);
    for (const g of data.guilds || []) {
      if (g && g.id) this.guilds.set(g.id, g);
    }
    // Rattrapage : comptes de guilde créés avant l'ajout de guildName.
    for (const p of this.players.values()) {
      if (!p.guildName && p.guildId) {
        const g = this.guilds.get(p.guildId);
        if (g) p.guildName = g.name;
      }
    }
    // Rattrapage : ensureAchievementState() (au-dessus) a fixé createdAt à
    // « maintenant » faute de mieux pour les comptes déjà existants, avant
    // que les identifiants (avec leur vraie date d'inscription) soient
    // chargés ci-dessus — on corrige ici avec la date réelle, sinon
    // l'ancienneté d'un compte de plusieurs mois repartirait de zéro.
    for (const p of this.players.values()) {
      const cred = this.credentials.get(p.id);
      if (cred && typeof cred.createdAt === 'number') p.createdAt = cred.createdAt;
    }
    for (const c of data.castles || []) {
      if (c && c.terrain) this.castles.set(c.terrain, c);
    }
    if (Array.isArray(data.chatLog)) this.chatLog = data.chatLog.slice(-CHAT_LOG_MAX);
    // Migration d'une base existante sans rôles : le compte le plus ancien
    // (par date de création) hérite du rôle admin, faute de quoi personne
    // n'aurait accès à l'administration après coup.
    if (this.players.size && ![...this.players.values()].some((p) => p.role === 'admin')) {
      let oldest = null;
      let oldestAt = Infinity;
      for (const p of this.players.values()) {
        const at = (this.credentials.get(p.id) || {}).createdAt;
        if (typeof at === 'number' && at < oldestAt) { oldest = p; oldestAt = at; }
      }
      if (oldest) oldest.role = 'admin';
    }
    for (const [mapId, state] of Object.entries(data.mapStates || {})) {
      const map = this.mapOf(mapId);
      if (!map || map.kind !== 'dungeon' || !map.dungeon) continue;
      map.dungeon.kills = Number(state.kills) || 0;
      map.dungeon.killsRequired = Number(state.killsRequired) || map.dungeon.killsRequired;
      map.dungeon.bossAlive = !!state.bossAlive;
      const bossTile = map.tiles.get(map.dungeon.bossTileKey);
      if (bossTile) bossTile.content = map.dungeon.bossAlive ? { ...map.dungeon.bossTemplate } : null;
    }
    // Rejoue la redistribution nocturne de la faune sauvage déjà survenue
    // avant ce redémarrage (avant les diffs d'inactiveUntil ci-dessous, qui
    // doivent s'appliquer sur la disposition à jour, pas sur celle d'origine).
    this.wildSalt = Number(data.wildSalt) || 0;
    if (this.wildSalt > 0) applyWildLayer(this.worldMap.tiles, this.seed, this.wildSalt);
    this.worldBossAlive = !!data.worldBossAlive;
    this.worldBossNextSpawnAt = typeof data.worldBossNextSpawnAt === 'number' ? data.worldBossNextSpawnAt : Date.now();
    if (data.mapDiffs) {
      for (const [mapId, diffs] of Object.entries(data.mapDiffs || {})) {
        const map = this.mapOf(mapId);
        for (const [key, until] of diffs) {
          const tile = map.tiles.get(key);
          if (tile && tile.content) tile.content.inactiveUntil = until;
        }
      }
    } else {
      for (const [flatKey, until] of data.worldDiffs || []) {
        const sep = String(flatKey).indexOf('|');
        const mapId = sep >= 0 ? flatKey.slice(0, sep) : 'world';
        const key = sep >= 0 ? flatKey.slice(sep + 1) : flatKey;
        const tile = this.mapOf(mapId).tiles.get(key);
        if (tile && tile.content) tile.content.inactiveUntil = until;
      }
    }
  }
}

module.exports = { Game, CHAT_LOG_MAX };
