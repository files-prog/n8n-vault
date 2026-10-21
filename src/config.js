'use strict';

/**
 * Central configuration, entirely environment-driven.
 * Every value has a safe default except the n8n connection itself.
 */

const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  // HTTP
  port: int(process.env.PORT, 3444),
  appUrl: (process.env.APP_URL || `http://localhost:${int(process.env.PORT, 3444)}`).replace(/\/+$/, ''),
  trustProxy: bool(process.env.TRUST_PROXY, true),
  cookieSecure: bool(process.env.COOKIE_SECURE, (process.env.APP_URL || '').startsWith('https://')),

  // n8n connection
  n8nUrl: (process.env.N8N_URL || 'http://n8n:5678').replace(/\/+$/, ''),
  n8nApiKey: process.env.N8N_API_KEY || '',
  // Public URL of the n8n editor, used for "Open in n8n" links in the UI.
  // Falls back to N8N_URL when both are reachable by the users' browsers.
  n8nPublicUrl: (process.env.N8N_PUBLIC_URL || process.env.N8N_URL || 'http://n8n:5678').replace(/\/+$/, ''),

  // Sync engine
  syncIntervalSeconds: Math.max(15, int(process.env.SYNC_INTERVAL_SECONDS, 60)),
  // Include node position changes as versions ("layout changes"). Detected but flagged.
  keepDays: int(process.env.AUDIT_KEEP_DAYS, 365),

  // Storage
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Sessions
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 8),
  sessionAbsoluteHours: int(process.env.SESSION_ABSOLUTE_HOURS, 24 * 7),

  // Bootstrap admin (created on first start if the users table is empty)
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // Optional Google Workspace sign-in (OIDC)
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    // If set, users of this domain can sign in and are auto-provisioned
    // with GOOGLE_AUTO_ROLE (default: viewer). Otherwise only pre-created
    // users may sign in with Google.
    allowedDomain: (process.env.GOOGLE_ALLOWED_DOMAIN || '').trim().toLowerCase(),
    autoRole: ['viewer', 'editor'].includes(process.env.GOOGLE_AUTO_ROLE) ? process.env.GOOGLE_AUTO_ROLE : 'viewer',
  },

  // Rate limiting for the login endpoint
  loginRateLimit: { windowMs: 10 * 60 * 1000, max: 8 },
};

config.googleEnabled = Boolean(config.google.clientId && config.google.clientSecret);

module.exports = config;
