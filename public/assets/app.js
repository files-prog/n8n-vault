'use strict';

/**
 * n8n Vault UI — a single small vanilla-JS app.
 * Views: workflow list + version timeline, and an admin panel.
 */

const state = {
  me: null,
  csrfToken: '',
  workflows: [],
  selectedId: null,
  detail: null,
  diffCache: new Map(),
};

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': state.csrfToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Session expired.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

function toast(message, isError = false) {
  const node = el('div', { class: `toast${isError ? ' error' : ''}` }, message);
  document.getElementById('toast-root').append(node);
  setTimeout(() => node.remove(), 4200);
}

function confirmModal({ title, body, confirmLabel, danger = false, withNote = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const noteInput = withNote
      ? el('textarea', { placeholder: 'Optional note — why are you restoring this version?' })
      : null;
    const close = (result) => {
      root.innerHTML = '';
      resolve(result);
    };
    const modal = el('div', { class: 'modal-backdrop', onclick: (e) => e.target.classList.contains('modal-backdrop') && close(null) },
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('h3', {}, title),
        el('p', {}, body),
        noteInput,
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn btn-outline', onclick: () => close(null) }, 'Cancel'),
          el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => close({ note: noteInput ? noteInput.value : '' }) }, confirmLabel)
        )
      )
    );
    root.append(modal);
  });
}

function timeAgo(iso) {
  if (!iso) return '';
  const utc = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const seconds = Math.floor((Date.now() - new Date(utc).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(utc).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fullDate(iso) {
  if (!iso) return '';
  const utc = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  return new Date(utc).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Workflow list (sidebar)
// ---------------------------------------------------------------------------

async function loadWorkflows() {
  const q = document.getElementById('search').value;
  const data = await api('GET', `/api/workflows?q=${encodeURIComponent(q)}`);
  state.workflows = data.workflows;
  renderWorkflowList();
}

function renderWorkflowList() {
  const list = document.getElementById('workflow-list');
  list.innerHTML = '';
  if (state.workflows.length === 0) {
    list.append(el('p', { class: 'muted', style: 'padding: 14px' }, 'No workflows yet. They will appear after the first sync.'));
    return;
  }
  for (const wf of state.workflows) {
    const dotClass = wf.deleted_at ? 'deleted' : wf.active ? 'active' : 'inactive';
    const item = el('button', {
      class: `workflow-item${wf.id === state.selectedId ? ' selected' : ''}`,
      onclick: () => selectWorkflow(wf.id),
    },
      el('span', { class: 'wf-name' },
        el('span', { class: `status-dot ${dotClass}`, title: wf.deleted_at ? 'Deleted in n8n' : wf.active ? 'Active' : 'Inactive' }),
        wf.name,
        wf.deleted_at ? el('span', { class: 'wf-deleted-label' }, 'deleted') : null
      ),
      el('div', { class: 'wf-meta' },
        `${wf.version_count} version${wf.version_count === 1 ? '' : 's'}`,
        wf.last_change_at ? ` · updated ${timeAgo(wf.last_change_at)}` : ''
      )
    );
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// Version timeline
// ---------------------------------------------------------------------------

async function selectWorkflow(id) {
  state.selectedId = id;
  history.replaceState(null, '', `/w/${encodeURIComponent(id)}`);
  renderWorkflowList();
  document.getElementById('empty-state').hidden = true;
  const detail = document.getElementById('detail');
  detail.hidden = false;
  detail.innerHTML = '<p class="muted">Loading history…</p>';
  try {
    state.detail = await api('GET', `/api/workflows/${encodeURIComponent(id)}/versions`);
    renderDetail();
  } catch (err) {
    detail.innerHTML = '';
    detail.append(el('p', { class: 'muted' }, err.message));
  }
}

function summaryBadges(summary) {
  const badges = [];
  if (summary.isFirst) badges.push(el('span', { class: 'badge badge-blue' }, 'First snapshot'));
  if (summary.layoutOnly) badges.push(el('span', { class: 'badge badge-gray' }, 'Layout only'));
  if (summary.nodesAdded?.length) badges.push(el('span', { class: 'badge badge-green' }, `+${summary.nodesAdded.length} node${summary.nodesAdded.length > 1 ? 's' : ''}`));
  if (summary.nodesRemoved?.length) badges.push(el('span', { class: 'badge badge-red' }, `−${summary.nodesRemoved.length} node${summary.nodesRemoved.length > 1 ? 's' : ''}`));
  if (summary.nodesModified?.length) badges.push(el('span', { class: 'badge badge-amber' }, `${summary.nodesModified.length} modified`));
  if (summary.connectionsChanged) badges.push(el('span', { class: 'badge badge-blue' }, 'Connections'));
  if (summary.settingsChanged) badges.push(el('span', { class: 'badge badge-blue' }, 'Settings'));
  if (summary.renamed) badges.push(el('span', { class: 'badge badge-blue' }, 'Renamed'));
  if (summary.activeChanged) badges.push(el('span', { class: 'badge badge-blue' }, summary.activeChanged.to ? 'Activated' : 'Deactivated'));
  if (summary.tagsChanged) badges.push(el('span', { class: 'badge badge-gray' }, 'Tags'));
  return badges;
}

function changeRows(summary) {
  const rows = [];
  const pills = (names, kind) => names.map((n) => el('span', { class: `node-pill ${kind}` }, n));
  if (summary.renamed) {
    rows.push(el('div', { class: 'change-row' }, el('span', { class: 'chg-what' }, 'Renamed'), `“${summary.renamed.from}” → “${summary.renamed.to}”`));
  }
  if (summary.nodesAdded?.length) {
    rows.push(el('div', { class: 'change-row' }, el('span', { class: 'chg-what' }, 'Added'), pills(summary.nodesAdded, 'added')));
  }
  if (summary.nodesRemoved?.length) {
    rows.push(el('div', { class: 'change-row' }, el('span', { class: 'chg-what' }, 'Removed'), pills(summary.nodesRemoved, 'removed')));
  }
  for (const mod of summary.nodesModified || []) {
    rows.push(el('div', { class: 'change-row' },
      el('span', { class: 'chg-what' }, 'Changed'),
      el('span', { class: 'node-pill modified' }, mod.name),
      el('span', { class: 'param-list' }, mod.changes.join(', '))
    ));
  }
  if (summary.nodesMoved?.length && !summary.layoutOnly) {
    rows.push(el('div', { class: 'change-row' }, el('span', { class: 'chg-what' }, 'Moved'), el('span', { class: 'param-list' }, summary.nodesMoved.join(', '))));
  }
  if (summary.connectionsChanged) {
    rows.push(el('div', { class: 'change-row' }, el('span', { class: 'chg-what' }, 'Wiring'), 'Node connections changed'));
  }
  if (summary.activeChanged) {
    rows.push(el('div', { class: 'change-row' }, el('span', { class: 'chg-what' }, 'Status'), summary.activeChanged.to ? 'Workflow activated' : 'Workflow deactivated'));
  }
  return rows;
}

function renderDetail() {
  const { workflow, versions } = state.detail;
  const detail = document.getElementById('detail');
  detail.innerHTML = '';

  const editorUrl = `${state.me.n8nUrl}/workflow/${encodeURIComponent(workflow.id)}`;
  detail.append(
    el('div', { class: 'detail-header' },
      el('div', {},
        el('h2', {}, workflow.name),
        el('p', { class: 'detail-sub' },
          workflow.deleted_at
            ? `Deleted in n8n ${timeAgo(workflow.deleted_at)} — history preserved. Restoring will recreate it.`
            : `${versions.length} version${versions.length === 1 ? '' : 's'} · tracked since ${fullDate(workflow.first_seen_at)}`
        )
      ),
      el('div', { class: 'version-actions' },
        workflow.deleted_at ? null : el('a', { class: 'btn btn-outline btn-sm open-in-n8n', href: editorUrl, target: '_blank', rel: 'noopener' }, 'Open in n8n ↗'),
        !workflow.deleted_at && ['editor', 'admin'].includes(state.me.user.role)
          ? el('button', { class: 'btn btn-primary btn-sm', onclick: () => commitWorkflow(workflow) }, 'Save version')
          : null
      )
    )
  );

  const timeline = el('div', { class: 'timeline' });
  const isEditor = ['editor', 'admin'].includes(state.me.user.role);

  versions.forEach((version, index) => {
    const isLatest = index === 0;
    const card = el('div', { class: `version-card${version.summary.layoutOnly ? ' layout-only' : ''}` });

    const actions = el('div', { class: 'version-actions' });
    actions.append(el('button', { class: 'btn btn-ghost btn-sm', onclick: () => toggleDiff(version, card) }, 'View changes'));
    if (isEditor) {
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', onclick: () => editNote(version) }, version.note ? 'Edit note' : 'Add note'));
      if (!isLatest || workflow.deleted_at) {
        actions.append(el('button', { class: 'btn btn-outline btn-sm', onclick: () => restoreVersion(workflow, version) }, 'Restore'));
      }
    }
    actions.append(el('button', { class: 'btn btn-ghost btn-sm', onclick: () => downloadVersion(workflow, version) }, 'Download'));

    card.append(
      el('div', { class: 'version-head' },
        el('span', { class: 'version-no' }, `v${version.version_no}`),
        isLatest && !workflow.deleted_at ? el('span', { class: 'badge badge-green' }, 'Current') : null,
        version.source === 'restore' ? el('span', { class: 'badge badge-blue' }, 'Restored') : null,
        version.source === 'manual'
          ? el('span', { class: 'badge badge-blue', title: 'Saved explicitly from the editor' }, version.note_author ? `Saved by ${version.note_author.split('@')[0]}` : 'Saved manually')
          : null,
        summaryBadges(version.summary),
        el('span', { class: 'version-spacer' }),
        el('span', { class: 'version-date', title: fullDate(version.created_at) }, timeAgo(version.created_at)),
        actions
      )
    );

    if (version.note) {
      card.append(el('div', { class: 'version-note' },
        el('span', { class: 'note-label' }, `Note${version.note_author ? ` · ${version.note_author}` : ''}: `),
        ` ${version.note}`
      ));
    }

    timeline.append(card);
  });

  detail.append(timeline);
}

async function toggleDiff(version, card) {
  const existing = card.querySelector('.version-body');
  if (existing) {
    existing.remove();
    return;
  }
  const body = el('div', { class: 'version-body' }, el('p', { class: 'muted' }, 'Loading diff…'));
  card.append(body);

  try {
    let diff = state.diffCache.get(version.id);
    if (!diff) {
      diff = await api('GET', `/api/versions/${version.id}/diff`);
      state.diffCache.set(version.id, diff);
    }
    body.innerHTML = '';

    const rows = changeRows(diff.semantic);
    if (rows.length > 0) {
      body.append(el('div', { class: 'change-grid' }, rows));
    } else if (diff.semantic.isFirst) {
      body.append(el('p', { class: 'muted' }, 'First snapshot of this workflow — everything is new.'));
    } else if (diff.semantic.layoutOnly) {
      body.append(el('p', { class: 'muted' }, `Only node positions changed (${diff.semantic.nodesMoved.join(', ')}). Logic is identical.`));
    }

    if (diff.base) {
      const toggle = el('button', { class: 'btn btn-ghost btn-sm diff-toggle' }, `Show raw diff (+${diff.lines.additions} −${diff.lines.deletions})`);
      toggle.addEventListener('click', () => {
        const open = body.querySelector('.diff-view');
        if (open) {
          open.remove();
          toggle.textContent = `Show raw diff (+${diff.lines.additions} −${diff.lines.deletions})`;
        } else {
          body.append(renderLineDiff(diff.lines));
          toggle.textContent = 'Hide raw diff';
        }
      });
      body.append(toggle);
    }
  } catch (err) {
    body.innerHTML = '';
    body.append(el('p', { class: 'muted' }, err.message));
  }
}

function renderLineDiff(lines) {
  const view = el('div', { class: 'diff-view' });
  for (const hunk of lines.hunks) {
    const hunkEl = el('div', { class: 'diff-hunk' },
      el('div', { class: 'diff-hunk-header' }, `@@ line ${hunk.startB} @@`)
    );
    for (const { op, text } of hunk.lines) {
      hunkEl.append(el('div', { class: `diff-line${op === '+' ? ' add' : op === '-' ? ' del' : ''}` }, `${op} ${text}`));
    }
    view.append(hunkEl);
  }
  if (lines.hunks.length === 0) view.append(el('div', { class: 'diff-line' }, 'No textual differences.'));
  return view;
}

async function commitWorkflow(workflow) {
  const confirmed = await confirmModal({
    title: `Save a version of “${workflow.name}”`,
    body: 'Vault will read the current state from n8n and save it as a new version — only if something actually changed. Describe what you did:',
    confirmLabel: 'Save version',
    withNote: true,
  });
  if (!confirmed) return;

  try {
    const result = await api('POST', `/api/workflows/${encodeURIComponent(workflow.id)}/commit`, { note: confirmed.note });
    if (result.changed) {
      toast(`v${result.versionNo} saved for “${result.name}”.`);
    } else {
      toast(`No changes since v${result.versionNo} — nothing to save.`);
    }
    state.diffCache.clear();
    await loadWorkflows();
    await selectWorkflow(workflow.id);
  } catch (err) {
    toast(err.message, true);
  }
}

async function restoreVersion(workflow, version) {
  const confirmed = await confirmModal({
    title: `Restore v${version.version_no}?`,
    body: workflow.deleted_at
      ? `“${workflow.name}” was deleted in n8n. Restoring will recreate it from v${version.version_no} as a new workflow.`
      : `The live workflow “${workflow.name}” in n8n will be overwritten with v${version.version_no}. The current state is already saved as a version, so you can always go back.`,
    confirmLabel: 'Restore this version',
    danger: true,
    withNote: true,
  });
  if (!confirmed) return;

  try {
    const result = await api('POST', `/api/versions/${version.id}/restore`);
    if (confirmed.note) {
      // Attach the note to the newly created "restored" version.
      const refreshed = await api('GET', `/api/workflows/${encodeURIComponent(workflow.id)}/versions`);
      const newest = refreshed.versions[0];
      if (newest && newest.source === 'restore') {
        await api('PATCH', `/api/versions/${newest.id}/note`, { note: confirmed.note });
      }
    }
    toast(result.recreatedAs
      ? `Workflow recreated in n8n from v${version.version_no}.`
      : `Restored v${version.version_no} to n8n.`);
    await Promise.all([loadWorkflows(), selectWorkflow(state.selectedId)]);
  } catch (err) {
    toast(err.message, true);
  }
}

async function editNote(version) {
  const result = await confirmModal({
    title: `Note for v${version.version_no}`,
    body: 'Describe what this change was about. The note is visible to everyone with access.',
    confirmLabel: 'Save note',
    withNote: true,
  });
  if (!result) return;
  try {
    await api('PATCH', `/api/versions/${version.id}/note`, { note: result.note });
    state.diffCache.delete(version.id);
    await selectWorkflow(state.selectedId);
    toast('Note saved.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function downloadVersion(workflow, version) {
  try {
    const data = await api('GET', `/api/versions/${version.id}`);
    const blob = new Blob([data.content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${workflow.name.replace(/[^\w.-]+/g, '-')}-v${version.version_no}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------------------

async function renderAdmin() {
  document.getElementById('main-view').hidden = true;
  const view = document.getElementById('admin-view');
  view.hidden = false;
  const content = document.getElementById('admin-content');
  content.innerHTML = '<p class="muted">Loading…</p>';

  try {
    const [usersData, auditData] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/audit')]);
    content.innerHTML = '';

    content.append(el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-bottom:14px', onclick: showMain }, '← Back to workflows'));

    // Users
    const usersTable = el('table', { class: 'data' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Email'), el('th', {}, 'Name'), el('th', {}, 'Role'),
        el('th', {}, 'Status'), el('th', {}, 'Last sign-in'), el('th', {}, '')
      )),
      el('tbody', {}, usersData.users.map((user) => {
        const roleSelect = el('select', {
          onchange: async (e) => {
            try {
              await api('PATCH', `/api/users/${user.id}`, { role: e.target.value });
              toast(`${user.email} is now ${e.target.value}.`);
            } catch (err) {
              toast(err.message, true);
              e.target.value = user.role;
            }
          },
        }, ['viewer', 'editor', 'admin'].map((r) => {
          const opt = el('option', { value: r }, r);
          if (r === user.role) opt.selected = true;
          return opt;
        }));
        return el('tr', {},
          el('td', {}, user.email),
          el('td', {}, user.name || '—'),
          el('td', {}, roleSelect),
          el('td', {}, user.disabled ? el('span', { class: 'badge badge-red' }, 'Disabled') : el('span', { class: 'badge badge-green' }, 'Active')),
          el('td', { class: 'muted' }, user.last_login_at ? timeAgo(user.last_login_at) : 'never'),
          el('td', {},
            el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                try {
                  await api('PATCH', `/api/users/${user.id}`, { disabled: !user.disabled });
                  renderAdmin();
                } catch (err) {
                  toast(err.message, true);
                }
              },
            }, user.disabled ? 'Enable' : 'Disable')
          )
        );
      }))
    );

    const addForm = el('div', { class: 'form-row' },
      el('input', { id: 'new-email', type: 'email', placeholder: 'email@company.com' }),
      el('input', { id: 'new-name', type: 'text', placeholder: 'Full name' }),
      el('select', { id: 'new-role' },
        el('option', { value: 'viewer' }, 'viewer'),
        el('option', { value: 'editor' }, 'editor'),
        el('option', { value: 'admin' }, 'admin')
      ),
      el('input', { id: 'new-password', type: 'password', placeholder: 'Password (min 10 chars)' }),
      el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: async () => {
          try {
            await api('POST', '/api/users', {
              email: document.getElementById('new-email').value,
              name: document.getElementById('new-name').value,
              role: document.getElementById('new-role').value,
              password: document.getElementById('new-password').value,
            });
            toast('User created.');
            renderAdmin();
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, 'Add user')
    );

    content.append(el('section', { class: 'admin-section' },
      el('h3', {}, 'Users'),
      usersTable,
      el('p', { class: 'muted', style: 'margin: 14px 0 4px; font-size: 0.85rem' }, 'Add a user. Leave the password empty for Google-only sign-in.'),
      addForm
    ));

    // Audit log
    content.append(el('section', { class: 'admin-section' },
      el('h3', {}, 'Audit log'),
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Who'), el('th', {}, 'Action'), el('th', {}, 'Details'))),
        el('tbody', {}, auditData.entries.map((entry) => el('tr', {},
          el('td', { class: 'muted', title: fullDate(entry.at) }, timeAgo(entry.at)),
          el('td', {}, entry.user_email || 'system'),
          el('td', { class: 'mono' }, entry.action),
          el('td', { class: 'mono muted' }, JSON.stringify(entry.details))
        )))
      )
    ));
  } catch (err) {
    content.innerHTML = '';
    content.append(el('p', { class: 'muted' }, err.message));
  }
}

function showMain() {
  document.getElementById('admin-view').hidden = true;
  document.getElementById('main-view').hidden = false;
}

// ---------------------------------------------------------------------------
// Topbar behaviors
// ---------------------------------------------------------------------------

function renderSyncStatus() {
  const box = document.getElementById('sync-status');
  const sync = state.me.sync;
  if (sync.lastError) {
    box.className = 'sync-status error';
    box.innerHTML = '<span class="dot"></span>Sync error — check n8n connection';
    box.title = sync.lastError;
  } else {
    box.className = 'sync-status';
    box.innerHTML = `<span class="dot"></span>Auto-sync every ${sync.intervalSeconds}s${sync.lastRunAt ? ` · last ${timeAgo(sync.lastRunAt)}` : ''}`;
  }
}

async function refreshMe() {
  state.me = await api('GET', '/api/me');
  state.csrfToken = state.me.csrfToken;
  document.getElementById('user-email').textContent = state.me.user.email;
  renderSyncStatus();
  const isEditor = ['editor', 'admin'].includes(state.me.user.role);
  document.getElementById('sync-now').hidden = !isEditor;
  document.getElementById('nav-admin').hidden = state.me.user.role !== 'admin';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    await refreshMe();
  } catch {
    return; // redirected to /login
  }
  await loadWorkflows();

  const deepLink = location.pathname.match(/^\/w\/(.+)$/);
  if (deepLink) {
    const id = decodeURIComponent(deepLink[1]);
    const wantsCommit = new URLSearchParams(location.search).get('commit') === '1';
    const workflow = state.workflows.find((w) => w.id === id);

    if (workflow) await selectWorkflow(id);

    if (wantsCommit && ['editor', 'admin'].includes(state.me.user.role)) {
      // The workflow may be brand new and not auto-synced yet; the commit
      // endpoint reads it straight from n8n either way.
      commitWorkflow(workflow || { id, name: 'this workflow', deleted_at: null });
    }
  }

  document.getElementById('search').addEventListener('input', () => loadWorkflows());

  document.getElementById('logout').addEventListener('click', async () => {
    await api('POST', '/auth/logout').catch(() => {});
    location.href = '/login';
  });

  document.getElementById('nav-admin').addEventListener('click', renderAdmin);

  document.getElementById('sync-now').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Syncing…';
    try {
      const report = await api('POST', '/api/sync');
      const changes = report.newVersions?.length || 0;
      toast(changes > 0 ? `Sync complete — ${changes} workflow${changes > 1 ? 's' : ''} changed.` : 'Sync complete — everything is up to date.');
      state.diffCache.clear();
      await refreshMe();
      await loadWorkflows();
      if (state.selectedId) await selectWorkflow(state.selectedId);
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Sync now';
    }
  });

  // Keep the workflow list and sync status quietly fresh.
  setInterval(async () => {
    try {
      await refreshMe();
      await loadWorkflows();
    } catch {
      /* transient */
    }
  }, 30000);
}

boot();
