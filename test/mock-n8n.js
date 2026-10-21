'use strict';

/**
 * Minimal mock of the n8n public API for end-to-end testing.
 * Serves /api/v1/workflows (paginated) and accepts PUT/POST updates.
 */

const http = require('http');

const workflows = new Map();

function seed(id, name, nodes, extra = {}) {
  workflows.set(id, {
    id,
    name,
    active: true,
    isArchived: false,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    versionId: 'aaa-111',
    triggerCount: 1,
    nodes,
    connections: { Start: { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
    tags: [{ id: 't1', name: 'production', createdAt: 'x', updatedAt: 'y' }],
    pinData: { secret: 'SHOULD NEVER BE STORED' },
    staticData: { runtime: 'noise' },
    ...extra,
  });
}

seed('wf-billing', 'Billing Sync', [
  { name: 'Start', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'hours' }] } } },
  { name: 'Send Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [200, 0], parameters: { subject: 'Invoice ready', toEmail: 'ops@entirety.biz' } },
]);
seed('wf-alerts', 'Slack Alerts', [
  { name: 'Start', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'alerts' } },
  { name: 'Send Email', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [200, 0], parameters: { channel: '#alerts' } },
]);

const requestLog = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requestLog.push(`${req.method} ${url.pathname}`);

  if (req.headers['x-n8n-api-key'] !== 'test-key') {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'unauthorized' }));
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/workflows') {
    // Two-page pagination to prove cursor handling works.
    const all = [...workflows.values()];
    const cursor = url.searchParams.get('cursor');
    const page = cursor ? all.slice(1) : all.slice(0, 1);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: page, nextCursor: cursor ? null : 'page2' }));
  }

  const getMatch = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
  if (req.method === 'GET' && getMatch) {
    const wf = workflows.get(getMatch[1]);
    if (!wf) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'not found' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(wf));
  }

  const putMatch = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
  if (req.method === 'PUT' && putMatch) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const id = putMatch[1];
      if (!workflows.has(id)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'not found' }));
      }
      const update = JSON.parse(body);
      const existing = workflows.get(id);
      workflows.set(id, { ...existing, ...update, updatedAt: new Date().toISOString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(workflows.get(id)));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/workflows') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const created = { ...JSON.parse(body), id: 'wf-recreated', active: false };
      workflows.set(created.id, created);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(created));
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'not found' }));
});

module.exports = { server, workflows, requestLog };

if (require.main === module) {
  server.listen(5999, () => console.log('mock n8n on :5999'));
}
