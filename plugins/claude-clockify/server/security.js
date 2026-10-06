import crypto from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || b === '') return false;
  // Hash first so lengths always match and the comparison stays constant-time.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Local API guard.
 * - Host must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding defense).
 * - Origin, when present, must be http://127.0.0.1:<port> or http://localhost:<port>.
 * - Any non-GET/HEAD request needs X-Session-Token equal to the session token (anti-CSRF).
 * @param {import('node:http').IncomingMessage} req
 * @param {string} sessionToken
 * @param {number} [port] defaults to the socket's local port
 * @returns {{ok: boolean, status?: number, reason?: string}}
 */
export function checkRequest(req, sessionToken, port = req.socket?.localPort) {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!port || !allowedHosts.includes(host)) return { ok: false, status: 403, reason: 'host not allowed' };

  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.map((h) => `http://${h}`).includes(String(origin).toLowerCase())) {
    return { ok: false, status: 403, reason: 'origin not allowed' };
  }

  if (!SAFE_METHODS.has(req.method) && !sameSecret(req.headers['x-session-token'], sessionToken)) {
    return { ok: false, status: 403, reason: 'missing or invalid session token' };
  }
  return { ok: true };
}
