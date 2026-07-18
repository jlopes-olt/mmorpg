'use strict';

/* ============================================================
 * store.js — persistance SQLite (node:sqlite, natif Node 22+).
 *
 * Trois tables :
 *   meta        clé/valeur (seed, horloge virtuelle, savedAt)
 *   accounts    un compte = identifiants (scrypt) + état joueur (JSON)
 *   world_diffs respawns en cours (le monde se régénère par seed)
 *
 * Contrairement à l'ancien state.json : écritures transactionnelles
 * (WAL), et chaque compte est sauvé individuellement dès qu'un
 * événement important le modifie — plus de fenêtre de perte de 30 s.
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(dbFile) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS meta (' +
      '  key TEXT PRIMARY KEY,' +
      '  value TEXT NOT NULL' +
      ');' +
      'CREATE TABLE IF NOT EXISTS accounts (' +
      '  id TEXT PRIMARY KEY,' +
      '  username TEXT NOT NULL UNIQUE,' +
      '  pass_hash TEXT,' +
      '  pass_salt TEXT,' +
      '  token TEXT UNIQUE,' +
      '  created_at INTEGER NOT NULL,' +
      '  last_seen INTEGER NOT NULL,' +
      '  data TEXT NOT NULL' +
      ');' +
      'CREATE TABLE IF NOT EXISTS world_diffs (' +
      '  tile_key TEXT PRIMARY KEY,' +
      '  inactive_until REAL NOT NULL' +
      ');'
    );

    this.stmt = {
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ),
      allAccounts: this.db.prepare('SELECT * FROM accounts'),
      countAccounts: this.db.prepare('SELECT COUNT(*) AS n FROM accounts'),
      upsertAccount: this.db.prepare(
        'INSERT INTO accounts (id, username, pass_hash, pass_salt, token, created_at, last_seen, data) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET ' +
        '  username = excluded.username, pass_hash = excluded.pass_hash, pass_salt = excluded.pass_salt, ' +
        '  token = excluded.token, last_seen = excluded.last_seen, data = excluded.data'
      ),
      deleteAccount: this.db.prepare('DELETE FROM accounts WHERE id = ?'),
      allDiffs: this.db.prepare('SELECT tile_key, inactive_until FROM world_diffs'),
      clearDiffs: this.db.prepare('DELETE FROM world_diffs'),
      upsertDiff: this.db.prepare(
        'INSERT INTO world_diffs (tile_key, inactive_until) VALUES (?, ?) ' +
        'ON CONFLICT(tile_key) DO UPDATE SET inactive_until = excluded.inactive_until'
      ),
    };
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ---------- meta ---------- */
  getMeta(key, dflt) {
    const row = this.stmt.getMeta.get(key);
    return row ? JSON.parse(row.value) : dflt;
  }

  setMeta(key, value) {
    this.stmt.setMeta.run(key, JSON.stringify(value));
  }

  /* ---------- comptes ---------- */
  countAccounts() {
    return Number(this.stmt.countAccounts.get().n);
  }

  /* → [{ player, credentials: {passHash, passSalt, createdAt} }] */
  loadAccounts() {
    return this.stmt.allAccounts.all().map((row) => ({
      player: JSON.parse(row.data),
      credentials: {
        passHash: row.pass_hash,
        passSalt: row.pass_salt,
        createdAt: Number(row.created_at),
      },
    }));
  }

  saveAccount(player, credentials) {
    const cred = credentials || {};
    this.stmt.upsertAccount.run(
      player.id,
      player.username,
      cred.passHash || null,
      cred.passSalt || null,
      player.token || null,
      cred.createdAt || Date.now(),
      player.lastSeen || Date.now(),
      JSON.stringify(player)
    );
  }

  deleteAccount(id) {
    this.stmt.deleteAccount.run(id);
  }

  /* ---------- monde ---------- */
  loadDiffs() {
    return this.stmt.allDiffs.all().map((r) => [r.tile_key, Number(r.inactive_until)]);
  }

  saveDiffs(diffs) {
    this.transaction(() => {
      this.stmt.clearDiffs.run();
      for (const [key, until] of diffs) this.stmt.upsertDiff.run(key, until);
    });
  }

  close() {
    try { this.db.close(); } catch (e) { /* déjà fermée */ }
  }
}

module.exports = { Store };
