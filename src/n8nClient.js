'use strict';

/**
 * Thin client for the n8n public REST API (/api/v1).
 * This is the ONLY coupling point with n8n: the public API is stable across
 * releases, which is what makes this service survive n8n upgrades.
 */

const config = require('./config');

async function api(method, endpoint, body) {
  const res = await fetch(`${config.n8nUrl}/api/v1${endpoint}`, {
    method,
    headers: {
      'X-N8N-API-KEY': config.n8nApiKey,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`n8n API ${method} ${endpoint} failed: ${res.status} ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/** Fetch every workflow, following pagination cursors. */
async function listAllWorkflows() {
  const workflows = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: '250', excludePinnedData: 'true' });
    if (cursor) query.set('cursor', cursor);
    const page = await api('GET', `/workflows?${query}`);
    workflows.push(...(page.data || []));
    cursor = page.nextCursor || null;
  } while (cursor);
  return workflows;
}

/** Fetch a single workflow by id. */
async function getWorkflow(id) {
  return api('GET', `/workflows/${encodeURIComponent(id)}?excludePinnedData=true`);
}

/**
 * Overwrite a workflow in n8n with stored content (rollback).
 * The update endpoint only accepts these fields; anything else is rejected.
 */
async function updateWorkflow(id, normalized) {
  return api('PUT', `/workflows/${encodeURIComponent(id)}`, {
    name: normalized.name,
    nodes: normalized.nodes,
    connections: normalized.connections,
    settings: normalized.settings || {},
  });
}

/** Recreate a workflow that no longer exists in n8n. Returns the new workflow. */
async function createWorkflow(normalized) {
  return api('POST', '/workflows', {
    name: normalized.name,
    nodes: normalized.nodes,
    connections: normalized.connections,
    settings: normalized.settings || {},
  });
}

module.exports = { listAllWorkflows, getWorkflow, updateWorkflow, createWorkflow };
