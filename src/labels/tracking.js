// Tracking-number normalization + matching.
//
// A USPS tracking number shows up in two forms that have to be reconciled:
//   • Human-readable on the label:  "9205 5903 7248 8900 6563 92"  (22 digits)
//   • Encoded in the CODE-128 / IMpb barcode the packer scans: the same 22
//     digits prefixed by a routing block — "420" + destination ZIP(5 or 9)
//     + the 22-digit tracking, e.g. "420 92102 9205 5903 7248 8900 6563 92".
//
// So the number we OCR/print and the number a scanner reads off the barcode
// differ. We canonicalize both to a comparable form (the trailing 22-digit
// USPS tracking when present) and, as a fallback, match by digit containment
// so a barcode scan still verifies against the stored human tracking.

const USPS_22 = /^9\d{21}$/;
const UPS_1Z = /1Z[0-9A-Z]{16}/;

// USPS package numbers (IMpb PICs: 20, 22 or 26 digits) end in a mod-10
// check digit: weights 3,1,3,1… from the rightmost body digit. Every USPS
// number stored by 2026-11-08 (410) passes; the 17 OCR misreads of that day
// (a 9 read as 0) all fail. Any single wrong digit — the first one included —
// always fails.
function mod10Ok(d) {
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(d[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}
const PIC_LENGTHS = [22, 26, 20];

export function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

// Reduce any decoded/typed string to its canonical tracking number.
//   • UPS "1Z..." is returned verbatim (alphanumeric — never digit-stripped).
//   • USPS IMpb: the human tracking is the trailing 22 digits; drop the
//     "420 + ZIP" routing prefix the barcode carries.
//   • Anything else (FedEx / unknown): the full digit run.
export function canonicalTracking(raw) {
  const s = String(raw || '').toUpperCase();
  const ups = s.match(UPS_1Z);
  if (ups) return ups[0];

  const d = digitsOnly(s);
  if (!d) return '';
  if (d.length > 22) {
    const tail = d.slice(-22);
    if (USPS_22.test(tail)) return tail; // strip IMpb routing prefix
  }
  if (USPS_22.test(d)) return d;
  return d;
}

// True if two tracking strings refer to the same parcel. Robust to the IMpb
// routing prefix: compares canonical forms first, then falls back to digit
// containment (the shorter human tracking is a substring of the longer
// barcode payload). The 12-digit floor keeps short coincidental overlaps
// from false-matching. A USPS-looking value (9-led) only counts as the
// contained side when it is a whole, check-valid PIC: labels bought together
// share their first 20 digits, so a stored fragment would otherwise "match"
// every label of the batch and let the wrong label pass the packer's check.
export function tracksMatch(a, b) {
  const ca = canonicalTracking(a);
  const cb = canonicalTracking(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;

  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  const shorter = da.length <= db.length ? da : db;
  const longer = da.length <= db.length ? db : da;
  if (shorter.length < 12 || !longer.includes(shorter)) return false;
  return shorter[0] !== '9' || (PIC_LENGTHS.includes(shorter.length) && mod10Ok(shorter));
}


// True/false for a 9-led 20- or 22-digit USPS number, null for anything else.
export function uspsCheckDigitOk(raw) {
  const d = canonicalTracking(raw);
  if (!/^9\d{19}$|^9\d{21}$/.test(d)) return null;
  return mod10Ok(d);
}

// The PIC inside a scanned or pasted IMpb payload: "420"+ZIP5 (8 digits) or
// "420"+ZIP9 (12) is dropped when a check-valid PIC remains.
function uspsPic(digits) {
  if (digits.startsWith('420')) {
    for (const cut of [8, 12]) {
      const rest = digits.slice(cut);
      if (PIC_LENGTHS.includes(rest.length) && mod10Ok(rest)) return rest;
    }
  }
  return digits;
}

// Is this a USPS-style number that was read or typed wrong? Used wherever a
// tracking # is SAVED (Import labels, the record-tracking API), because a
// wrong # gives the box a number no label scan will ever match.
//   • UPS 1Z…: never judged here.
//   • A letter inside a long number (an O typed for a 0): misread.
//   • 19–26 digits: valid only as a 20-, 22- or 26-digit PIC that passes the
//     check digit; a dropped/added digit or a failing check is a misread.
//   • 12–18 digits starting with 9: a USPS number cut short — misread.
//   • Anything shorter or longer (FedEx, DHL, S10 international…): not judged.
// Mirrored in api/_lib/tracking.js (keep identical).
export function trackingLooksMisread(raw) {
  const s = String(raw || '').toUpperCase().trim();
  if (!s || UPS_1Z.test(s)) return false;
  const compact = s.replace(/[\s-]/g, '');
  if (/[A-Z]/.test(compact)) return digitsOnly(compact).length >= 18;
  const d = uspsPic(digitsOnly(compact));
  // A 9-led 12–18-digit value is a USPS number cut short (OCR split it, or a
  // partial paste) — saved, it would match every label of its batch, since
  // labels bought together share their first 20 digits.
  if (d[0] === '9' && d.length >= 12 && d.length < 19) return true;
  if (d.length < 19 || d.length > 26) return false;
  return !PIC_LENGTHS.includes(d.length) || !mod10Ok(d);
}

// Pull a tracking number out of OCR'd label text. The barcode is the exact
// source when it decodes, but on image-only labels it often doesn't — and the
// human-readable tracking ("9205 5903 7248 8900 6563 92") is printed in large
// type right below it, which OCR reads cleanly. Prefer a USPS 22-digit, then
// UPS 1Z, else the longest plausible digit run.
export function extractTrackingFromText(text) {
  const s = String(text || '').toUpperCase();

  const ups = s.match(UPS_1Z);
  if (ups) return ups[0];

  // The USPS number is printed in digit groups ("9205 5903 7248 8900 6563
  // 92"). OCR can run a neighbouring line into it (a ZIP+4 above, a stray
  // digit below) or glue a digit on, so candidates are tried in order of
  // trust, each validated by the USPS check digit:
  //   1. printed groups on one line that make up the whole number — a group
  //      run reaching 26 digits is a 26-digit PIC, one stopping at 22 a
  //      22-digit PIC, one ending at exactly 20 a 20-digit number (never the
  //      first 20 digits of a longer one, which pass by chance 1 time in 10),
  //   2. the same across lines (OCR wrapped the number),
  //   3. any check-valid 9-led 22-digit window in a digit run,
  // and only then the first 9-led 22 digits unchecked — which the Import
  // labels review flags as misread — or the longest digit run.
  const lines = s.split(/\n/);
  const runsOf = (texts) => texts.flatMap((t) => [...t.matchAll(/\d[\d\s-]{8,}\d/g)].map((m) => m[0]));
  const aligned = (run) => {
    const groups = run.split(/[\s-]+/).filter(Boolean);
    for (let i = 0; i < groups.length; i++) {
      if (groups[i][0] !== '9') continue;
      let acc = '';
      let pick = '';
      for (let j = i; j < groups.length && acc.length < 26; j++) {
        acc += groups[j];
        if (acc.length === 26 || acc.length === 22) pick = acc;
        else if (acc.length === 20 && j === groups.length - 1) pick = acc;
      }
      if (pick && mod10Ok(pick)) return pick;
    }
    return '';
  };
  for (const runs of [runsOf(lines), runsOf([s])]) {
    for (const run of runs) {
      const hit = aligned(run);
      if (hit) return hit;
    }
  }
  let best = '';
  let uspsUnchecked = '';
  for (const runs of [runsOf(lines), runsOf([s])]) {
    for (const run of runs) {
      const d = run.replace(/\D/g, '');
      for (let i = 0; i + 22 <= d.length; i++) {
        if (d[i] !== '9') continue;
        const w = d.slice(i, i + 22);
        if (mod10Ok(w)) return w;
        if (!uspsUnchecked) uspsUnchecked = w;
      }
      if (d.length > best.length) best = d;
    }
  }
  if (uspsUnchecked) return uspsUnchecked;
  return best.length >= 12 ? canonicalTracking(best) : '';
}

// Does this string plausibly carry a parcel tracking number? Used to route a
// scan-strip/USB-scanner read toward label verification instead of the
// box-code / item-SKU paths.
export function looksLikeTracking(raw) {
  const s = String(raw || '').toUpperCase();
  if (UPS_1Z.test(s)) return true;
  return digitsOnly(s).length >= 18;
}

// Pretty-print a 22-digit USPS tracking in the carrier's 4-4-4-4-4-2 groups.
// Non-USPS values are returned trimmed but otherwise untouched.
export function formatTracking(raw) {
  const c = canonicalTracking(raw);
  if (USPS_22.test(c)) {
    return c.replace(/(\d{4})(\d{4})(\d{4})(\d{4})(\d{4})(\d{2})/, '$1 $2 $3 $4 $5 $6');
  }
  return String(raw || '').trim();
}
