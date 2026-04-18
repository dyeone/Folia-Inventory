import crypto from 'node:crypto';

const ITER = 120000;
const KEY_LEN = 32;
const DIGEST = 'sha256';

// Static salt used by the previous client-side SHA-256 scheme.
// Kept only so pre-existing users can still log in; they'll be rehashed
// to pbkdf2 on their next successful login.
const LEGACY_SALT = 'folia-inv-2026';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITER, KEY_LEN, DIGEST).toString('hex');
  return `pbkdf2$${ITER}$${salt}$${hash}`;
}

// Returns { valid, needsRehash }.
export function verifyPassword(password, stored) {
  if (!stored) return { valid: false, needsRehash: false };

  if (stored.startsWith('pbkdf2$')) {
    const [, iterStr, salt, expected] = stored.split('$');
    const iter = parseInt(iterStr, 10);
    const hash = crypto.pbkdf2Sync(password, salt, iter, KEY_LEN, DIGEST).toString('hex');
    try {
      const valid = crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(hash, 'hex')
      );
      return { valid, needsRehash: false };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }

  // Legacy: SHA-256 of (password + static salt), raw hex.
  const legacy = crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
  if (legacy === stored) return { valid: true, needsRehash: true };
  return { valid: false, needsRehash: false };
}
