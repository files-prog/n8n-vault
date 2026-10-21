'use strict';

/**
 * End-to-end test against a mock n8n API.
 * Verifies the core promises of the product:
 *   1. Anonymous access is blocked everywhere.
 *   2. Only changed workflows produce new versions.
 *   3. pinData / staticData / timestamps never reach storage.
 *   4. Semantic diffs identify the exact node + parameter that changed.
 *   5. RBAC blocks viewers from restore/sync; CSRF is enforced.
 *   6. Restore pushes the stored version back to n8n (and recreates deleted ones).
 *   7. Deleted workflows are tombstoned, history preserved.
 */

process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/vault-test-');
process.env.N8N_URL = 'http://127.0.0.1:5999';
process.env.N8N_API_KEY = 'test-key';
process.env.ADMIN_EMAIL = 'admin@entirety.biz';
process.env.ADMIN_PASSWORD = 'super-secret-password';
process.env.PORT = '3555';
process.env.APP_URL = 'http://127.0.0.1:3555';
process.env.SYNC_INTERVAL_SECONDS = '3600'; // scheduler quiet during test

const assert = require('assert');
const mock = require('./mock-n8n');
const app = require('../src/server');
const auth = require('../src/auth');
const sync = require('../src/sync');
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

const BASE = 'http://127.0.0.1:3555';
let passed = 0;

function ok(name, condition) {
  assert(condition, name);
  passed++;
  console.log(`  ✔ ${name}`);
}

async function main() {
  await new Promise((r) => mock.server.listen(5999, r));
  auth.bootstrapAdmin();
  const httpServer = app.listen(3555);

  // Create a viewer account for RBAC tests.
  db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(
    'viewer@entirety.biz', 'Viewer', 'viewer', bcrypt.hashSync('viewer-password-1', 10)
  );

  const jar = {};
  async function login(email, password, key) {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert(res.ok, `login failed for ${email}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const me = await fetch(`${BASE}/api/me`, { headers: { cookie } }).then((r) => r.json());
    jar[key] = { cookie, csrf: me.csrfToken };
  }
  const call = (key, method, path, body) =>
    fetch(`${BASE}${path}`, {
      method,
      headers: {
        cookie: jar[key].cookie,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-csrf-token': jar[key].csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  console.log('\n— Security —');
  {
    const anonymous = await fetch(`${BASE}/api/workflows`);
    ok('anonymous API access is rejected (401)', anonymous.status === 401);
    const page = await fetch(`${BASE}/`, { redirect: 'manual' });
    ok('anonymous page access redirects to /login', page.status === 302 && page.headers.get('location') === '/login');
    const badLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@entirety.biz', password: 'wrong' }),
    });
    ok('wrong password is rejected (401)', badLogin.status === 401);
  }

  await login('admin@entirety.biz', 'super-secret-password', 'admin');
  await login('viewer@entirety.biz', 'viewer-password-1', 'viewer');

  console.log('\n— Sync: only changes are stored —');
  {
    const first = await sync.runSync('manual', { id: 1, email: 'admin@entirety.biz' });
    ok('first sync captures both workflows (paginated fetch)', first.checked === 2 && first.newVersions.length === 2);

    const second = await sync.runSync('manual', { id: 1, email: 'admin@entirety.biz' });
    ok('second sync stores NOTHING when nothing changed', second.newVersions.length === 0 && second.unchanged === 2);

    // Modify one workflow: change one parameter of one node.
    const billing = mock.workflows.get('wf-billing');
    billing.nodes[1].parameters.subject = 'Invoice ready (v2)';
    billing.updatedAt = new Date().toISOString();

    const third = await sync.runSync('manual', { id: 1, email: 'admin@entirety.biz' });
    ok('only the modified workflow gets a new version', third.newVersions.length === 1 && third.newVersions[0].id === 'wf-billing');
    ok('the unchanged workflow is skipped', third.unchanged === 1);
  }

  console.log('\n— Stored content hygiene —');
  {
    const res = await call('admin', 'GET', '/api/workflows/wf-billing/versions');
    const { versions } = await res.json();
    const v2 = await (await call('admin', 'GET', `/api/versions/${versions[0].id}`)).json();
    ok('pinData is never stored', !v2.content.includes('SHOULD NEVER BE STORED'));
    ok('staticData / updatedAt / versionId are excluded', !/staticData|updatedAt|versionId|triggerCount/.test(v2.content));
    ok('tags are stored as clean names', v2.content.includes('"production"'));
  }

  console.log('\n— Semantic diff —');
  {
    const { versions } = await (await call('admin', 'GET', '/api/workflows/wf-billing/versions')).json();
    const diff = await (await call('admin', 'GET', `/api/versions/${versions[0].id}/diff`)).json();
    ok('diff identifies the exact modified node', diff.semantic.nodesModified.length === 1 && diff.semantic.nodesModified[0].name === 'Send Email');
    ok('diff identifies the exact changed parameter', diff.semantic.nodesModified[0].changes.includes('parameters.subject'));
    ok('no false positives (no added/removed nodes)', diff.semantic.nodesAdded.length === 0 && diff.semantic.nodesRemoved.length === 0);
    ok('raw line diff is minimal (one line replaced)', diff.lines.additions === 1 && diff.lines.deletions === 1);
    const oldLine = diff.lines.hunks[0].lines.find((l) => l.op === '-');
    const newLine = diff.lines.hunks[0].lines.find((l) => l.op === '+');
    ok('line diff shows the actual before/after values',
      oldLine.text.includes('Invoice ready') && newLine.text.includes('Invoice ready (v2)'));
  }

  console.log('\n— RBAC & CSRF —');
  {
    const viewerSync = await call('viewer', 'POST', '/api/sync');
    ok('viewer cannot trigger sync (403)', viewerSync.status === 403);
    const viewerUsers = await call('viewer', 'GET', '/api/users');
    ok('viewer cannot list users (403)', viewerUsers.status === 403);

    const noCsrf = await fetch(`${BASE}/api/sync`, { method: 'POST', headers: { cookie: jar.admin.cookie } });
    ok('mutating request without CSRF token is rejected (403)', noCsrf.status === 403);
  }

  console.log('\n— Explicit "Save version" (per-workflow commit) —');
  {
    const noChange = await (await call('admin', 'POST', '/api/workflows/wf-billing/commit', { note: 'nothing changed' })).json();
    ok('commit with no changes saves nothing and says so', noChange.changed === false && noChange.versionNo === 2);

    const billing = mock.workflows.get('wf-billing');
    billing.nodes[1].parameters.toEmail = 'finance@entirety.biz';
    const committed = await (await call('admin', 'POST', '/api/workflows/wf-billing/commit', { note: 'Route invoices to finance' })).json();
    ok('commit after an edit creates exactly one new version', committed.changed === true && committed.versionNo === 3);

    const { versions } = await (await call('admin', 'GET', '/api/workflows/wf-billing/versions')).json();
    ok('the version carries the note and its author', versions[0].note === 'Route invoices to finance' && versions[0].note_author === 'admin@entirety.biz');
    ok('the version is marked as a manual save', versions[0].source === 'manual');

    const viewerCommit = await call('viewer', 'POST', '/api/workflows/wf-billing/commit', { note: 'x' });
    ok('viewer cannot commit (403)', viewerCommit.status === 403);

    const missing = await call('admin', 'POST', '/api/workflows/does-not-exist/commit', { note: 'x' });
    ok('committing a nonexistent workflow returns 404', missing.status === 404);
  }

  console.log('\n— Restore (rollback) —');
  {
    const { versions } = await (await call('admin', 'GET', '/api/workflows/wf-billing/versions')).json();
    const v1 = versions.find((v) => v.version_no === 1);
    const restore = await call('admin', 'POST', `/api/versions/${v1.id}/restore`);
    ok('restore succeeds for editors/admins', restore.status === 200);
    ok('n8n now holds the v1 content again',
      mock.workflows.get('wf-billing').nodes[1].parameters.subject === 'Invoice ready');

    const after = await (await call('admin', 'GET', '/api/workflows/wf-billing/versions')).json();
    ok('the restore itself is captured as a new version', after.versions[0].source === 'restore' && after.versions[0].version_no === 4);
  }

  console.log('\n— Deleted workflow: tombstone + recreate —');
  {
    mock.workflows.delete('wf-alerts');
    await sync.runSync('manual', { id: 1, email: 'admin@entirety.biz' });
    const list = await (await call('admin', 'GET', '/api/workflows')).json();
    const alerts = list.workflows.find((w) => w.id === 'wf-alerts');
    ok('deleted workflow is tombstoned, history preserved', Boolean(alerts.deleted_at) && alerts.version_count >= 1);

    const { versions } = await (await call('admin', 'GET', '/api/workflows/wf-alerts/versions')).json();
    const restore = await call('admin', 'POST', `/api/versions/${versions[0].id}/restore`);
    const body = await restore.json();
    ok('restoring a deleted workflow recreates it in n8n', restore.status === 200 && body.recreatedAs === 'wf-recreated');
  }

  console.log('\n— Audit trail —');
  {
    const audit = await (await call('admin', 'GET', '/api/audit')).json();
    const actions = audit.entries.map((e) => e.action);
    ok('audit log captured logins, denials, syncs and restores',
      ['auth.login', 'auth.login_failed', 'authz.denied', 'sync.manual', 'version.restore'].every((a) => actions.includes(a)));
  }

  console.log('\n— Storage efficiency —');
  {
    const blobCount = db.prepare('SELECT COUNT(*) c FROM blobs').get().c;
    const versionCount = db.prepare('SELECT COUNT(*) c FROM versions').get().c;
    ok(`deduplication works: ${versionCount} versions share ${blobCount} unique blobs`, blobCount < versionCount);
  }

  console.log(`\nAll ${passed} checks passed.\n`);
  httpServer.close();
  mock.server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  ✘ FAILED: ${err.message}\n`);
  process.exit(1);
});
