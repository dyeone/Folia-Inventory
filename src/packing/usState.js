// US state / country name → 2-letter codes, for addresses parsed client-side
// (Nigel's order slips spell states out: "Florida", "District of Columbia").
// Twin of api/_lib/usState.js — the server re-normalizes at quote/buy time
// regardless, but boxes should carry the same short form every other import
// path writes so the Shipping tab's address line and grouping stay uniform.
const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'washington dc': 'DC',
  'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI',
  'us virgin islands': 'VI', 'american samoa': 'AS', 'northern mariana islands': 'MP',
};

export function normalizeUsState(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_CODES[s.toLowerCase().replace(/\s+/g, ' ')] || s;
}

// True when the string is a spelled-out or 2-letter US state we know —
// used by the slip parser to find the "State ZIP" part of a comma-joined
// address without trusting OCR's line breaks.
export function isKnownUsState(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^[A-Za-z]{2}$/.test(s)) return Object.values(STATE_CODES).includes(s.toUpperCase());
  return s.toLowerCase().replace(/\s+/g, ' ') in STATE_CODES;
}

const COUNTRY_CODES = {
  'united states': 'US', 'united states of america': 'US', usa: 'US',
  'u.s.': 'US', 'u.s.a.': 'US', america: 'US',
  canada: 'CA', mexico: 'MX',
};

export function normalizeCountry(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY_CODES[s.toLowerCase().replace(/\s+/g, ' ')] || s;
}
