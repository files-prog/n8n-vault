/**
 * n8n Vault — editor integration (no fork required).
 *
 * This script is injected into the n8n editor by your reverse proxy (see
 * nginx/n8n-proxy.conf). It adds a "Version History" button when a workflow
 * is open. Clicking it opens that workflow's timeline in n8n Vault.
 *
 * It touches nothing inside n8n: it only reads the URL. Because of that it
 * keeps working across n8n upgrades. Vault itself requires sign-in, so the
 * button exposes nothing to unauthorized users.
 */
(function () {
  'use strict';

  var VAULT_URL = '__VAULT_URL__';
  var BUTTON_ID = 'n8n-vault-button';

  function currentWorkflowId() {
    var match = location.pathname.match(/\/workflow\/([^/]+)/);
    if (!match || match[1] === 'new') return null;
    return match[1];
  }

  var FONT = '600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

  function segment(href, label, title, background, extraStyle) {
    var link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = title;
    link.innerHTML = label;
    link.setAttribute('style', [
      'display:inline-flex',
      'align-items:center',
      'padding:8px 14px',
      'background:' + background,
      'color:#fff',
      'font:' + FONT,
      'text-decoration:none',
      extraStyle || '',
    ].join(';'));
    return link;
  }

  function ensureButton() {
    var id = currentWorkflowId();
    var existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();
    if (!id) return;

    var base = VAULT_URL + '/w/' + encodeURIComponent(id);
    var group = document.createElement('div');
    group.id = BUTTON_ID;
    group.setAttribute('style', [
      'position:fixed',
      'bottom:18px',
      'right:18px',
      'z-index:9999',
      'display:inline-flex',
      'border-radius:999px',
      'overflow:hidden',
      'box-shadow:0 2px 10px rgba(0,0,0,0.25)',
      'opacity:0.94',
    ].join(';'));
    group.addEventListener('mouseenter', function () { group.style.opacity = '1'; });
    group.addEventListener('mouseleave', function () { group.style.opacity = '0.94'; });

    // Primary action: save the changes you just made as a version, with a note.
    group.appendChild(segment(
      base + '?commit=1',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px">' +
      '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>' +
      'Save version',
      'Save the current state of this workflow as a new version in n8n Vault',
      '#ff6d5a'
    ));

    // Secondary action: browse the timeline.
    group.appendChild(segment(
      base,
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px">' +
      '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 3"/></svg>' +
      'History',
      'Open this workflow’s version history in n8n Vault',
      '#2d3543',
      'border-left:1px solid rgba(255,255,255,0.25)'
    ));

    document.body.appendChild(group);
  }

  // The n8n editor is a SPA: watch for route changes cheaply.
  var lastPath = '';
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      ensureButton();
    }
  }, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureButton);
  } else {
    ensureButton();
  }
})();
