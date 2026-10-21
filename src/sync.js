'use strict';

/**
 * The sync engine: the heart of "only what changed".
 *
 * On every cycle it fetches all workflows from n8n, normalizes each one and
 * computes its content fingerprint. A new version row is created ONLY when the
 * fingerprint differs from the latest stored version — unchanged workflows
 * produce no writes at all. Deleted workflows are tombstoned, never erased.
 *
 * Runs automatically on an interval, so nobody has to remember to export
 * anything. "Sync now" in the UI triggers the same function on demand.
 */

const { db, putBlob, audit } = require('./db');
const {
  normalizeWorkflow,
  serializeWorkflow,
  fingerprint,
  semanticDiff,
  isLayoutOnly,
} = require('./diff');
const n8n = require('./n8nClient');
const config = require('./config');

const getLatestVersion = db.prepare(
  'SELECT * FROM versions WHERE workflow_id = ? ORDER BY version_no DESC LIMIT 1'
);
const upsertWorkflow = db.prepare(`
  INSERT INTO workflows (id, name, active, archived, last_seen_at, deleted_at)
  VALUES (@id, @name, @active, @archived, datetime('now'), NULL)
  ON CONFLICT(id) DO UPDATE SET
    name = @name, active = @active, archived = @archived,
    last_seen_at = datetime('now'), deleted_at = NULL
`);
const insertVersion = db.prepare(`
  INSERT INTO versions (workflow_id, version_no, blob_hash, fingerprint, source, summary, n8n_updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const tombstone = db.prepare(`
  UPDATE workflows SET deleted_at = datetime('now')
  WHERE deleted_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))
`);

const state = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
};

/**
 * One sync cycle. Returns a report of what happened.
 * @param {string} source 'auto' | 'manual'
 * @param {object|null} user the user who triggered a manual sync
 */
async function runSync(source = 'auto', user = null) {
  if (state.running) return { skipped: true, reason: 'sync already in progress' };
  state.running = true;

  try {
    const raw = await n8n.listAllWorkflows();
    const report = { checked: raw.length, newVersions: [], unchanged: 0, deleted: 0 };

    const persist = db.transaction(() => {
      const liveIds = [];

      for (const rawWorkflow of raw) {
        const normalized = normalizeWorkflow(rawWorkflow);
        const text = serializeWorkflow(normalized);
        const fp = fingerprint(text);
        const id = String(rawWorkflow.id);
        liveIds.push(id);

        upsertWorkflow.run({
          id,
          name: normalized.name || '(unnamed)',
          active: normalized.active ? 1 : 0,
          archived: normalized.isArchived ? 1 : 0,
        });

        const latest = getLatestVersion.get(id);
        if (latest && latest.fingerprint === fp) {
          report.unchanged++;
          continue;
        }

        // Content changed (or first sighting) -> store exactly one new version.
        const prevNormalized = latest ? JSON.parse(require('./db').getBlob(latest.blob_hash)) : null;
        const summary = semanticDiff(prevNormalized, normalized);
        summary.layoutOnly = isLayoutOnly(summary);

        const blobHash = putBlob(text);
        const versionNo = latest ? latest.version_no + 1 : 1;
        insertVersion.run(
          id,
          versionNo,
          blobHash,
          fp,
          source === 'restore' ? 'restore' : 'sync',
          JSON.stringify(summary),
          rawWorkflow.updatedAt || null
        );
        report.newVersions.push({ id, name: normalized.name, versionNo, layoutOnly: summary.layoutOnly });
      }

      const result = tombstone.run(JSON.stringify(liveIds));
      report.deleted = result.changes;
    });

    persist();

    state.lastRunAt = new Date().toISOString();
    state.lastResult = report;
    state.lastError = null;

    if (source === 'manual') {
      audit('sync.manual', { user, details: { newVersions: report.newVersions.length, deleted: report.deleted } });
    } else if (report.newVersions.length > 0 || report.deleted > 0) {
      audit('sync.auto', { details: { newVersions: report.newVersions.length, deleted: report.deleted } });
    }
    return report;
  } catch (err) {
    state.lastError = err.message;
    audit('sync.error', { details: { message: err.message } });
    throw err;
  } finally {
    state.running = false;
  }
}

/**
 * Explicitly save ONE workflow as a new version, with an optional note by the
 * user who pressed "Save version". This is the per-workflow "push my changes"
 * action; the automatic sync remains as a safety net.
 *
 * Returns { changed, versionNo, name } — or { changed: false } when the
 * workflow is identical to its latest stored version.
 */
async function syncOne(workflowId, user, note = '') {
  let raw;
  try {
    raw = await n8n.getWorkflow(workflowId);
  } catch (err) {
    if (err.status === 404) return { notFound: true };
    throw err;
  }

  const normalized = normalizeWorkflow(raw);
  const text = serializeWorkflow(normalized);
  const fp = fingerprint(text);
  const id = String(raw.id);

  const persist = db.transaction(() => {
    upsertWorkflow.run({
      id,
      name: normalized.name || '(unnamed)',
      active: normalized.active ? 1 : 0,
      archived: normalized.isArchived ? 1 : 0,
    });

    const latest = getLatestVersion.get(id);
    if (latest && latest.fingerprint === fp) {
      return { changed: false, versionNo: latest.version_no, name: normalized.name };
    }

    const prevNormalized = latest ? JSON.parse(require('./db').getBlob(latest.blob_hash)) : null;
    const summary = semanticDiff(prevNormalized, normalized);
    summary.layoutOnly = isLayoutOnly(summary);

    const blobHash = putBlob(text);
    const versionNo = latest ? latest.version_no + 1 : 1;
    const info = db.prepare(`
      INSERT INTO versions (workflow_id, version_no, blob_hash, fingerprint, source, summary, note, note_author_id, n8n_updated_at)
      VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?)
    `).run(id, versionNo, blobHash, fp, JSON.stringify(summary), String(note || '').slice(0, 2000), user ? user.id : null, raw.updatedAt || null);

    return { changed: true, versionNo, versionId: info.lastInsertRowid, name: normalized.name };
  });

  const result = persist();
  audit('version.commit', {
    user,
    details: { workflowId: id, name: result.name, changed: result.changed, versionNo: result.versionNo, hasNote: Boolean(note) },
  });
  return result;
}

let timer = null;

function startScheduler() {
  const tick = () => {
    runSync('auto').catch(() => {
      /* recorded in state.lastError and audit log */
    });
  };
  tick();
  timer = setInterval(tick, config.syncIntervalSeconds * 1000);
  timer.unref();
}

module.exports = { runSync, syncOne, startScheduler, state };
