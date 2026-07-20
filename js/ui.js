'use strict';

/* ============================================================
 * ui.js — HUD, bottom-sheets, popups, toasts, création de perso
 * Tactile first : cibles larges, une main, portrait.
 * ============================================================ */

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Conversion standard clé VAPID (base64url) -> Uint8Array attendu par
// PushManager.subscribe({ applicationServerKey: ... }).
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

class UI {
  constructor(server, renderer) {
    this.server = server;
    this.renderer = renderer;
    this.feed = [];
    this.openSheet = null;
    this.inventorySort = 'type';
    this.adminOpen = false;   // état du <details> admin, survit aux re-rendus
    this.adminExpandedUser = null;   // ligne dépliée dans le dashboard admin, survit aux re-rendus
    this.chatChannel = 'general';   // 'general' | 'guild' | 'whisper', survit aux re-rendus
    this.chatWhisperTarget = null;  // pseudo de l'ami actuellement en conversation privée
    this.chatUnread = { general: false, guild: false, whisper: false };
    this.lastSeenGuildInviteKey = null;
    this.seenFriendRequestKeys = new Set();
    this.onAdminReset = null;
    this.pushSupported = false;   // calculé de façon asynchrone, voir checkPushSupport()
    this.pushSubscribed = false;
    this.checkPushSupport();
    this.combatSwordSrc = 'assets/combat_sword.png';
    this.modalAssetSrc = {
      frame: 'assets/modal_frame_raw.png',
      buttonSecondary: 'assets/modal_button_secondary_raw.png',
      buttonPrimary: 'assets/modal_button_primary_raw.png',
    };
    this.navIconSrc = {
      inventory: 'assets/nav_inventory_raw.png',
      shop: 'assets/nav_shop_raw.png',
      profile: 'assets/nav_profile_raw.png',
      map: 'assets/nav_map_raw.png',
      social: 'assets/nav_social_raw.png',
    };
    this.harvestToolSrc = {
      MINERAI: 'assets/harvest_pickaxe.png',
      BOIS: 'assets/harvest_axe.png',
      PLANTE: 'assets/harvest_sickle.png',
      INGREDIENT: 'assets/harvest_knife.png',
    };
    this.consumableIconSrc = {
      RAGOUT: 'assets/item_ragout_du_chasseur.png',
      BOUILLON: 'assets/item_bouillon_decailles.png',
      POTION_SEVE: 'assets/item_potion_de_seve.png',
      PARCHEMIN_ENDURANCE: 'assets/item_parchemin_endurance.png',
    };
    this.currencyIconSrc = {
      gold: 'assets/currency_gold.png',
      premium: 'assets/currency_moon_scale.png',
    };
    this.harvestFxTimer = null;
    this.inventoryCooldownTimer = null;
    this.popupMode = null;
    this.tradeDraft = null;
    this.tradeUiState = { filter: 'ALL', scrollTop: 0 };
    this.desktopMedia = window.matchMedia('(min-width: 1600px)');
    this.desktopProfileSignature = '';
    this.desktopSocialRequest = 0;

    // Feuille de sprites partagée avec le CSS (avatars DOM).
    // URL absolue obligatoire : une url() relative dans une custom
    // property se résout par rapport à la feuille de style (css/…).
    const spriteSrc = (typeof window !== 'undefined' && window.WILDRIFT_SPRITE) ||
      new URL('assets/personnages_small.png', location.href).href;
    document.documentElement.style.setProperty('--sprite-url', 'url("' + spriteSrc + '")');
    document.documentElement.style.setProperty('--modal-frame-url', 'none');
    document.documentElement.style.setProperty('--modal-button-secondary-url', 'none');
    document.documentElement.style.setProperty('--modal-button-primary-url', 'none');
    document.documentElement.style.setProperty('--nav-icon-inventory-url', 'none');
    document.documentElement.style.setProperty('--nav-icon-shop-url', 'none');
    document.documentElement.style.setProperty('--nav-icon-profile-url', 'none');
    document.documentElement.style.setProperty('--nav-icon-map-url', 'none');
    document.documentElement.style.setProperty('--nav-icon-social-url', 'none');
    this.loadCombatFxAssets();

    $('sheetClose').addEventListener('click', () => this.closeSheet());
    $('lobbyStart').addEventListener('click', async () => {
      const me = this.server.me;
      if (!me || !me.raidKey) return;
      const r = await Promise.resolve(this.server.startRaidNow(me.raidKey));
      if (!r.ok) this.toast(r.error);
    });
    $('lobbyDeployEngine').addEventListener('click', () => this.showDeployEnginePicker());
    $('popup').addEventListener('click', (e) => {
      if (e.target.id === 'popup' && this.popupMode !== 'trade') this.closePopup();
    });
    document.querySelectorAll('#nav button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.panel;
        this.openSheet === name ? this.closeSheet() : this.showSheet(name);
      });
    });
    $('desktopProfileOpen').addEventListener('click', () => this.showSheet('profile'));
    $('desktopMapOpen').addEventListener('click', () => this.showSheet('map'));
    const onDesktopChange = () => this.syncDesktopPanels(true);
    if (this.desktopMedia.addEventListener) this.desktopMedia.addEventListener('change', onDesktopChange);
    else this.desktopMedia.addListener(onDesktopChange);

    server.on('toast', (t) => this.toast(t.text));
    server.on('chat', (msg) => {
      this.pushFeed(msg);
      // Bulle au-dessus de la tête : uniquement le canal Général (le seul
      // « parlé à voix haute » dans le monde), et seulement si l'expéditeur
      // est un vrai joueur actuellement chargé (pas un message système).
      if (msg.type === 'chat' && msg.channel === 'general' && msg.from && this.renderer) {
        this.renderer.showChatBubble(msg.from, msg.text);
      }
    });
    server.on('ready', () => {
      // Historique reçu à la connexion (général vu de tous, guilde courante,
      // MP qui nous concernent) : on le rejoue pour retrouver le fil après
      // une déconnexion. Le simple fait qu'un canal contienne un message
      // d'autrui ne veut pas dire qu'il est NON LU — on compare à la
      // signature du dernier message déjà vu (persistée localement) pour ne
      // signaler que ce qui est vraiment arrivé depuis la dernière lecture,
      // sinon la pastille rouge réapparaît à chaque reconnexion sans raison.
      const history = Array.isArray(this.server.chatHistory) ? this.server.chatHistory.slice(-120) : [];
      this.feed = history.map((m) => ({
        ...m,
        self: !!(m.from && this.server.me && m.from === this.server.me.username),
      }));
      this.chatSeen = this.loadChatSeen();
      for (const ch of ['general', 'guild', 'whisper']) {
        const hasOthers = this.feed.some((m) => m.type === 'chat' && !m.self && (m.channel || 'general') === ch);
        this.chatUnread[ch] = hasOthers && this.chatChannelSignature(ch) !== (this.chatSeen[ch] || '');
      }
      this.updateChatBadges();
      this.syncDesktopPanels(true);
    });
    server.on('result', (r) => this.showResult(r));
    server.on('siegeResult', (r) => this.showSiegeResult(r));
    server.on('tradeInvite', (invite) => this.showTradeInvite(invite));
    server.on('duelInvite', (invite) => this.showDuelInvite(invite));
    server.on('duelResult', (r) => this.showDuelResult(r));
    server.on('achievementUnlocked', (a) => this.showAchievementUnlocked(a));
    server.on('trade', (trade) => {
      if (trade) {
        this.tradeDraft = {
          id: trade.id,
          gold: (trade.offers && trade.offers.self && trade.offers.self.gold) || 0,
          items: { ...(((trade.offers && trade.offers.self) || {}).items || {}) },
        };
        this.showTradePopup(trade);
      } else {
        this.tradeDraft = null;
        if (this.popupMode === 'trade') this.closePopup();
      }
    });
    server.on('self', () => {
      this.updateDesktopProfile();
      if (this.openSheet === 'inventory') this.showSheet('inventory');
      if (this.openSheet === 'shop') this.showSheet('shop');
      if (this.openSheet === 'profile') this.showSheet('profile');
      if (this.openSheet === 'capital') this.showSheet('capital');
      if (this.openSheet === 'marmite') this.showSheet('marmite');
      // Re-rendu complet sauf si l'utilisateur est en train de saisir du texte
      // (message, nom de guilde, pseudo…) — sinon le rafraîchissement
      // périodique de self l'effacerait en pleine frappe. Et même quand on
      // rafraîchit, on restaure le défilement pour ne pas ramener en haut
      // quelqu'un qui lisait le fil ou la liste des membres.
      if (this.openSheet === 'social') {
        const sheetBody = $('sheetBody');
        const active = document.activeElement;
        const isTyping = sheetBody && active && sheetBody.contains(active) &&
          (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA');
        if (!isTyping) {
          // build_social est asynchrone (fetch guilde/amis) : on ne peut pas
          // restaurer le défilement juste après l'appel, il faut le faire à
          // la fin du rendu réel (renderSocial), une fois le contenu repeuplé.
          this.pendingSocialScrollTop = sheetBody ? sheetBody.scrollTop : null;
          this.showSheet('social');
        }
      }
      if (this.popupMode === 'trade' && this.server.trade) this.showTradePopup(this.server.trade);
    });
    server.on('self', (p) => {
      if (p && p.guildInvite) {
        const key = p.guildInvite.guildId + '|' + p.guildInvite.at;
        if (key !== this.lastSeenGuildInviteKey) {
          this.lastSeenGuildInviteKey = key;
          this.toast('🏰 ' + p.guildInvite.fromUsername + ' vous invite dans « ' + p.guildInvite.guildName + ' ».');
        }
      } else {
        this.lastSeenGuildInviteKey = null;
      }
      if (p && Array.isArray(p.friendRequests)) {
        for (const r of p.friendRequests) {
          const key = r.fromId + '|' + r.at;
          if (!this.seenFriendRequestKeys.has(key)) {
            this.seenFriendRequestKeys.add(key);
            this.toast('👥 ' + r.fromUsername + ' vous a envoyé une demande d’ami.');
          }
        }
      }
    });
  }

  /* ---------- Notifications push (Endurance pleine, siège, ami, MP) ---------- */
  async checkPushSupport() {
    this.pushSupported = !!(this.server.remote && typeof Notification !== 'undefined' &&
      'serviceWorker' in navigator && 'PushManager' in window);
    if (!this.pushSupported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      this.pushSubscribed = !!sub;
    } catch (e) { this.pushSubscribed = false; }
    if (this.openSheet === 'profile') this.showSheet('profile');
  }

  async togglePushNotifications() {
    if (!this.pushSupported) return;
    try {
      if (this.pushSubscribed) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await Promise.resolve(this.server.unsubscribePush(sub.endpoint));
          await sub.unsubscribe();
        }
        this.pushSubscribed = false;
        this.toast('🔕 Notifications désactivées.');
      } else {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { this.toast('Permission refusée par le navigateur.'); return; }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        const r = await Promise.resolve(this.server.subscribePush(sub.toJSON()));
        if (!r.ok) { this.toast(r.error || 'Erreur serveur.'); return; }
        this.pushSubscribed = true;
        this.toast('🔔 Notifications activées.');
      }
    } catch (e) {
      this.toast('Impossible de modifier les notifications.');
    }
    if (this.openSheet === 'profile') this.showSheet('profile');
  }

  /* ---------- % de victoire : classes de couleur + rendu ---------- */
  chanceClass(chance) {
    if (chance >= 0.75) return 'chance-good';
    if (chance >= 0.4) return 'chance-mid';
    return 'chance-bad';
  }

  chanceHtml(chance) {
    return '<b class="' + this.chanceClass(chance) + '">' + Math.round(chance * 100) + ' %</b>';
  }

  terrainLabel(terrain) {
    return {
      FORET: 'Forêt',
      PLAINE: 'Plaine',
      MONTAGNE: 'Montagne',
      MARECAGE: 'Marécage',
    }[terrain] || terrain;
  }

  directionLabel(x, y) {
    if (x === 0 && y === 0) return 'Centre';
    if (Math.abs(x) >= Math.abs(y)) return x > 0 ? 'Est' : 'Ouest';
    return y > 0 ? 'Sud' : 'Nord';
  }

  listVillageDestinations(currentTile) {
    const out = [{
      label: 'Capitale',
      x: 0,
      y: 0,
      kind: 'capital',
      meta: 'Hub central',
    }];

    const visited = new Set((this.server.me && this.server.me.visitedVillages) || []);
    for (const tile of this.server.tiles.values()) {
      if (!tile.content || tile.content.kind !== 'village') continue;
      if (!visited.has(tileKey(tile.x, tile.y))) continue;   // à découvrir à pied
      if (currentTile && tile.x === currentTile.x && tile.y === currentTile.y) continue;
      out.push({
        label: tile.content.name || ('Village ' + this.terrainLabel(tile.terrain)),
        x: tile.x,
        y: tile.y,
        kind: 'village',
        terrain: tile.terrain,
        tier: tile.content.tier,
        meta: this.terrainLabel(tile.terrain) + ' · ' + this.directionLabel(tile.x, tile.y) + ' · T' + tile.content.tier,
      });
    }

    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'capital' ? -1 : 1;
      return Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y);
    });
    return out;
  }

  showVillagePopup(tile) {
    const destinations = this.listVillageDestinations(tile);
    const wrap = $('popup');
    wrap.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'popup-card';
    card.innerHTML =
      '<h3>Village</h3>' +
      '<div class="popup-body">' +
        '<p>Depuis ' + esc(tile.content.name || 'ce village') + ', vous pouvez voyager instantanément vers un autre village ou la Capitale.</p>' +
        '<div id="villageTravelList" class="stacks"></div>' +
      '</div>';

    const list = document.createElement('div');
    list.className = 'stacks';

    for (const dest of destinations) {
      const btn = document.createElement('button');
      btn.className = 'travel-choice' + (dest.kind === 'capital' ? ' capital' : '');
      btn.innerHTML =
        '<span class="travel-choice-title">' + esc(dest.label) + '</span>' +
        '<span class="travel-choice-meta">' + esc(dest.meta) + ' · (' + dest.x + ', ' + dest.y + ')</span>';
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.teleportVillage(dest.x, dest.y));
        if (!r.ok) this.toast(r.error);
        else this.closePopup();
      });
      list.appendChild(btn);
    }

    const closeRow = document.createElement('div');
    closeRow.className = 'popup-actions';
    const marmiteBtn = document.createElement('button');
    marmiteBtn.className = 'btn primary';
    marmiteBtn.textContent = '🍲 Marmite';
    marmiteBtn.addEventListener('click', () => { this.closePopup(); this.showSheet('marmite'); });
    closeRow.appendChild(marmiteBtn);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Fermer';
    closeBtn.addEventListener('click', () => this.closePopup());
    closeRow.appendChild(closeBtn);

    card.querySelector('#villageTravelList').replaceWith(list);
    card.appendChild(closeRow);
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
  }

  showFastTravelPopupFromCapital() {
    const destinations = this.listVillageDestinations(null).filter((d) => !(d.kind === 'capital' && d.x === 0 && d.y === 0));
    const wrap = $('popup');
    wrap.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'popup-card';
    card.innerHTML =
      '<h3>Téléporteurs</h3>' +
      '<div class="popup-body">' +
        '<p>Depuis la Capitale, vous pouvez rejoindre n’importe quel village découvert du monde.</p>' +
        '<div id="capitalTravelList"></div>' +
      '</div>';

    const list = document.createElement('div');
    list.className = 'stacks';
    for (const dest of destinations) {
      const btn = document.createElement('button');
      btn.className = 'travel-choice' + (dest.kind === 'capital' ? ' capital' : '');
      btn.innerHTML =
        '<span class="travel-choice-title">' + esc(dest.label) + '</span>' +
        '<span class="travel-choice-meta">' + esc(dest.meta) + ' · (' + dest.x + ', ' + dest.y + ')</span>';
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.teleportVillage(dest.x, dest.y));
        if (!r.ok) this.toast(r.error);
        else this.closePopup();
      });
      list.appendChild(btn);
    }
    card.querySelector('#capitalTravelList').replaceWith(list);

    const closeRow = document.createElement('div');
    closeRow.className = 'popup-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Fermer';
    closeBtn.addEventListener('click', () => this.closePopup());
    closeRow.appendChild(closeBtn);
    card.appendChild(closeRow);

    wrap.appendChild(card);
    wrap.classList.remove('hidden');
  }

showDungeonPopup(tile, onEnter) {
    const terrain = this.terrainLabel(tile.terrain);
    this.popup(
      'Donjon ' + terrain,
      '<p>Entrée détectée en biome <b>' + terrain + '</b>.</p>' +
      '<p class="dim">Ce donjon mène vers une carte partagée avec couloirs, monstres T6, boss de biome et ressource spéciale.</p>',
      [
        { label: 'Fermer' },
        {
          label: 'Entrer',
          primary: true,
          cb: () => { if (onEnter) onEnter(); }
        },
      ]
    );
  }

  async showCastlePopup(tile) {
    const me = this.server.me;
    const terrain = tile.terrain;
    const terrainName = this.terrainLabel(terrain);
    this.popup('Château — ' + terrainName, '<p class="dim">Chargement…</p>', [{ label: 'Fermer' }], { mode: 'castle' });
    const res = await Promise.resolve(this.server.castlesInfo());
    if (this.popupMode !== 'castle') return;   // fermé entre-temps
    const list = (res && res.ok) ? res.list : [];
    if (this.renderer && typeof this.renderer.setCastleInfo === 'function') {
      this.renderer.setCastleInfo(list);
    }
    const c = list.find((x) => x.terrain === terrain) ||
      { terrain, ownerGuildId: null, ownerGuildName: null, hp: 0, hpMax: 0, level: 0, maxLevel: CASTLE_MAX_LEVEL, fortLevel: 0, maxFortLevel: CASTLE_MAX_FORT_LEVEL, isOwnGuild: false };

    const pct = c.hpMax ? Math.max(0, Math.min(100, Math.round(100 * c.hp / c.hpMax))) : 0;
    const bonusPct = Math.round((CASTLE_ZONE_GOLD_BONUS - 1) * 100);
    const resType = CASTLE_TERRAIN_RESOURCE[terrain];
    const siegeKey = 'siege:' + terrain;
    const activeSiege = (me.guildId && c.ownerGuildId) ? this.server.raids.get(siegeKey) : null;
    const alreadyInSiege = !!(activeSiege && me.raidKey === siegeKey);

    const statusHtml =
      (c.ownerGuildName
        ? '<p>Tenu par <b>' + esc(c.ownerGuildName) + '</b></p>' +
          '<div class="castle-badges">' +
            '<span class="tier t' + c.level + '">Niveau ' + c.level + ' / ' + c.maxLevel + '</span>' +
            (c.fortLevel ? '<span class="tier t' + c.fortLevel + '">🛡 Fortification ' + c.fortLevel + ' / ' + c.maxFortLevel + '</span>' : '') +
          '</div>' +
          '<div class="xp-track"><div class="xp-fill" style="width:' + pct + '%"></div></div>' +
          '<p class="dim small">' + c.hp + ' / ' + c.hpMax + ' points de structure</p>'
        : '<p class="dim">Libre — aucune guilde ne le tient.</p>') +
      '<p class="dim small">Le tenir offre à la guilde +' + bonusPct + ' % d’or sur toute la zone ' + terrainName + '.</p>';

    let costHtml = '';
    if (!me.guildId) {
      costHtml = '<p class="hp-c small">Rejoignez une guilde pour revendiquer, renforcer ou assiéger un château.</p>';
    } else if (!c.ownerGuildId) {
      costHtml = '<p class="dim small">Fondation : ' + CASTLE_CLAIM_COST_GOLD + ' ' + this.currencyIcon('gold', 'small') + ' (contribution personnelle).</p>';
    } else if (c.isOwnGuild) {
      costHtml = this.castleReinforceCardHtml(c, resType) +
        this.castleRepairCardHtml(c, resType) +
        this.castleFortifyCardHtml(c, resType);
    }

    const secsLeftSiege = activeSiege ? Math.max(0, Math.ceil((activeSiege.endsAt - this.server.now) / 1000)) : 0;
    const siegeHtml = !activeSiege ? '' : c.isOwnGuild
      ? '<p class="hp-c small"><b>🛡 Vous êtes assiégés !</b> ' + activeSiege.participants.length + ' assaillant(s) — ' +
        this.chanceHtml(1 - this.server.raidChance(activeSiege)) + ' de chances de tenir — résolution dans ' + secsLeftSiege + ' s. ' +
        'Restez sur la tuile du château pour renforcer la défense.</p>'
      : '<p class="dim small">' + (alreadyInSiege ? 'Vous participez au siège en cours' : 'Siège en cours') + ' — ' +
        activeSiege.participants.length + ' assaillant(s) — ' + this.chanceHtml(this.server.raidChance(activeSiege)) + ' de victoire — résolution dans ' +
        secsLeftSiege + ' s.</p>';

    const actions = [{ label: 'Fermer' }];
    if (me.guildId && !c.ownerGuildId) {
      actions.unshift({
        label: 'Revendiquer',
        primary: true,
        cb: async () => {
          const r = await Promise.resolve(this.server.claimCastle(terrain));
          if (r.ok && this.renderer) this.renderer.refreshCastleLevels();
          this.toast(r.ok ? 'Château fondé !' : r.error);
        },
      });
    } else if (me.guildId && c.ownerGuildId && !c.isOwnGuild && !alreadyInSiege) {
      actions.unshift({
        label: activeSiege ? 'Rejoindre le siège' : '⚔ Lancer le siège',
        primary: true,
        cb: async () => {
          const r = await Promise.resolve(this.server.assaultCastle(terrain));
          if (r.ok && this.renderer) this.renderer.refreshCastleLevels();
          if (!r.ok) { this.toast(r.error); return; }
          this.toast(activeSiege
            ? 'Vous rejoignez le siège en cours.'
            : '⚔ Siège lancé — ralliez vos alliés avant la résolution (30 s).');
        },
      });
    }

    this.popup('Château — ' + terrainName, statusHtml + costHtml + siegeHtml, actions, { mode: 'castle' });

    if (c.isOwnGuild) {
      $('popup').querySelectorAll('[data-castle-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.castleAction;
          let r;
          if (action === 'reinforce') r = await Promise.resolve(this.server.reinforceCastle(terrain));
          else if (action === 'repair') r = await Promise.resolve(this.server.repairCastle(terrain, me.gold));
          else if (action === 'fortify') r = await Promise.resolve(this.server.fortifyCastle(terrain));
          if (!r) return;
          if (r.ok && this.renderer) this.renderer.refreshCastleLevels();
          if (action === 'reinforce') this.toast(r.ok ? ('Château renforcé (niveau ' + r.level + ').') : r.error);
          else if (action === 'repair') this.toast(r.ok ? ('Réparé de ' + r.healed + ' PS pour ' + r.cost + ' 🪙 + ' + r.resourceCost + '× ' + resourceLabel(r.resourceType, r.resourceTier) + '.') : r.error);
          else if (action === 'fortify') this.toast(r.ok ? ('Fortifications renforcées (niveau ' + r.fortLevel + ').') : r.error);
          if (r.ok) this.showCastlePopup(tile);
        });
      });
    }
  }

  castleReinforceCardHtml(c, resType) {
    const me = this.server.me;
    if (c.level >= c.maxLevel) {
      return '<div class="upg"><div class="upg-head"><b>⚒ Renfort</b><span class="tier t' + c.maxLevel + '">Niveau max</span></div></div>';
    }
    const next = c.level + 1;
    const recipe = CASTLE_REINFORCE_RESOURCES[next];
    const haveGold = me.gold || 0;
    const goldOk = haveGold >= CASTLE_REINFORCE_COST_GOLD;
    const haveRes = me.inventory[stackKey(resType, recipe.tier)] || 0;
    const resOk = haveRes >= recipe.qty;
    return '<div class="upg">' +
      '<div class="upg-head"><b>⚒ Renfort</b><span><span class="tier t' + c.level + '">' + c.level + '</span> → <span class="tier t' + next + '">' + next + '</span></span></div>' +
      '<ul class="upg-needs">' +
        '<li class="' + (goldOk ? 'ok-c' : 'hp-c') + '">' + CASTLE_REINFORCE_COST_GOLD + ' ' + this.currencyIcon('gold', 'small') + ' <span class="dim">(' + haveGold + ')</span></li>' +
        '<li class="' + (resOk ? 'ok-c' : 'hp-c') + '">' + recipe.qty + '× ' + esc(resourceLabel(resType, recipe.tier)) + ' <span class="dim">(' + haveRes + ')</span></li>' +
      '</ul>' +
      '<button class="btn primary wide" data-castle-action="reinforce"' + ((goldOk && resOk) ? '' : ' disabled') + '>⚒ Renforcer</button>' +
    '</div>';
  }

  castleRepairCardHtml(c, resType) {
    const me = this.server.me;
    const missing = c.hpMax - c.hp;
    if (missing <= 0) {
      return '<div class="upg"><div class="upg-head"><b>🔧 Réparation</b><span class="dim small">structure intacte</span></div></div>';
    }
    const repairTier = castleRepairResourceTier(c.level);
    const haveGold = me.gold || 0;
    const haveRes = me.inventory[stackKey(resType, repairTier)] || 0;
    const fullGoldCost = missing * CASTLE_REPAIR_GOLD_PER_HP;
    const fullResCost = Math.ceil(missing / CASTLE_REPAIR_HP_PER_RESOURCE);
    const preview = Math.max(0, Math.min(missing, Math.floor(haveGold / CASTLE_REPAIR_GOLD_PER_HP), haveRes * CASTLE_REPAIR_HP_PER_RESOURCE));
    const goldOk = haveGold >= fullGoldCost;
    const resOk = haveRes >= fullResCost;
    return '<div class="upg">' +
      '<div class="upg-head"><b>🔧 Réparation</b><span class="dim small">' + missing + ' PS manquants</span></div>' +
      '<ul class="upg-needs">' +
        '<li class="' + (goldOk ? 'ok-c' : 'hp-c') + '">' + fullGoldCost + ' ' + this.currencyIcon('gold', 'small') + ' pour tout réparer <span class="dim">(' + haveGold + ')</span></li>' +
        '<li class="' + (resOk ? 'ok-c' : 'hp-c') + '">' + fullResCost + '× ' + esc(resourceLabel(resType, repairTier)) + ' pour tout réparer <span class="dim">(' + haveRes + ')</span></li>' +
      '</ul>' +
      (preview > 0 && preview < missing ? '<p class="dim small">Répare au maximum de vos moyens actuels : jusqu’à <b>' + preview + ' PS</b>.</p>' : '') +
      '<button class="btn wide" data-castle-action="repair"' + (preview <= 0 ? ' disabled' : '') + '>🔧 Réparer' + (preview > 0 ? ' (' + preview + ' PS)' : '') + '</button>' +
    '</div>';
  }

  castleFortifyCardHtml(c, resType) {
    const me = this.server.me;
    const fortLevel = c.fortLevel || 0;
    if (fortLevel >= c.maxFortLevel) {
      return '<div class="upg"><div class="upg-head"><b>🛡 Fortification</b><span class="tier t' + c.maxFortLevel + '">Niveau max</span></div></div>';
    }
    const next = fortLevel + 1;
    const recipe = CASTLE_FORTIFY_RESOURCES[next];
    const haveGold = me.gold || 0;
    const goldOk = haveGold >= CASTLE_FORTIFY_COST_GOLD;
    const haveRes = me.inventory[stackKey(resType, recipe.tier)] || 0;
    const resOk = haveRes >= recipe.qty;
    return '<div class="upg">' +
      '<div class="upg-head"><b>🛡 Fortification</b><span><span class="tier t' + fortLevel + '">' + fortLevel + '</span> → <span class="tier t' + next + '">' + next + '</span></span></div>' +
      '<ul class="upg-needs">' +
        '<li class="' + (goldOk ? 'ok-c' : 'hp-c') + '">' + CASTLE_FORTIFY_COST_GOLD + ' ' + this.currencyIcon('gold', 'small') + ' <span class="dim">(' + haveGold + ')</span></li>' +
        '<li class="' + (resOk ? 'ok-c' : 'hp-c') + '">' + recipe.qty + '× ' + esc(resourceLabel(resType, recipe.tier)) + ' <span class="dim">(' + haveRes + ')</span></li>' +
      '</ul>' +
      '<p class="dim small">+' + CASTLE_FORTIFY_BONUS_PER_LEVEL + ' garnison passive, sans besoin de défenseurs présents.</p>' +
      '<button class="btn wide" data-castle-action="fortify"' + ((goldOk && resOk) ? '' : ' disabled') + '>🛡 Fortifier</button>' +
    '</div>';
  }

  showDeployEnginePicker() {
    const me = this.server.me;
    if (!me) return;
    const owned = [1, 2, 3, 4, 5].filter((t) => (me.inventory[stackKey(SIEGE_ENGINE_ITEM, t)] || 0) > 0);
    if (!owned.length) {
      this.toast('Aucun engin de siège en stock — à construire à la Capitale.');
      return;
    }
    const actions = owned.map((t) => ({
      label: SIEGE_ENGINES[t].label + ' · T' + t + ' (+' + SIEGE_ENGINE_FORCE[t] + ' force, +' + SIEGE_ENGINE_DAMAGE[t] + ' PS)',
      primary: t === owned[owned.length - 1],
      cb: async () => {
        const key = me.raidKey;
        const r = await Promise.resolve(this.server.deploySiegeEngine(key, t));
        this.toast(r.ok ? ('⚙ Engin T' + t + ' déployé pour ce siège.') : r.error);
      },
    }));
    actions.push({ label: 'Annuler' });
    const engineCards = owned.map((t) => (
      '<div class="siege-engine-pick">' +
        '<img src="' + SIEGE_ENGINES[t].asset + '" alt="' + esc(SIEGE_ENGINES[t].label) + '">' +
        '<span><b>' + esc(SIEGE_ENGINES[t].label) + '</b><small>T' + t + '</small></span>' +
      '</div>'
    )).join('');
    this.popup(
      'Déployer un engin de siège',
      '<div class="siege-engine-picker">' + engineCards + '</div>' +
      '<p class="dim small">Un seul engin par personne et par siège — consommé, gagné ou perdu.</p>',
      actions,
      { mode: 'generic' }
    );
  }

  playerSummaryHtml(player) {
    const cls = CLASSES[player.speciesClass] || { label: player.classLabel || player.speciesClass, role: player.role || '' };
    return (
      '<div class="player-peek">' +
        this.spriteAvatar(player.speciesClass, 'small', player.skinId) +
        '<div class="player-peek-copy">' +
          '<div class="player-peek-name">' + esc(player.username) + this.titleGuildTag(player) + '</div>' +
          '<div class="player-peek-class">' + esc(cls.label) + (cls.role ? ' · ' + esc(cls.role) : '') + '</div>' +
          '<div class="player-peek-gear">Arme T' + (player.weaponTier || 0) + ' · Armure T' + (player.armorTier || 0) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  showPlayerPicker(players, opts) {
    const wrap = $('popup');
    wrap.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'popup-card';
    const tile = opts && opts.tile;
    card.innerHTML =
      '<h3>Aventuriers présents</h3>' +
      '<div class="popup-body">' +
        '<p>' + players.length + ' héros occupent cette zone' +
        (tile ? ' <b>(' + tile.x + ', ' + tile.y + ')</b>' : '') + '.</p>' +
        '<div class="player-choice-list"></div>' +
      '</div>';
    const list = card.querySelector('.player-choice-list');
    for (const player of players) {
      const btn = document.createElement('button');
      btn.className = 'travel-choice player-choice';
      btn.innerHTML =
        '<span class="travel-choice-title">' + esc(player.username) + '</span>' +
        '<span class="travel-choice-meta">' + esc(player.classLabel || ((CLASSES[player.speciesClass] || {}).label || player.speciesClass)) +
        ' · Arme T' + (player.weaponTier || 0) + ' · Armure T' + (player.armorTier || 0) + '</span>';
      btn.addEventListener('click', () => this.showPlayerInteraction(player));
      list.appendChild(btn);
    }

    const row = document.createElement('div');
    row.className = 'popup-actions';
    if (opts && opts.moveLabel && opts.moveCb) {
      const moveBtn = document.createElement('button');
      moveBtn.className = 'btn primary';
      moveBtn.textContent = opts.moveLabel;
      moveBtn.addEventListener('click', () => { this.closePopup(); opts.moveCb(); });
      row.appendChild(moveBtn);
    }
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Fermer';
    closeBtn.addEventListener('click', () => this.closePopup());
    row.appendChild(closeBtn);
    card.appendChild(row);
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
    this.popupMode = 'generic';
  }

  showPlayerInspect(player) {
    const cls = CLASSES[player.speciesClass] || { label: player.classLabel || player.speciesClass, bonus: '' };
    this.popup(
      'Profil de ' + esc(player.username),
      this.playerSummaryHtml(player) +
      '<p><b>Arme</b> : ' + esc(player.weaponType || 'Équipement') + ' · T' + (player.weaponTier || 0) + '</p>' +
      '<p><b>Armure</b> : ' + esc(player.armorType || 'Équipement') + ' · T' + (player.armorTier || 0) + '</p>' +
      (cls.bonus ? '<p class="dim small">Talent : ' + esc(cls.bonus) + '</p>' : ''),
      [{ label: 'Fermer' }]
    );
  }

  showPlayerInteraction(player) {
    const me = this.server.me;
    const sameMap = me && player && ((me.mapId || 'world') === (player.mapId || 'world'));
    const dist = (sameMap && me.pos && player.pos) ? this.server.chebyshev(me.pos, player.pos) : Infinity;
    const near = dist <= 1;
    const wrap = $('popup');
    wrap.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'popup-card';
    card.innerHTML =
      '<h3>Interaction</h3>' +
      '<div class="popup-body">' +
        this.playerSummaryHtml(player) +
        '<p class="dim small">' + (dist === 0 ? 'Vous partagez la même case.' : near ? 'Vous êtes au contact.' : 'Approchez-vous pour échanger.') + '</p>' +
      '</div>';
    const row = document.createElement('div');
    row.className = 'popup-actions popup-actions-wrap';

    if (!near) {
      const moveBtn = document.createElement('button');
      moveBtn.className = 'btn primary';
      moveBtn.textContent = 'S’approcher';
      moveBtn.addEventListener('click', () => {
        this.closePopup();
        if (this.onApproachPlayer) this.onApproachPlayer(player);
      });
      row.appendChild(moveBtn);
    } else if (!player.bot) {
      const tradeBtn = document.createElement('button');
      tradeBtn.className = 'btn primary';
      tradeBtn.textContent = 'Échanger';
      tradeBtn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.requestTrade(player.id));
        if (!r.ok) this.toast(r.error);
      });
      row.appendChild(tradeBtn);

      const duelBtn = document.createElement('button');
      duelBtn.className = 'btn';
      duelBtn.textContent = '⚔ Défier en duel';
      duelBtn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.requestDuel(player.id));
        if (!r.ok) this.toast(r.error);
        else this.closePopup();
      });
      row.appendChild(duelBtn);
    }

    // Au contact (adjacent) mais pas encore sur sa case exacte : proposer de
    // le rejoindre quand même (ex. pour accéder à un repère qu'il occupe).
    if (dist === 1) {
      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn';
      joinBtn.textContent = 'Rejoindre sa case';
      joinBtn.addEventListener('click', () => {
        this.closePopup();
        if (this.onApproachPlayer) this.onApproachPlayer(player);
      });
      row.appendChild(joinBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Fermer';
    closeBtn.addEventListener('click', () => this.closePopup());
    row.appendChild(closeBtn);

    card.appendChild(row);
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
    this.popupMode = 'generic';
  }

  showTradeInvite(invite) {
    if (!invite || !invite.fromPlayer) return;
    const from = invite.fromPlayer;
    this.popup(
      'Demande d’échange',
      this.playerSummaryHtml(from) + '<p>Accepter l’échange avec ' + esc(from.username) + ' ?</p>',
      [
        {
          label: 'Refuser',
          cb: async () => {
            const r = await Promise.resolve(this.server.respondTradeInvite(from.id, false));
            if (!r.ok) this.toast(r.error);
          },
        },
        {
          label: 'Accepter',
          primary: true,
          cb: async () => {
            const r = await Promise.resolve(this.server.respondTradeInvite(from.id, true));
            if (!r.ok) this.toast(r.error);
          },
        },
      ]
    );
  }

  showDuelInvite(invite) {
    if (!invite || !invite.fromPlayer) return;
    const from = invite.fromPlayer;
    this.popup(
      'Défi en duel',
      this.playerSummaryHtml(from) +
      '<p>' + esc(from.username) + ' vous défie en duel amical.</p>' +
      '<p class="dim small">Aucune perte de PV ni d’or — seul le palmarès évolue.</p>',
      [
        {
          label: 'Refuser',
          cb: async () => {
            const r = await Promise.resolve(this.server.respondDuelInvite(from.id, false));
            if (!r.ok) this.toast(r.error);
          },
        },
        {
          label: 'Accepter',
          primary: true,
          cb: async () => {
            const r = await Promise.resolve(this.server.respondDuelInvite(from.id, true));
            if (!r.ok) this.toast(r.error);
          },
        },
      ]
    );
  }

  showDuelResult(r) {
    if (!r) return;
    this.popup(
      r.won ? '⚔ Victoire en duel !' : '⚔ Défaite en duel',
      '<p>Face à <b>' + esc(r.opponent) + '</b> — ' + r.chance + ' % de chances de victoire.</p>' +
      '<p class="dim small">Puissance : ' + r.yourPower + ' contre ' + r.opponentPower + '.</p>' +
      '<p class="dim small">Duel amical : aucune perte de PV ni d’or.</p>',
      [{ label: 'Fermer', primary: true }]
    );
  }

  showAchievementUnlocked(a) {
    if (!a) return;
    const reward = a.reward || {};
    const bits = [];
    if (reward.gold) bits.push('+' + reward.gold + ' or');
    if (reward.moonstones) bits.push('+' + reward.moonstones + ' ' + PREMIUM_CURRENCY.label.toLowerCase());
    if (reward.title) bits.push('titre « ' + reward.title + ' »');
    this.toast('Haut fait débloqué : ' + a.label + (bits.length ? ' (' + bits.join(', ') + ')' : ''));
  }

  /* Texte "«Titre» <Guilde>" affiché sous un pseudo, quand présent. */
  titleGuildTag(p) {
    let html = '';
    if (p && p.activeTitle) html += ' <span class="hero-title">« ' + esc(p.activeTitle) + ' »</span>';
    if (p && p.guildName) html += ' <span class="hero-guild">&lt;' + esc(p.guildName) + '&gt;</span>';
    return html;
  }

  tradeOfferSummaryHtml(offer) {
    const parts = [];
    if (offer.gold) parts.push(offer.gold + ' or');
    for (const [key, qty] of Object.entries(offer.items || {})) {
      const parsed = parseStackKey(key);
      parts.push(qty + '× ' + this.tradeStackLabel(parsed.type, parsed.tier));
    }
    return parts.length ? parts.join('<br>') : '<span class="dim">Aucune offre</span>';
  }

  tradeStackLabel(type, tier) {
    if (CONSUMABLES[type]) return CONSUMABLES[type].label + ' T' + tier;
    return resourceLabel(type, tier);
  }

  tradeStackKind(type) {
    if (CONSUMABLES[type]) return 'CONSUMABLE';
    if (type === 'BOIS' || type === 'BOIS_ANCIEN') return 'BOIS';
    if (type === 'MINERAI' || type === 'MINERAI_RUNIQUE') return 'MINERAI';
    if (type === 'PLANTE' || type === 'FLEUR_ASTRALE' || type === 'TOURBE_VIVANTE') return 'PLANTE';
    if (type === 'INGREDIENT') return 'INGREDIENT';
    return 'AUTRE';
  }

  tradeStackIconSrc(type, tier) {
    if (CONSUMABLES[type]) return this.getConsumableTargetSrc(type);
    return this.getResourceTargetSrc(type, tier);
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

  showTradePopup(trade) {
    if (!trade || !trade.withPlayer) return;
    const me = this.server.me;
    const own = trade.offers.self || { gold: 0, items: {}, accepted: false };
    const other = trade.offers.other || { gold: 0, items: {}, accepted: false };
    const draft = this.tradeDraft && this.tradeDraft.id === trade.id
      ? this.tradeDraft
      : { id: trade.id, gold: own.gold || 0, items: { ...(own.items || {}) } };
    const resourceKeys = Object.keys(me.inventory || {}).filter((key) => {
      const parsed = parseStackKey(key);
      return !!RESOURCES[parsed.type] || !!CONSUMABLES[parsed.type];
    }).sort((a, b) => {
        const pa = parseStackKey(a);
        const pb = parseStackKey(b);
        const ka = this.tradeStackKind(pa.type);
        const kb = this.tradeStackKind(pb.type);
        if (ka !== kb) return ka.localeCompare(kb);
        if (pa.type !== pb.type) return this.tradeStackLabel(pa.type, pa.tier).localeCompare(this.tradeStackLabel(pb.type, pb.tier));
        return pa.tier - pb.tier;
      });
    const filterDefs = [
      ['ALL', 'Tout'],
      ['BOIS', 'Bois'],
      ['MINERAI', 'Minerai'],
      ['PLANTE', 'Plante'],
      ['INGREDIENT', 'Ingrédients'],
      ['CONSUMABLE', 'Consommables'],
    ];
    const selectedFilter = this.tradeUiState.filter || 'ALL';

    const wrap = $('popup');
    wrap.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'popup-card trade-popup';
    card.innerHTML =
      '<h3>Échange avec ' + esc(trade.withPlayer.username) + '</h3>' +
      '<div class="popup-body">' +
        '<div class="trade-head">' +
          this.playerSummaryHtml(trade.withPlayer) +
        '</div>' +
        '<div class="trade-grid">' +
          '<div class="trade-side">' +
            '<div class="trade-side-title">Votre offre ' + (own.accepted ? '<span class="role-chip">Validée</span>' : '') + '</div>' +
            '<label class="trade-gold-label">Or' +
              '<input id="tradeGoldInput" class="trade-gold-input" type="number" min="0" max="' + (me.gold || 0) + '" value="' + (draft.gold || 0) + '">' +
            '</label>' +
            '<div class="trade-filterbar">' +
              filterDefs.map(([key, label]) =>
                '<button class="btn trade-filter-btn' + (selectedFilter === key ? ' active' : '') + '" data-trade-filter="' + key + '">' + label + '</button>'
              ).join('') +
            '</div>' +
            '<div class="trade-list" id="tradeOfferList"></div>' +
          '</div>' +
          '<div class="trade-side">' +
            '<div class="trade-side-title">Offre adverse ' + (other.accepted ? '<span class="role-chip">Validée</span>' : '') + '</div>' +
            '<div class="trade-summary-box">' + this.tradeOfferSummaryHtml(other) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    const list = card.querySelector('#tradeOfferList');
    const filteredKeys = resourceKeys.filter((key) => {
      if (selectedFilter === 'ALL') return true;
      const parsed = parseStackKey(key);
      return this.tradeStackKind(parsed.type) === selectedFilter;
    });
    if (!filteredKeys.length) {
      list.innerHTML = '<p class="dim small">Aucune ressource ou consommable échangeable.</p>';
    } else {
      for (const key of filteredKeys) {
        const parsed = parseStackKey(key);
        const art = this.tradeStackIconSrc(parsed.type, parsed.tier);
        const row = document.createElement('label');
        row.className = 'trade-row';
        row.innerHTML =
          '<span class="trade-row-art">' +
            (art ? '<img class="trade-row-icon" src="' + art + '" alt="">' : '<span class="trade-row-fallback">' + (RESOURCE_EMOJI[parsed.type] || '❔') + '</span>') +
          '</span>' +
          '<span class="trade-row-copy"><span class="trade-row-name">' + esc(this.tradeStackLabel(parsed.type, parsed.tier)) + '</span>' +
          '<span class="trade-row-kind">' + esc(this.tradeStackKind(parsed.type)) + '</span></span>' +
          '<span class="trade-row-have">x' + (me.inventory[key] || 0) + '</span>' +
          '<input class="trade-qty-input" data-trade-key="' + esc(key) + '" type="number" min="0" max="' + (me.inventory[key] || 0) + '" value="' + ((draft.items && draft.items[key]) || 0) + '">';
        list.appendChild(row);
      }
    }

    const syncTradeDraft = () => {
      const next = { id: trade.id, gold: 0, items: {} };
      const goldInput = card.querySelector('#tradeGoldInput');
      next.gold = Math.max(0, Number(goldInput && goldInput.value || 0));
      card.querySelectorAll('[data-trade-key]').forEach((input) => {
        const qty = Math.max(0, Number(input.value || 0));
        if (qty > 0) next.items[input.dataset.tradeKey] = qty;
      });
      this.tradeDraft = next;
      return next;
    };
    const rememberTradeUiState = () => {
      const activeFilter = card.querySelector('[data-trade-filter].active');
      this.tradeUiState.filter = activeFilter ? activeFilter.dataset.tradeFilter : (this.tradeUiState.filter || 'ALL');
      this.tradeUiState.scrollTop = list.scrollTop;
    };

    const goldInput = card.querySelector('#tradeGoldInput');
    if (goldInput) goldInput.addEventListener('input', syncTradeDraft);
    card.querySelectorAll('[data-trade-key]').forEach((input) => {
      input.addEventListener('input', syncTradeDraft);
      input.addEventListener('change', syncTradeDraft);
    });
    card.querySelectorAll('[data-trade-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tradeUiState.filter = btn.dataset.tradeFilter;
        this.tradeUiState.scrollTop = 0;
        this.showTradePopup(trade);
      });
    });
    list.addEventListener('scroll', () => {
      this.tradeUiState.scrollTop = list.scrollTop;
    });
    requestAnimationFrame(() => {
      list.scrollTop = this.tradeUiState.scrollTop || 0;
    });

    const row = document.createElement('div');
    row.className = 'popup-actions popup-actions-wrap';
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn primary';
    confirmBtn.textContent = own.accepted ? 'Retirer validation' : 'Valider';
    confirmBtn.addEventListener('click', async () => {
      rememberTradeUiState();
      if (!own.accepted) {
        const offer = syncTradeDraft();
        if (!this.sameTradeOffer(offer, own)) {
          const up = await Promise.resolve(this.server.updateTradeOffer(offer));
          if (!up.ok) { this.toast(up.error); return; }
        }
      }
      const r = await Promise.resolve(this.server.confirmTrade(!own.accepted));
      if (!r.ok) this.toast(r.error);
    });
    row.appendChild(confirmBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Annuler échange';
    cancelBtn.addEventListener('click', async () => {
      rememberTradeUiState();
      const r = await Promise.resolve(this.server.cancelTrade());
      if (!r.ok) this.toast(r.error);
    });
    row.appendChild(cancelBtn);

    card.appendChild(row);
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
    this.popupMode = 'trade';
  }

  /* ---------- HUD (appelé à chaque frame) ---------- */
  updateHud() {
    const me = this.server.me;
    if (!me) return;
    const mhp = maxHp(me);
    $('hpFill').style.width = (100 * me.hp / mhp) + '%';
    $('hpText').textContent = me.hp + ' / ' + mhp + ' PV';
    $('paFill').style.width = (100 * me.pa / CONFIG.PA.MAX) + '%';
    $('paText').textContent = me.pa + ' / ' + CONFIG.PA.MAX + ' PA';
    $('posText').textContent = '(' + me.pos.x + ', ' + me.pos.y + ')';
    const nextIn = Math.ceil((CONFIG.PA.REGEN_MS - me.paMs) / 1000);
    $('paNext').textContent = me.pa >= CONFIG.PA.MAX ? 'PA max' : '+1 PA dans ' + nextIn + ' s';

    // Bouton contextuel : PNJ de la Capitale (monde uniquement — l'entrée
    // d'un donjon est aussi en (0,0))
    const onCapital = (me.mapId || 'world') === 'world' && me.pos.x === 0 && me.pos.y === 0;
    $('ctxAction').classList.toggle('hidden', !onCapital);

    // Badge du buff de nourriture actif
    const buffBadge = $('buffBadge');
    if (me.buff && CONSUMABLES[me.buff.type]) {
      buffBadge.classList.remove('hidden');
      buffBadge.textContent = CONSUMABLES[me.buff.type].icon + ' ' +
        CONSUMABLES[me.buff.type].label + ' T' + me.buff.tier + ' · ' + me.buff.combats + ' ⚔';
    } else {
      buffBadge.classList.add('hidden');
    }

    // Bannière de lobby : compte à rebours + % de victoire en direct
    const banner = $('lobbyBanner');
    if (me.status === 'LOBBY_COMBAT' && me.raidKey) {
      const raid = this.server.raids.get(me.raidKey);
      if (raid) {
        banner.classList.remove('hidden');
        const chance = this.server.raidChance(raid);
        const pct = Math.round(chance * 100);
        const secsLeft = Math.max(0, Math.ceil((raid.endsAt - this.server.now) / 1000));
        const engineCount = (raid.engines || []).length;
        $('lobbyText').textContent = raid.siege
          ? '🏰 Siège — ' + raid.label + ' — résolution dans ' + secsLeft + ' s — ' + raid.participants.length + ' assaillant(s)' +
            (engineCount ? ' — ' + engineCount + ' engin(s)' : '')
          : '⚔ Raid ' + raid.label + ' T' + raid.tier + ' — résolution dans ' + secsLeft + ' s — ' + raid.participants.length + ' participant(s)';
        const chanceEl = $('lobbyChance');
        chanceEl.classList.remove('hidden');
        chanceEl.textContent = pct + ' % de victoire';
        chanceEl.className = 'chance-badge ' + this.chanceClass(chance);
        $('lobbyStart').classList.toggle('hidden', raid.leaderId !== me.id);

        const deployBtn = $('lobbyDeployEngine');
        const alreadyDeployed = (raid.engines || []).some((e) => e.by === me.id);
        const hasAnyEngine = raid.siege && [1, 2, 3, 4, 5].some((t) => (me.inventory[stackKey(SIEGE_ENGINE_ITEM, t)] || 0) > 0);
        deployBtn.classList.toggle('hidden', !raid.siege || alreadyDeployed || !hasAnyEngine);
      }
    } else {
      banner.classList.add('hidden');
    }

    const dungeonBanner = $('dungeonBanner');
    const currentMap = this.server.mapOf(this.server.currentMapId || (me.mapId || 'world'));
    if (currentMap && currentMap.kind === 'dungeon' && currentMap.dungeon) {
      const state = currentMap.dungeon;
      const hud = $('hud');
      const bossIcon = $('dungeonBannerBossIcon');
      const title = $('dungeonBannerTitle');
      const fill = $('dungeonBannerFill');
      const count = $('dungeonBannerCount');
      const hint = $('dungeonBannerHint');
      const progress = state.bossAlive ? 1 : Math.max(0, Math.min(1, state.kills / Math.max(1, state.killsRequired)));
      const bossSrc = currentMap.boss ? this.getMonsterTargetSrc({ type: currentMap.boss.type, tier: 6 }) : '';
      dungeonBanner.style.top = (hud ? (hud.offsetHeight + 10) : 118) + 'px';
      dungeonBanner.classList.remove('hidden');
      dungeonBanner.classList.toggle('boss-ready', !!state.bossAlive);
      bossIcon.src = bossSrc;
      bossIcon.style.visibility = bossSrc ? 'visible' : 'hidden';
      title.textContent = state.bossAlive ? 'Le boss est apparu' : 'Invocation du boss';
      fill.style.width = Math.round(progress * 100) + '%';
      count.textContent = state.bossAlive ? 'PRÊT' : (state.kills + ' / ' + state.killsRequired);
      hint.textContent = state.bossAlive
        ? 'Rassemblez votre groupe et terrassez le boss du biome.'
        : ('Abattez encore ' + Math.max(0, state.killsRequired - state.kills) + ' squelettes pour le faire apparaître.');
    } else {
      dungeonBanner.style.top = '';
      dungeonBanner.classList.add('hidden');
      dungeonBanner.classList.remove('boss-ready');
      $('dungeonBannerBossIcon').src = '';
    }
  }

  /* ---------- Toasts ---------- */
  toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2400);
    setTimeout(() => el.remove(), 2900);
  }

  /* ---------- Popup générique ---------- */
  popup(title, bodyHtml, actions, opts) {
    opts = opts || {};
    const wrap = $('popup');
    wrap.innerHTML = '';
    this.popupMode = opts.mode || 'generic';
    const card = document.createElement('div');
    card.className = opts.className || 'popup-card';
    card.innerHTML =
      (opts.decorated ? '<div class="popup-card-ornament top"></div><div class="popup-card-ornament bottom"></div>' : '') +
      (opts.heroHtml || '') +
      '<div class="popup-copy">' +
        (opts.kicker ? '<div class="popup-kicker">' + opts.kicker + '</div>' : '') +
        '<h3>' + title + '</h3><div class="popup-body">' + bodyHtml + '</div>' +
      '</div>';
    const row = document.createElement('div');
    row.className = 'popup-actions' + (actions.length > 2 ? ' popup-actions-wrap' : '');
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = a.primary ? 'btn primary' : 'btn';
      btn.textContent = a.label;
      btn.addEventListener('click', () => { this.closePopup(); if (a.cb) a.cb(); });
      row.appendChild(btn);
    }
    card.appendChild(row);
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
  }

  confirm(title, bodyHtml, okLabel, cb, opts) {
    this.popup(title, bodyHtml, [
      { label: 'Annuler' },
      { label: okLabel, primary: true, cb },
    ], opts);
  }

  confirmAction(opts) {
    const actions = [{ label: opts.cancelLabel || 'Annuler' }];
    actions.push({ label: opts.okLabel || 'Confirmer', primary: true, cb: opts.cb });
    this.popup(opts.title, opts.bodyHtml, actions, {
      className: 'popup-card action-popup tone-' + (opts.tone || 'travel'),
      decorated: true,
      kicker: opts.kicker || 'Action',
      heroHtml: this.buildActionHero(opts),
    });
  }

  closePopup() {
    this.popupMode = null;
    $('popup').classList.add('hidden');
  }

  loadCombatFxAssets() {
    const img = new Image();
    img.onload = () => {
      this.combatSwordSrc = this.removeChromaToDataUrl(img);
    };
    img.src = 'assets/combat_sword.png';

    Object.entries(this.modalAssetSrc).forEach(([key, src]) => {
      const asset = new Image();
      asset.onload = () => {
        const cleanCanvas = key === 'frame'
          ? this.removeEdgeBackgroundToCanvas(asset)
          : this.removeChromaToCanvas(asset);
        if (key === 'frame') document.documentElement.style.setProperty('--modal-frame-url', this.canvasToCssUrl(cleanCanvas, 700));
        if (key === 'buttonSecondary') document.documentElement.style.setProperty('--modal-button-secondary-url', this.canvasToCssUrl(cleanCanvas, 720));
        if (key === 'buttonPrimary') document.documentElement.style.setProperty('--modal-button-primary-url', this.canvasToCssUrl(cleanCanvas, 720));
      };
      asset.src = src;
    });

    Object.entries(this.navIconSrc).forEach(([key, src]) => {
      const asset = new Image();
      asset.onload = () => {
        const clean = this.removeChromaToDataUrl(asset);
        document.documentElement.style.setProperty('--nav-icon-' + key + '-url', 'url("' + clean + '")');
      };
      asset.src = src;
    });

    Object.entries(this.harvestToolSrc).forEach(([type, src]) => {
      const tool = new Image();
      tool.onload = () => {
        this.harvestToolSrc[type] = this.removeChromaToDataUrl(tool);
      };
      tool.src = src;
    });
  }

  removeChromaToDataUrl(image) {
    const c = this.removeChromaToCanvas(image);
    return c.toDataURL('image/png');
  }

  removeChromaToCanvas(image) {
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
      if (r > 220 && b > 220 && gg < 80) data[i + 3] = 0;
    }

    g.putImageData(img, 0, 0);
    return c;
  }

  removeEdgeBackgroundToCanvas(image) {
    const c = document.createElement('canvas');
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    const data = img.data;
    const seen = new Uint8Array(c.width * c.height);
    const stack = [];

    const isLightBorderPixel = (offset) => {
      const r = data[offset];
      const gg = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      if (a < 8) return true;
      const max = Math.max(r, gg, b);
      const min = Math.min(r, gg, b);
      return max > 230 && (max - min) < 28;
    };

    const tryPush = (idx) => {
      if (idx < 0 || idx >= seen.length || seen[idx]) return;
      if (!isLightBorderPixel(idx * 4)) return;
      seen[idx] = 1;
      stack.push(idx);
    };

    for (let x = 0; x < c.width; x++) {
      tryPush(x);
      tryPush((c.height - 1) * c.width + x);
    }
    for (let y = 0; y < c.height; y++) {
      tryPush(y * c.width);
      tryPush(y * c.width + (c.width - 1));
    }

    while (stack.length) {
      const idx = stack.pop();
      const x = idx % c.width;
      const y = Math.floor(idx / c.width);
      const off = idx * 4;
      data[off + 3] = 0;
      if (x > 0) tryPush(idx - 1);
      if (x + 1 < c.width) tryPush(idx + 1);
      if (y > 0) tryPush(idx - c.width);
      if (y + 1 < c.height) tryPush(idx + c.width);
    }

    g.putImageData(img, 0, 0);
    return c;
  }

  canvasToCssUrl(canvas, maxSize) {
    const maxDim = Math.max(canvas.width, canvas.height);
    if (maxSize && maxDim > maxSize) {
      const scale = maxSize / maxDim;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(canvas.width * scale));
      out.height = Math.max(1, Math.round(canvas.height * scale));
      const g = out.getContext('2d');
      g.drawImage(canvas, 0, 0, out.width, out.height);
      return 'url("' + out.toDataURL('image/webp', 0.9) + '")';
    }
    return 'url("' + canvas.toDataURL('image/webp', 0.9) + '")';
  }

  closeCombatFx() {
    const fx = $('combatFx');
    fx.className = 'hidden';
    fx.innerHTML = '';
  }

  closeHarvestFx() {
    if (this.harvestFxTimer) {
      clearTimeout(this.harvestFxTimer);
      this.harvestFxTimer = null;
    }
    const fx = $('harvestFx');
    fx.className = 'hidden';
    fx.innerHTML = '';
  }

  getHarvestTargetSrc(resource) {
    const sprite = this.renderer &&
      this.renderer.worldIcons &&
      this.renderer.worldIcons.resource &&
      this.renderer.worldIcons.resource[resource.type] &&
      this.renderer.worldIcons.resource[resource.type][resource.tier];
    return this.getSpriteSrc(sprite);
  }

  getResourceTargetSrc(type, tier) {
    const sprite = this.renderer &&
      this.renderer.worldIcons &&
      this.renderer.worldIcons.resource &&
      this.renderer.worldIcons.resource[type] &&
      this.renderer.worldIcons.resource[type][tier];
    return this.getSpriteSrc(sprite);
  }

  getHarvestToolKind(resourceType) {
    const family = resourceFamily(resourceType);
    return {
      MINERAI: 'mineral',
      BOIS: 'wood',
      PLANTE: 'plant',
      INGREDIENT: 'ingredient',
    }[family] || 'generic';
  }

  getConsumableTargetSrc(type) {
    return this.consumableIconSrc[type] || '';
  }

  currencyIcon(kind, extraClass) {
    const src = this.currencyIconSrc[kind];
    if (!src) return '';
    return '<img class="currency-icon ' + (extraClass || '') + '" src="' + src + '" alt="" aria-hidden="true">';
  }

  getSpriteSrc(sprite) {
    if (!sprite) return '';
    if (sprite.processed && typeof sprite.processed.toDataURL === 'function') {
      const bounds = sprite.bounds;
      if (bounds && bounds.w > 0 && bounds.h > 0) {
        const pad = Math.max(6, Math.round(Math.max(bounds.w, bounds.h) * 0.08));
        const c = document.createElement('canvas');
        c.width = bounds.w + pad * 2;
        c.height = bounds.h + pad * 2;
        const g = c.getContext('2d');
        g.drawImage(
          sprite.processed,
          bounds.x, bounds.y, bounds.w, bounds.h,
          pad, pad, bounds.w, bounds.h
        );
        return c.toDataURL('image/png');
      }
      return sprite.processed.toDataURL('image/png');
    }
    return sprite.src || '';
  }

  getMonsterTargetSrc(monster) {
    const sprite = this.renderer &&
      this.renderer.worldIcons &&
      this.renderer.worldIcons.monster &&
      (this.renderer.worldIcons.monster[monster.type] ||
        this.renderer.worldIcons.monster[MONSTERS[monster.tier] && MONSTERS[monster.tier].type]);
    return this.getSpriteSrc(sprite);
  }

  getTerrainPreviewSrc(terrain, x, y) {
    const list = this.renderer && this.renderer.terrainTiles && this.renderer.terrainTiles[terrain];
    if (!list || !list.length) return '';
    const index = Math.abs(((x * 31) ^ (y * 17) ^ (terrain ? terrain.length * 13 : 7))) % list.length;
    return this.getSpriteSrc(list[index]) || this.getSpriteSrc(list[0]);
  }

  buildActionHero(opts) {
    const src = opts.mediaSrc || '';
    const mediaClass = opts.mediaClass || '';
    const bare = mediaClass === 'resource' || mediaClass === 'monster';
    const badge = opts.badge ? '<div class="popup-hero-badge">' + esc(opts.badge) + '</div>' : '';
    const emblem = opts.emblem ? '<div class="popup-hero-emblem">' + opts.emblem + '</div>' : '';
    return (
      '<div class="popup-hero">' +
        '<div class="popup-hero-glow"></div>' +
        '<div class="popup-hero-frame ' + mediaClass + (bare ? ' bare' : '') + '">' +
          (src ? '<img class="popup-hero-art" src="' + src + '" alt="">' : emblem) +
        '</div>' +
        badge +
      '</div>'
    );
  }

  /* ---------- Résultat de raid ---------- */
  async showResult(r) {
    await this.playCombatClash(r);
    const monsterSrc = this.getMonsterTargetSrc({ tier: r.tier });
    const lines = [
      '<div class="vs battle-vs"><span>Équipe <b>' + r.teamForce + '</b></span><span class="vs-x">contre</span><span><b>' + r.monsterForce + '</b> ' + esc(r.label) + ' T' + r.tier + '</span></div>',
      '<p><span class="battle-label">Participants</span> ' + r.participants.map(esc).join(', ') + '</p>',
    ];
    if (typeof r.chance === 'number') {
      lines.push('<p><span class="battle-label">Chances</span> ' + this.chanceHtml(r.chance) + ' de victoire — le sort a ' + (r.victory ? 'souri' : 'tranché') + '.</p>');
    }
    if (r.victory) {
      lines.push('<p><span class="battle-label">PV perdus</span> <b class="hp-c">−' + r.hpLoss + '</b>' +
        (r.druid ? ' <span class="ok-c">(Sève : +15 % des PV max)</span>' : '') + '</p>');
      if (r.gold) lines.push('<p><span class="battle-label">Or</span> <b class="gold-c">+' + r.gold + ' ' + this.currencyIcon('gold', 'small') + '</b></p>');
      if (r.food) {
        const pf = parseStackKey(r.food);
        lines.push('<p><span class="battle-label">Trouvaille</span> ' + (RESOURCE_EMOJI[pf.type] || '❔') + ' 1× ' + resourceLabel(pf.type, pf.tier) + '</p>');
      }
      lines.push('<p><span class="battle-label">Maîtrise</span> +' + r.xp + ' XP d’arme</p>');
    } else {
      lines.push('<p class="hp-c"><b>☠ Vous êtes mort.</b> Rapatriement à la Capitale — reposez-vous à la fontaine avant de repartir.</p>');
    }
    this.popup(
      r.victory ? 'Victoire' : 'Défaite',
      lines.join(''),
      [{ label: 'Continuer', primary: true }],
      {
        className: 'popup-card action-popup result-popup tone-' + (r.victory ? 'harvest' : 'danger'),
        kicker: 'Rapport de bataille',
        heroHtml: this.buildActionHero({
          mediaSrc: monsterSrc,
          mediaClass: 'monster',
          badge: esc(r.label) + ' · T' + r.tier,
        }),
      }
    );
  }

  /* ---------- Résultat de siège de château ---------- */
  async showSiegeResult(r) {
    if (this.renderer) this.renderer.refreshCastleLevels();
    if (r.cancelled) {
      this.toast(esc(r.label) + ' — le siège a été annulé (château sans propriétaire valide).');
      return;
    }
    const isDefender = r.role === 'defender';
    const won = isDefender ? !r.victory : r.victory;   // du point de vue du joueur qui reçoit ce rapport
    await this.playCombatClash({ victory: won, label: r.label });
    const lines = [
      '<div class="vs battle-vs"><span>' + esc(r.attackerGuildName) + ' <b>' + r.teamForce + '</b></span>' +
        '<span class="vs-x">contre</span><span><b>' + r.defenseForce + '</b> ' + esc(r.defenderGuildName) + '</span></div>',
    ];
    if (isDefender && typeof r.garrison === 'number') {
      lines.push('<p class="dim small">Garnison ' + r.garrison + ' + défenseurs présents ' + r.defenseBonus + '</p>');
    }
    lines.push('<p><span class="battle-label">' + (isDefender ? 'Défenseurs présents' : 'Assaillants') + '</span> ' +
      (r.participants.length ? r.participants.map(esc).join(', ') : '—') + '</p>');
    if (r.engineCount) {
      lines.push('<p class="dim small">⚙ ' + r.engineCount + ' engin(s) de siège : +' + r.engineForce + ' force' +
        (r.engineDamage ? ', +' + r.engineDamage + ' PS garantis' : '') + '</p>');
    }
    lines.push('<p><span class="battle-label">Chances</span> ' + this.chanceHtml(isDefender ? 1 - r.chance : r.chance) +
      ' de victoire — le sort a ' + (won ? 'souri' : 'tranché') + '.</p>');
    if (!won) {
      lines.push(isDefender
        ? '<p class="hp-c"><b>🏰 Château perdu.</b> ' + esc(r.label) + ' appartient désormais à ' + esc(r.attackerGuildName) + '.</p>'
        : '<p class="hp-c"><b>☠ Assaut repoussé.</b> Rapatriement à la Capitale — reposez-vous à la fontaine avant de repartir.</p>');
    } else if (r.captured) {
      lines.push('<p class="ok-c"><b>🏰 Château conquis !</b> ' + esc(r.label) + ' appartient désormais à ' + esc(r.attackerGuildName) + '.</p>');
    } else if (isDefender) {
      lines.push('<p class="ok-c"><b>🛡 Assaut repoussé !</b> ' + r.hp + ' / ' + r.hpMax + ' PS restants.</p>');
    } else {
      lines.push('<p><span class="battle-label">Structure</span> ' + r.hp + ' / ' + r.hpMax + ' PS restants.</p>');
    }
    this.popup(
      won ? (isDefender ? 'Défense réussie' : (r.captured ? 'Château conquis' : 'Assaut réussi')) : (isDefender ? 'Château perdu' : 'Assaut repoussé'),
      lines.join(''),
      [{ label: 'Continuer', primary: true }],
      {
        className: 'popup-card action-popup result-popup tone-' + (won ? 'harvest' : 'danger'),
        kicker: 'Rapport de siège',
      }
    );
  }

  playCombatClash(r) {
    return new Promise((resolve) => {
      const wrap = $('combatFx');
      wrap.innerHTML =
        '<div class="combat-fx-backdrop ' + (r.victory ? 'victory' : 'defeat') + '">' +
          '<div class="combat-fx-center">' +
            '<div class="combat-fx-title">Affrontement</div>' +
            '<div class="combat-fx-subtitle">' + esc(r.label) + (r.tier ? ' T' + r.tier : '') + '</div>' +
            '<div class="combat-fx-swords" aria-hidden="true">' +
              '<img class="combat-fx-sword sword-left" src="' + this.combatSwordSrc + '" alt="">' +
              '<span class="combat-fx-flash"></span>' +
              '<img class="combat-fx-sword sword-right" src="' + this.combatSwordSrc + '" alt="">' +
            '</div>' +
            '<div class="combat-fx-status">' + (r.victory ? 'Victoire…' : 'Défaite…') + '</div>' +
          '</div>' +
        '</div>';
      wrap.className = '';

      const backdrop = wrap.firstElementChild;
      const center = backdrop.querySelector('.combat-fx-center');
      setTimeout(() => backdrop.classList.add('phase-impact'), 120);
      setTimeout(() => center.classList.add('phase-impact'), 120);
      setTimeout(() => backdrop.classList.add('phase-resolve'), 520);
      setTimeout(() => {
        this.closeCombatFx();
        resolve();
      }, 980);
    });
  }

  playHarvestFx(resource, durationMs) {
    this.closeHarvestFx();
    const fx = $('harvestFx');
    const tierColor = TIER_COLORS[resource.tier] || TIER_COLORS[1];
    const label = RESOURCES[resource.type] ? RESOURCES[resource.type].label : resource.type;
    const targetSrc = this.getHarvestTargetSrc(resource);
    const family = resourceFamily(resource.type);
    const toolSrc = this.harvestToolSrc[family] || this.harvestToolSrc.MINERAI;
    const toolKind = this.getHarvestToolKind(resource.type);
    const totalMs = Math.max(900, durationMs || CONFIG.HARVEST_MS);
    const cycleMs = Math.max(520, Math.min(780, Math.round(totalMs / 4)));
    fx.innerHTML =
      '<div class="harvest-fx-backdrop" style="--harvest-tier:' + tierColor + ';--harvest-cycle:' + cycleMs + 'ms">' +
        '<div class="harvest-fx-center">' +
          '<div class="harvest-fx-stage">' +
            '<span class="harvest-fx-shadow"></span>' +
            '<span class="harvest-fx-impact impact-' + toolKind + '"></span>' +
            (targetSrc ? '<img class="harvest-fx-target ' + toolKind + '" src="' + targetSrc + '" alt="">' : '') +
            '<img class="harvest-fx-tool tool-' + toolKind + '" src="' + toolSrc + '" alt="">' +
          '</div>' +
          '<div class="harvest-fx-title">Récolte</div>' +
          '<div class="harvest-fx-subtitle">' + esc(label) + ' T' + resource.tier + '</div>' +
        '</div>' +
      '</div>';
    fx.className = '';
    this.harvestFxTimer = setTimeout(() => this.closeHarvestFx(), totalMs);
  }

  /* ---------- Bottom sheets ---------- */
  showSheet(name) {
    if (name === 'social' && this.desktopPanelsActive()) {
      this.closeSheet();
      this.refreshDesktopSocial(true);
      this.emphasizeDesktopPanel('desktopRight');
      return;
    }
    this.openSheet = name;
    this.stopInventoryCooldownTimer();
    const titles = { inventory: 'Inventaire', shop: 'Boutique', profile: 'Profil', map: 'Carte du monde', social: 'Social', capital: 'Capitale — PNJ Artisans', marmite: 'La Marmite — Cuisine', admin: 'Administration' };
    $('sheetTitle').textContent = titles[name];
    const body = $('sheetBody');
    body.innerHTML = '';
    this['build_' + name](body);
    $('sheet').classList.remove('hidden');
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  }

  closeSheet() {
    this.stopInventoryCooldownTimer();
    this.openSheet = null;
    $('sheet').classList.add('hidden');
    document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('active'));
  }

  desktopPanelsActive() {
    return !!(this.desktopMedia && this.desktopMedia.matches && this.server.me);
  }

  syncDesktopPanels(refreshSocial) {
    const layout = $('desktopLayout');
    if (!layout) return;
    const active = this.desktopPanelsActive();
    layout.classList.toggle('desktop-panels-ready', active);
    if (!active) {
      this.desktopProfileSignature = '';
      this.desktopSocialRequest += 1;
      $('desktopProfileBody').innerHTML = '';
      $('desktopSocialBody').innerHTML = '';
      $('desktopSocialBody').removeAttribute('data-ready');
      return;
    }
    if (this.openSheet === 'social') this.closeSheet();
    this.updateDesktopProfile(true);
    this.renderer.drawMinimap($('desktopMinimap'));
    if (refreshSocial || !$('desktopSocialBody').dataset.ready) this.refreshDesktopSocial(true);
  }

  emphasizeDesktopPanel(id) {
    const panel = $(id);
    if (!panel) return;
    panel.classList.remove('desktop-panel-emphasis');
    requestAnimationFrame(() => panel.classList.add('desktop-panel-emphasis'));
    setTimeout(() => panel.classList.remove('desktop-panel-emphasis'), 700);
  }

  updateDesktopProfile(force) {
    if (!this.desktopPanelsActive()) return;
    const me = this.server.me;
    const cls = CLASSES[me.speciesClass];
    const skin = skinFor(me.skinId);
    const buffKey = me.buff ? [me.buff.type, me.buff.tier, me.buff.combats].join(':') : 'none';
    const signature = [me.username, me.speciesClass, me.skinId || 'base', me.hp, me.gold,
      me.weapon.type, me.weapon.tier, me.armor.type, me.armor.tier,
      me.harvestLevel, me.weaponMastery, buffKey].join('|');
    if (!force && signature === this.desktopProfileSignature) return;
    this.desktopProfileSignature = signature;
    const buff = me.buff && CONSUMABLES[me.buff.type];
    const buffAsset = buff ? this.consumableIconSrc[me.buff.type] : '';
    $('desktopProfileBody').innerHTML =
      '<div class="desktop-hero-summary">' +
        this.spriteAvatar(me.speciesClass, 'hero', me.skinId) +
        '<div class="desktop-hero-copy">' +
          '<div class="hero-name">' + esc(me.username) + this.titleGuildTag(me) + '</div>' +
          '<div class="hero-class">' + esc(cls.label) + ' · ' + esc(cls.role) + '</div>' +
          '<div class="desktop-skin-name">' + esc((skin && skin.label) || 'Tenue de base') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="desktop-stat-grid">' +
        '<div><span>Puissance</span><b>' + Math.round(combatPower(me)) + '</b></div>' +
        '<div><span>PV</span><b>' + me.hp + ' / ' + maxHp(me) + '</b></div>' +
        '<div><span>Or</span><b>' + (me.gold || 0).toLocaleString('fr-FR') + '</b></div>' +
      '</div>' +
      '<div class="desktop-equipment-grid">' +
        '<div class="desktop-equipment-item"><img src="' + equipmentAsset('weapon', me.weapon.type) + '" alt=""><span><small>Arme</small><b>' + esc(me.weapon.type) + '</b></span><i class="tier t' + me.weapon.tier + '">T' + me.weapon.tier + '</i></div>' +
        '<div class="desktop-equipment-item"><img src="' + equipmentAsset('armor', me.armor.type) + '" alt=""><span><small>Armure</small><b>' + esc(me.armor.type) + '</b></span><i class="tier t' + me.armor.tier + '">T' + me.armor.tier + '</i></div>' +
      '</div>' +
      '<div class="desktop-mastery-row"><span>Récolte <b>T' + me.harvestLevel + '</b></span><span>Maîtrise <b>T' + me.weaponMastery + '</b></span></div>' +
      '<div class="desktop-buff' + (buff ? ' active' : '') + '">' +
        (buffAsset ? '<img src="' + buffAsset + '" alt="">' : '<span class="desktop-buff-empty">✦</span>') +
        '<span><small>Effet actif</small><b>' + (buff ? esc(buff.label + ' T' + me.buff.tier) : 'Aucun mets actif') + '</b>' +
        (buff ? '<em>' + me.buff.combats + ' combat' + (me.buff.combats > 1 ? 's' : '') + '</em>' : '') + '</span>' +
      '</div>';
  }

  refreshDesktopSocial(force) {
    if (!this.desktopPanelsActive()) return;
    const body = $('desktopSocialBody');
    const active = document.activeElement;
    const isTyping = active && body.contains(active) &&
      (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA');
    if (isTyping && !force) return;
    const me = this.server.me;
    const request = ++this.desktopSocialRequest;
    if (!body.dataset.ready) body.innerHTML = '<p class="dim">Chargement…</p>';
    Promise.all([
      me.guildId ? Promise.resolve(this.server.guildInfo()) : Promise.resolve({ ok: false }),
      Promise.resolve(this.server.friendsList()),
      me.guildId ? Promise.resolve(this.server.castlesInfo()) : Promise.resolve({ ok: false }),
    ]).then(([guildRes, friendsRes, castlesRes]) => {
      if (request !== this.desktopSocialRequest || !this.desktopPanelsActive()) return;
      this.renderSocial(
        body, me,
        (guildRes && guildRes.ok) ? guildRes.guild : null,
        (friendsRes && friendsRes.ok) ? friendsRes.list : [],
        (castlesRes && castlesRes.ok) ? castlesRes.list : []
      );
      body.dataset.ready = 'true';
    });
  }

  build_inventory(body) {
    const me = this.server.me;
    const inv = me.inventory;
    const goldHtml =
      '<div class="gold-banner">' +
        '<span class="gold-coin">' + this.currencyIcon('gold', 'large') + '</span>' +
        '<span class="gold-label">Or</span>' +
        '<span class="gold-amount">' + (me.gold || 0).toLocaleString('fr-FR') + '</span>' +
      '</div>';
    const keys = Object.keys(inv).sort();
    if (!keys.length) {
      body.innerHTML = goldHtml + '<p class="empty">Inventaire vide. Récoltez des ressources sur la carte (2 PA).</p>';
      return;
    }
    const typeOrder = {
      BOIS: 0,
      MINERAI: 1,
      PLANTE: 2,
      INGREDIENT: 3,
      RAGOUT: 4,
      BOUILLON: 5,
      POTION_SEVE: 6,
      TOURBE_VIVANTE: 7,
      ENGIN_SIEGE: 8,
    };
    const sortedKeys = keys.sort((a, b) => {
      const pa = parseStackKey(a);
      const pb = parseStackKey(b);
      if (this.inventorySort === 'tier') {
        if (pa.tier !== pb.tier) return pa.tier - pb.tier;
        if (pa.type !== pb.type) return (typeOrder[pa.type] || 9) - (typeOrder[pb.type] || 9);
        return a.localeCompare(b);
      }
      if (pa.type !== pb.type) return (typeOrder[pa.type] || 9) - (typeOrder[pb.type] || 9);
      if (pa.tier !== pb.tier) return pa.tier - pb.tier;
      return a.localeCompare(b);
    });
    const rows = sortedKeys.map((k) => {
      const p = parseStackKey(k);

      // Consommables : carte cliquable → utiliser
      const cons = CONSUMABLES[p.type];
      if (cons) {
        const consSrc = this.getConsumableTargetSrc(p.type);
        const isPaScroll = p.type === 'PARCHEMIN_ENDURANCE';
        const cooldownMs = isPaScroll ? this.paScrollCooldownRemaining() : 0;
        return '<button class="inv-card inv-consumable' + (cooldownMs > 0 ? ' is-cooling-down' : '') + '" data-consume="' + k + '"' +
          (isPaScroll ? ' data-pa-scroll-cooldown' : '') + (cooldownMs > 0 ? ' disabled' : '') + '>' +
          '<div class="inv-card-art-wrap">' +
            (consSrc
              ? '<img class="inv-card-art" src="' + consSrc + '" alt="">'
              : '<span class="inv-card-emoji">' + cons.icon + '</span>') +
            '<span class="tier t' + p.tier + ' inv-card-tier">T' + p.tier + '</span>' +
            (isPaScroll ? '<span class="inv-cooldown-badge" data-cooldown-label>' +
              (cooldownMs > 0 ? 'Recharge ' + this.formatCooldown(cooldownMs) : 'Disponible') + '</span>' : '') +
          '</div>' +
          '<div class="inv-card-name">' + cons.label + '</div>' +
          '<div class="inv-card-meta">' + consumableDesc(p.type, p.tier) + '</div>' +
          '<div class="inv-card-qty">×' + inv[k] + '</div>' +
          '<div class="inv-card-use" data-consume-label>' + (cooldownMs > 0 ? 'En recharge' : 'Utiliser') + '</div>' +
        '</button>';
      }

      if (p.type === SIEGE_ENGINE_ITEM && SIEGE_ENGINES[p.tier]) {
        const engine = SIEGE_ENGINES[p.tier];
        return '<div class="inv-card">' +
          '<div class="inv-card-art-wrap">' +
            '<img class="inv-card-art" src="' + engine.asset + '" alt="">' +
            '<span class="tier t' + p.tier + ' inv-card-tier">T' + p.tier + '</span>' +
          '</div>' +
          '<div class="inv-card-name">' + esc(engine.label) + '</div>' +
          '<div class="inv-card-meta">Engin de siège · Tier ' + p.tier + '</div>' +
          '<div class="inv-card-qty">×' + inv[k] + '</div>' +
        '</div>';
      }

      const res = RESOURCES[p.type];
      const displayName = resourceLabel(p.type, p.tier);
      const iconSrc = this.getResourceTargetSrc(p.type, p.tier);
      return '<div class="inv-card">' +
        '<div class="inv-card-art-wrap">' +
          (iconSrc ? '<img class="inv-card-art" src="' + iconSrc + '" alt="">' :
            '<span class="inv-card-emoji">' + (RESOURCE_EMOJI[p.type] || '❔') + '</span>') +
          '<span class="tier t' + p.tier + ' inv-card-tier">T' + p.tier + '</span>' +
        '</div>' +
        '<div class="inv-card-name">' + displayName + '</div>' +
        '<div class="inv-card-meta">' + (this.inventorySort === 'tier' ? res.label + ' · ' : '') + 'Tier ' + p.tier + '</div>' +
        '<div class="inv-card-qty">×' + inv[k] + '</div>' +
      '</div>';
    });
    body.innerHTML =
      goldHtml +
      '<div class="sortbar">' +
        '<span class="sortbar-label">Trier</span>' +
        '<div class="sortbar-actions">' +
          '<button class="btn sort-btn' + (this.inventorySort === 'type' ? ' active' : '') + '" data-inventory-sort="type">Par type</button>' +
          '<button class="btn sort-btn' + (this.inventorySort === 'tier' ? ' active' : '') + '" data-inventory-sort="tier">Par tier</button>' +
        '</div>' +
      '</div>' +
      '<div class="inv-grid">' + rows.join('') + '</div>';
    body.querySelectorAll('[data-inventory-sort]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.inventorySort = btn.dataset.inventorySort;
        this.showSheet('inventory');
      });
    });
    body.querySelectorAll('[data-consume]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.consume;
        const p = parseStackKey(k);
        const cons = CONSUMABLES[p.type];
        this.confirm(
          cons.icon + ' Utiliser ' + cons.label + ' T' + p.tier + ' ?',
          '<p>' + consumableDesc(p.type, p.tier) + '.</p>' +
          (cons.kind === 'buff' ? '<p class="dim">Remplace le buff de nourriture en cours, le cas échéant.</p>' : ''),
          'Utiliser',
          async () => {
            const r = await Promise.resolve(this.server.consume(k));
            if (!r.ok) this.toast(r.error);
          }
        );
      });
    });
    this.startInventoryCooldownTimer(body);
  }

  paScrollCooldownRemaining() {
    const me = this.server.me;
    const lastUsedAt = Number(me && me.lastPaScrollAt);
    if (!Number.isFinite(lastUsedAt)) return 0;
    return Math.max(0, PA_SCROLL_COOLDOWN_MS - (this.server.now - lastUsedAt));
  }

  formatCooldown(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  startInventoryCooldownTimer(body) {
    const card = body.querySelector('[data-pa-scroll-cooldown]');
    if (!card) return;
    const update = () => {
      if (this.openSheet !== 'inventory' || !card.isConnected) {
        this.stopInventoryCooldownTimer();
        return;
      }
      const remainingMs = this.paScrollCooldownRemaining();
      const badge = card.querySelector('[data-cooldown-label]');
      const action = card.querySelector('[data-consume-label]');
      const coolingDown = remainingMs > 0;
      card.disabled = coolingDown;
      card.classList.toggle('is-cooling-down', coolingDown);
      if (badge) badge.textContent = coolingDown ? 'Recharge ' + this.formatCooldown(remainingMs) : 'Disponible';
      if (action) action.textContent = coolingDown ? 'En recharge' : 'Utiliser';
      if (!coolingDown) this.stopInventoryCooldownTimer();
    };
    update();
    if (!card.disabled) return;
    this.inventoryCooldownTimer = setInterval(update, 1000);
  }

  stopInventoryCooldownTimer() {
    if (!this.inventoryCooldownTimer) return;
    clearInterval(this.inventoryCooldownTimer);
    this.inventoryCooldownTimer = null;
  }

  build_shop(body) {
    const me = this.server.me;
    const goldSkins = SKIN_SHOP_ITEMS.filter((item) => item.currency === 'gold');
    const premiumSkins = SKIN_SHOP_ITEMS.filter((item) => item.currency === PREMIUM_CURRENCY.key);
    const moneyCard =
      '<div class="shop-wallets">' +
        '<div class="shop-wallet">' + this.currencyIcon('gold', 'large') + '<span><span class="shop-wallet-label">Or</span><b>' +
          (me.gold || 0).toLocaleString('fr-FR') + '</b></span></div>' +
        '<div class="shop-wallet premium">' + this.currencyIcon('premium', 'large') + '<span><span class="shop-wallet-label">' + PREMIUM_CURRENCY.label + '</span><b>' +
          (me[PREMIUM_CURRENCY.key] || 0).toLocaleString('fr-FR') + '</b></span></div>' +
      '</div>';
    body.innerHTML =
      moneyCard +
      '<div class="shop-section">' +
        '<div class="upg-head"><b>Recharger en ' + PREMIUM_CURRENCY.label + '</b><span class="dim">Paiement sécurisé</span></div>' +
        '<div class="shop-packs">' + MOONSTONE_PACKS.map((pack) => this.moonstonePackCard(pack)).join('') + '</div>' +
      '</div>' +
      '<div class="shop-section gold-exchange-section">' +
        '<div class="upg-head"><b>Obtenir des pièces d’or</b><span class="dim">Contre des ' + PREMIUM_CURRENCY.label + '</span></div>' +
        '<div class="shop-packs gold-packs">' + GOLD_PACKS.map((pack) => this.goldPackCard(pack)).join('') + '</div>' +
      '</div>' +
      this.paScrollCardHtml(me) +
      '<div class="shop-section">' +
        '<div class="upg-head"><b>Garde-robe des aventuriers</b><span class="dim">Skins contre or</span></div>' +
        '<div class="shop-grid">' + goldSkins.map((item) => this.shopSkinCard(me, item)).join('') + '</div>' +
      '</div>' +
      '<div class="shop-section premium">' +
        '<div class="upg-head"><b>Collection premium</b><span class="dim">' + PREMIUM_CURRENCY.label + ' ' + this.currencyIcon('premium', 'small') + '</span></div>' +
        '<div class="shop-grid">' + premiumSkins.map((item) => this.shopSkinCard(me, item)).join('') + '</div>' +
      '</div>';
    body.querySelectorAll('[data-shop-buy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.buySkin(btn.dataset.shopBuy));
        this.toast(r.ok ? 'Skin acheté.' : r.error);
      });
    });
    body.querySelectorAll('[data-shop-equip]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const value = btn.dataset.shopEquip === 'base' ? null : btn.dataset.shopEquip;
        const r = await Promise.resolve(this.server.equipSkin(value));
        this.toast(r.ok ? 'Apparence mise à jour.' : r.error);
      });
    });
    body.querySelectorAll('[data-buy-pack]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.getCheckoutLink(btn.dataset.buyPack));
        if (r.ok && r.url) window.location.href = r.url;
        else this.toast(r.error || 'Achat indisponible pour le moment.');
      });
    });
    body.querySelectorAll('[data-buy-gold-pack]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.buyGoldPack(btn.dataset.buyGoldPack));
        this.toast(r.ok ? ('+' + r.gold.toLocaleString('fr-FR') + ' pièces d’or ajoutées.') : r.error);
        if (r.ok) this.showSheet('shop');
      });
    });
    const paScrollBtn = body.querySelector('[data-buy-pa-scroll]');
    if (paScrollBtn) {
      paScrollBtn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.buyPaScroll());
        this.toast(r.ok ? '📜 Parchemin ajouté à l’inventaire.' : r.error);
        if (r.ok) this.showSheet('shop');
      });
    }
  }

  moonstonePackCard(pack) {
    const packLabels = { small: 'Petit', medium: 'Moyen', large: 'Grand' };
    return '<article class="shop-pack pack-' + esc(pack.id) + '">' +
      (pack.bonusLabel ? '<span class="shop-pack-bonus">' + esc(pack.bonusLabel) + '</span>' : '') +
      '<div class="shop-pack-name">' + esc(packLabels[pack.id] || pack.id) + '</div>' +
      '<div class="shop-pack-art">' + this.currencyIcon('premium', 'pack-currency') + '</div>' +
      '<div class="shop-pack-amount"><b>' + pack.lunaires + '</b><span>Écailles</span></div>' +
      '<button class="btn primary shop-btn" data-buy-pack="' + esc(pack.id) + '">' + esc(pack.priceLabel) + '</button>' +
    '</article>';
  }

  goldPackCard(pack) {
    const packLabels = { pouch: 'Bourse', chest: 'Coffre', hoard: 'Trésor' };
    return '<article class="shop-pack gold-pack gold-pack-' + esc(pack.id) + '">' +
      (pack.bonusLabel ? '<span class="shop-pack-bonus">' + esc(pack.bonusLabel) + '</span>' : '') +
      '<div class="shop-pack-name">' + esc(packLabels[pack.id] || pack.id) + '</div>' +
      '<div class="shop-pack-art">' + this.currencyIcon('gold', 'pack-currency') + '</div>' +
      '<div class="shop-pack-amount"><b>+' + pack.gold.toLocaleString('fr-FR') + '</b><span>Pièces d’or</span></div>' +
      '<button class="btn primary shop-btn" data-buy-gold-pack="' + esc(pack.id) + '">' +
        pack.moonstones + ' ' + this.currencyIcon('premium', 'small') +
      '</button>' +
    '</article>';
  }

  // Simple carte d'achat : le parchemin part en inventaire, pas d'effet
  // immédiat — le cooldown d'utilisation s'affiche/s'applique depuis
  // l'Inventaire (voir build_inventory), pas ici.
  paScrollCardHtml(me) {
    const canAfford = Number(me[PREMIUM_CURRENCY.key] || 0) >= PA_SCROLL_COST_MOONSTONES;
    return '<div class="upg pa-scroll-card">' +
      '<img class="pa-scroll-art" src="' + this.getConsumableTargetSrc('PARCHEMIN_ENDURANCE') + '" alt="Parchemin d’Endurance">' +
      '<div class="pa-scroll-copy">' +
        '<div class="upg-head"><b>Parchemin d’Endurance</b><span class="dim small">' + PA_SCROLL_COST_MOONSTONES + ' ' + this.currencyIcon('premium', 'small') + '</span></div>' +
        '<p class="dim small">Recharge l’Endurance au maximum quand vous l’utilisez depuis l’Inventaire — limité à 1-2 utilisations par jour.</p>' +
        '<button class="btn primary wide" data-buy-pa-scroll' + (canAfford ? '' : ' disabled') + '>Acheter</button>' +
      '</div>' +
    '</div>';
  }

  shopSkinCard(me, item) {
    const cls = CLASSES[item.speciesClass] || { label: item.speciesClass, role: '' };
    const owned = !!(me.ownedSkins || []).includes(item.id);
    const equipped = me.speciesClass === item.speciesClass && me.skinId === item.id;
    const compatible = me.speciesClass === item.speciesClass;
    const canAfford = Number(me[item.currency] || 0) >= item.price;
    let cta = '';
    if (equipped) cta = '<button class="btn shop-btn" data-shop-equip="base">Tenue de base</button>';
    else if (owned) cta = '<button class="btn primary shop-btn" data-shop-equip="' + item.id + '"' + (compatible ? '' : ' disabled') + '>Équiper</button>';
    else cta = '<button class="btn primary shop-btn" data-shop-buy="' + item.id + '"' + (compatible && canAfford ? '' : ' disabled') + '>Acheter</button>';
    return (
      '<article class="shop-card' + (equipped ? ' equipped' : '') + (owned ? ' owned' : '') + '">' +
        '<div class="shop-card-art" style="--skin-scale:' + classSkinScale(item.speciesClass) + '"><img src="' + skinAssetUrl(item.asset) + '" alt="' + esc(item.label) + '"></div>' +
        '<div class="shop-card-copy">' +
          '<div class="shop-card-top">' +
            '<b>' + esc(item.label) + '</b>' +
            '<span class="role-chip">' + esc(cls.label) + '</span>' +
          '</div>' +
          '<div class="shop-card-meta">' + esc(cls.role || 'Classe') + '</div>' +
          '<div class="shop-card-price ' + (item.currency === PREMIUM_CURRENCY.key ? 'premium' : 'gold') + '">' +
            (item.currency === PREMIUM_CURRENCY.key ? this.currencyIcon('premium') : this.currencyIcon('gold')) + ' ' + item.price +
          '</div>' +
          '<div class="shop-card-state">' +
            (equipped ? 'Équipé' : owned ? 'Possédé' : compatible ? (canAfford ? 'Disponible' : 'Fonds insuffisants') : 'Active cette classe pour l’utiliser') +
          '</div>' +
        '</div>' +
        '<div class="shop-card-actions">' + cta + '</div>' +
      '</article>'
    );
  }

  /* Avatar découpé dans la feuille de sprites (grille 3x2) */
  spriteAvatar(speciesClass, extraClass, skinId) {
    const skin = skinFor(skinId);
    const asset = skin ? skin.asset : baseSkinAsset(speciesClass);
    if (asset) {
      return '<span class="avatar skin-avatar ' + (extraClass || '') + '" style="--skin-scale:' + classSkinScale(speciesClass) + '"><img src="' + skinAssetUrl(asset) + '" alt="' + esc(skin ? skin.label : 'Tenue de base') + '"></span>';
    }
    const cell = SPRITE_CELLS[speciesClass];
    return '<span class="avatar sprite ' + (extraClass || '') + '" style="background-position:' +
      (cell[0] * 50) + '% ' + (cell[1] * 100) + '%"></span>';
  }

  wardrobePreview(speciesClass, skinId) {
    const skin = skinFor(skinId);
    const asset = skin ? skin.asset : baseSkinAsset(speciesClass);
    if (asset) {
      return '<div class="wardrobe-preview" style="--skin-scale:' + classSkinScale(speciesClass) + '"><img class="wardrobe-preview-img" src="' + skinAssetUrl(asset) + '" alt="' + esc(skin ? skin.label : 'Tenue de base') + '"></div>';
    }
    const cell = SPRITE_CELLS[speciesClass];
    return '<div class="wardrobe-preview wardrobe-preview-base">' +
      '<span class="wardrobe-base-sprite" style="background-position:' +
      (cell[0] * 50) + '% ' + (cell[1] * 100) + '%"></span>' +
    '</div>';
  }

  build_profile(body) {
    const me = this.server.me;
    const cls = CLASSES[me.speciesClass];
    const power = Math.round(combatPower(me));
    // En solo (sandbox locale), les outils de triche restent toujours accessibles ;
    // en multijoueur, ils sont réservés au rôle admin.
    const showCheats = !this.server.remote || me.role === 'admin';
    const isAdmin = this.server.remote && me.role === 'admin';
    body.innerHTML =
      // En-tête façon fiche d'aventurier : portrait cerclé d'or, nom, devise
      '<div class="profile-hero">' +
        this.spriteAvatar(me.speciesClass, 'hero', me.skinId) +
        '<div class="hero-name">' + esc(me.username) + this.titleGuildTag(me) + '</div>' +
        '<div class="hero-class">' + cls.label + ' <span class="role-chip">' + cls.role + '</span></div>' +
        '<p class="hero-bonus">« ' + cls.bonus + ' »</p>' +
      '</div>' +

      '<div class="stat-line">' +
        '<span>⚔ Puissance <b>' + power + '</b></span>' +
        '<span>♥ PV max <b>' + maxHp(me) + '</b></span>' +
        '<span>' + this.currencyIcon('gold') + ' Or <b>' + (me.gold || 0).toLocaleString('fr-FR') + '</b></span>' +
        '<span>' + this.currencyIcon('premium') + ' ' + PREMIUM_CURRENCY.label + ' <b>' + (me[PREMIUM_CURRENCY.key] || 0).toLocaleString('fr-FR') + '</b></span>' +
        '<span>🥊 Duels <b>' + ((me.duels && me.duels.wins) || 0) + 'V / ' + ((me.duels && me.duels.losses) || 0) + 'D</b></span>' +
      '</div>' +

      this.xpBar('Niveau de récolte', me.harvestLevel, me.harvestXp) +
      this.xpBar('Maîtrise d’arme', me.weaponMastery, me.weaponXp) +

      '<div class="section-divider">✦</div>' +

      '<div class="profile-sec-title">Équipement</div>' +
      '<div class="gear-line"><img class="gear-art" src="' + equipmentAsset('weapon', me.weapon.type) + '" alt="' + esc(me.weapon.type) + '"><span class="gear-name">' + me.weapon.type + '</span><span class="tier t' + me.weapon.tier + '">T' + me.weapon.tier + '</span></div>' +
      '<div class="gear-line"><img class="gear-art" src="' + equipmentAsset('armor', me.armor.type) + '" alt="Armure de ' + esc(me.armor.type) + '"><span class="gear-name">Armure de ' + me.armor.type + '</span><span class="tier t' + me.armor.tier + '">T' + me.armor.tier + '</span></div>' +
      '<div class="gear-line"><span class="gear-ico">✨</span><span class="gear-name">Apparence ' + esc((skinFor(me.skinId) || {}).label || 'Tenue de base') + '</span><span class="tier">Actuelle</span></div>' +
      '<button id="profileSkinBtn" class="btn wide">Changer d’apparence</button>' +
      '<p class="dim small profile-hint">Unique et évolutif — chez le Forgeron de la Capitale.</p>' +

      '<div class="section-divider">✦</div>' +
      this.buildAchievementsSectionHtml(me) +

      '<div class="section-divider">✦</div>' +
      this.buildCharactersSection(me) +

      '<div class="section-divider">✦</div>' +
      (isAdmin ? '<button id="openAdminBtn" class="btn wide admin-btn">🛠 Administration</button>' : '') +
      (showCheats ?
        '<details class="profile-admin"' + (this.adminOpen ? ' open' : '') + '>' +
          '<summary>🛠 Outils de test (admin)</summary>' +
          '<div class="admin-grid">' +
            '<button class="btn" data-admin-tier="harvest:1">Récolte T1</button>' +
            '<button class="btn" data-admin-tier="harvest:2">Récolte T2</button>' +
            '<button class="btn" data-admin-tier="harvest:3">Récolte T3</button>' +
            '<button class="btn" data-admin-tier="harvest:4">Récolte T4</button>' +
            '<button class="btn" data-admin-tier="harvest:5">Récolte T5</button>' +
            '<button class="btn" data-admin-tier="harvest:6">Récolte T6</button>' +
            '<button class="btn" data-admin-tier="weapon:1">Maîtrise T1</button>' +
            '<button class="btn" data-admin-tier="weapon:2">Maîtrise T2</button>' +
            '<button class="btn" data-admin-tier="weapon:3">Maîtrise T3</button>' +
            '<button class="btn" data-admin-tier="weapon:4">Maîtrise T4</button>' +
            '<button class="btn" data-admin-tier="weapon:5">Maîtrise T5</button>' +
            '<button class="btn" data-admin-tier="weapon:6">Maîtrise T6</button>' +
          '</div>' +
          '<div class="admin-grid">' +
            '<button class="btn" data-admin-gear="weapon:0">Arme T0</button>' +
            '<button class="btn" data-admin-gear="armor:0">Armure T0</button>' +
            '<button class="btn" data-admin-gear="weapon:1">Arme T1</button>' +
            '<button class="btn" data-admin-gear="armor:1">Armure T1</button>' +
            '<button class="btn" data-admin-gear="weapon:2">Arme T2</button>' +
            '<button class="btn" data-admin-gear="armor:2">Armure T2</button>' +
            '<button class="btn" data-admin-gear="weapon:3">Arme T3</button>' +
            '<button class="btn" data-admin-gear="armor:3">Armure T3</button>' +
            '<button class="btn" data-admin-gear="weapon:4">Arme T4</button>' +
            '<button class="btn" data-admin-gear="armor:4">Armure T4</button>' +
            '<button class="btn" data-admin-gear="weapon:5">Arme T5</button>' +
            '<button class="btn" data-admin-gear="armor:5">Armure T5</button>' +
            '<button class="btn" data-admin-gear="weapon:6">Arme T6</button>' +
            '<button class="btn" data-admin-gear="armor:6">Armure T6</button>' +
          '</div>' +
          '<button id="adminSpawnBossBtn" class="btn primary wide">Faire apparaître le boss</button>' +
          '<button id="profileResetBtn" class="btn danger wide">Réinitialiser le personnage</button>' +
        '</details>'
        : '') +
      (this.pushSupported ?
        '<div class="section-divider">✦</div>' +
        '<div class="profile-sec-title">Notifications</div>' +
        '<p class="dim small">Endurance pleine, résultat de siège, demande d’ami, message privé — même app fermée.</p>' +
        '<button id="pushToggleBtn" class="btn wide">' +
          (this.pushSubscribed ? '🔕 Désactiver les notifications' : '🔔 Activer les notifications') +
        '</button>'
        : '') +
      (this.server.remote ? '<button id="logoutBtn" class="btn wide logout-btn">🚪 Se déconnecter</button>' : '');
    if (isAdmin) {
      $('openAdminBtn').addEventListener('click', () => this.showSheet('admin'));
    }
    body.querySelectorAll('[data-title]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const title = btn.dataset.title || null;
        const r = await Promise.resolve(this.server.setActiveTitle(title));
        if (!r.ok) this.toast(r.error);
      });
    });
    const achDetails = body.querySelector('.ach-details');
    if (achDetails) achDetails.addEventListener('toggle', (e) => { this.achievementsOpen = e.target.open; });
    if (this.pushSupported) {
      $('pushToggleBtn').addEventListener('click', () => this.togglePushNotifications());
    }
    if (showCheats) {
      body.querySelectorAll('[data-admin-tier]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const [kind, tier] = btn.dataset.adminTier.split(':');
          const r = await Promise.resolve(this.server.setAdminTier(kind, Number(tier)));
          this.toast(r.ok ? ((kind === 'harvest' ? 'Récolte' : 'Maîtrise arme') + ' fixée à T' + tier) : r.error);
        });
      });
      body.querySelectorAll('[data-admin-gear]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const [slot, tier] = btn.dataset.adminGear.split(':');
          const r = await Promise.resolve(this.server.setAdminGear(slot, Number(tier)));
          this.toast(r.ok ? ((slot === 'weapon' ? 'Arme' : 'Armure') + ' fixée à T' + tier) : r.error);
        });
      });
      $('adminSpawnBossBtn').addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.remote
          ? this.server.dev({ spawnBoss: true })
          : this.server.adminSpawnBoss());
        this.toast(r.ok ? 'Boss invoqué.' : r.error);
      });
      $('profileResetBtn').addEventListener('click', () => {
        if (this.onAdminReset) this.onAdminReset();
      });
      body.querySelector('.profile-admin').addEventListener('toggle', (e) => {
        this.adminOpen = e.target.open;
      });
    }
    if (this.server.remote) {
      $('logoutBtn').addEventListener('click', () => {
        if (this.onLogout) this.onLogout();
      });
    }
    body.querySelectorAll('.char-switch').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.switchCharacter(Number(btn.dataset.char)));
        this.toast(r.ok ? 'Métamorphose !' : r.error);
      });
    });
    body.querySelectorAll('.char-create').forEach((btn) => {
      btn.addEventListener('click', () => this.showCharacterCreatePopup());
    });
    $('profileSkinBtn').addEventListener('click', () => this.showSkinWardrobePopup());
  }

  /* ---------- Administration (rôle admin, multijoueur uniquement) ---------- */
  build_admin(body) {
    const me = this.server.me;
    if (!this.server.remote || !me || me.role !== 'admin') {
      body.innerHTML = '<p class="empty">Accès réservé aux administrateurs.</p>';
      return;
    }
    body.innerHTML = '<p class="dim">Chargement…</p>';
    Promise.all([
      Promise.resolve(this.server.adminStats()),
      Promise.resolve(this.server.adminPlayers()),
    ]).then(([statsRes, playersRes]) => {
      if (this.openSheet !== 'admin') return;   // fermé entre-temps
      if (!statsRes.ok || !playersRes.ok) {
        body.innerHTML = '<p class="empty">' + esc(statsRes.error || playersRes.error || 'Erreur serveur.') + '</p>';
        return;
      }
      this.renderAdminPanel(body, statsRes.stats, playersRes.list);
    });
  }

  renderAdminPanel(body, stats, list) {
    const classEntries = Object.entries(stats.byClass || {})
      .map(([k, n]) => ((CLASSES[k] && CLASSES[k].label) || k) + ' ×' + n)
      .join(' · ');
    const statsHtml =
      '<div class="admin-stats-bar">' +
        '<span><b>' + stats.total + '</b> comptes</span>' +
        '<span><b>' + stats.online + '</b> en ligne</span>' +
        '<span><b>' + stats.admins + '</b> admin' + (stats.admins > 1 ? 's' : '') + '</span>' +
      '</div>' +
      (classEntries ? '<p class="dim small admin-class-breakdown">' + esc(classEntries) + '</p>' : '');

    body.innerHTML =
      statsHtml +
      '<div class="section-divider">✦</div>' +
      '<div class="admin-player-list">' + list.map((p) => this.adminPlayerRow(p)).join('') + '</div>';

    body.querySelectorAll('.admin-player').forEach((det) => {
      det.addEventListener('toggle', (e) => {
        this.adminExpandedUser = e.target.open ? e.target.dataset.username : null;
      });
    });
    body.querySelectorAll('[data-admin-role-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.adminSetRole(btn.dataset.adminRoleToggle, btn.dataset.nextRole));
        this.toast(r.ok ? 'Rôle mis à jour.' : r.error);
        if (r.ok) this.showSheet('admin');
      });
    });
    body.querySelectorAll('[data-admin-slot]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.adminGrantSlot(btn.dataset.adminSlot, 1));
        this.toast(r.ok ? '+1 emplacement de personnage.' : r.error);
        if (r.ok) this.showSheet('admin');
      });
    });
    body.querySelectorAll('.admin-grant-form').forEach((form) => {
      const username = form.dataset.username;
      const whatSel = form.querySelector('[data-role="what"]');
      const tierSel = form.querySelector('[data-role="tier"]');
      const qtyInput = form.querySelector('[data-role="qty"]');
      form.querySelector('[data-role="submit"]').addEventListener('click', async () => {
        const what = whatSel.value;
        const tier = Number(tierSel.value);
        const qty = Math.max(1, Number(qtyInput.value) || 1);
        let r;
        if (what === 'gold') r = await Promise.resolve(this.server.adminGrantGold(username, qty));
        else if (what === 'premium') r = await Promise.resolve(this.server.adminGrantPremium(username, qty));
        else if (what === 'level:harvest') r = await Promise.resolve(this.server.adminSetLevel(username, 'harvest', tier));
        else if (what === 'level:weapon') r = await Promise.resolve(this.server.adminSetLevel(username, 'weapon', tier));
        else if (what === 'gear:weapon') r = await Promise.resolve(this.server.adminSetGear(username, 'weapon', tier));
        else if (what === 'gear:armor') r = await Promise.resolve(this.server.adminSetGear(username, 'armor', tier));
        else if (what.indexOf('item:') === 0) r = await Promise.resolve(this.server.adminGrantItem(username, stackKey(what.slice(5), tier), qty));
        this.toast((r && r.ok) ? 'Attribution effectuée.' : ((r && r.error) || 'Erreur serveur.'));
        if (r && r.ok) this.showSheet('admin');
      });
    });
  }

  adminPlayerRow(p) {
    const isOpen = this.adminExpandedUser === p.username;
    const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleDateString('fr-FR') : '?';
    return (
      '<details class="admin-player"' + (isOpen ? ' open' : '') + ' data-username="' + esc(p.username) + '">' +
        '<summary>' +
          '<span class="admin-dot ' + (p.online ? 'on' : 'off') + '"></span>' +
          '<span class="admin-player-name">' + esc(p.username) + '</span>' +
          (p.role === 'admin' ? '<span class="role-chip">Admin</span>' : '') +
          '<span class="dim small admin-player-meta">' + esc(p.classLabel || '') + ' · Récolte ' + p.harvestLevel + ' · Arme ' + p.weaponMastery + ' · ' + this.currencyIcon('gold', 'small') + ' ' + (p.gold || 0) + ' · ' + this.currencyIcon('premium', 'small') + ' ' + (p[PREMIUM_CURRENCY.key] || 0) + '</span>' +
        '</summary>' +
        '<div class="admin-player-body">' +
          '<p class="dim small">Inscrit le ' + dateStr + ' · ' + p.charCount + ' personnage(s) / ' + p.charSlots + ' emplacement(s) (max ' + MAX_CHAR_SLOTS + ') · arme T' + p.weaponTier + ' · armure T' + p.armorTier + '</p>' +
          '<div class="admin-row-actions">' +
            '<button class="btn" data-admin-role-toggle="' + esc(p.username) + '" data-next-role="' + (p.role === 'admin' ? 'user' : 'admin') + '">' +
              (p.role === 'admin' ? 'Rétrograder utilisateur' : 'Promouvoir admin') +
            '</button>' +
            '<button class="btn" data-admin-slot="' + esc(p.username) + '"' + (p.charSlots >= MAX_CHAR_SLOTS ? ' disabled' : '') + '>+1 emplacement perso</button>' +
          '</div>' +
          this.adminGrantForm(p.username) +
        '</div>' +
      '</details>'
    );
  }

  adminGrantForm(username) {
    const resourceOptions = Object.keys(RESOURCES)
      .map((t) => '<option value="item:' + t + '">' + RESOURCES[t].label + '</option>').join('');
    const consumableOptions = Object.keys(CONSUMABLES)
      .map((t) => '<option value="item:' + t + '">' + CONSUMABLES[t].label + '</option>').join('');
    const tierOptions = [0, 1, 2, 3, 4, 5, 6]
      .map((t) => '<option value="' + t + '"' + (t === 1 ? ' selected' : '') + '>T' + t + '</option>').join('');
    return (
      '<div class="admin-grant-form" data-username="' + esc(username) + '">' +
        '<select class="admin-select admin-select-what" data-role="what">' +
          '<optgroup label="Compte">' +
            '<option value="gold">Or</option>' +
            '<option value="premium">' + PREMIUM_CURRENCY.label + '</option>' +
          '</optgroup>' +
          '<optgroup label="Progression">' +
            '<option value="level:harvest">⛏ Niveau de récolte</option>' +
            '<option value="level:weapon">⚔ Maîtrise d’arme</option>' +
            '<option value="gear:weapon">🗡 Tier d’arme</option>' +
            '<option value="gear:armor">🛡 Tier d’armure</option>' +
          '</optgroup>' +
          '<optgroup label="Ressources">' + resourceOptions + '</optgroup>' +
          '<optgroup label="Consommables">' + consumableOptions + '</optgroup>' +
        '</select>' +
        '<select class="admin-select admin-select-tier" data-role="tier">' + tierOptions + '</select>' +
        '<input class="admin-select admin-qty" data-role="qty" type="number" min="1" max="999" value="1">' +
        '<button class="btn primary" data-role="submit">Donner</button>' +
      '</div>'
    );
  }

  /* ---------- La Marmite : cuisine des consommables ---------- */

  canCook(me, tier) {
    const recipe = CONSUMABLE_RECIPES[tier];
    if (!recipe) return false;
    for (const [k, n] of Object.entries(recipe)) {
      if (k === 'gold') { if ((me.gold || 0) < n) return false; }
      else if ((me.inventory[k] || 0) < n) return false;
    }
    return true;
  }

  recipeLines(me, tier) {
    const recipe = CONSUMABLE_RECIPES[tier];
    return Object.entries(recipe).map(([k, n]) => {
      if (k === 'gold') {
        const ok = (me.gold || 0) >= n;
        return '<li class="' + (ok ? 'ok-c' : 'hp-c') + '">' + n + ' ' + this.currencyIcon('gold', 'small') + ' <span class="dim">(' + (me.gold || 0) + ')</span></li>';
      }
      const r = parseStackKey(k);
      const have = me.inventory[k] || 0;
      return '<li class="' + (have >= n ? 'ok-c' : 'hp-c') + '">' + n + '× ' + resourceLabel(r.type, r.tier) + ' <span class="dim">(' + have + '/' + n + ')</span></li>';
    }).join('');
  }

  build_marmite(body) {
    const me = this.server.me;
    let html =
      '<p class="dim">Les ingrédients viennent du Marais (et parfois des monstres vaincus) ; ' +
      'les plantes, de la récolte. Un seul buff de nourriture actif à la fois — les potions sont instantanées.</p>' +
      (me.buff
        ? '<p class="ok-c">' + CONSUMABLES[me.buff.type].icon + ' Actif : ' + CONSUMABLES[me.buff.type].label +
          ' T' + me.buff.tier + ' (' + me.buff.combats + ' combats restants)</p>'
        : '');
    for (const [type, item] of Object.entries(CONSUMABLES)) {
      // Seuls les plats cuisinés (buff/instant) se préparent à la Marmite —
      // le Parchemin d'Endurance s'achète à la Boutique contre des Écailles
      // Lunaires, il n'a pas de recette CONSUMABLE_RECIPES.
      if (item.kind !== 'buff' && item.kind !== 'instant') continue;
      const itemSrc = this.getConsumableTargetSrc(type);
      let tiersHtml = '';
      for (let t = 1; t <= 6; t++) {
        tiersHtml += '<button class="btn cook-btn" data-cook="' + type + ':' + t + '"' +
          (this.canCook(me, t) ? '' : ' disabled') + '>T' + t + '</button>';
      }
      html +=
        '<div class="upg cook-item">' +
          '<div class="upg-head"><b>' +
            (itemSrc ? '<img class="cook-item-icon" src="' + itemSrc + '" alt=""> ' : item.icon + ' ') +
            item.label +
          '</b><span class="role-chip">' + item.role + '</span></div>' +
          '<p class="dim small">' + consumableDesc(type, 1) + ' … ' + consumableDesc(type, 6) + '</p>' +
          '<div class="cook-tiers">' + tiersHtml + '</div>' +
        '</div>';
    }
    html += '<p class="dim small">Recette Tn : 2× Ingrédient Tn + 2× Plante Tn + or. ' +
      'Le T6 exige la Tourbe vivante du donjon des marais.</p>';
    body.innerHTML = html;

    body.querySelectorAll('[data-cook]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [type, tierStr] = btn.dataset.cook.split(':');
        const tier = Number(tierStr);
        const item = CONSUMABLES[type];
        this.confirm(
          item.icon + ' Cuisiner ' + item.label + ' T' + tier + ' ?',
          '<p>' + consumableDesc(type, tier) + '.</p><ul class="upg-needs">' + this.recipeLines(me, tier) + '</ul>',
          'Cuisiner',
          async () => {
            const r = await Promise.resolve(this.server.cook(type, tier));
            if (!r.ok) this.toast(r.error);
          }
        );
      });
    });
  }

  /* ---------- Personnages multiples (formes) ---------- */

  /* ---------- Hauts faits ---------- */
  buildAchievementsSectionHtml(me) {
    const unlockedSet = new Set(me.unlockedAchievements || []);
    const totalCount = ACHIEVEMENTS.length;
    const unlockedCount = unlockedSet.size;

    const byCategory = {};
    for (const a of ACHIEVEMENTS) {
      (byCategory[a.category] = byCategory[a.category] || []).push(a);
    }
    const rows = Object.entries(byCategory).map(([cat, list]) => {
      const items = list.map((a) => {
        const done = unlockedSet.has(a.id);
        const reward = a.reward || {};
        const bits = [];
        if (reward.gold) bits.push(reward.gold + ' or');
        if (reward.moonstones) bits.push(reward.moonstones + ' ' + PREMIUM_CURRENCY.label.toLowerCase());
        if (reward.title) bits.push('titre « ' + reward.title + ' »');
        return '<div class="ach-item' + (done ? ' unlocked' : '') + '">' +
          '<span class="ach-status">' + (done ? '✓' : '—') + '</span>' +
          '<span class="ach-copy"><b>' + esc(a.label) + '</b>' +
          (bits.length ? '<small>' + esc(bits.join(' · ')) + '</small>' : '') +
          '</span>' +
        '</div>';
      }).join('');
      return '<div class="ach-cat">' + esc(cat) + '</div><div class="ach-list">' + items + '</div>';
    }).join('');

    const titles = me.titles || [];
    const titlePicker = titles.length ?
      '<p class="dim small">Titre affiché sous votre pseudo :</p>' +
      '<div class="title-picker">' +
        '<button class="btn title-chip' + (!me.activeTitle ? ' active' : '') + '" data-title="">Aucun</button>' +
        titles.map((t) => '<button class="btn title-chip' + (me.activeTitle === t ? ' active' : '') +
          '" data-title="' + esc(t) + '">' + esc(t) + '</button>').join('') +
      '</div>'
      : '<p class="dim small">Débloquez des hauts faits pour gagner des titres à afficher sous votre pseudo.</p>';

    return '<div class="profile-sec-title">Hauts faits <span class="sec-count">' + unlockedCount + ' / ' + totalCount + '</span></div>' +
      titlePicker +
      '<details class="ach-details"' + (this.achievementsOpen ? ' open' : '') + '>' +
        '<summary>Voir la liste des hauts faits</summary>' +
        rows +
      '</details>';
  }

  buildCharactersSection(me) {
    if (!Array.isArray(me.characters)) return '';
    const cards = [];
    for (let i = 0; i < me.characters.length; i++) {
      // La forme active vit "à plat" sur le joueur ; les autres dans leur slot
      const c = i === me.activeChar ? me : me.characters[i];
      const cls = CLASSES[c.speciesClass];
      cards.push(
        '<div class="char-card' + (i === me.activeChar ? ' active' : '') + '">' +
          this.spriteAvatar(c.speciesClass, '', c.skinId) +
          '<span class="char-info">' +
            '<b>' + cls.label + ' <span class="role-chip">' + cls.role + '</span></b>' +
            '<small>Maîtrise T' + c.weaponMastery + ' · Récolte T' + c.harvestLevel +
            ' · Arme T' + c.weapon.tier + ' · Armure T' + c.armor.tier +
            ' · ' + esc((skinFor(c.skinId) || {}).label || 'Base') + '</small>' +
          '</span>' +
          (i === me.activeChar
            ? '<span class="char-active-badge">Actif</span>'
            : '<button class="btn char-switch" data-char="' + i + '">Incarner</button>') +
        '</div>'
      );
    }
    for (let i = me.characters.length; i < me.charSlots; i++) {
      cards.push(
        '<button class="char-card empty char-create"><span><span class="char-plus">+</span> Éveiller une nouvelle forme</span>' +
        '<small>Gratuit — à la Capitale ou dans un village</small></button>'
      );
    }
    if (me.charSlots < MAX_CHAR_SLOTS) {
      cards.push(
        '<div class="char-card locked">🔒 Emplacement supplémentaire' +
        '<small>Bientôt disponible en boutique</small></div>'
      );
    }
    return '<div class="chars-section">' +
      '<div class="profile-sec-title">Mes personnages <span class="sec-count">' +
        me.characters.length + ' / ' + me.charSlots + '</span></div>' +
      '<p class="dim small">PA, PV et inventaire sont partagés ; chaque forme garde ses maîtrises et son équipement. ' +
      'La métamorphose se fait à la Capitale ou dans un village.</p>' +
      '<div class="char-list">' + cards.join('') + '</div>' +
    '</div>';
  }

  showCharacterCreatePopup() {
    const me = this.server.me;
    const owned = new Set(me.characters.map((c) => c.speciesClass));
    const wrap = $('popup');
    wrap.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'popup-card';
    card.innerHTML =
      '<h3>Éveiller une nouvelle forme</h3>' +
      '<div class="popup-body">' +
        '<p class="dim">Chaque forme progresse séparément (maîtrises, équipement). ' +
        'L’inventaire, l’endurance et les PV restent partagés — et le choix est définitif.</p>' +
        '<div class="class-grid"></div>' +
      '</div>';
    const grid = card.querySelector('.class-grid');
    for (const [key, c] of Object.entries(CLASSES)) {
      if (owned.has(key)) continue;
      const btn = document.createElement('button');
      btn.className = 'class-card';
      btn.innerHTML =
        this.spriteAvatar(key) +
        '<span class="class-info"><b>' + c.label + ' <span class="role-chip">' + c.role + '</span></b>' +
        '<small>' + c.bonus + '</small></span>';
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.createCharacter(key));
        if (!r.ok) { this.toast(r.error); return; }
        this.toast(c.label + ' éveillé !');
        this.closePopup();
      });
      grid.appendChild(btn);
    }
    const row = document.createElement('div');
    row.className = 'popup-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Annuler';
    cancel.addEventListener('click', () => this.closePopup());
    row.appendChild(cancel);
    card.appendChild(row);
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
  }

  showSkinWardrobePopup() {
    const me = this.server.me;
    const ownedIds = new Set(me.ownedSkins || []);
    const available = SKIN_SHOP_ITEMS.filter((item) => item.speciesClass === me.speciesClass && ownedIds.has(item.id));
    const wrap = $('popup');
    wrap.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'popup-card';
    card.innerHTML =
      '<h3>Garde-robe</h3>' +
      '<div class="popup-body">' +
        '<p class="dim">Choisissez l’apparence de votre forme active: <b>' + esc((CLASSES[me.speciesClass] || {}).label || me.speciesClass) + '</b>.</p>' +
        '<div class="shop-grid wardrobe-grid"></div>' +
      '</div>';
    const grid = card.querySelector('.wardrobe-grid');

    const base = document.createElement('button');
    base.className = 'shop-card wardrobe-card' + (!me.skinId ? ' equipped' : '');
    base.innerHTML =
      '<div class="shop-card-art wardrobe-art">' + this.wardrobePreview(me.speciesClass, null) + '</div>' +
      '<div class="shop-card-copy">' +
        '<div class="shop-card-top"><b>Tenue de base</b><span class="role-chip">Standard</span></div>' +
        '<div class="shop-card-state">' + (!me.skinId ? 'Équipée' : 'Disponible') + '</div>' +
      '</div>' +
      '<div class="shop-card-actions"><span class="btn ' + (!me.skinId ? '' : 'primary ') + 'shop-btn">' + (!me.skinId ? 'Actuelle' : 'Équiper') + '</span></div>';
    base.addEventListener('click', async () => {
      const r = await Promise.resolve(this.server.equipSkin(null));
      this.toast(r.ok ? 'Apparence mise à jour.' : r.error);
      if (r.ok) this.closePopup();
    });
    grid.appendChild(base);

    for (const item of available) {
      const owned = document.createElement('button');
      owned.className = 'shop-card wardrobe-card' + (me.skinId === item.id ? ' equipped owned' : ' owned');
      owned.innerHTML =
        '<div class="shop-card-art wardrobe-art">' + this.wardrobePreview(me.speciesClass, item.id) + '</div>' +
        '<div class="shop-card-copy">' +
          '<div class="shop-card-top"><b>' + esc(item.label) + '</b><span class="role-chip">Possédé</span></div>' +
          '<div class="shop-card-state">' + (me.skinId === item.id ? 'Équipé' : 'Cliquer pour équiper') + '</div>' +
        '</div>' +
        '<div class="shop-card-actions"><span class="btn ' + (me.skinId === item.id ? '' : 'primary ') + 'shop-btn">' + (me.skinId === item.id ? 'Actuel' : 'Équiper') + '</span></div>';
      owned.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.equipSkin(item.id));
        this.toast(r.ok ? 'Apparence mise à jour.' : r.error);
        if (r.ok) this.closePopup();
      });
      grid.appendChild(owned);
    }

    if (!available.length) {
      const empty = document.createElement('div');
      empty.className = 'upg';
      empty.innerHTML = '<p>Aucun skin possédé pour cette forme pour le moment.</p><p class="dim">Passe par la boutique pour débloquer des apparences.</p>';
      card.querySelector('.popup-body').appendChild(empty);
    }

    const row = document.createElement('div');
    row.className = 'popup-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Fermer';
    closeBtn.addEventListener('click', () => this.closePopup());
    row.appendChild(closeBtn);
    card.appendChild(row);
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
    this.popupMode = 'generic';
  }

  xpBar(label, lvl, xp) {
    if (lvl >= 6) {
      return '<div class="xp"><div class="xp-head"><span>' + label + '</span><span class="tier t6">T6 — max</span></div>' +
        '<div class="xp-track"><div class="xp-fill" style="width:100%"></div></div></div>';
    }
    const prev = XP_LEVELS[lvl - 1], next = XP_LEVELS[lvl];
    const frac = Math.max(0, Math.min(1, (xp - prev) / (next - prev)));
    return '<div class="xp"><div class="xp-head"><span>' + label + '</span>' +
      '<span><span class="tier t' + lvl + '">T' + lvl + '</span> <span class="dim">' + xp + ' / ' + next + ' XP</span></span></div>' +
      '<div class="xp-track"><div class="xp-fill" style="width:' + (frac * 100) + '%"></div></div></div>';
  }

  build_map(body) {
    body.innerHTML =
      '<canvas id="minimap" width="320" height="320"></canvas>' +
      '<div class="legend">' +
        '<span><i class="legend-mark legend-capital"></i>Capitale</span>' +
        '<span><i class="legend-mark legend-village"></i>Village</span>' +
        '<span><i class="legend-mark legend-dungeon"></i>Donjon</span>' +
        '<span><i class="legend-mark legend-me"></i>Vous</span>' +
      '</div>' +
      '<p class="dim small">Le fond de la minimap reprend le biome exploré, teinté par le tier de la zone ' +
      '(T1 gris → T5 or). Les villages et donjons remplacent désormais les anciens repères de ressources et de monstres.</p>';
    this.renderer.drawMinimap($('minimap'));
  }

  build_social(body) {
    const me = this.server.me;
    body.innerHTML = '<p class="dim">Chargement…</p>';
    Promise.all([
      me.guildId ? Promise.resolve(this.server.guildInfo()) : Promise.resolve({ ok: false }),
      Promise.resolve(this.server.friendsList()),
      me.guildId ? Promise.resolve(this.server.castlesInfo()) : Promise.resolve({ ok: false }),
    ]).then(([guildRes, friendsRes, castlesRes]) => {
      if (this.openSheet !== 'social') return;   // fermé entre-temps
      this.renderSocial(
        body, me,
        (guildRes && guildRes.ok) ? guildRes.guild : null,
        (friendsRes && friendsRes.ok) ? friendsRes.list : [],
        (castlesRes && castlesRes.ok) ? castlesRes.list : []
      );
    });
  }

  // Changer d'onglet de discussion (ou de destinataire de MP) est un pur
  // changement d'affichage local : on rappelle renderSocial directement avec
  // les données déjà en mémoire plutôt que showSheet('social'), qui repasse
  // par « Chargement… » et re-fetch guilde/amis — ça évitait le clignotement
  // à chaque changement d'onglet.
  renderSocial(body, me, guild, friends, castles) {
    // L'onglet actif est sous les yeux : plus la peine d'y signaler du non-lu.
    this.chatUnread[this.chatChannel] = false;
    this.markChatSeen(this.chatChannel);

    const tabs = [
      { key: 'general', label: 'Général' },
      { key: 'guild', label: 'Guilde' },
      { key: 'whisper', label: 'MP' },
    ];
    const tabsHtml = '<div class="chat-tabs">' +
      tabs.map((t) => '<button class="chat-tab' + (this.chatChannel === t.key ? ' active' : '') + '" data-chat-tab="' + t.key + '">' +
        t.label + '<span class="chat-tab-badge' + (this.chatUnread[t.key] ? '' : ' hidden') + '"></span></button>').join('') +
    '</div>';

    let whisperBarHtml = '';
    if (this.chatChannel === 'whisper') {
      if (!friends.length) {
        whisperBarHtml = '<p class="dim small chat-whisper-hint">Ajoutez un ami pour lui écrire en privé.</p>';
        this.chatWhisperTarget = null;
      } else {
        if (!this.chatWhisperTarget || !friends.some((f) => f.username === this.chatWhisperTarget)) {
          this.chatWhisperTarget = friends[0].username;
        }
        whisperBarHtml = '<div class="chat-whisper-bar"><select id="whisperTargetSelect">' +
          friends.map((f) => '<option value="' + esc(f.username) + '"' + (f.username === this.chatWhisperTarget ? ' selected' : '') + '>' +
            (f.online ? '🟢 ' : '⚪ ') + esc(f.username) + '</option>').join('') +
        '</select></div>';
      }
    }

    const canType = this.chatChannel !== 'whisper' ? true : !!(this.chatWhisperTarget && friends.length);
    const placeholder = this.chatChannel === 'general' ? 'Écrire dans le canal général…'
      : this.chatChannel === 'guild' ? (guild ? 'Écrire à la guilde…' : 'Rejoignez une guilde pour discuter ici')
      : (this.chatWhisperTarget ? ('Écrire à ' + this.chatWhisperTarget + '…') : 'Choisissez un ami…');

    body.innerHTML =
      tabsHtml +
      whisperBarHtml +
      '<div id="feed" class="feed"></div>' +
      '<div class="chat-row">' +
        '<input id="chatInput" type="text" maxlength="120" placeholder="' + esc(placeholder) + '"' + (canType ? '' : ' disabled') + ' autocomplete="off">' +
        '<button id="chatSend" class="btn primary"' + (canType ? '' : ' disabled') + '>Envoyer</button>' +
      '</div>' +
      '<div class="section-divider">✦</div>' +
      this.buildGuildSectionHtml(me, guild, castles) +
      '<div class="section-divider">✦</div>' +
      this.buildFriendsSectionHtml(me, friends);

    this.renderFeed();

    body.querySelectorAll('[data-chat-tab]').forEach((btn) => {
      btn.addEventListener('click', () => { this.chatChannel = btn.dataset.chatTab; this.renderSocial(body, me, guild, friends, castles); });
    });
    const whisperSelect = $('whisperTargetSelect');
    if (whisperSelect) {
      whisperSelect.addEventListener('change', () => {
        this.chatWhisperTarget = whisperSelect.value;
        this.renderSocial(body, me, guild, friends, castles);
      });
    }

    const send = () => {
      const input = $('chatInput');
      const text = input.value.trim();
      if (!text || !canType) return;
      input.value = '';
      const target = this.chatChannel === 'whisper' ? this.chatWhisperTarget : undefined;
      Promise.resolve(this.server.say(text, this.chatChannel, target)).then((r) => {
        if (!r.ok) this.toast(r.error);
      });
    };
    $('chatSend').addEventListener('click', send);
    $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    this.wireGuildSection(body);
    this.wireFriendsSection(body);
    this.updateChatBadges();

    if (typeof this.pendingSocialScrollTop === 'number') {
      body.scrollTop = this.pendingSocialScrollTop;
      this.pendingSocialScrollTop = null;
    }
  }

  /* ---------- Guilde ---------- */
  buildGuildSectionHtml(me, guild, castles) {
    if (me.guildInvite) {
      return '<div class="profile-sec-title">Guilde</div>' +
        '<div class="invite-card">' +
          '<p>' + esc(me.guildInvite.fromUsername) + ' vous invite dans <b>' + esc(me.guildInvite.guildName) + '</b>.</p>' +
          '<div class="admin-row-actions">' +
            '<button class="btn" id="guildInviteDecline">Refuser</button>' +
            '<button class="btn primary" id="guildInviteAccept">Rejoindre</button>' +
          '</div>' +
        '</div>';
    }
    if (!guild) {
      return '<div class="profile-sec-title">Guilde</div>' +
        '<p class="dim small">Fondez une guilde pour coopérer et discuter en privé avec vos alliés.</p>' +
        '<div class="chat-row">' +
          '<input id="guildNameInput" type="text" maxlength="24" placeholder="Nom de la guilde…">' +
          '<button id="guildCreateBtn" class="btn primary">Fonder</button>' +
        '</div>';
    }
    const isLeader = guild.leaderId === me.id;
    const rows = guild.members.map((m) => (
      '<div class="friend-row">' +
        '<span class="admin-dot ' + (m.online ? 'on' : 'off') + '"></span>' +
        '<span class="friend-name">' + esc(m.username) + (m.isLeader ? ' <span class="role-chip">Chef</span>' : '') + '</span>' +
        '<span class="dim small friend-class">' + esc(m.classLabel) + '</span>' +
        (isLeader && !m.isLeader ? '<button class="btn btn-small" data-guild-kick="' + esc(m.username) + '">Exclure</button>' : '') +
      '</div>'
    )).join('');
    const owned = (castles || []).filter((c) => c.isOwnGuild);
    const castlesHtml = '<div class="profile-sec-title">Châteaux <span class="sec-count">' + owned.length + '</span></div>' +
      (owned.length
        ? '<div class="castle-owned-list">' + owned.map((c) => {
            const pct = c.hpMax ? Math.max(0, Math.min(100, Math.round(100 * c.hp / c.hpMax))) : 0;
            return '<div class="castle-owned-row">' +
              '<div class="castle-owned-head">' +
                '<span class="castle-owned-name">' + esc(this.terrainLabel(c.terrain)) + '</span>' +
                '<span class="castle-badges">' +
                  '<span class="tier t' + c.level + '">Niv. ' + c.level + ' / ' + c.maxLevel + '</span>' +
                  '<span class="tier t' + (c.fortLevel || 0) + '">🛡 ' + (c.fortLevel || 0) + ' / ' + c.maxFortLevel + '</span>' +
                '</span>' +
              '</div>' +
              '<div class="xp-track"><div class="xp-fill" style="width:' + pct + '%"></div></div>' +
              '<p class="dim small">' + c.hp + ' / ' + c.hpMax + ' PS</p>' +
            '</div>';
          }).join('') + '</div>'
        : '<p class="dim small">Aucun château détenu pour l’instant.</p>');
    return '<div class="profile-sec-title">Guilde <span class="sec-count">' + guild.members.length + ' / ' + guild.maxMembers + '</span></div>' +
      '<div class="hero-name guild-name">' + esc(guild.name) + '</div>' +
      '<div class="friend-list">' + rows + '</div>' +
      (isLeader ? '<div class="chat-row"><input id="guildInviteInput" type="text" maxlength="16" placeholder="Pseudo à inviter…"><button id="guildInviteBtn" class="btn primary">Inviter</button></div>' : '') +
      '<button class="btn wide danger" id="guildLeaveBtn">Quitter la guilde</button>' +
      '<div class="section-divider">✦</div>' +
      castlesHtml;
  }

  wireGuildSection(body) {
    const acceptBtn = $('guildInviteAccept');
    if (acceptBtn) acceptBtn.addEventListener('click', async () => {
      const r = await Promise.resolve(this.server.respondGuildInvite(true));
      if (!r.ok) this.toast(r.error); else this.showSheet('social');
    });
    const declineBtn = $('guildInviteDecline');
    if (declineBtn) declineBtn.addEventListener('click', async () => {
      const r = await Promise.resolve(this.server.respondGuildInvite(false));
      if (!r.ok) this.toast(r.error); else this.showSheet('social');
    });
    const createBtn = $('guildCreateBtn');
    if (createBtn) createBtn.addEventListener('click', async () => {
      const input = $('guildNameInput');
      const name = input.value.trim();
      if (!name) return;
      const r = await Promise.resolve(this.server.createGuild(name));
      if (!r.ok) this.toast(r.error); else this.showSheet('social');
    });
    const inviteBtn = $('guildInviteBtn');
    if (inviteBtn) inviteBtn.addEventListener('click', async () => {
      const input = $('guildInviteInput');
      const username = input.value.trim();
      if (!username) return;
      const r = await Promise.resolve(this.server.inviteToGuild(username));
      this.toast(r.ok ? 'Invitation envoyée.' : r.error);
      if (r.ok) input.value = '';
    });
    body.querySelectorAll('[data-guild-kick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.kickFromGuild(btn.dataset.guildKick));
        if (!r.ok) this.toast(r.error); else this.showSheet('social');
      });
    });
    const leaveBtn = $('guildLeaveBtn');
    if (leaveBtn) leaveBtn.addEventListener('click', () => {
      this.confirm('Quitter la guilde ?', '<p>Vous devrez être réinvité pour la rejoindre à nouveau.</p>', 'Quitter', async () => {
        const r = await Promise.resolve(this.server.leaveGuild());
        if (!r.ok) this.toast(r.error); else this.showSheet('social');
      });
    });
  }

  /* ---------- Amis ---------- */
  buildFriendsSectionHtml(me, friends) {
    const requests = (me.friendRequests || []).map((r) => (
      '<div class="invite-card">' +
        '<p>' + esc(r.fromUsername) + ' souhaite devenir votre ami.</p>' +
        '<div class="admin-row-actions">' +
          '<button class="btn" data-friend-decline="' + esc(r.fromId) + '">Refuser</button>' +
          '<button class="btn primary" data-friend-accept="' + esc(r.fromId) + '">Accepter</button>' +
        '</div>' +
      '</div>'
    )).join('');
    const rows = friends.map((f) => (
      '<div class="friend-row">' +
        '<span class="admin-dot ' + (f.online ? 'on' : 'off') + '"></span>' +
        '<span class="friend-name">' + esc(f.username) + '</span>' +
        '<span class="dim small friend-class">' + esc(f.classLabel) + '</span>' +
        '<button class="btn btn-small" data-friend-remove="' + esc(f.username) + '">Retirer</button>' +
      '</div>'
    )).join('');
    return '<div class="profile-sec-title">Amis <span class="sec-count">' + friends.length + '</span></div>' +
      requests +
      (friends.length ? '<div class="friend-list">' + rows + '</div>' : '<p class="dim small">Aucun ami pour l’instant.</p>') +
      '<div class="chat-row"><input id="friendAddInput" type="text" maxlength="16" placeholder="Ajouter un ami (pseudo)…"><button id="friendAddBtn" class="btn primary">Ajouter</button></div>';
  }

  wireFriendsSection(body) {
    body.querySelectorAll('[data-friend-accept]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.respondFriendRequest(btn.dataset.friendAccept, true));
        if (!r.ok) this.toast(r.error); else this.showSheet('social');
      });
    });
    body.querySelectorAll('[data-friend-decline]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.respondFriendRequest(btn.dataset.friendDecline, false));
        if (!r.ok) this.toast(r.error); else this.showSheet('social');
      });
    });
    body.querySelectorAll('[data-friend-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.removeFriend(btn.dataset.friendRemove));
        if (!r.ok) this.toast(r.error); else this.showSheet('social');
      });
    });
    const addBtn = $('friendAddBtn');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const input = $('friendAddInput');
      const username = input.value.trim();
      if (!username) return;
      const r = await Promise.resolve(this.server.sendFriendRequest(username));
      this.toast(r.ok ? (r.addedDirectly ? 'Vous êtes maintenant amis !' : 'Demande envoyée.') : r.error);
      if (r.ok) { input.value = ''; this.showSheet('social'); }
    });
  }

  build_capital(body) {
    const me = this.server.me;
    body.innerHTML =
      '<p class="dim">Zone neutre absolue. Les PNJ Artisans (T1 à T6) y tiennent boutique.</p>' +
      '<button id="restBtn" class="btn wide">⛲ Se reposer à la fontaine — PV restaurés (gratuit)</button>' +
      '<button id="travelBtn" class="btn wide">🌀 Réseau de téléporteurs</button>' +
      '<button id="marmiteBtn" class="btn wide">🍲 La Marmite — cuisine & buffs</button>' +
      this.upgradeCard('weapon') +
      this.upgradeCard('armor') +
      this.engineCraftSection();
    $('restBtn').addEventListener('click', async () => {
      const r = await Promise.resolve(this.server.rest());
      if (!r.ok) this.toast(r.error);
    });
    $('travelBtn').addEventListener('click', () => this.showFastTravelPopupFromCapital());
    $('marmiteBtn').addEventListener('click', () => this.showSheet('marmite'));
    body.querySelectorAll('[data-upgrade]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.upgrade(btn.dataset.upgrade));
        this.toast(r.ok ? 'Amélioration réussie !' : r.error);
      });
    });
    body.querySelectorAll('[data-craft-engine]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.craftSiegeEngine(Number(btn.dataset.craftEngine)));
        this.toast(r.ok ? '⚙ Engin de siège construit !' : r.error);
        if (r.ok) this.showSheet('capital');
      });
    });
  }

  engineCraftSection() {
    const me = this.server.me;
    const rows = [1, 2, 3, 4, 5].map((t) => {
      const engine = SIEGE_ENGINES[t];
      const recipe = SIEGE_ENGINE_RECIPES[t];
      const have = me.inventory[stackKey(SIEGE_ENGINE_ITEM, t)] || 0;
      let allOk = true;
      const parts = Object.entries(recipe).map(([k, n]) => {
        if (k === 'gold') {
          const ok = (me.gold || 0) >= n;
          if (!ok) allOk = false;
          return '<span class="' + (ok ? 'ok-c' : 'hp-c') + '">' + n + ' ' + this.currencyIcon('gold', 'small') + '</span>';
        }
        const r = parseStackKey(k);
        const ok = (me.inventory[k] || 0) >= n;
        if (!ok) allOk = false;
        return '<span class="' + (ok ? 'ok-c' : 'hp-c') + '">' + n + '× ' + esc(resourceLabel(r.type, r.tier)) + '</span>';
      });
      return '<div class="upg siege-engine-card">' +
        '<img class="siege-engine-art" src="' + engine.asset + '" alt="' + esc(engine.label) + '">' +
        '<div class="siege-engine-copy">' +
          '<div class="upg-head"><b>' + esc(engine.label) + ' · T' + t + '</b><span class="dim small">en stock : ' + have + '</span></div>' +
          '<p class="dim small">' + parts.join(' · ') + '</p>' +
          '<p class="dim small">En siège : +' + SIEGE_ENGINE_FORCE[t] + ' force, +' + SIEGE_ENGINE_DAMAGE[t] + ' PS garantis.</p>' +
          '<button class="btn wide" data-craft-engine="' + t + '"' + (allOk ? '' : ' disabled') + '>⚙ Construire</button>' +
        '</div>' +
      '</div>';
    }).join('');
    return '<div class="profile-sec-title">Ingénierie de siège</div>' +
      '<p class="dim small">Prépare une attaque de château à l’avance — les engins se déploient (1 par personne) en rejoignant un siège.</p>' +
      rows;
  }

  upgradeCard(slot) {
    const me = this.server.me;
    const item = me[slot];
    const name = slot === 'weapon' ? item.type : 'Armure de ' + item.type;
    const art = equipmentAsset(slot, item.type);
    const target = item.tier + 1;
    if (target > 6) {
      return '<div class="upg equipment-upgrade-card">' +
        '<img class="equipment-art" src="' + art + '" alt="' + esc(name) + '">' +
        '<div class="equipment-copy"><div class="upg-head"><b>' + name + '</b><span class="tier t6">T6 — max</span></div>' +
        '<p class="dim">Tier maximum atteint.</p></div></div>';
    }
    const recipe = UPGRADE_RECIPES[slot][target];
    const paCost = CONFIG.COSTS.UPGRADE[target];
    let allOk = true;
    const needs = Object.entries(recipe).map(([k, n]) => {
      const p = parseStackKey(k);
      const have = me.inventory[k] || 0;
      const ok = have >= n;
      if (!ok) allOk = false;
      return '<li class="' + (ok ? 'ok-c' : 'hp-c') + '">' + n + '× ' + resourceLabel(p.type, p.tier) +
        ' <span class="dim">(' + have + '/' + n + ')</span></li>';
    });
    const masteryOk = me.weaponMastery >= target;
    if (!masteryOk) allOk = false;
    const paOk = me.pa >= paCost;
    if (!paOk) allOk = false;

    return '<div class="upg equipment-upgrade-card">' +
      '<img class="equipment-art" src="' + art + '" alt="' + esc(name) + '">' +
      '<div class="equipment-copy">' +
        '<div class="upg-head"><b>' + name + '</b><span><span class="tier t' + item.tier + '">T' + item.tier + '</span> → <span class="tier t' + target + '">T' + target + '</span></span></div>' +
        '<ul class="upg-needs">' + needs.join('') +
          '<li class="' + (masteryOk ? 'ok-c' : 'hp-c') + '">Maîtrise d’arme T' + target + ' <span class="dim">(actuelle : T' + me.weaponMastery + ')</span></li>' +
          '<li class="' + (paOk ? 'ok-c' : 'hp-c') + '">' + paCost + ' PA</li>' +
        '</ul>' +
        '<button class="btn primary wide" data-upgrade="' + slot + '"' + (allOk ? '' : ' disabled') + '>⚒ Améliorer (' + paCost + ' PA)</button>' +
      '</div>' +
    '</div>';
  }

  /* ---------- Fil social / événements ---------- */
  pushFeed(msg) {
    this.feed.push(msg);
    if (this.feed.length > 120) this.feed.shift();
    if (this.openSheet === 'social' || this.desktopPanelsActive()) this.renderFeed();

    if (msg.type === 'chat') {
      const ch = msg.channel || 'general';
      const socialVisible = this.openSheet === 'social' || this.desktopPanelsActive();
      const inView = socialVisible && this.chatChannel === ch &&
        (ch !== 'whisper' || (this.chatWhisperTarget && (msg.from === this.chatWhisperTarget || msg.to === this.chatWhisperTarget)));
      if (inView) {
        // Déjà sous les yeux (même en train de recevoir en direct) : on
        // retient la signature tout de suite pour qu'une reconnexion
        // immédiate après ne re-signale pas ce qu'on vient de voir.
        this.markChatSeen(ch);
      } else if (!msg.self) {
        this.chatUnread[ch] = true;
        this.updateChatBadges();
      }
    }
  }

  // Signature bon marché (sans horodatage côté serveur) du dernier message
  // d'un canal : compte + expéditeur + texte. Sert uniquement à détecter
  // « quelque chose a changé depuis la dernière lecture », pas à trier.
  chatChannelSignature(channel) {
    const msgs = this.feed.filter((m) => m.type === 'chat' && (m.channel || 'general') === channel);
    if (!msgs.length) return '';
    const last = msgs[msgs.length - 1];
    return msgs.length + '|' + (last.from || '') + '|' + (last.text || '');
  }

  chatSeenStorageKey() {
    return CONFIG.SAVE_KEY + '_chatseen_' + (this.server.me ? this.server.me.username : '');
  }

  loadChatSeen() {
    try { return JSON.parse(localStorage.getItem(this.chatSeenStorageKey()) || '{}'); }
    catch (e) { return {}; }
  }

  saveChatSeen() {
    try { localStorage.setItem(this.chatSeenStorageKey(), JSON.stringify(this.chatSeen || {})); }
    catch (e) { /* stockage indisponible (navigation privée, quota…) */ }
  }

  markChatSeen(channel) {
    if (!this.chatSeen) this.chatSeen = this.loadChatSeen();
    this.chatSeen[channel] = this.chatChannelSignature(channel);
    this.saveChatSeen();
  }

  /* Pastilles de messages non lus : icône Social (bar du bas) + onglets de canal */
  updateChatBadges() {
    const navBadge = $('socialNavBadge');
    if (navBadge) {
      const anyUnread = this.chatUnread.general || this.chatUnread.guild || this.chatUnread.whisper;
      navBadge.classList.toggle('hidden', !anyUnread);
    }
    document.querySelectorAll('.chat-tab').forEach((btn) => {
      const badge = btn.querySelector('.chat-tab-badge');
      if (badge) badge.classList.toggle('hidden', !this.chatUnread[btn.dataset.chatTab]);
    });
  }

  renderFeed() {
    const el = $('feed');
    if (!el) return;
    // Ne recolle en bas que si on y était déjà — sinon on gèle le défilement
    // de quelqu'un qui remonte lire l'historique.
    const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const prevScrollTop = el.scrollTop;
    const relevant = this.feed.filter((m) => {
      const ch = m.channel || 'general';
      if (ch !== this.chatChannel) return false;
      if (ch === 'whisper') {
        if (!this.chatWhisperTarget) return false;
        return m.from === this.chatWhisperTarget || m.to === this.chatWhisperTarget;
      }
      return true;
    });
    el.innerHTML = relevant.map((m) => {
      if (m.type === 'chat') {
        return '<div class="msg' + (m.self ? ' me' : '') + '"><b>' + esc(m.from) + '</b> ' + esc(m.text) + '</div>';
      }
      return '<div class="msg sys">' + esc(m.text) + '</div>';
    }).join('');
    el.scrollTop = wasNearBottom ? el.scrollHeight : prevScrollTop;
  }

  /* ---------- Création de personnage ---------- */
  /* ---------- Inscription / connexion (mode connecté) ---------- */
  showAuth(handlers) {
    const overlay = $('creation');

    // Le serveur a refusé (mauvais mot de passe, nom pris…) : l'écran est
    // déjà affiché avec les saisies de l'utilisateur — on réactive juste
    // les boutons, le toast d'erreur est arrivé par ailleurs.
    if (overlay.dataset.mode === 'auth' && !overlay.classList.contains('hidden')) {
      const lb = $('loginBtn'), rb = $('registerBtn');
      if (lb) { lb.disabled = false; lb.textContent = 'Se connecter'; }
      if (rb) { rb.disabled = false; rb.textContent = 'Créer mon aventurier'; }
      return;
    }
    overlay.dataset.mode = 'auth';

    const cards = Object.entries(CLASSES).map(([key, c]) =>
      '<button class="class-card" data-class="' + key + '">' +
        this.spriteAvatar(key, 'big') +
        '<span class="class-info"><b>' + c.label + ' <span class="role-chip">' + c.role + '</span></b><small>' + c.bonus + '</small></span>' +
      '</button>'
    ).join('');

    overlay.innerHTML =
      '<div class="creation-card">' +
        '<img class="auth-logo" src="assets/feralia_online_logo.png" alt="FERALIA Online">' +
        '<div class="auth-tabs">' +
          '<button id="tabLogin" class="auth-tab active" type="button">Se connecter</button>' +
          '<button id="tabRegister" class="auth-tab" type="button">Créer un compte</button>' +
        '</div>' +
        '<div id="paneLogin">' +
          '<input id="loginName" type="text" maxlength="16" placeholder="Nom d’aventurier…" autocomplete="username">' +
          '<input id="loginPass" type="password" maxlength="64" placeholder="Mot de passe" autocomplete="current-password">' +
          '<button id="loginBtn" class="btn primary wide" disabled>Se connecter</button>' +
        '</div>' +
        '<div id="paneRegister" class="hidden">' +
          '<input id="regName" type="text" maxlength="16" placeholder="Nom d’aventurier (3 caractères min.)" autocomplete="username">' +
          '<input id="regPass" type="password" maxlength="64" placeholder="Mot de passe (4 caractères min.)" autocomplete="new-password">' +
          '<input id="regPass2" type="password" maxlength="64" placeholder="Confirmez le mot de passe" autocomplete="new-password">' +
          '<p id="regHint" class="hp-c small hidden"></p>' +
          '<p class="dim small">Choisissez votre combo espèce / classe — il est définitif.</p>' +
          '<div class="class-grid">' + cards + '</div>' +
          '<button id="registerBtn" class="btn primary wide" disabled>Créer mon aventurier</button>' +
        '</div>' +
      '</div>';
    overlay.classList.remove('hidden');

    const setTab = (login) => {
      $('paneLogin').classList.toggle('hidden', !login);
      $('paneRegister').classList.toggle('hidden', login);
      $('tabLogin').classList.toggle('active', login);
      $('tabRegister').classList.toggle('active', !login);
    };
    $('tabLogin').addEventListener('click', () => setTab(true));
    $('tabRegister').addEventListener('click', () => setTab(false));

    // --- Connexion ---
    const refreshLogin = () => {
      $('loginBtn').disabled = !$('loginName').value.trim() || !$('loginPass').value;
    };
    const submitLogin = () => {
      if ($('loginBtn').disabled) return;
      $('loginBtn').disabled = true;
      $('loginBtn').textContent = 'Connexion…';
      handlers.login($('loginName').value.trim(), $('loginPass').value);
    };
    $('loginName').addEventListener('input', refreshLogin);
    $('loginPass').addEventListener('input', refreshLogin);
    $('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
    $('loginBtn').addEventListener('click', submitLogin);

    // --- Inscription ---
    let chosen = null;
    const refreshRegister = () => {
      $('registerBtn').disabled =
        !chosen ||
        $('regName').value.trim().length < 3 ||
        $('regPass').value.length < 4 ||
        !$('regPass2').value;
    };
    overlay.querySelectorAll('.class-card').forEach((card) => {
      card.addEventListener('click', () => {
        chosen = card.dataset.class;
        overlay.querySelectorAll('.class-card').forEach((c) => c.classList.toggle('selected', c === card));
        refreshRegister();
      });
    });
    for (const id of ['regName', 'regPass', 'regPass2']) {
      $(id).addEventListener('input', () => {
        $('regHint').classList.add('hidden');
        refreshRegister();
      });
    }
    $('registerBtn').addEventListener('click', () => {
      if ($('regPass').value !== $('regPass2').value) {
        $('regHint').textContent = 'Les deux mots de passe ne correspondent pas.';
        $('regHint').classList.remove('hidden');
        return;
      }
      $('registerBtn').disabled = true;
      $('registerBtn').textContent = 'Création…';
      handlers.register($('regName').value.trim(), $('regPass').value, chosen);
    });
  }

  showCreation(onDone) {
    const overlay = $('creation');
    overlay.dataset.mode = 'creation';
    const cards = Object.entries(CLASSES).map(([key, c]) =>
      '<button class="class-card" data-class="' + key + '">' +
        this.spriteAvatar(key, 'big') +
        '<span class="class-info"><b>' + c.label + ' <span class="role-chip">' + c.role + '</span></b><small>' + c.bonus + '</small></span>' +
      '</button>'
    ).join('');
    overlay.innerHTML =
      '<div class="creation-card">' +
        '<img class="auth-logo" src="assets/feralia_online_logo.png" alt="FERALIA Online">' +
        '<p class="dim">Choisissez votre combo espèce / classe — il est définitif.</p>' +
        '<input id="nameInput" type="text" maxlength="16" placeholder="Nom d’aventurier…" autocomplete="off">' +
        '<div class="class-grid">' + cards + '</div>' +
        '<button id="startBtn" class="btn primary wide" disabled>Entrer dans les Terres Sauvages</button>' +
      '</div>';
    overlay.classList.remove('hidden');

    let chosen = null;
    const refresh = () => {
      $('startBtn').disabled = !chosen || !$('nameInput').value.trim();
    };
    overlay.querySelectorAll('.class-card').forEach((card) => {
      card.addEventListener('click', () => {
        chosen = card.dataset.class;
        overlay.querySelectorAll('.class-card').forEach((c) => c.classList.toggle('selected', c === card));
        refresh();
      });
    });
    $('nameInput').addEventListener('input', refresh);
    $('startBtn').addEventListener('click', () => {
      overlay.classList.add('hidden');
      onDone($('nameInput').value.trim(), chosen);
    });
  }
}
