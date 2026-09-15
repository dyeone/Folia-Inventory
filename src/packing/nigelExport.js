import { shortBoxCode } from '../labels/boxCode.js';
import { isNigelBoxId } from './platform.js';

// Export Nigel's boxes' shipping info.
//
// Nigel (BoyGardening) hands us his orders as slips; we pack and ship
// them and he needs the tracking back in his own system. This builds one
// CSV row per ORDER (his unit of work — several of his orders can share a
// box, in which case they share a tracking number) across every Nigel box
// in the brand, open or shipped, with the customer, ship-to, items,
// carrier/tracking, label + ship dates and a status. Derived entirely from
// the items (boxes are items sharing a shipmentBoxId) and the shipments
// map the Shipping tab already holds — no new endpoint.

export function trackingUrl(carrierCode, trackingNumber) {
  const t = String(trackingNumber || '').trim();
  if (!t) return '';
  const c = String(carrierCode || '').toLowerCase();
  if (c.includes('ups') || /^1Z/i.test(t)) return `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(t)}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`;
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}`;
}

function carrierLabel(shipment) {
  const c = String(shipment?.carrierCode || '').toLowerCase();
  if (c.includes('ups')) return 'UPS';
  if (c.includes('fedex')) return 'FedEx';
  if (c === 'palmstreet' || c.includes('usps') || c.includes('stamps')) return 'USPS';
  return shipment?.carrierCode ? String(shipment.carrierCode) : '';
}

const SERVICE_LABELS = {
  ups_2nd_day_air: 'UPS 2nd Day Air',
  ups_next_day_air: 'UPS Next Day Air',
  ups_next_day_air_saver: 'UPS Next Day Air Saver',
  ups_ground: 'UPS Ground',
  usps_priority: 'USPS Priority',
  usps_priority_mail: 'USPS Priority',
  usps_ground_advantage: 'USPS Ground Advantage',
  palmstreet_usps: 'USPS',
};

function serviceLabel(shipment) {
  const s = String(shipment?.serviceCode || '');
  return SERVICE_LABELS[s] || s.replace(/_/g, ' ');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function boxStatus(items) {
  const sold = items.filter(i => i.status === 'sold');
  if (sold.length === 0) return 'shipped';
  return sold.every(i => i.packedAt) ? 'packed' : 'open';
}

// rows: one per order. `shipmentsByBox` = { [shipmentBoxId]: shipments row }.
export function buildNigelShippingRows(inventoryItems, shipmentsByBox = {}) {
  const boxes = new Map();
  for (const it of inventoryItems || []) {
    if (it.deletedAt || !it.shipmentBoxId || !isNigelBoxId(it.shipmentBoxId)) continue;
    if (!['sold', 'shipped', 'delivered'].includes(it.status)) continue;
    if (!boxes.has(it.shipmentBoxId)) boxes.set(it.shipmentBoxId, []);
    boxes.get(it.shipmentBoxId).push(it);
  }
  const rows = [];
  for (const [boxId, items] of boxes) {
    const shipment = shipmentsByBox?.[boxId];
    const live = shipment && !shipment.voidedAt ? shipment : null;
    const status = boxStatus(items);
    const shippedAt = items.map(i => i.shippedAt).filter(Boolean).sort()[0] || '';
    const first = items[0];
    const a = first.buyerAddress || {};
    // Orders in this box, oldest first; lines without an order # fall
    // into one "other" row.
    const orders = new Map();
    for (const it of items) {
      const key = it.orderId || '';
      if (!orders.has(key)) orders.set(key, { orderId: key, orderDate: it.orderDate || it.soldAt || '', items: [] });
      orders.get(key).items.push(it);
    }
    for (const o of [...orders.values()].sort((x, y) => String(x.orderDate).localeCompare(String(y.orderDate)))) {
      rows.push({
        orderNumber: o.orderId,
        orderDate: fmtDate(o.orderDate),
        customer: first.buyer || '',
        email: a.email || '',
        phone: a.phone || '',
        street: [a.street1, a.street2].filter(Boolean).join(', '),
        city: a.city || '',
        state: a.state || '',
        zip: a.zip || '',
        items: o.items.map(i => `${i.name || i.sku || 'item'}${(parseInt(i.quantity, 10) || 1) > 1 ? ` ×${parseInt(i.quantity, 10)}` : ''}`).join('; '),
        qty: o.items.reduce((n, i) => n + (parseInt(i.quantity, 10) || 1), 0),
        deliveryMethod: a.shipmentMethod || '',
        carrier: live ? carrierLabel(live) : '',
        service: live ? serviceLabel(live) : '',
        trackingNumber: live?.trackingNumber || '',
        trackingUrl: live ? trackingUrl(live.carrierCode, live.trackingNumber) : '',
        labelBought: live ? fmtDate(live.purchasedAt) : '',
        shippedAt: status === 'shipped' ? fmtDate(shippedAt) : '',
        status,
        boxCode: shortBoxCode(boxId),
        ordersInBox: orders.size,
      });
    }
  }
  rows.sort((x, y) => String(x.orderNumber).localeCompare(String(y.orderNumber), undefined, { numeric: true }));
  return rows;
}

const COLUMNS = [
  ['orderNumber', 'Order #'],
  ['orderDate', 'Order date'],
  ['customer', 'Customer'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['street', 'Street'],
  ['city', 'City'],
  ['state', 'State'],
  ['zip', 'ZIP'],
  ['items', 'Items'],
  ['qty', 'Qty'],
  ['deliveryMethod', 'Delivery method'],
  ['carrier', 'Carrier'],
  ['service', 'Service'],
  ['trackingNumber', 'Tracking #'],
  ['trackingUrl', 'Tracking link'],
  ['labelBought', 'Label bought'],
  ['shippedAt', 'Shipped'],
  ['status', 'Status'],
  ['boxCode', 'Box'],
  ['ordersInBox', 'Orders in box'],
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function nigelShippingCsv(rows) {
  const head = COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map(r => COLUMNS.map(([key]) => csvCell(r[key])).join(','));
  // BOM so Excel opens it as UTF-8 (item names carry quotes and dashes).
  return `\uFEFF${[head, ...body].join('\r\n')}\r\n`;
}

export function downloadNigelShippingCsv(rows) {
  const blob = new Blob([nigelShippingCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nigel-shipping-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
