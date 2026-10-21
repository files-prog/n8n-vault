'use strict';

/**
 * SQLite storage layer.
 *
 * Design notes:
 *  - `blobs` deduplicates workflow content by SHA-256: identical content is
 *    stored exactly once, deflate-compressed.
 *  - `versions` are immutable snapshots referencing a blob. A version is only
 *    created when the workflow's content fingerprint actually changes.
 *  - `audit_log` records every security-relevant action.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'vault.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','editor','admin')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS workflows (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS blobs (
  hash       TEXT PRIMARY KEY,
  content    BLOB NOT NULL,
  raw_size   INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id    TEXT NOT NULL REFERENCES workflows(id),
  version_no     INTEGER NOT NULL,
  blob_hash      TEXT NOT NULL REFERENCES blobs(hash),
  fingerprint    TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'sync' CHECK (source IN ('sync','restore','manual')),
  summary        TEXT NOT NULL DEFAULT '{}',
  note           TEXT NOT NULL DEFAULT '',
  note_author_id INTEGER REFERENCES users(id),
  n8n_updated_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workflow_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_versions_workflow ON versions(workflow_id, version_no DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  user_id    INTEGER,
  user_email TEXT,
  action     TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '{}',
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`);

// ---------------------------------------------------------------------------
// Migration: older databases allowed only ('sync','restore') as version source.
// ---------------------------------------------------------------------------

{
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='versions'").get();
  if (tableSql && !tableSql.sql.includes("'manual'")) {
    db.exec(`
      BEGIN;
      ALTER TABLE versions RENAME TO versions_old;
      CREATE TABLE versions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id    TEXT NOT NULL REFERENCES workflows(id),
        version_no     INTEGER NOT NULL,
        blob_hash      TEXT NOT NULL REFERENCES blobs(hash),
        fingerprint    TEXT NOT NULL,
        source         TEXT NOT NULL DEFAULT 'sync' CHECK (source IN ('sync','restore','manual')),
        summary        TEXT NOT NULL DEFAULT '{}',
        note           TEXT NOT NULL DEFAULT '',
        note_author_id INTEGER REFERENCES users(id),
        n8n_updated_at TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (workflow_id, version_no)
      );
      INSERT INTO versions SELECT * FROM versions_old;
      DROP TABLE versions_old;
      CREATE INDEX IF NOT EXISTS idx_versions_workflow ON versions(workflow_id, version_no DESC);
      COMMIT;
    `);
  }
}

// ---------------------------------------------------------------------------
// Blob helpers (dedup + compression)
// ---------------------------------------------------------------------------

function putBlob(text) {
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const exists = db.prepare('SELECT 1 FROM blobs WHERE hash = ?').get(hash);
  if (!exists) {
    db.prepare('INSERT INTO blobs (hash, content, raw_size) VALUES (?, ?, ?)').run(
      hash,
      zlib.deflateSync(Buffer.from(text, 'utf8')),
      Buffer.byteLength(text, 'utf8')
    );
  }
  return hash;
}

function getBlob(hash) {
  const row = db.prepare('SELECT content FROM blobs WHERE hash = ?').get(hash);
  if (!row) return null;
  return zlib.inflateSync(row.content).toString('utf8');
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function audit(action, { user = null, details = {}, ip = null } = {}) {
  db.prepare('INSERT INTO audit_log (user_id, user_email, action, details, ip) VALUES (?, ?, ?, ?, ?)').run(
    user ? user.id : null,
    user ? user.email : null,
    action,
    JSON.stringify(details),
    ip
  );
}

function pruneAudit(keepDays) {
  db.prepare(`DELETE FROM audit_log WHERE at < datetime('now', ?)`).run(`-${keepDays} days`);
}

module.exports = { db, putBlob, getBlob, audit, pruneAudit };
