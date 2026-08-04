'use strict';

/**
 * Proposal screenshot tour: boots the real app against a mock n8n seeded with
 * realistic workflows, builds a believable history (edits, notes, a restore,
 * a deletion), then captures every key screen with headless Chromium.
 */

process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/vault-demo-');
process.env.N8N_URL = 'http://127.0.0.1:5999';
process.env.N8N_API_KEY = 'test-key';
process.env.ADMIN_EMAIL = 'bi@entirety.biz';
process.env.ADMIN_PASSWORD = 'super-secret-password';
process.env.PORT = '3557';
process.env.APP_URL = 'http://127.0.0.1:3557';
process.env.SYNC_INTERVAL_SECONDS = '60';

const bcrypt = require('bcryptjs');
const mock = require('./mock-n8n');
const app = require('../src/server');
const auth = require('../src/auth');
const sync = require('../src/sync');
const { db } = require('../src/db');
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:3557';
const OUT = '/home/claude/demo';

function node(name, type, x, params = {}, extra = {}) {
  return { name, type: `n8n-nodes-base.${type}`, typeVersion: 2, position: [x, 0], parameters: params, ...extra };
}

function seed(id, name, nodes, active = true) {
  mock.workflows.set(id, {
    id, name, active, isArchived: false,
    createdAt: '2026-07-01T09:00:00.000Z', updatedAt: '2026-07-01T09:00:00.000Z',
    versionId: 'x', triggerCount: 1, nodes,
    connections: {}, settings: { executionOrder: 'v1' },
    tags: [{ id: 't1', name: 'production' }], pinData: {}, staticData: null,
  });
}

async function main() {
  // ---------- Seed realistic workflows ----------
  mock.workflows.clear();
  seed('wf-ance', 'ANCE - Agent Decodification', [
    node('Get many messages', 'gmail', 0, { filters: { q: 'subject:"Certificado emitido del servicio"' } }),
    node('Parse Email', 'code', 200, { language: 'python', pythonCode: 'results = []\nfor email in _("Get many messages").all():\n    ...' }),
    node('get_sustaining_board', 'httpRequest', 400, { method: 'POST', url: 'https://api.monday.com/v2/' }),
    node('Update a document', 'googleDocs', 600, { operation: 'update' }),
    node('Send a message', 'gmail', 800, { sendTo: 'miguel.cano@entirety.biz', subject: 'Solicitud Ampliación Titularidad - ZEBRA' }),
  ]);
  seed('wf-quote', 'Generate Quote PDF (Google Docs + Sheets)', [
    node('Form Trigger', 'formTrigger', 0, { formTitle: 'Quote request' }),
    node('Read prices', 'googleSheets', 200, { operation: 'read' }),
    node('Fill template', 'googleDocs', 400, { operation: 'update' }),
    node('Export PDF', 'googleDrive', 600, { operation: 'download' }),
    node('Send quote', 'gmail', 800, { subject: 'Your quote from Entirety' }),
  ]);
  seed('wf-expiry', 'Certificate Expiry Monitor', [
    node('Every morning', 'scheduleTrigger', 0, {}),
    node('Query Monday', 'httpRequest', 200, { method: 'POST', url: 'https://api.monday.com/v2/' }),
    node('Notify team', 'gmail', 400, { subject: 'Certificates expiring soon' }),
  ]);
  seed('wf-cleanup', 'Old Import Cleanup', [
    node('Weekly', 'scheduleTrigger', 0, {}),
    node('Delete stale rows', 'httpRequest', 200, { method: 'POST', url: 'https://api.monday.com/v2/' }),
  ], false);

  await new Promise((r) => mock.server.listen(5999, r));
  auth.bootstrapAdmin();
  db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(
    'miguel.cano@entirety.biz', 'Miguel Cano', 'editor', bcrypt.hashSync('demo-password-123', 10));
  db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(
    'laura.gomez@entirety.biz', 'Laura Gómez', 'viewer', bcrypt.hashSync('demo-password-123', 10));
  const httpServer = app.listen(3557);

  // ---------- Build a believable history ----------
  await sync.runSync('auto'); // v1 of everything

  const ance = mock.workflows.get('wf-ance');
  ance.nodes[1].parameters.pythonCode = 'results = []\nfor email in _("Get many messages").all():\n    # also match NOM-019\n    ...';
  ance.nodes.splice(2, 0, node('Check NOM-019', 'if', 300, { conditions: {} }));
  await sync.runSync('auto'); // ANCE v2

  ance.nodes.find((n) => n.name === 'Send a message').parameters.subject =
    'Solicitud Ampliación Titularidad - ZEBRA - {{device}}';
  await sync.runSync('auto'); // ANCE v3

  const quote = mock.workflows.get('wf-quote');
  quote.nodes.find((n) => n.name === 'Send quote').parameters.subject = 'Your quotation from Entirety (updated)';
  await sync.runSync('auto'); // Quote v2

  // Attach human notes (as if saved via "Save version")
  const setNote = db.prepare('UPDATE versions SET note = ?, note_author_id = ?, source = ? WHERE workflow_id = ? AND version_no = ?');
  setNote.run('Support NOM-019 certificates in the decodification flow', 2, 'manual', 'wf-ance', 2);
  setNote.run('Include device model in the email subject for finance', 1, 'manual', 'wf-ance', 3);
  setNote.run('Reword quote email subject after client feedback', 2, 'manual', 'wf-quote', 2);

  // A real restore through the API (populates audit + "Restored" badge)
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bi@entirety.biz', password: 'super-secret-password' }),
  });
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  const me = await fetch(`${BASE}/api/me`, { headers: { cookie } }).then((r) => r.json());
  const v2 = db.prepare('SELECT id FROM versions WHERE workflow_id = ? AND version_no = 2').get('wf-ance');
  await fetch(`${BASE}/api/versions/${v2.id}/restore`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': me.csrfToken },
  });
  const v4 = db.prepare('SELECT id FROM versions WHERE workflow_id = ? AND version_no = 4').get('wf-ance');
  if (v4) db.prepare('UPDATE versions SET note = ?, note_author_id = 1 WHERE id = ?')
    .run('Rollback: the new subject broke the finance mail filter', v4.id);

  // A deletion, history preserved
  mock.workflows.delete('wf-cleanup');
  await sync.runSync('auto');

  require('fs').mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 1. Login
  await page.goto(`${BASE}/login`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/01-login.png` });

  // 2. Timeline with notes, badges and the restore
  await page.fill('#email', 'bi@entirety.biz');
  await page.fill('#password', 'super-secret-password');
  await page.click('#submit');
  await page.waitForSelector('.workflow-item');
  await page.click('.workflow-item'); // ANCE (most recently changed)
  await page.waitForSelector('.version-card');
  await page.screenshot({ path: `${OUT}/02-version-history.png` });

  // 3. Semantic diff + raw diff of v2
  const cards = await page.$$('.version-card');
  const v2card = cards[2]; // v4, v3, v2...
  await (await v2card.$('.btn-ghost')).click();
  await page.waitForSelector('.change-grid');
  const toggle = await v2card.$('.diff-toggle');
  if (toggle) await toggle.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/03-what-changed.png`, fullPage: true });

  // 4. Save version dialog
  await page.goto(`${BASE}/w/wf-ance?commit=1`);
  await page.waitForSelector('.modal textarea');
  await page.fill('.modal textarea', 'Add retry logic to the Monday board query');
  await page.screenshot({ path: `${OUT}/04-save-version.png` });
  await page.click('.modal .btn-outline'); // cancel

  // 5. Restore confirmation
  await page.waitForSelector('.version-card');
  const cards2 = await page.$$('.version-card');
  const restoreBtn = await cards2[2].$('.btn-outline');
  await restoreBtn.click();
  await page.waitForSelector('.modal');
  await page.fill('.modal textarea', 'Reverting: finance filter broke with the new subject');
  await page.screenshot({ path: `${OUT}/05-restore.png` });
  await page.click('.modal .btn-outline'); // cancel

  // 6. Deleted workflow — history preserved
  await page.click('#search');
  await page.fill('#search', 'cleanup');
  await page.waitForTimeout(400);
  await page.click('.workflow-item');
  await page.waitForSelector('.version-card');
  await page.screenshot({ path: `${OUT}/06-deleted-workflow.png` });

  // 7. Admin: users + audit trail
  await page.fill('#search', '');
  await page.click('#nav-admin');
  await page.waitForSelector('.admin-section');
  await page.screenshot({ path: `${OUT}/07-admin-users-audit.png`, fullPage: true });

  // 8. The buttons inside the n8n editor (real inject.js over an illustrative canvas)
  await page.route('**://demo-n8n.local/workflow/KCw8H995ZdG9L2Qs', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>
      body{margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:#f4f5f8;
        background-image:radial-gradient(circle,#d9dce3 1px,transparent 1px);background-size:22px 22px}
      .top{height:52px;background:#fff;border-bottom:1px solid #e2e4ea;display:flex;align-items:center;
        padding:0 18px;font-weight:600;color:#333;gap:10px}
      .badge{background:#eef1f5;color:#777;font-size:12px;padding:2px 8px;border-radius:99px;font-weight:500}
      .node{position:absolute;width:130px;height:70px;background:#fff;border:1px solid #dcdfe6;border-radius:10px;
        box-shadow:0 1px 4px rgba(0,0,0,.06);display:flex;align-items:center;justify-content:center;
        font-size:12px;color:#555;text-align:center;padding:6px}
      .wire{position:absolute;height:2px;background:#c9cdd6}
    </style></head><body>
      <div class="top">ANCE - Agent Decodification <span class="badge">Active</span><span class="badge">n8n editor (illustrative)</span></div>
      <div class="node" style="left:120px;top:240px">Get many<br>messages</div>
      <div class="wire" style="left:250px;top:275px;width:90px"></div>
      <div class="node" style="left:340px;top:240px">Parse Email</div>
      <div class="wire" style="left:470px;top:275px;width:90px"></div>
      <div class="node" style="left:560px;top:240px">get_sustaining<br>_board</div>
      <div class="wire" style="left:690px;top:275px;width:90px"></div>
      <div class="node" style="left:780px;top:240px">Send a message</div>
      <script>${require('fs').readFileSync(require('path').join(__dirname, '..', 'inject', 'inject.js'), 'utf8').replace('__VAULT_URL__', BASE)}</script>
    </body></html>`,
  }));
  await page.goto('http://demo-n8n.local/workflow/KCw8H995ZdG9L2Qs');
  await page.waitForSelector('#n8n-vault-button');
  await page.screenshot({ path: `${OUT}/08-buttons-in-n8n.png` });

  // 9. Mobile view
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${BASE}/login`);
  await mobile.fill('#email', 'bi@entirety.biz');
  await mobile.fill('#password', 'super-secret-password');
  await mobile.click('#submit');
  await mobile.waitForSelector('.workflow-item');
  await mobile.click('.workflow-item');
  await mobile.waitForSelector('.version-card');
  await mobile.screenshot({ path: `${OUT}/09-mobile.png` });

  await browser.close();
  httpServer.close();
  mock.server.close();
  console.log('demo screenshots saved to', OUT);
  process.exit(0);
}

main().catch((err) => {
  console.error('demo run failed:', err.message);
  process.exit(1);
});
