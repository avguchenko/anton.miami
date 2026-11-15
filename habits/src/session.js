// Signed session cookies: '<expiry>.<HMAC(expiry)>', keyed off the password.

export const SESSION_DAYS = 365;

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmacKey(password) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('habits-session-v1\0' + password));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function sign(password, payload) {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(password), enc.encode(payload)));
}

// Compare digests of both sides so the comparison time doesn't depend on the input.
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export async function makeSession(password, now = Date.now()) {
  const exp = String(Math.floor(now / 1000) + SESSION_DAYS * 86400);
  return `${exp}.${await sign(password, exp)}`;
}
export async function validSession(password, value, now = Date.now()) {
  const [exp, mac] = String(value || '').split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || +exp * 1000 < now) return false;
  return safeEqual(mac, await sign(password, exp));
}
