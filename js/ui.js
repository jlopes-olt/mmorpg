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

class UI {
  constructor(server, renderer) {
    this.server = server;
    this.renderer = renderer;
    this.feed = [];
    this.openSheet = null;
    this.inventorySort = 'type';
    this.onAdminReset = null;
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
    };
    this.harvestFxTimer = null;

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
    $('popup').addEventListener('click', (e) => {
      if (e.target.id === 'popup') this.closePopup();
    });
    document.querySelectorAll('#nav button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.panel;
        this.openSheet === name ? this.closeSheet() : this.showSheet(name);
      });
    });

    server.on('toast', (t) => this.toast(t.text));
    server.on('chat', (msg) => this.pushFeed(msg));
    server.on('result', (r) => this.showResult(r));
    server.on('self', () => {
      if (this.openSheet === 'inventory') this.showSheet('inventory');
      if (this.openSheet === 'shop') this.showSheet('shop');
      if (this.openSheet === 'profile') this.showSheet('profile');
      if (this.openSheet === 'capital') this.showSheet('capital');
    });
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

    for (const tile of this.server.tiles.values()) {
      if (!tile.content || tile.content.kind !== 'village') continue;
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

  showDungeonPopup(tile) {
    const terrain = this.terrainLabel(tile.terrain);
    this.popup(
      'Donjon ' + terrain,
      '<p>Entrée détectée en biome <b>' + terrain + '</b>.</p>' +
      '<p class="dim">Le vrai contenu donjon arrivera dans une prochaine étape : carte dédiée, minimap persistante, monstres et ressources spéciales, puis zone T6 pensée pour le groupe.</p>',
      [
        { label: 'Fermer' },
        {
          label: 'Entrer',
          primary: true,
          cb: () => this.toast('Donjon T6 : contenu à venir.')
        },
      ]
    );
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

    // Bouton contextuel : PNJ de la Capitale
    const onCapital = me.pos.x === 0 && me.pos.y === 0;
    $('ctxAction').classList.toggle('hidden', !onCapital);

    // Bannière de lobby (+ bouton "lancer maintenant" pour le chef)
    const banner = $('lobbyBanner');
    if (me.status === 'LOBBY_COMBAT' && me.raidKey) {
      const raid = this.server.raids.get(me.raidKey);
      if (raid) {
        banner.classList.remove('hidden');
        $('lobbyText').textContent = '⚔ Raid ' + raid.label + ' T' + raid.tier + ' — résolution dans ' +
          Math.max(0, Math.ceil((raid.endsAt - this.server.now) / 1000)) + ' s — ' +
          raid.participants.length + ' participant(s)';
        $('lobbyStart').classList.toggle('hidden', raid.leaderId !== me.id);
      }
    } else {
      banner.classList.add('hidden');
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
    row.className = 'popup-actions';
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

  closePopup() { $('popup').classList.add('hidden'); }

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
    return {
      MINERAI: 'mineral',
      BOIS: 'wood',
      PLANTE: 'plant',
    }[resourceType] || 'generic';
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
      this.renderer.worldIcons.monster[monster.tier];
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
      '<p><span class="battle-label">PV perdus</span> <b class="hp-c">−' + r.hpLoss + '</b>' + (r.druid ? ' <span class="ok-c">(+15 Sève du Druide)</span>' : '') + '</p>',
    ];
    if (r.victory && r.loot) {
      const items = Object.entries(r.loot).map(([k, n]) => {
        const p = parseStackKey(k);
        return n + '× ' + RESOURCES[p.type].label + ' <span class="tier t' + p.tier + '">T' + p.tier + '</span>';
      });
      lines.push('<p><span class="battle-label">Butin</span> ' + items.join(' · ') + '</p>');
      lines.push('<p><span class="battle-label">Maîtrise</span> +' + r.xp + ' XP d’arme</p>');
    } else {
      lines.push('<p class="dim battle-empty">Aucun butin. Revenez plus nombreux…</p>');
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

  playCombatClash(r) {
    return new Promise((resolve) => {
      const wrap = $('combatFx');
      wrap.innerHTML =
        '<div class="combat-fx-backdrop ' + (r.victory ? 'victory' : 'defeat') + '">' +
          '<div class="combat-fx-center">' +
            '<div class="combat-fx-title">Affrontement</div>' +
            '<div class="combat-fx-subtitle">' + esc(r.label) + ' T' + r.tier + '</div>' +
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
    const toolSrc = this.harvestToolSrc[resource.type] || this.harvestToolSrc.MINERAI;
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
    this.openSheet = name;
    const titles = { inventory: 'Inventaire', shop: 'Boutique', profile: 'Profil', map: 'Carte du monde', social: 'Social', capital: 'Capitale — PNJ Artisans' };
    $('sheetTitle').textContent = titles[name];
    const body = $('sheetBody');
    body.innerHTML = '';
    this['build_' + name](body);
    $('sheet').classList.remove('hidden');
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  }

  closeSheet() {
    this.openSheet = null;
    $('sheet').classList.add('hidden');
    document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('active'));
  }

  build_inventory(body) {
    const inv = this.server.me.inventory;
    const keys = Object.keys(inv).sort();
    if (!keys.length) {
      body.innerHTML = '<p class="empty">Inventaire vide. Récoltez des ressources sur la carte (2 PA).</p>';
      return;
    }
    const typeOrder = { BOIS: 0, MINERAI: 1, PLANTE: 2 };
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
      const iconSrc = this.getResourceTargetSrc(p.type, p.tier);
      return '<div class="inv-card">' +
        '<div class="inv-card-art-wrap">' +
          (iconSrc ? '<img class="inv-card-art" src="' + iconSrc + '" alt="">' : '') +
          '<span class="tier t' + p.tier + ' inv-card-tier">T' + p.tier + '</span>' +
        '</div>' +
        '<div class="inv-card-name">' + RESOURCES[p.type].label + '</div>' +
        '<div class="inv-card-meta">' + (this.inventorySort === 'tier' ? RESOURCES[p.type].label + ' · ' : '') + 'Tier ' + p.tier + '</div>' +
        '<div class="inv-card-qty">×' + inv[k] + '</div>' +
      '</div>';
    });
    body.innerHTML =
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
  }

  build_shop(body) {
    body.innerHTML =
      '<div class="upg shop-empty">' +
        '<div class="upg-head"><b>Échoppes fermées</b><span class="dim">Bientôt</span></div>' +
        '<p>La boutique arrivera dans une prochaine étape.</p>' +
        '<p class="dim">Pour l’instant, vos services actifs restent ceux de la Capitale : téléporteurs, repos et amélioration d’équipement.</p>' +
      '</div>';
  }

  /* Avatar découpé dans la feuille de sprites (grille 3x2) */
  spriteAvatar(speciesClass, extraClass) {
    const cell = SPRITE_CELLS[speciesClass];
    return '<span class="avatar sprite ' + (extraClass || '') + '" style="background-position:' +
      (cell[0] * 50) + '% ' + (cell[1] * 100) + '%"></span>';
  }

  build_profile(body) {
    const me = this.server.me;
    const cls = CLASSES[me.speciesClass];
    body.innerHTML =
      '<div class="profile-head">' +
        this.spriteAvatar(me.speciesClass) +
        '<div><b class="profile-name">' + esc(me.username) + '</b><br><span class="profile-class">' + cls.label + '</span></div>' +
      '</div>' +
      '<p class="bonus">' + cls.bonus + '</p>' +
      '<div class="statgrid">' +
        '<div><span class="dim">Force individuelle</span><b>' + playerForce(me) + '</b></div>' +
        '<div><span class="dim">PV max</span><b>' + maxHp(me) + '</b></div>' +
      '</div>' +
      this.xpBar('Niveau de récolte', me.harvestLevel, me.harvestXp) +
      this.xpBar('Maîtrise d’arme', me.weaponMastery, me.weaponXp) +
      '<div class="gear">' +
        '<div class="gear-card"><span class="dim">Arme</span><b>' + me.weapon.type + '</b><span class="tier t' + me.weapon.tier + '">T' + me.weapon.tier + '</span></div>' +
        '<div class="gear-card"><span class="dim">Armure</span><b>' + me.armor.type + '</b><span class="tier t' + me.armor.tier + '">T' + me.armor.tier + '</span></div>' +
      '</div>' +
      '<p class="dim small">Arme et armure sont uniques et évolutives — améliorez-les chez le Forgeron de la Capitale (0,0).</p>' +
      '<div class="admin-card">' +
        '<div class="upg-head"><b>Admin</b><span class="dim">Gestion personnage</span></div>' +
        '<p class="dim small">Efface ce personnage et rouvre l’écran de création.</p>' +
        '<div class="admin-grid">' +
          '<button class="btn" data-admin-tier="harvest:1">Récolte T1</button>' +
          '<button class="btn" data-admin-tier="harvest:2">Récolte T2</button>' +
          '<button class="btn" data-admin-tier="harvest:3">Récolte T3</button>' +
          '<button class="btn" data-admin-tier="harvest:4">Récolte T4</button>' +
          '<button class="btn" data-admin-tier="harvest:5">Récolte T5</button>' +
          '<button class="btn" data-admin-tier="weapon:1">Maîtrise T1</button>' +
          '<button class="btn" data-admin-tier="weapon:2">Maîtrise T2</button>' +
          '<button class="btn" data-admin-tier="weapon:3">Maîtrise T3</button>' +
          '<button class="btn" data-admin-tier="weapon:4">Maîtrise T4</button>' +
          '<button class="btn" data-admin-tier="weapon:5">Maîtrise T5</button>' +
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
        '</div>' +
        '<button id="profileResetBtn" class="btn danger wide">Réinitialiser le personnage</button>' +
      '</div>';
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
    $('profileResetBtn').addEventListener('click', () => {
      if (this.onAdminReset) this.onAdminReset();
    });
  }

  xpBar(label, lvl, xp) {
    if (lvl >= 5) {
      return '<div class="xp"><div class="xp-head"><span>' + label + '</span><span class="tier t5">T5 — max</span></div>' +
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
    body.innerHTML =
      '<div id="feed" class="feed"></div>' +
      '<div class="chat-row">' +
        '<input id="chatInput" type="text" maxlength="120" placeholder="Écrire au canal local…" autocomplete="off">' +
        '<button id="chatSend" class="btn primary">Envoyer</button>' +
      '</div>';
    this.renderFeed();
    const send = () => {
      const input = $('chatInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this.server.say(text);
    };
    $('chatSend').addEventListener('click', send);
    $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  build_capital(body) {
    const me = this.server.me;
    body.innerHTML =
      '<p class="dim">Zone neutre absolue. Les PNJ Artisans (T1 à T5) y tiennent boutique.</p>' +
      '<button id="restBtn" class="btn wide">⛲ Se reposer à la fontaine — PV restaurés (gratuit)</button>' +
      '<button id="travelBtn" class="btn wide">🌀 Réseau de téléporteurs</button>' +
      this.upgradeCard('weapon') +
      this.upgradeCard('armor');
    $('restBtn').addEventListener('click', async () => {
      const r = await Promise.resolve(this.server.rest());
      if (!r.ok) this.toast(r.error);
    });
    $('travelBtn').addEventListener('click', () => this.showFastTravelPopupFromCapital());
    body.querySelectorAll('[data-upgrade]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await Promise.resolve(this.server.upgrade(btn.dataset.upgrade));
        this.toast(r.ok ? 'Amélioration réussie !' : r.error);
      });
    });
  }

  upgradeCard(slot) {
    const me = this.server.me;
    const item = me[slot];
    const name = slot === 'weapon' ? item.type : 'Armure de ' + item.type;
    const target = item.tier + 1;
    if (target > 5) {
      return '<div class="upg"><div class="upg-head"><b>' + name + '</b><span class="tier t5">T5 — max</span></div>' +
        '<p class="dim">Tier maximum atteint.</p></div>';
    }
    const recipe = UPGRADE_RECIPES[slot][target];
    const paCost = CONFIG.COSTS.UPGRADE[target];
    let allOk = true;
    const needs = Object.entries(recipe).map(([k, n]) => {
      const p = parseStackKey(k);
      const have = me.inventory[k] || 0;
      const ok = have >= n;
      if (!ok) allOk = false;
      return '<li class="' + (ok ? 'ok-c' : 'hp-c') + '">' + n + '× ' + RESOURCES[p.type].label +
        ' T' + p.tier + ' <span class="dim">(' + have + '/' + n + ')</span></li>';
    });
    const masteryOk = me.weaponMastery >= target;
    if (!masteryOk) allOk = false;
    const paOk = me.pa >= paCost;
    if (!paOk) allOk = false;

    return '<div class="upg">' +
      '<div class="upg-head"><b>' + name + '</b><span><span class="tier t' + item.tier + '">T' + item.tier + '</span> → <span class="tier t' + target + '">T' + target + '</span></span></div>' +
      '<ul class="upg-needs">' + needs.join('') +
        '<li class="' + (masteryOk ? 'ok-c' : 'hp-c') + '">Maîtrise d’arme T' + target + ' <span class="dim">(actuelle : T' + me.weaponMastery + ')</span></li>' +
        '<li class="' + (paOk ? 'ok-c' : 'hp-c') + '">' + paCost + ' PA</li>' +
      '</ul>' +
      '<button class="btn primary wide" data-upgrade="' + slot + '"' + (allOk ? '' : ' disabled') + '>⚒ Améliorer (' + paCost + ' PA)</button>' +
      '</div>';
  }

  /* ---------- Fil social / événements ---------- */
  pushFeed(msg) {
    this.feed.push(msg);
    if (this.feed.length > 120) this.feed.shift();
    if (this.openSheet === 'social') this.renderFeed();
  }

  renderFeed() {
    const el = $('feed');
    if (!el) return;
    el.innerHTML = this.feed.map((m) => {
      if (m.type === 'chat') {
        return '<div class="msg' + (m.self ? ' me' : '') + '"><b>' + esc(m.from) + '</b> ' + esc(m.text) + '</div>';
      }
      return '<div class="msg sys">' + esc(m.text) + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  /* ---------- Création de personnage ---------- */
  showCreation(onDone) {
    const overlay = $('creation');
    const cards = Object.entries(CLASSES).map(([key, c]) =>
      '<button class="class-card" data-class="' + key + '">' +
        this.spriteAvatar(key, 'big') +
        '<span class="class-info"><b>' + c.label + '</b><small>' + c.bonus + '</small></span>' +
      '</button>'
    ).join('');
    overlay.innerHTML =
      '<div class="creation-card">' +
        '<h1>WildRift <span class="dim">RPG</span></h1>' +
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
