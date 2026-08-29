// US state/territory name → USPS 2-letter code. Carrier APIs (ShipStation
// getrates/createlabel, Shippo's UPS accounts) reject or misprice full state
// names — a buyer address entered as "Florida" made ShipStation's whole
// getrates call 500 ("One or more providers reported an error"). Addresses
// reach us from many sources (manual entry, CSVs, history picks), so the
// server normalizes at quote/buy time instead of trusting every entry path.
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

// 2-letter inputs pass through uppercased; known full names map to their
// code; anything else returns trimmed as-is (don't invent data — the carrier
// will say what it thinks of it).
export function normalizeUsState(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_CODES[s.toLowerCase().replace(/\s+/g, ' ')] || s;
}

// Country name → ISO-2 code, same posture as states: carriers want "US",
// but addresses arrive with whatever the source wrote — TikTok's order
// export says "United States" (which made ShipStation createlabel return
// "The request is invalid"), manual entries say "USA". 2-letter inputs
// pass through uppercased; unknown names return trimmed as-is.
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
