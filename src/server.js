'use strict';

/**
 * n8n Vault — secure version history for self-hosted n8n.
 * Express application: static UI + JSON API.
 */

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('./config');
const { db, getBlob, audit, pruneAudit } = require('./db');
const { lineDiff, semanticDiff } = require('./diff');
const sync = require('./sync');
const n8n = require('./n8nClient');
const auth = require('./auth');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(auth.sessionMiddleware);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'"
  );
  next();
});

const publicDir = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/w/:id', (req, res) => {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.use('/assets', express.static(path.join(publicDir, 'assets'), { maxAge: '1h' }));

// The editor integration script is intentionally public: it contains no data,
// it only renders a link back to this app (which itself requires login).
app.get('/inject.js', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/javascript');
  res.send(
    require('fs')
      .readFileSync(path.join(__dirname, '..', 'inject', 'inject.js'), 'utf8')
      .replace('__VAULT_URL__', config.appUrl)
  );
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const result = auth.passwordLogin(email, password, req);
  if (result.error) return res.status(result.status).json({ error: result.error });
  auth.setSessionCookie(res, auth.createSession(result.user, req));
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  if (req.user) audit('auth.logout', { user: req.user, ip: req.ip });
  auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/auth/google', (req, res) => {
  if (!config.googleEnabled) return res.status(404).send('Google sign-in is not configured.');
  res.redirect(auth.googleAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  if (!config.googleEnabled) return res.status(404).send('Google sign-in is not configured.');
  try {
    const result = await auth.googleCallback(String(req.query.code || ''), String(req.query.state || ''), req);
    if (result.error) return res.redirect(`/login?error=${encodeURIComponent(result.error)}`);
    auth.setSessionCookie(res, auth.createSession(result.user, req));
    res.redirect('/');
  } catch (err) {
    res.redirect(`/login?error=${encodeURIComponent('Google sign-in failed. Please try again.')}`);
  }
});

// ---------------------------------------------------------------------------
// API (session + RBAC + CSRF)
// ---------------------------------------------------------------------------

const api = express.Router();
api.use(auth.requireRole('viewer'));
api.use(auth.csrfProtection);
app.use('/api', api);

api.get('/me', (req, res) => {
  res.json({
    user: req.user,
    csrfToken: req.sessionCsrf,
    sync: { ...sync.state, intervalSeconds: config.syncIntervalSeconds },
    googleEnabled: config.googleEnabled,
    n8nUrl: config.n8nPublicUrl,
  });
});

// Workflow list with latest-version metadata
api.get('/workflows', (req, res) => {
  const search = `%${String(req.query.q || '').trim()}%`;
  const rows = db.prepare(`
    SELECT w.id, w.name, w.active, w.archived, w.deleted_at, w.last_seen_at,
           v.version_no  AS latest_version,
           v.created_at  AS last_change_at,
           v.summary     AS latest_summary,
           (SELECT COUNT(*) FROM versions WHERE workflow_id = w.id) AS version_count
    FROM workflows w
    LEFT JOIN versions v ON v.workflow_id = w.id
      AND v.version_no = (SELECT MAX(version_no) FROM versions WHERE workflow_id = w.id)
    WHERE w.name LIKE ?
    ORDER BY (w.deleted_at IS NULL) DESC, v.created_at DESC
  `).all(search);
  res.json({
    workflows: rows.map((r) => ({ ...r, latest_summary: JSON.parse(r.latest_summary || '{}') })),
  });
});

// Version timeline for one workflow
api.get('/workflows/:id/versions', (req, res) => {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  if (!workflow) return res.status(404).json({ error: 'Workflow not found.' });
  const versions = db.prepare(`
    SELECT v.id, v.version_no, v.source, v.summary, v.note, v.created_at, v.n8n_updated_at,
           u.email AS note_author
    FROM versions v LEFT JOIN users u ON u.id = v.note_author_id
    WHERE v.workflow_id = ? ORDER BY v.version_no DESC
  `).all(req.params.id);
  res.json({
    workflow,
    versions: versions.map((v) => ({ ...v, summary: JSON.parse(v.summary) })),
  });
});

// Full content of one version
api.get('/versions/:vid', (req, res) => {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(req.params.vid);
  if (!version) return res.status(404).json({ error: 'Version not found.' });
  res.json({ ...version, summary: JSON.parse(version.summary), content: getBlob(version.blob_hash) });
});

// Diff between a version and its predecessor (or any other version)
api.get('/versions/:vid/diff', (req, res) => {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(req.params.vid);
  if (!version) return res.status(404).json({ error: 'Version not found.' });

  let base;
  if (req.query.against) {
    base = db.prepare('SELECT * FROM versions WHERE id = ? AND workflow_id = ?').get(
      req.query.against,
      version.workflow_id
    );
    if (!base) return res.status(404).json({ error: 'Comparison version not found.' });
  } else {
    base = db.prepare(
      'SELECT * FROM versions WHERE workflow_id = ? AND version_no < ? ORDER BY version_no DESC LIMIT 1'
    ).get(version.workflow_id, version.version_no);
  }

  const currentText = getBlob(version.blob_hash);
  const baseText = base ? getBlob(base.blob_hash) : '';
  const semantic = base
    ? semanticDiff(JSON.parse(baseText), JSON.parse(currentText))
    : JSON.parse(version.summary);

  res.json({
    version: { id: version.id, version_no: version.version_no },
    base: base ? { id: base.id, version_no: base.version_no } : null,
    semantic,
    lines: lineDiff(baseText, currentText),
  });
});

// Annotate a version (editor+)
api.patch('/versions/:vid/note', auth.requireRole('editor'), (req, res) => {
  const note = String((req.body || {}).note || '').slice(0, 2000);
  const result = db.prepare('UPDATE versions SET note = ?, note_author_id = ? WHERE id = ?').run(
    note,
    req.user.id,
    req.params.vid
  );
  if (result.changes === 0) return res.status(404).json({ error: 'Version not found.' });
  audit('version.note', { user: req.user, ip: req.ip, details: { versionId: Number(req.params.vid) } });
  res.json({ ok: true });
});

// Explicitly save one workflow's current state as a version, with a note.
// This is the "push my changes" action offered inside the n8n editor.
api.post('/workflows/:id/commit', auth.requireRole('editor'), async (req, res) => {
  const note = String((req.body || {}).note || '').slice(0, 2000);
  try {
    const result = await sync.syncOne(req.params.id, req.user, note);
    if (result.notFound) return res.status(404).json({ error: 'This workflow no longer exists in n8n.' });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Could not reach n8n: ${err.message}` });
  }
});

// Trigger a sync (editor+)
api.post('/sync', auth.requireRole('editor'), async (req, res) => {
  try {
    const report = await sync.runSync('manual', req.user);
    res.json(report);
  } catch (err) {
    res.status(502).json({ error: `Could not reach n8n: ${err.message}` });
  }
});

// Rollback (editor+): overwrite the live workflow in n8n with this version.
api.post('/versions/:vid/restore', auth.requireRole('editor'), async (req, res) => {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(req.params.vid);
  if (!version) return res.status(404).json({ error: 'Version not found.' });
  const normalized = JSON.parse(getBlob(version.blob_hash));

  try {
    let recreatedAs = null;
    try {
      await n8n.updateWorkflow(version.workflow_id, normalized);
    } catch (err) {
      if (err.status === 404) {
        // The workflow was deleted in n8n — recreate it (n8n assigns a new id).
        const created = await n8n.createWorkflow(normalized);
        recreatedAs = String(created.id);
      } else {
        throw err;
      }
    }

    audit('version.restore', {
      user: req.user,
      ip: req.ip,
      details: {
        workflowId: version.workflow_id,
        versionNo: version.version_no,
        recreatedAs,
      },
    });

    // Capture the restored state as a new version immediately.
    await sync.runSync('restore', req.user).catch(() => {});
    res.json({ ok: true, recreatedAs });
  } catch (err) {
    res.status(502).json({ error: `Rollback failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Admin: users & audit log
// ---------------------------------------------------------------------------

api.get('/users', auth.requireRole('admin'), (req, res) => {
  res.json({
    users: db.prepare('SELECT id, email, name, role, disabled, created_at, last_login_at FROM users ORDER BY email').all(),
  });
});

api.post('/users', auth.requireRole('admin'), (req, res) => {
  const { email, name, role, password } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!['viewer', 'editor', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Role must be viewer, editor or admin.' });
  }
  if (password && String(password).length < 10) {
    return res.status(400).json({ error: 'Passwords must be at least 10 characters.' });
  }
  try {
    const info = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(
      normalizedEmail,
      String(name || '').slice(0, 120),
      role,
      password ? bcrypt.hashSync(String(password), 12) : null
    );
    audit('user.created', { user: req.user, ip: req.ip, details: { email: normalizedEmail, role } });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(409).json({ error: 'A user with this email already exists.' });
  }
});

api.patch('/users/:id', auth.requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const { role, disabled, password } = req.body || {};
  const isSelf = target.id === req.user.id;

  if (role !== undefined) {
    if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (isSelf && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role.' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
  }
  if (disabled !== undefined) {
    if (isSelf && disabled) return res.status(400).json({ error: 'You cannot disable your own account.' });
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, target.id);
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  }
  if (password) {
    if (String(password).length < 10) return res.status(400).json({ error: 'Passwords must be at least 10 characters.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 12), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(target.id, req.user.id);
  }

  audit('user.updated', {
    user: req.user,
    ip: req.ip,
    details: { target: target.email, role, disabled, passwordChanged: Boolean(password) },
  });
  res.json({ ok: true });
});

api.get('/audit', auth.requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all();
  res.json({ entries: rows.map((r) => ({ ...r, details: JSON.parse(r.details) })) });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Unexpected server error.' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (require.main === module) {
  auth.bootstrapAdmin();
  pruneAudit(config.keepDays);
  sync.startScheduler();
  app.listen(config.port, () => {
    console.log(`[vault] listening on :${config.port} — syncing ${config.n8nUrl} every ${config.syncIntervalSeconds}s`);
  });
}

module.exports = app;
