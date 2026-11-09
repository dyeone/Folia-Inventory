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
// from false-matching.
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
  return shorter.length >= 12 && longer.includes(shorter);
}

// USPS tracking numbers (20 or 22 digits, starting with 9) end in a mod-10
// check digit: weights 3,1,3,1… from the rightmost body digit. Every USPS
// number stored by 2026-11-08 (410) passes; the 17 OCR misreads of that day
// (a 9 read as 0) all fail — any single wrong digit always fails. Returns
// true/false, or null when the value isn't a USPS-shaped number.
export function uspsCheckDigitOk(raw) {
  const d = canonicalTracking(raw);
  if (!/^9\d{19}$|^9\d{21}$/.test(d)) return null;
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(d[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
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

  // Digit runs that may carry internal spaces/hyphens from the printed groups.
  // OCR can glue a stray digit onto the printed USPS number or run it into
  // the next line ("…6123 31" + "0" read as 23 digits), so a run holding a
  // 9-led 22-digit number is searched for the window that passes the USPS
  // check digit. A run with no passing window still yields its first 9-led
  // 22 digits — the Import labels review flags that as misread.
  let best = '';
  let uspsUnchecked = '';
  for (const m of s.matchAll(/\d[\d\s-]{8,}\d/g)) {
    const d = m[0].replace(/\D/g, '');
    if (/9\d{21}/.test(d)) {
      for (let i = 0; i + 22 <= d.length; i++) {
        if (d[i] !== '9') continue;
        const w = d.slice(i, i + 22);
        if (uspsCheckDigitOk(w)) return w; // USPS — done
        if (!uspsUnchecked) uspsUnchecked = w;
      }
    }
    if (d.length > best.length) best = d;
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
