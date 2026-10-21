'use strict';

/** Boot the app against the mock n8n, sign in, and capture UI screenshots. */

process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/vault-shot-');
process.env.N8N_URL = 'http://127.0.0.1:5999';
process.env.N8N_API_KEY = 'test-key';
process.env.ADMIN_EMAIL = 'admin@entirety.biz';
process.env.ADMIN_PASSWORD = 'super-secret-password';
process.env.PORT = '3556';
process.env.APP_URL = 'http://127.0.0.1:3556';
process.env.SYNC_INTERVAL_SECONDS = '3600';

const mock = require('./mock-n8n');
const app = require('../src/server');
const auth = require('../src/auth');
const sync = require('../src/sync');
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:3556';

async function main() {
  await new Promise((r) => mock.server.listen(5999, r));
  auth.bootstrapAdmin();
  const httpServer = app.listen(3556);

  // Build a small history so the UI has something to show.
  await sync.runSync('manual');
  const billing = mock.workflows.get('wf-billing');
  billing.nodes[1].parameters.subject = 'Invoice ready (v2)';
  billing.nodes.push({ name: 'Log to Sheet', type: 'n8n-nodes-base.googleSheets', typeVersion: 4, position: [400, 0], parameters: { operation: 'append' } });
  await sync.runSync('manual');

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 1. Login page
  await page.goto(`${BASE}/login`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/home/claude/shot-login.png' });

  // 2. Sign in and open the timeline
  await page.fill('#email', 'admin@entirety.biz');
  await page.fill('#password', 'super-secret-password');
  await page.click('#submit');
  await page.waitForSelector('.workflow-item');
  await page.click('.workflow-item');
  await page.waitForSelector('.version-card');
  await page.screenshot({ path: '/home/claude/shot-timeline.png' });

  // 3. The "Save version" dialog, exactly as it opens from the n8n editor button
  // (simulate an edit made in the n8n editor right before pressing the button)
  billing.nodes[1].parameters.subject = 'Your invoice from Entirety';
  await page.goto(`${BASE}/w/wf-billing?commit=1`);
  await page.waitForSelector('.modal textarea');
  await page.fill('.modal textarea', 'Add Google Sheets logging and update the invoice subject');
  await page.screenshot({ path: '/home/claude/shot-commit.png' });
  await page.click('.modal .btn-primary');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/home/claude/shot-timeline.png' });

  // 4. Expand the diff of the latest version
  await page.click('.version-card .btn-ghost');
  await page.waitForSelector('.change-grid, .version-body .muted');
  const rawToggle = await page.$('.diff-toggle');
  if (rawToggle) await rawToggle.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/home/claude/shot-diff.png', fullPage: true });

  await browser.close();
  httpServer.close();
  mock.server.close();
  console.log('screenshots saved');
  process.exit(0);
}

main().catch((err) => {
  console.error('screenshot run failed:', err.message);
  process.exit(1);
});
