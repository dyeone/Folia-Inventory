import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { hashPassword } from '../api/_lib/hash.js';
import { issueSessionToken, readSessionToken, SESSION_TTL_SECONDS } from '../api/_lib/session.js';
import { apiBase, SESSION_KEY, sessionHeaders } from '../extension/api-auth.js';

// Every database operation in this suite stays in memory. No credentials,
// deployed API or Shopify calls are involved.
let tables;
let writes;
class Query {
  constructor(table) { this.table = table; this.filters = []; this.operation = 'read'; }
  select(_columns, options = {}) { this.head = options.head; return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  gte() { return this; }
  lt() { return this; }
  is(key, value) { return this.eq(key, value); }
  not(key, _operator, value) { this.filters.push(row => row[key] !== value); return this; }
  like(key, value) { this.filters.push(row => String(row[key] || '').startsWith(value.replace(/%$/, ''))); return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  insert(value) { this.operation = 'insert'; this.value = value; return this; }
  update(value) { this.operation = 'update'; this.value = value; return this; }
  upsert(value) { this.operation = 'upsert'; this.value = value; return this; }
  delete() { this.operation = 'delete'; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  then(resolve, reject) {
    try {
      const rows = tables[this.table] ||= [];
      let matched = rows.filter(row => this.filters.every(filter => filter(row)));
      if (this.operation !== 'read') {
        writes.push({ table: this.table, operation: this.operation });
        if (this.operation === 'insert') {
          matched = structuredClone(Array.isArray(this.value) ? this.value : [this.value]);
          rows.push(...matched);
        } else if (this.operation === 'update') matched.forEach(row => Object.assign(row, this.value));
        else if (this.operation === 'upsert') {
          const found = rows.find(row => row.id === this.value.id);
          if (found) Object.assign(found, this.value); else rows.push(structuredClone(this.value));
          matched = [found || this.value];
        } else if (this.operation === 'delete') tables[this.table] = rows.filter(row => !matched.includes(row));
      }
      return Promise.resolve({ data: this.head ? null : structuredClone(this.one ? matched[0] || null : matched), count: matched.length, error: null }).then(resolve, reject);
    } catch (error) { return Promise.reject(error).then(resolve, reject); }
  }
}

mock.module('@supabase/supabase-js', { namedExports: { createClient: () => ({ from: table => new Query(table) }) } });
mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request in auth test'); });
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
const { default: auth } = await import('../api/auth.js');
const { default: users } = await import('../api/users.js');
const { default: settings } = await import('../api/settings.js');
const { default: bridge } = await import('../api/bridge.js');
const { default: items } = await import('../api/items.js');
const { wrap } = await import('../api/_lib/respond.js');

const adminHash = hashPassword('admin-password');
const staffHash = hashPassword('staff-password');
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('SHOPIFY_')) delete process.env[key];
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = 'test-only-session-key-at-least-32-bytes';
  process.env.REGISTRATION_PASSWORD = 'test-registration-key';
  tables = {
    users: [
      { id: 'admin-id', username: 'admin', passwordHash: adminHash, displayName: 'Admin', role: 'admin', active: true, brandIds: ['bae'], bridgeToken: 'bridge-test-token' },
      { id: 'staff-id', username: 'staff', passwordHash: staffHash, displayName: 'Staff', role: 'packer', active: true, brandIds: ['bae'] },
    ],
    brands: [{ id: 'bae', slug: 'bae', name: 'BAE' }],
    app_settings: [], auth_attempts: [], inventory_items: [], bridge_jobs: [],
  };
  writes = [];
});

function cookieFor(id = 'admin-id') { return `folia-session=${issueSessionToken(tables.users.find(u => u.id === id))}`; }
async function call(handler, { method = 'POST', body = {}, query = {}, cookie, authorization, origin, headers = {} } = {}) {
  const req = { method, body, query, headers: { host: 'inventory.example', ...headers, ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}) } };
  const res = {
    statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }, end() { return this; },
  };
  await handler(req, res);
  return res;
}

test('password login issues a secure HttpOnly cookie, never exposes a token or bridge secret', async () => {
  const result = await call(auth, { body: { action: 'login', username: 'admin', password: 'admin-password' } });
  assert.equal(result.statusCode, 200);
  assert.match(result.headers['set-cookie'], /HttpOnly; SameSite=Lax; Secure/);
  assert.match(result.headers['set-cookie'], new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));
  assert.equal(result.body.sessionToken, undefined);
  assert.equal(result.body.user.passwordHash, undefined);
  assert.equal(result.body.user.bridgeToken, undefined);
  assert.equal(readSessionToken(result.headers['set-cookie'].split(';')[0].split('=')[1]).sub, 'admin-id');
});

test('wrong password cannot mint cookie or Bearer', async () => {
  const result = await call(auth, { body: { action: 'login', username: 'admin', password: 'wrong', sessionMode: 'token' } });
  assert.equal(result.statusCode, 401);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.body.sessionToken, undefined);
});

test('legacy password upgrade signs against the stored upgraded credential', async () => {
  tables.users[1].passwordHash = createHash('sha256').update('staff-passwordfolia-inv-2026').digest('hex');
  const result = await call(auth, { body: { action: 'login', username: 'staff', password: 'staff-password' } });
  assert.equal(result.statusCode, 200);
  assert.match(tables.users[1].passwordHash, /^pbkdf2\$/);
  assert.equal((await call(auth, { cookie: result.headers['set-cookie'].split(';')[0], body: { action: 'session' } })).statusCode, 200);
});

test('plain IDs, tampered signatures and expired sessions are rejected', async () => {
  for (const cookie of [undefined, 'folia-session=admin-id', `${cookieFor()}x`, `folia-session=${issueSessionToken(tables.users[0], Date.now() - (SESSION_TTL_SECONDS + 1) * 1000)}`]) {
    const result = await call(auth, { cookie, body: { action: 'session', userId: 'admin-id' } });
    assert.equal(result.statusCode, 401);
  }
});

test('session restore derives identity and refuses forged user/admin actor IDs', async () => {
  const cookie = cookieFor('staff-id');
  const restored = await call(auth, { cookie, body: { action: 'session' } });
  assert.equal(restored.body.user.id, 'staff-id');
  for (const field of ['userId', 'adminUserId']) {
    const result = await call(auth, { cookie, body: { action: 'session', [field]: 'admin-id' } });
    assert.equal(result.statusCode, 403);
  }
});

test('central gate binds both actor fields but preserves selected target IDs', async () => {
  const handler = wrap(async (req, res) => res.json({ query: req.query, body: req.body }));
  const result = await call(handler, { cookie: cookieFor(), body: { id: 'staff-id', targetUserId: 'staff-id' } });
  assert.equal(result.body.body.userId, 'admin-id');
  assert.equal(result.body.body.adminUserId, 'admin-id');
  assert.equal(result.body.body.id, 'staff-id');
  assert.equal(result.body.body.targetUserId, 'staff-id');
  assert.equal((await call(handler, { method: 'GET', cookie: cookieFor(), query: { userId: 'staff-id' } })).statusCode, 403);
});

test('private handlers fail closed without a session, including every Shopify follow path', async () => {
  const files = (await readdir(new URL('../api/', import.meta.url))).filter(name => name.endsWith('.js'));
  for (const name of files) {
    const handler = (await import(`../api/${name}`)).default;
    const result = await call(handler, { body: { action: name === 'auth.js' ? 'session' : 'pool-sync', userId: 'admin-id', adminUserId: 'admin-id' } });
    assert.equal(result.statusCode, 401, name);
  }
  assert.equal(writes.length, 0);
});

test('authenticated packer keeps the automatic sync path and brand authorization', async () => {
  const result = await call(items, { cookie: cookieFor('staff-id'), body: { action: 'pool-sync', brandId: 'bae' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.configured, false);
  assert.equal((await call(items, { cookie: cookieFor('staff-id'), body: { action: 'pool-sync', brandId: 'other-brand' } })).statusCode, 403);
});

test('registration requires shared secret, then issues the normal session', async () => {
  const input = { action: 'register', username: 'new-staff', password: 'new-password' };
  assert.equal((await call(auth, { body: input })).statusCode, 401);
  const result = await call(auth, { body: { ...input, registrationPassword: process.env.REGISTRATION_PASSWORD } });
  assert.equal(result.statusCode, 201);
  assert.match(result.headers['set-cookie'], /HttpOnly/);
  assert.equal(result.body.user.role, 'packer');
});

test('session signing configuration is required before login, registration or private access', async () => {
  delete process.env.SESSION_SECRET;
  const silence = mock.method(console, 'error', () => {});
  try {
    for (const action of ['login', 'register', 'session']) {
      const result = await call(auth, { body: { action, username: 'admin', password: 'admin-password', registrationPassword: 'test-registration-key', userId: 'admin-id' } });
      assert.equal(result.statusCode, 503, action);
      assert.equal(result.headers['set-cookie'], undefined);
    }
    assert.equal(writes.length, 0);
  } finally { silence.mock.restore(); }
});

test('admin and account mutations require the verified actor, role and current password', async () => {
  const staff = cookieFor('staff-id');
  const patch = { id: 'staff-id', patch: { role: 'admin' } };
  assert.equal((await call(users, { method: 'PATCH', cookie: staff, body: { ...patch, adminUserId: 'admin-id' } })).statusCode, 403);
  assert.equal((await call(users, { method: 'PATCH', cookie: staff, body: patch })).statusCode, 403);
  assert.equal((await call(users, { method: 'GET', cookie: staff })).statusCode, 403);
  const roster = await call(users, { method: 'GET', cookie: cookieFor() });
  assert.equal(roster.statusCode, 200);
  assert.ok(roster.body.users.every(user => !('passwordHash' in user) && !('bridgeToken' in user)));
  assert.equal((await call(auth, { cookie: staff, body: { action: 'change-password', userId: 'admin-id', currentPassword: 'admin-password', newPassword: 'another-password' } })).statusCode, 403);
  assert.equal((await call(auth, { cookie: staff, body: { action: 'change-password', currentPassword: 'wrong-password', newPassword: 'another-password' } })).statusCode, 401);
  assert.equal(writes.length, 0);
});

test('password reset, deactivation and role changes take effect without token reissue', async () => {
  const staff = cookieFor('staff-id');
  const reset = await call(users, { method: 'PATCH', cookie: cookieFor(), body: { id: 'staff-id', newPassword: 'reset-password' } });
  assert.equal(reset.statusCode, 200);
  assert.equal((await call(auth, { cookie: staff, body: { action: 'session' } })).statusCode, 401);
  const admin = cookieFor();
  tables.users[0].active = false;
  assert.equal((await call(users, { method: 'GET', cookie: admin })).statusCode, 401);
  tables.users[0].active = true;
  tables.users[0].role = 'packer';
  assert.equal((await call(users, { method: 'GET', cookie: admin })).statusCode, 403);
});

test('password change rotates this browser cookie and invalidates previous tokens', async () => {
  const old = cookieFor('staff-id');
  const result = await call(auth, { cookie: old, body: { action: 'change-password', currentPassword: 'staff-password', newPassword: 'changed-password' } });
  assert.equal(result.statusCode, 200);
  assert.equal((await call(auth, { cookie: old, body: { action: 'session' } })).statusCode, 401);
  assert.equal((await call(auth, { cookie: result.headers['set-cookie'].split(';')[0], body: { action: 'session' } })).statusCode, 200);
});

test('logout clears the HttpOnly cookie even after expiry and anonymous restore fails', async () => {
  const result = await call(auth, { body: { action: 'logout' } });
  assert.equal(result.statusCode, 200);
  assert.match(result.headers['set-cookie'], /folia-session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax; Secure/);
  assert.equal((await call(auth, { body: { action: 'session' } })).statusCode, 401);
});

test('cross-origin cookie writes and login CSRF are rejected', async () => {
  const input = { action: 'login', username: 'admin', password: 'admin-password' };
  assert.equal((await call(auth, { origin: 'https://unrelated.example', body: input })).statusCode, 403);
  assert.equal((await call(users, { method: 'PATCH', cookie: cookieFor(), origin: 'https://unrelated.example', body: { id: 'staff-id', patch: { role: 'admin' } } })).statusCode, 403);
  assert.equal(writes.length, 0);
});

test('extension password login produces a signed Bearer, not a user-ID fallback', async () => {
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const result = await call(auth, { origin, body: { action: 'login', username: 'staff', password: 'staff-password', sessionMode: 'token' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(readSessionToken(result.body.sessionToken).sub, 'staff-id');
  const restored = await call(auth, { origin, authorization: `Bearer ${result.body.sessionToken}`, body: { action: 'session' } });
  assert.equal(restored.statusCode, 200);
  assert.equal((await call(auth, { origin, authorization: 'Bearer staff-id', body: { action: 'session' } })).statusCode, 401);
  const preflight = await call(users, { method: 'OPTIONS', origin });
  assert.equal(preflight.statusCode, 204);
  assert.match(preflight.headers['access-control-allow-headers'], /Authorization/);
});

test('intentional public reads remain public, while method/action variations stay private', async () => {
  delete process.env.SESSION_SECRET;
  assert.equal((await call(auth, { method: 'GET', query: { action: 'has-users' } })).statusCode, 200);
  assert.equal((await call(settings, { method: 'GET', query: { action: 'landing-public', brandId: 'bae' } })).statusCode, 200);
  assert.equal((await call(bridge, { method: 'GET', query: { action: 'mac-version' } })).statusCode, 200);
  process.env.SESSION_SECRET = 'test-only-session-key-at-least-32-bytes';
  for (const [handler, method, action] of [[auth, 'POST', 'has-users'], [settings, 'POST', 'landing-public'], [bridge, 'POST', 'mac-version'], [bridge, 'GET', 'health']]) {
    assert.equal((await call(handler, { method, query: { action }, body: { action } })).statusCode, 401);
  }
});

test('Mac bridge actions retain their own Bearer gate without browser sessions', async () => {
  for (const [method, action] of [['GET', 'next'], ['POST', 'complete'], ['GET', 'packing-status'], ['GET', 'live-show']]) {
    assert.equal((await call(bridge, { method, query: { action }, body: { action } })).statusCode, 401);
  }
  const result = await call(bridge, { method: 'GET', query: { action: 'packing-status' }, authorization: 'Bearer bridge-test-token' });
  assert.equal(result.statusCode, 200);
  assert.equal((await call(bridge, { body: { action: 'generate-token', userId: 'admin-id' } })).statusCode, 401);
});

test('extension sends its token only to the configured API origin and subject', async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: { get: async () => ({ [SESSION_KEY]: { apiBase: 'https://inventory.example', userId: 'staff-id', token: 'test-signed-token' } }) } } };
  try {
    assert.deepEqual(await sessionHeaders({ apiBase: 'https://inventory.example', userId: 'staff-id' }), { Authorization: 'Bearer test-signed-token' });
    await assert.rejects(sessionHeaders({ apiBase: 'https://other.example', userId: 'staff-id' }), /Sign in/);
    await assert.rejects(sessionHeaders({ apiBase: 'https://inventory.example', userId: 'admin-id' }), /Sign in/);
    assert.throws(() => apiBase('http://inventory.example'), /HTTPS/);
    assert.throws(() => apiBase('https://inventory.example@other.example/path'), /HTTPS/);
    assert.throws(() => apiBase('https://inventory.example/#fragment'), /HTTPS/);
    assert.equal(apiBase('http://localhost:5173/'), 'http://localhost:5173');
  } finally { globalThis.chrome = previous; }
});

test('plant list: a whole read returns syncAt, a read since it returns the changes, costs hidden from the bench', async () => {
  tables.inventory_items.push(
    { id: 'p1', brandId: 'bae', sku: 'B-ANT-1', grossCost: 12, netCost: 10, deletedAt: null, changedAt: '2026-11-23T12:00:00.000Z' },
    { id: 'p2', brandId: 'other', sku: 'G-ANT-1', grossCost: 5, deletedAt: null },
  );
  tables.inventory_item_tombstones = [];
  const whole = await call(items, { method: 'GET', cookie: cookieFor('staff-id'), query: { brandId: 'bae' } });
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.body.full, true);
  assert.ok(Date.parse(whole.body.syncAt));
  assert.deepEqual(whole.body.items.map(i => i.id), ['p1']);
  assert.equal(whole.body.items[0].grossCost, undefined);

  const feed = await call(items, { method: 'GET', cookie: cookieFor('staff-id'), query: { brandId: 'bae', since: whole.body.syncAt } });
  assert.equal(feed.statusCode, 200);
  assert.equal(feed.body.full, false);
  assert.deepEqual(feed.body.removedIds, []);
  assert.equal(feed.body.items[0].grossCost, undefined);

  const admin = await call(items, { method: 'GET', cookie: cookieFor(), query: { brandId: 'bae', since: whole.body.syncAt } });
  assert.equal(admin.body.items[0].grossCost, 12);
  // A since too old to trust reads everything again.
  const stale = await call(items, { method: 'GET', cookie: cookieFor(), query: { brandId: 'bae', since: '2026-01-01T00:00:00.000Z' } });
  assert.equal(stale.body.full, true);
});
