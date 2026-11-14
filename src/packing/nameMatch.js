// Do a listing title and a plant name describe the same plant? Shared by
// Validate Sales (lineup-number fallback) and the packer (which placeholder
// line a scanned plant can fill). Titles are typed by hand during a show —
// "553 rose belle", "mint dark phoenix #2", "KOS x RC rehab" — so this is a
// loose test: any significant word in common, prefixes allowed
// ("Varigated" / "variegated" aside, "offspring" ↔ "offsprings").
const STOP = new Set(['anthurium', 'the', 'and', 'with', 'for', 'plant', 'var']);

// Significant words of a name or title; a leading lineup number is dropped.
export function nameWords(s) {
  return String(s || '').toLowerCase()
    .replace(/^\s*\d{1,4}\s+/, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w));
}

// How many of `a`'s words appear in `b` (exact or one a prefix of the other).
export function sharedWords(a, b) {
  const wb = nameWords(b);
  return nameWords(a).filter((w) => wb.some((x) => x === w || x.startsWith(w) || w.startsWith(x))).length;
}

export function namesAgree(a, b) {
  return sharedWords(a, b) > 0;
}
