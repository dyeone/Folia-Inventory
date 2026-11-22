import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

const copy = (value) => structuredClone(value);
let current;

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.action = 'select';
  }
  select() { return this; }
  range() { return this; }
  eq(key, value) { this.filters.push((row) => this.value(row, key) === value); return this; }
  is(key, value) { this.filters.push((row) => (this.value(row, key) ?? null) === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(this.value(row, key))); return this; }
  not(key, _operator, value) { this.filters.push((row) => (this.value(row, key) ?? null) !== value); return this; }
  like(key, pattern) { this.filters.push((row) => String(this.value(row, key) || '').startsWith(pattern.replace(/%$/, ''))); return this; }
  insert(value) { this.action = 'insert'; this.payload = value; return this; }
  upsert(value) { this.action = 'upsert'; this.payload = value; return this; }
  update(value) { this.action = 'update'; this.payload = value; return this; }
  delete() { this.action = 'delete'; return this; }
  maybeSingle() { this.single = true; return this; }
  value(row, key) { return key.split('->>').reduce((value, part) => value?.[part.replaceAll('"', '')], row); }
  then(resolve, reject) { return Promise.resolve().then(() => this.execute()).then(resolve, reject); }
  execute() {
    const rows = current.tables[this.table] ||= [];
    let matches = rows.filter((row) => this.filters.every((matches) => matches(row)));
    if (this.action === 'insert') {
      if (rows.some((row) => row.id === this.payload.id)) return { data: null, error: { code: '23505' } };
      rows.push(copy(this.payload));
      matches = [rows.at(-1)];
    } else if (this.action === 'upsert') {
      const row = rows.find((row) => row.id === this.payload.id);
      if (row) Object.assign(row, copy(this.payload));
      else rows.push(copy(this.payload));
      matches = [row || rows.at(-1)];
    } else if (this.action === 'update') {
      for (const row of matches) Object.assign(row, copy(this.payload));
      if (this.table === 'inventory_items') current.inventoryWrites.push(copy(this.payload));
    } else if (this.action === 'delete') {
      current.tables[this.table] = rows.filter((row) => !matches.includes(row));
    }
    return { data: copy(this.single ? matches[0] || null : matches), error: null };
  }
}

const supabaseMock = mock.module(new URL('./supabase.js', import.meta.url), {
  namedExports: { supabase: { from: (table) => new Query(table) }, newId: () => `row-${++current.seq}` },
});
const fetchAllMock = mock.module(new URL('./fetchAll.js', import.meta.url), {
  namedExports: { fetchAllById: async (build) => {
    const { data, error } = await build();
    if (error) throw new Error(error.message);
    return data;
  } },
});
const envKeys = ['SHOPIFY_SHOP_BAE', 'SHOPIFY_ADMIN_TOKEN_BAE', 'SHOPIFY_CLIENT_ID_BAE', 'SHOPIFY_CLIENT_SECRET_BAE', 'SHOPIFY_API_VERSION'];
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.SHOPIFY_SHOP_BAE = 'unit-test-shop';
process.env.SHOPIFY_ADMIN_TOKEN_BAE = 'unit-test-token';
process.env.SHOPIFY_API_VERSION = '2026-10';
delete process.env.SHOPIFY_CLIENT_ID_BAE;
delete process.env.SHOPIFY_CLIENT_SECRET_BAE;
const { pullShopifyOrders } = await import('./shopify.js');
after(() => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  supabaseMock.restore();
  fetchAllMock.restore();
});

function plant(overrides = {}) {
  return {
    id: 'plant-1', brandId: 'bae', sku: 'B-PLANT-1', status: 'available',
    deletedAt: null, shipmentBoxId: null, packedAt: null, notes: '', shopify: {},
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 'gid://shopify/Order/1', name: '#1001', number: 1001,
    createdAt: '2026-11-18T12:00:00Z', processedAt: '2026-11-18T12:00:00Z', updatedAt: '2026-11-18T12:00:00Z',
    displayFinancialStatus: 'PAID', cancelledAt: null, test: false, email: 'buyer@example.test',
    shippingAddress: { name: 'Test Buyer', address1: '1 Test St', city: 'Test City', provinceCode: 'CA', zip: '90000', countryCodeV2: 'US' },
    totalShippingPriceSet: { shopMoney: { amount: '10' } }, shippingLines: { nodes: [] },
    lineItems: { nodes: [{ sku: 'B-PLANT-1', name: 'Test plant', quantity: 1, currentQuantity: 1, discountedTotalSet: { shopMoney: { amount: '200' } } }] },
    ...overrides,
  };
}

function soldPlant(overrides = {}) {
  return plant({
    status: 'sold', shipmentBoxId: 'box-1', orderId: '#1001',
    shopify: { orderGid: 'gid://shopify/Order/1', orderName: '#1001' }, ...overrides,
  });
}

function fulfillmentOrder(overrides = {}) {
  return {
    name: '#1001', displayFinancialStatus: 'PAID', cancelledAt: null,
    fulfillmentOrders: {
      pageInfo: { hasNextPage: false },
      nodes: [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', lineItems: {
        pageInfo: { hasNextPage: false },
        nodes: [{ id: 'gid://shopify/FulfillmentOrderLineItem/1', remainingQuantity: 1, lineItem: { sku: 'B-PLANT-1' } }],
      } }],
    },
    ...overrides,
  };
}

function scenario({ items = [plant()], orders = [], fo = fulfillmentOrder(), payment = order(), fulfillmentResult, trackingResult } = {}) {
  current = {
    tables: { inventory_items: copy(items), app_settings: [], shipments: [{ id: 'box-1', brandId: 'bae', trackingNumber: 'TEST-TRACKING', carrier: 'usps', voidedAt: null, isTestLabel: false }] },
    inventoryWrites: [], requests: [], orders: copy(orders), fo: copy(fo), payment: copy(payment), fulfillmentResult, trackingResult, seq: 0,
  };
  return current;
}

async function pull(state) {
  current = state;
  const fetchMock = mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /^https:\/\/unit-test-shop\.myshopify\.com\/admin\/api\//);
    const { query, variables } = JSON.parse(options.body);
    const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    state.requests.push({ operation, variables });
    let data;
    if (operation === 'Orders') data = { orders: { nodes: copy(state.orders), pageInfo: { hasNextPage: false } } };
    else if (operation === 'FO') data = { order: copy(state.fo) };
    else if (operation === 'OrderPayment') data = { order: copy(state.payment) };
    else if (operation === 'Ful') data = { fulfillmentCreate: state.fulfillmentResult === undefined
      ? { fulfillment: { id: 'gid://shopify/Fulfillment/1' }, userErrors: [] } : copy(state.fulfillmentResult) };
    else if (operation === 'Trk') data = { fulfillmentTrackingInfoUpdate: state.trackingResult === undefined
      ? { fulfillment: { id: variables.id }, userErrors: [] } : copy(state.trackingResult) };
    else assert.fail(`Unexpected GraphQL operation: ${operation}`);
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  try { return await pullShopifyOrders('bae', { force: true, user: { displayName: 'Test user' } }); }
  finally { fetchMock.mock.restore(); }
}

const requests = (state, operation) => state.requests.filter((request) => request.operation === operation);
const problems = (state) => state.tables.app_settings.find((row) => row.id === 'shopify:bae')?.data?.problems || [];
const assertNotFulfilled = (state) => {
  assert.equal(requests(state, 'Ful').length, 0);
  assert.ok(state.tables.inventory_items.every((item) => !item.shopify.fulfilledAt));
};

test('only uncancelled, non-test PAID orders mark a plant sold', async (t) => {
  for (const status of ['PAID', 'PENDING', 'AUTHORIZED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED', 'EXPIRED', null]) {
    await t.test(String(status), async () => {
      const state = scenario({ orders: [order({ displayFinancialStatus: status })] });
      const result = await pull(state);
      assert.equal(state.tables.inventory_items[0].status, status === 'PAID' ? 'sold' : 'available');
      assert.equal(result.soldIds.length, status === 'PAID' ? 1 : 0);
    });
  }
  for (const overrides of [{ cancelledAt: '2026-11-18T12:01:00Z' }, { test: true }]) {
    const state = scenario({ orders: [order(overrides)] });
    assert.equal((await pull(state)).soldIds.length, 0);
    assert.equal(state.tables.inventory_items[0].status, 'available');
  }
});

test('repeated PAID order pulls claim the plant and assign its shipping box once', async () => {
  const state = scenario({ orders: [order()] });
  assert.deepEqual((await pull(state)).soldIds, ['plant-1']);
  const boxId = state.tables.inventory_items[0].shipmentBoxId;
  assert.deepEqual((await pull(state)).soldIds, []);
  assert.equal(state.tables.inventory_items[0].shipmentBoxId, boxId);
  assert.equal(state.inventoryWrites.filter((patch) => patch.status === 'sold').length, 1);
});

test('fresh payment or cancellation changes block fulfillment after an earlier PAID import', async (t) => {
  for (const change of [
    { displayFinancialStatus: 'PENDING' }, { displayFinancialStatus: 'AUTHORIZED' },
    { displayFinancialStatus: 'PARTIALLY_PAID' }, { displayFinancialStatus: 'PARTIALLY_REFUNDED' },
    { displayFinancialStatus: 'REFUNDED' }, { cancelledAt: '2026-11-18T12:01:00Z' },
  ]) {
    await t.test(JSON.stringify(change), async () => {
      const state = scenario({ orders: [order()], fo: fulfillmentOrder(change) });
      await pull(state);
      const item = state.tables.inventory_items[0];
      assert.equal(item.status, 'sold');
      state.tables.shipments[0].id = item.shipmentBoxId;
      await pull(state);
      assert.equal(requests(state, 'FO').length, 1);
      assertNotFulfilled(state);
      assert.ok(problems(state).some((problem) => /only paid|cancelled/.test(problem.message)));
    });
  }
});

test('missing, truncated, held, or unmatched fulfillment data never partially fulfills a box', async (t) => {
  const empty = fulfillmentOrder({ fulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [] } });
  const truncatedOrders = fulfillmentOrder();
  truncatedOrders.fulfillmentOrders.pageInfo.hasNextPage = true;
  const truncatedLines = fulfillmentOrder();
  truncatedLines.fulfillmentOrders.nodes[0].lineItems.pageInfo.hasNextPage = true;
  const held = fulfillmentOrder();
  held.fulfillmentOrders.nodes[0].status = 'ON_HOLD';
  const alreadyClosed = fulfillmentOrder();
  alreadyClosed.fulfillmentOrders.nodes[0].status = 'CLOSED';
  alreadyClosed.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity = 0;
  const secondPlant = soldPlant({ id: 'plant-2', sku: 'B-PLANT-2' });
  const mixedZero = fulfillmentOrder();
  mixedZero.fulfillmentOrders.nodes[0].lineItems.nodes.push({
    id: 'gid://shopify/FulfillmentOrderLineItem/2', remainingQuantity: 0, lineItem: { sku: 'B-PLANT-2' },
  });
  const mixedHeld = fulfillmentOrder();
  mixedHeld.fulfillmentOrders.nodes.push({
    id: 'gid://shopify/FulfillmentOrder/2', status: 'ON_HOLD', lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [{ id: 'gid://shopify/FulfillmentOrderLineItem/2', remainingQuantity: 1, lineItem: { sku: 'B-PLANT-2' } }],
    },
  });
  for (const [name, fo, extraItems] of [
    ['missing order', null], ['no fulfillment orders', empty], ['missing page information', fulfillmentOrder({ fulfillmentOrders: { nodes: [] } })],
    ['truncated orders', truncatedOrders], ['truncated lines', truncatedLines], ['held', held], ['already closed', alreadyClosed],
    ['one SKU absent', fulfillmentOrder(), [secondPlant]],
    ['one SKU has zero remaining', mixedZero, [secondPlant]], ['one SKU on hold', mixedHeld, [secondPlant]],
  ]) {
    await t.test(name, async () => {
      const state = scenario({ items: [soldPlant(), ...(extraItems || [])], fo });
      await pull(state);
      assertNotFulfilled(state);
      assert.ok(problems(state).length > 0);
    });
  }
});

test('a confirmed PAID fulfillment stamps only after Shopify returns its ID', async () => {
  const state = scenario({ items: [soldPlant()] });
  await pull(state);
  assert.equal(requests(state, 'Ful').length, 1);
  assert.equal(requests(state, 'Ful')[0].variables.fulfillment.notifyCustomer, true);
  assert.equal(state.tables.inventory_items[0].shopify.fulfillmentId, 'gid://shopify/Fulfillment/1');
  assert.ok(state.tables.inventory_items[0].shopify.fulfilledAt);
  await pull(state);
  assert.equal(requests(state, 'Ful').length, 1);
});

test('a complete two-plant box fulfills both matching lines in one confirmed operation', async () => {
  const fo = fulfillmentOrder();
  fo.fulfillmentOrders.nodes[0].lineItems.nodes.push({
    id: 'gid://shopify/FulfillmentOrderLineItem/2', remainingQuantity: 1, lineItem: { sku: 'B-PLANT-2' },
  });
  const state = scenario({ items: [soldPlant(), soldPlant({ id: 'plant-2', sku: 'B-PLANT-2' })], fo });
  await pull(state);
  const fulfillmentRequests = requests(state, 'Ful');
  assert.equal(fulfillmentRequests.length, 1);
  assert.equal(fulfillmentRequests[0].variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems.length, 2);
  assert.ok(state.tables.inventory_items.every((item) => item.shopify.fulfilledAt && item.shopify.fulfillmentId === 'gid://shopify/Fulfillment/1'));
});

test('missing fulfillment confirmation or mutation errors do not stamp local fulfillment state', async (t) => {
  for (const result of [null, { fulfillment: null, userErrors: [] }, { fulfillment: { id: 'gid://shopify/Fulfillment/1' }, userErrors: [{ message: 'Not fulfilled' }] }]) {
    await t.test(JSON.stringify(result), async () => {
      const state = scenario({ items: [soldPlant()], fulfillmentResult: result });
      await pull(state);
      assert.equal(requests(state, 'Ful').length, 1);
      assert.equal(state.tables.inventory_items[0].shopify.fulfilledAt, undefined);
      assert.ok(problems(state).length > 0);
    });
  }
});

test('tracking notifications require a fresh uncancelled PAID order and confirmed mutation', async (t) => {
  const item = () => soldPlant({ shopify: {
    orderGid: 'gid://shopify/Order/1', orderName: '#1001', fulfilledAt: '2026-11-18T12:01:00Z',
    fulfillmentId: 'gid://shopify/Fulfillment/1', trackingNumber: 'OLD-TRACKING',
  } });
  for (const change of [
    { displayFinancialStatus: 'PENDING' }, { displayFinancialStatus: 'AUTHORIZED' },
    { displayFinancialStatus: 'PARTIALLY_PAID' }, { displayFinancialStatus: 'PARTIALLY_REFUNDED' },
    { displayFinancialStatus: 'REFUNDED' }, { cancelledAt: '2026-11-18T12:02:00Z' },
  ]) {
    await t.test(JSON.stringify(change), async () => {
      const state = scenario({ items: [item()], payment: order(change) });
      await pull(state);
      assert.equal(requests(state, 'OrderPayment').length, 1);
      assert.equal(requests(state, 'Trk').length, 0);
      assert.equal(state.tables.inventory_items[0].shopify.trackingNumber, 'OLD-TRACKING');
      assert.ok(problems(state).length > 0);
    });
  }
  const unconfirmed = scenario({ items: [item()], trackingResult: { fulfillment: null, userErrors: [] } });
  await pull(unconfirmed);
  assert.equal(unconfirmed.tables.inventory_items[0].shopify.trackingNumber, 'OLD-TRACKING');
  const confirmed = scenario({ items: [item()] });
  await pull(confirmed);
  assert.equal(requests(confirmed, 'Trk').length, 1);
  assert.equal(confirmed.tables.inventory_items[0].shopify.trackingNumber, 'TEST-TRACKING');
});

test('voided and test labels never trigger fulfillment', async () => {
  for (const label of [{ voidedAt: '2026-11-18T12:02:00Z' }, { isTestLabel: true }]) {
    const state = scenario({ items: [soldPlant()] });
    Object.assign(state.tables.shipments[0], label);
    await pull(state);
    assert.equal(requests(state, 'FO').length, 0);
    assertNotFulfilled(state);
  }
});

// ─── lines without a SKU (products made by hand in Shopify) ─────────────────

const noSkuLine = (id, name, overrides = {}) => ({
  id: `gid://shopify/LineItem/${id}`, sku: null, name, quantity: 1, currentQuantity: 1,
  discountedTotalSet: { shopMoney: { amount: '300' } }, ...overrides,
});
const purgePlant = (overrides = {}) => plant({
  id: 'p154', sku: 'B-ANT-A919', lotNumber: 154, name: 'Dark handsome x dream weaver', saleId: 'fb', ...overrides,
});
const byId = (state, id) => state.tables.inventory_items.find((row) => row.id === id);
const placeholders = (state) => state.tables.inventory_items.filter((row) => row.lotKind === 'unmatched');

test('a line with no SKU finds its plant by lot number + name and is boxed like any sale', async () => {
  const state = scenario({
    items: [purgePlant(), plant({ id: 'old154', sku: 'B-ANT-9825', lotNumber: 154, name: 'Red tiger x Pink lemonade' })],
    orders: [order({ lineItems: { nodes: [noSkuLine(1, '154 Dark handsome x dream weaver')] } })],
  });
  state.tables.sales = [{ id: 'fb', brandId: 'bae', status: 'ongoing' }];
  const result = await pull(state);
  const sold = byId(state, 'p154');
  assert.deepEqual(result.soldIds, ['p154']);
  assert.equal(result.matched, 1);
  assert.equal(sold.status, 'sold');
  assert.equal(sold.orderId, '#1001');
  assert.equal(sold.salePrice, 300);
  assert.equal(sold.shopify.lineItemGid, 'gid://shopify/LineItem/1');
  assert.match(sold.notes, /lot 154/);
  assert.equal(byId(state, 'old154').status, 'available');
  assert.equal(placeholders(state).length, 0);
  // Read again: nothing changes.
  assert.deepEqual((await pull(state)).soldIds, []);
  assert.equal(state.inventoryWrites.filter((patch) => patch.status === 'sold').length, 1);
});

test('a line no plant can be found for still ships: a placeholder in the buyer\'s box, once', async () => {
  const state = scenario({
    items: [purgePlant()],
    orders: [order({ lineItems: { nodes: [
      noSkuLine(1, '154 Dark handsome x dream weaver'),
      noSkuLine(2, '166 Red velvet cake x Michelle'),
    ] } })],
  });
  const result = await pull(state);
  assert.equal(result.placeholders, 1);
  const [ph] = placeholders(state);
  assert.equal(ph.sku, 'UNMATCHED-SHOP-bae-1001-2');
  assert.equal(ph.name, '166 Red velvet cake x Michelle');
  assert.equal(ph.status, 'sold');
  assert.equal(ph.lotNumber, null);
  assert.equal(ph.shipmentBoxId, byId(state, 'p154').shipmentBoxId);
  assert.equal(ph.shopify.lineItemGid, 'gid://shopify/LineItem/2');
  // The order's shipping fee is counted once across the box.
  assert.equal([byId(state, 'p154'), ph].reduce((sum, row) => sum + (row.orderShippingFee || 0), 0), 10);
  assert.ok(problems(state).some((problem) => problem.kind === 'unmatched' && /placeholder/.test(problem.message)));
  // Read again → no second placeholder; the packer linked a plant to it (placeholder trashed) → still none.
  await pull(state);
  assert.equal(placeholders(state).length, 1);
  ph.deletedAt = '2026-11-21T23:00:00Z';
  await pull(state);
  assert.equal(placeholders(state).length, 1);
});

test('two plants that fit equally well are not guessed between', async () => {
  const state = scenario({
    items: [purgePlant({ saleId: null }), purgePlant({ id: 'twin', sku: 'B-ANT-A777', saleId: null })],
    orders: [order({ lineItems: { nodes: [noSkuLine(1, '154 Dark handsome x dream weaver')] } })],
  });
  await pull(state);
  assert.ok(['p154', 'twin'].every((id) => byId(state, id).status === 'available'));
  assert.equal(placeholders(state).length, 1);
  assert.ok(problems(state).some((problem) => /could be B-ANT-A919, B-ANT-A777/.test(problem.message)));
});

test('an order fulfilled in Shopify before the app saw it opens no box', async () => {
  const state = scenario({
    items: [purgePlant()],
    orders: [order({ displayFulfillmentStatus: 'FULFILLED', lineItems: { nodes: [noSkuLine(1, '154 Dark handsome x dream weaver')] } })],
  });
  await pull(state);
  assert.equal(byId(state, 'p154').status, 'available');
  assert.equal(placeholders(state).length, 0);
  assert.ok(problems(state).some((problem) => problem.kind === 'fulfilled'));
});

test('a cancelled order flags plants found by title and placeholders still in a box', async () => {
  const state = scenario({
    items: [purgePlant()],
    orders: [order({ lineItems: { nodes: [noSkuLine(1, '154 Dark handsome x dream weaver'), noSkuLine(2, '999 Nothing like it')] } })],
  });
  await pull(state);
  state.orders[0].cancelledAt = '2026-11-21T12:00:00Z';
  await pull(state);
  const flagged = problems(state).filter((problem) => problem.kind === 'cancelled').map((problem) => problem.message);
  assert.equal(flagged.length, 2);
  assert.ok(flagged.some((message) => /B-ANT-A919/.test(message)));
  assert.ok(flagged.some((message) => /"999 Nothing like it"/.test(message)));
});

test('the box\'s tracking fulfils lines found by title and placeholder lines by their line id', async () => {
  const state = scenario({
    items: [purgePlant()],
    orders: [order({ lineItems: { nodes: [noSkuLine(1, '154 Dark handsome x dream weaver'), noSkuLine(2, '999 Nothing like it')] } })],
    fo: fulfillmentOrder({ fulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { id: 'gid://shopify/FulfillmentOrderLineItem/1', remainingQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/1', sku: null } },
        { id: 'gid://shopify/FulfillmentOrderLineItem/2', remainingQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/2', sku: null } },
      ],
    } }] } }),
  });
  await pull(state);
  state.tables.shipments[0].id = byId(state, 'p154').shipmentBoxId;
  await pull(state);
  const ful = requests(state, 'Ful');
  assert.equal(ful.length, 1);
  assert.deepEqual(ful[0].variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems.map((li) => li.id),
    ['gid://shopify/FulfillmentOrderLineItem/1', 'gid://shopify/FulfillmentOrderLineItem/2']);
  assert.ok([byId(state, 'p154'), ...placeholders(state)].every((row) => row.shopify.fulfilledAt));
});

test('Sync now (and the first pull with title matching) reads the last week again and clears old "no SKU" notes', async () => {
  const state = scenario({
    items: [purgePlant()],
    orders: [order({ lineItems: { nodes: [noSkuLine(1, '154 Dark handsome x dream weaver')] } })],
  });
  const cursor = new Date(Date.now() - 60 * 1000).toISOString();
  state.tables.app_settings.push({ id: 'shopify:bae', data: {
    connectedAt: '2020-01-01T00:00:00Z', orderCursor: cursor,
    problems: [{ key: 'gid://shopify/Order/1|no-sku|', kind: 'no-sku', order: '#1001', message: 'has no SKU' },
      { key: 'gid://shopify/Order/9|no-sku|', kind: 'no-sku', order: '#1009', message: 'has no SKU' }],
  } });
  await pull(state);
  const since = Date.parse(/updated_at:>'([^']+)'/.exec(requests(state, 'Orders')[0].variables.q)[1]);
  assert.ok(Date.now() - since > 6 * 86400000, 'looked back a week');
  assert.deepEqual(problems(state).map((problem) => problem.order), ['#1009']);
  assert.ok(state.tables.app_settings.find((row) => row.id === 'shopify:bae').data.lineMatchAt);
});

test('a Shopify plant combined into a Palmstreet box is fulfilled with that box\'s label, UPS when the number says so', async () => {
  // Combine orders moved it into the buyer's Palmstreet box; the Palmstreet
  // label's row is always stored as 'usps' (record-tracking).
  const state = scenario({ items: [soldPlant({ shipmentBoxId: 'up777|andie.shell' })] });
  state.tables.shipments = [{ id: 'up777|andie.shell', brandId: 'bae', trackingNumber: '1Z999AA10123456784', carrier: 'usps', carrierCode: 'palmstreet', voidedAt: null, isTestLabel: false }];
  await pull(state);
  const ful = requests(state, 'Ful');
  assert.equal(ful.length, 1);
  assert.deepEqual(ful[0].variables.fulfillment.trackingInfo, { company: 'UPS', number: '1Z999AA10123456784' });
  assert.ok(state.tables.inventory_items[0].shopify.fulfilledAt);
});
