import crypto from 'node:crypto';
import { config } from './config.js';

// Stateless HMAC-signed cookie sessions. On serverless platforms (Vercel etc.)
// parallel requests can be served by different processes, so an in-memory
// session map is unreliable — the cookie itself carries a signed expiry and
// every instance can verify it without shared state.

const COOKIE_NAME = 'astra_admin';

function secret() {
  // Dedicated secret if provided; otherwise derived from the admin password.
  // Changing either invalidates all existing sessions.
  return process.env.SESSION_SECRET || config.adminPassword;
}

function sign(expiresAt) {
  return crypto.createHmac('sha256', secret()).update(`admin:${expiresAt}`).digest('hex');
}

function issue(res, expiresAt) {
  res.cookie(COOKIE_NAME, `${expiresAt}.${sign(expiresAt)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: config.sessionTtlMs,
  });
}

function verify(raw) {
  if (typeof raw !== 'string') return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const expiresAt = Number(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return null;
  const expected = sign(expiresAt);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return expiresAt;
}

export function login(res, password) {
  if (!config.adminPassword || password !== config.adminPassword) return false;
  grantSession(res);
  return true;
}

export function grantSession(res) {
  issue(res, Date.now() + config.sessionTtlMs);
}

export function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
}

export function adminAuth(req, res, next) {
  const expiresAt = verify(req.cookies?.[COOKIE_NAME]);
  if (!expiresAt) {
    return res.status(401).json({ error: { message: 'Unauthorized', type: 'unauthorized' } });
  }
  issue(res, Date.now() + config.sessionTtlMs); // sliding expiration
  next();
}
