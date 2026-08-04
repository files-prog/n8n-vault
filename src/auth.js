'use strict';

/**
 * Authentication & authorization.
 *
 *  - Session cookies: HttpOnly + SameSite=Lax (+ Secure when served over
 *    HTTPS). Only a SHA-256 hash of the token is stored server-side.
 *  - Sliding expiration plus an absolute cap.
 *  - CSRF: double-submit token bound to the session, required on every
 *    mutating API call (defense in depth on top of SameSite).
 *  - Rate limiting on login (per IP + email).
 *  - RBAC: viewer < editor < admin.
 *  - Optional Google Workspace sign-in (OIDC authorization-code flow with
 *    a `state` nonce), restricted to pre-created users or an allowed domain.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');
const config = require('./config');

const COOKIE = 'vault_session';
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

// ---------------------------------------------------------------------------
// Bootstrap admin
// ---------------------------------------------------------------------------

function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  if (!config.adminEmail || !config.adminPassword) {
    console.warn('[auth] No users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set. Nobody can log in.');
    return;
  }
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
    config.adminEmail,
    'Administrator',
    bcrypt.hashSync(config.adminPassword, 12),
    'admin'
  );
  audit('user.bootstrap', { details: { email: config.adminEmail } });
  console.log(`[auth] Bootstrap admin created: ${config.adminEmail}`);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createSession(user, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, absolute_expires_at, ip, user_agent)
    VALUES (?, ?, ?, datetime('now', ?), datetime('now', ?), ?, ?)
  `).run(
    sha256(token),
    user.id,
    csrf,
    `+${config.sessionTtlHours} hours`,
    `+${config.sessionAbsoluteHours} hours`,
    req.ip,
    String(req.headers['user-agent'] || '').slice(0, 300)
  );
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  return token;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function readSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const session = db.prepare(`
    SELECT s.*, u.email, u.name, u.role, u.disabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND s.absolute_expires_at > datetime('now')
  `).get(sha256(token));
  if (!session || session.disabled) return null;

  // Sliding expiration
  db.prepare(`UPDATE sessions SET expires_at = datetime('now', ?) WHERE token_hash = ?`).run(
    `+${config.sessionTtlHours} hours`,
    session.token_hash
  );
  return session;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionAbsoluteHours * 3600}`,
  ];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Attach req.user when a valid session exists. */
function sessionMiddleware(req, res, next) {
  const session = readSession(req);
  if (session) {
    req.user = { id: session.user_id, email: session.email, name: session.name, role: session.role };
    req.sessionCsrf = session.csrf_token;
    req.sessionToken = parseCookies(req)[COOKIE];
  }
  next();
}

/** Require an authenticated user with at least `role`. */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) {
      audit('authz.denied', { user: req.user, ip: req.ip, details: { needed: role, path: req.path } });
      return res.status(403).json({ error: `This action requires the ${role} role.` });
    }
    next();
  };
}

/** CSRF check for mutating requests. */
function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  if (req.headers['x-csrf-token'] !== req.sessionCsrf) {
    return res.status(403).json({ error: 'Invalid CSRF token. Refresh the page and try again.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Login rate limiting (in-memory sliding window)
// ---------------------------------------------------------------------------

const attempts = new Map();

function loginRateLimited(key) {
  const now = Date.now();
  const windowStart = now - config.loginRateLimit.windowMs;
  const list = (attempts.get(key) || []).filter((t) => t > windowStart);
  attempts.set(key, list);
  return list.length >= config.loginRateLimit.max;
}

function recordLoginAttempt(key) {
  const list = attempts.get(key) || [];
  list.push(Date.now());
  attempts.set(key, list);
}

// ---------------------------------------------------------------------------
// Password login
// ---------------------------------------------------------------------------

function passwordLogin(email, password, req) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const key = `${req.ip}|${normalizedEmail}`;

  if (loginRateLimited(key)) {
    audit('auth.rate_limited', { ip: req.ip, details: { email: normalizedEmail } });
    return { error: 'Too many attempts. Try again in a few minutes.', status: 429 };
  }
  recordLoginAttempt(key);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user || user.disabled || !user.password_hash || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    audit('auth.login_failed', { ip: req.ip, details: { email: normalizedEmail } });
    return { error: 'Invalid email or password.', status: 401 };
  }

  audit('auth.login', { user, ip: req.ip, details: { method: 'password' } });
  return { user };
}

// ---------------------------------------------------------------------------
// Google Workspace (OIDC authorization code flow)
// ---------------------------------------------------------------------------

const oauthStates = new Map(); // state -> expiry

function googleAuthUrl() {
  const state = crypto.randomBytes(16).toString('base64url');
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: `${config.appUrl}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    ...(config.google.allowedDomain ? { hd: config.google.allowedDomain } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function googleCallback(code, state, req) {
  const expiry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!expiry || expiry < Date.now()) return { error: 'Sign-in session expired. Please try again.' };

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: `${config.appUrl}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return { error: 'Google sign-in failed. Please try again.' };
  const tokens = await tokenRes.json();

  // Decode the ID token payload. Integrity is guaranteed here because the
  // token was received directly from Google over TLS in a server-to-server
  // exchange authenticated with our client secret.
  const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
  if (payload.aud !== config.google.clientId || !payload.email_verified) {
    return { error: 'Google sign-in could not be verified.' };
  }

  const email = String(payload.email).toLowerCase();
  const domain = email.split('@')[1];

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    if (!config.google.allowedDomain || domain !== config.google.allowedDomain) {
      audit('auth.google_denied', { ip: req.ip, details: { email } });
      return { error: 'This Google account is not authorized to access this application.' };
    }
    const info = db.prepare('INSERT INTO users (email, name, role) VALUES (?, ?, ?)').run(
      email,
      payload.name || email,
      config.google.autoRole
    );
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    audit('user.auto_provisioned', { user, ip: req.ip, details: { via: 'google', role: user.role } });
  }
  if (user.disabled) {
    audit('auth.google_denied', { ip: req.ip, details: { email, reason: 'disabled' } });
    return { error: 'This account has been disabled.' };
  }

  audit('auth.login', { user, ip: req.ip, details: { method: 'google' } });
  return { user };
}

module.exports = {
  bootstrapAdmin,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  requireRole,
  csrfProtection,
  passwordLogin,
  googleAuthUrl,
  googleCallback,
};
