'use strict';

/**
 * Workflow normalization, fingerprinting and diffing.
 *
 * Fingerprint = SHA-256 of the normalized workflow JSON. Normalization sorts
 * every object key recursively so that semantically identical workflows always
 * produce identical text — this is what makes change detection reliable and
 * line diffs minimal.
 *
 * Deliberately excluded from versioning (noise / runtime data / secrets risk):
 *   createdAt, updatedAt, versionId, triggerCount, shared, meta,
 *   pinData (may contain real production payloads), staticData (runtime state).
 */

const crypto = require('crypto');

const KEEP_FIELDS = ['id', 'name', 'active', 'isArchived', 'nodes', 'connections', 'settings'];

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/** Reduce a raw n8n API workflow to its meaningful, stable representation. */
function normalizeWorkflow(raw) {
  const clean = {};
  for (const field of KEEP_FIELDS) {
    if (raw[field] !== undefined) clean[field] = raw[field];
  }
  clean.tags = (raw.tags || []).map((t) => (typeof t === 'string' ? t : t.name)).sort();
  return sortValue(clean);
}

function serializeWorkflow(normalized) {
  return JSON.stringify(normalized, null, 2) + '\n';
}

function fingerprint(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Semantic diff: what changed, in n8n terms (nodes, parameters, connections)
// ---------------------------------------------------------------------------

const NODE_FIELDS = ['type', 'typeVersion', 'parameters', 'credentials', 'disabled', 'notes'];

function nodeMap(workflow) {
  const map = new Map();
  for (const node of workflow.nodes || []) map.set(node.name, node);
  return map;
}

function json(v) {
  return JSON.stringify(v === undefined ? null : v);
}

/** List which parts of a node changed, at parameter-key granularity. */
function nodeChanges(a, b) {
  const changes = [];
  for (const field of NODE_FIELDS) {
    if (field === 'parameters') continue;
    if (json(a[field]) !== json(b[field])) changes.push(field);
  }
  const pa = a.parameters || {};
  const pb = b.parameters || {};
  for (const key of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (json(pa[key]) !== json(pb[key])) changes.push(`parameters.${key}`);
  }
  return changes;
}

/**
 * Compare two normalized workflows.
 * Returns a summary object designed to be rendered directly in the UI.
 */
function semanticDiff(prev, curr) {
  if (!prev) {
    return {
      isFirst: true,
      nodesAdded: (curr.nodes || []).map((n) => n.name),
      nodesRemoved: [],
      nodesModified: [],
      nodesMoved: [],
      connectionsChanged: false,
      settingsChanged: false,
      renamed: null,
      activeChanged: null,
      tagsChanged: false,
    };
  }

  const prevNodes = nodeMap(prev);
  const currNodes = nodeMap(curr);

  const nodesAdded = [];
  const nodesRemoved = [];
  const nodesModified = [];
  const nodesMoved = [];

  for (const [name, node] of currNodes) {
    const before = prevNodes.get(name);
    if (!before) {
      nodesAdded.push(name);
      continue;
    }
    const changes = nodeChanges(before, node);
    if (changes.length > 0) {
      nodesModified.push({ name, changes });
    } else if (json(before.position) !== json(node.position)) {
      nodesMoved.push(name);
    }
  }
  for (const name of prevNodes.keys()) {
    if (!currNodes.has(name)) nodesRemoved.push(name);
  }

  return {
    isFirst: false,
    nodesAdded,
    nodesRemoved,
    nodesModified,
    nodesMoved,
    connectionsChanged: json(prev.connections) !== json(curr.connections),
    settingsChanged: json(prev.settings) !== json(curr.settings),
    renamed: prev.name !== curr.name ? { from: prev.name, to: curr.name } : null,
    activeChanged: prev.active !== curr.active ? { from: prev.active, to: curr.active } : null,
    tagsChanged: json(prev.tags) !== json(curr.tags),
  };
}

/** True when the only difference between two versions is node layout. */
function isLayoutOnly(summary) {
  return (
    !summary.isFirst &&
    summary.nodesMoved.length > 0 &&
    summary.nodesAdded.length === 0 &&
    summary.nodesRemoved.length === 0 &&
    summary.nodesModified.length === 0 &&
    !summary.connectionsChanged &&
    !summary.settingsChanged &&
    !summary.renamed &&
    !summary.activeChanged &&
    !summary.tagsChanged
  );
}

// ---------------------------------------------------------------------------
// Line diff (for the "raw changes" view) — LCS with prefix/suffix trimming
// ---------------------------------------------------------------------------

function lineDiff(textA, textB) {
  const a = textA.split('\n');
  const b = textB.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  // LCS dynamic programming on the changed region only.
  const n = midA.length;
  const m = midB.length;
  const ops = [];

  if (n * m > 4_000_000) {
    // Degenerate fallback for enormous changes: plain replace.
    for (const line of midA) ops.push(['-', line]);
    for (const line of midB) ops.push(['+', line]);
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push([' ', midA[i]]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push(['-', midA[i++]]);
      } else {
        ops.push(['+', midB[j++]]);
      }
    }
    while (i < n) ops.push(['-', midA[i++]]);
    while (j < m) ops.push(['+', midB[j++]]);
  }

  // Rebuild with context: 3 lines around each change, hunks separated.
  const full = [];
  for (let k = 0; k < start; k++) full.push([' ', a[k]]);
  full.push(...ops);
  for (let k = endA; k < a.length; k++) full.push([' ', a[k]]);

  const CONTEXT = 3;
  const keep = new Array(full.length).fill(false);
  for (let k = 0; k < full.length; k++) {
    if (full[k][0] !== ' ') {
      for (let c = Math.max(0, k - CONTEXT); c <= Math.min(full.length - 1, k + CONTEXT); c++) keep[c] = true;
    }
  }

  const hunks = [];
  let current = null;
  let lineA = 0;
  let lineB = 0;
  for (let k = 0; k < full.length; k++) {
    const [op, text] = full[k];
    const posA = lineA + 1;
    const posB = lineB + 1;
    if (op !== '+') lineA++;
    if (op !== '-') lineB++;
    if (!keep[k]) {
      current = null;
      continue;
    }
    if (!current) {
      current = { startA: posA, startB: posB, lines: [] };
      hunks.push(current);
    }
    current.lines.push({ op, text });
  }

  return { hunks, additions: ops.filter((o) => o[0] === '+').length, deletions: ops.filter((o) => o[0] === '-').length };
}

module.exports = {
  normalizeWorkflow,
  serializeWorkflow,
  fingerprint,
  semanticDiff,
  isLayoutOnly,
  lineDiff,
};
