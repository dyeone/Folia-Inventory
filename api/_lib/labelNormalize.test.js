// Run: node --test api/_lib/labelNormalize.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { normalizeLabelTo4x6 } from './labelNormalize.js';

// Build a base64 PDF of the given page size (points), with a marker drawn in the
// top-left so we can reason about what the crop keeps.
async function makePdf(w, h, { pages = 1 } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([w, h]);
    p.drawText('LABEL', { x: 6, y: h - 24, size: 12 }); // top-left
  }
  return Buffer.from(await doc.save()).toString('base64');
}

async function pageSize(base64) {
  const doc = await PDFDocument.load(Buffer.from(base64, 'base64'));
  const { width, height } = doc.getPages()[0].getSize();
  return { width: Math.round(width), height: Math.round(height), count: doc.getPageCount() };
}

test('crops an 8.5x11 letter label to a single top-left 4x6 page', async () => {
  const input = await makePdf(612, 792, { pages: 2 }); // letter + packing slip page
  const { base64, changed, from, to } = await normalizeLabelTo4x6(input);
  assert.equal(changed, true);
  assert.deepEqual(from, [612, 792]);
  assert.deepEqual(to, [288, 432]);
  const size = await pageSize(base64);
  assert.deepEqual([size.width, size.height], [288, 432]);
  assert.equal(size.count, 1, 'trailing packing-slip page is dropped');
});

test('leaves a true 4x6 (288x432) label untouched', async () => {
  const input = await makePdf(288, 432);
  const { base64, changed } = await normalizeLabelTo4x6(input);
  assert.equal(changed, false);
  assert.equal(base64, input, 'bytes are returned unchanged');
});

test('leaves a slightly-narrow 3.81x6 (274x432) USPS label untouched', async () => {
  const input = await makePdf(274, 432);
  const { changed } = await normalizeLabelTo4x6(input);
  assert.equal(changed, false);
});

test('fails safe: garbage input returns the original bytes, never throws', async () => {
  const garbage = Buffer.from('not a pdf').toString('base64');
  const { base64, changed, error } = await normalizeLabelTo4x6(garbage);
  assert.equal(changed, false);
  assert.equal(base64, garbage);
  assert.ok(error, 'reports the error instead of throwing');
});

test('null/empty input is a no-op', async () => {
  const { base64, changed } = await normalizeLabelTo4x6(null);
  assert.equal(changed, false);
  assert.equal(base64, null);
});
