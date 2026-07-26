// Heat check for outgoing boxes: live plants cook in transit above ~90°F,
// so before shipping, the desk scans every recipient's 3-day forecast and
// flags the hot destinations to contact. Free, key-less, CLIENT-side
// sources — api.zippopotam.us (US zip → lat/lon) and open-meteo.com (daily
// highs) — so the Vercel 12-function cap is untouched and no secrets are
// needed.

// zip5 → {lat, lon, place} | null (null = zip is unresolvable, cached so a
// bad zip isn't re-fetched every run; transient network errors are NOT
// cached).
const zipCache = new Map();

function zip5(address) {
  const raw = String(address?.zip || address?.zipCode || '').trim();
  const m = /^(\d{5})/.exec(raw);
  return m ? m[1] : null;
}

async function resolveZip(zip) {
  if (zipCache.has(zip)) return zipCache.get(zip);
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!r.ok) { zipCache.set(zip, null); return null; }
    const j = await r.json();
    const p = j?.places?.[0];
    const out = p
      ? { lat: parseFloat(p.latitude), lon: parseFloat(p.longitude), place: `${p['place name']}, ${p['state abbreviation']}` }
      : null;
    zipCache.set(zip, out);
    return out;
  } catch {
    return null;
  }
}

// Open-Meteo accepts comma-separated coordinate lists and answers with an
// array in request order — one request covers every unique zip. Chunked to
// stay well under URL limits. A single location comes back unwrapped.
async function fetchMaxTemps(coords) {
  const out = new Array(coords.length).fill(null);
  const CHUNK = 50;
  for (let i = 0; i < coords.length; i += CHUNK) {
    const chunk = coords.slice(i, i + CHUNK);
    const lats = chunk.map(c => c.lat.toFixed(3)).join(',');
    const lons = chunk.map(c => c.lon.toFixed(3)).join(',');
    try {
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`
        + '&daily=temperature_2m_max&temperature_unit=fahrenheit&forecast_days=3&timezone=auto',
      );
      if (!r.ok) continue;
      const j = await r.json();
      const list = Array.isArray(j) ? j : [j];
      list.forEach((loc, idx) => {
        const temps = loc?.daily?.temperature_2m_max;
        if (Array.isArray(temps) && temps.length) {
          out[i + idx] = { temps: temps.filter(t => Number.isFinite(t)), days: loc?.daily?.time || [] };
        }
      });
    } catch { /* chunk failed — its recipients report as unchecked */ }
  }
  return out;
}

// Scan the given boxes' recipients (one entry per buyer+zip, boxes merged).
// Returns { hot, checked, total, failed }: hot = recipients whose 3-day max
// meets the threshold, hottest first, each { buyer, buyerUsername, place,
// zip, boxCodes, maxTemp, peakDay('YYYY-MM-DD') }; failed = recipients whose
// zip couldn't be parsed/located/forecast.
export async function scanRecipientHeat(boxes, thresholdF = 90) {
  const byRecipient = new Map();
  const failed = [];
  for (const box of boxes || []) {
    const zip = zip5(box.buyerAddress);
    if (!zip) {
      failed.push({ buyer: box.buyer || '(no name)', buyerUsername: box.buyerUsername || '', zip: null, boxCodes: [box.code] });
      continue;
    }
    const key = `${(box.buyer || '').trim().toLowerCase()}|${zip}`;
    let r = byRecipient.get(key);
    if (!r) {
      r = { buyer: box.buyer || '(no name)', buyerUsername: box.buyerUsername || '', zip, boxCodes: [] };
      byRecipient.set(key, r);
    }
    r.boxCodes.push(box.code);
  }
  const recips = [...byRecipient.values()];

  const uniqueZips = [...new Set(recips.map(r => r.zip))];
  const zipInfo = new Map();
  const POOL = 6; // zippopotam has no batch endpoint — bound the fan-out
  for (let i = 0; i < uniqueZips.length; i += POOL) {
    await Promise.all(uniqueZips.slice(i, i + POOL).map(async z => { zipInfo.set(z, await resolveZip(z)); }));
  }
  const located = uniqueZips.filter(z => zipInfo.get(z));
  const forecasts = await fetchMaxTemps(located.map(z => ({ lat: zipInfo.get(z).lat, lon: zipInfo.get(z).lon })));
  const tempsByZip = new Map(located.map((z, i) => [z, forecasts[i]]));

  const hot = [];
  let checked = 0;
  for (const r of recips) {
    const info = zipInfo.get(r.zip);
    const fc = tempsByZip.get(r.zip);
    if (!info || !fc || !fc.temps.length) { failed.push(r); continue; }
    checked += 1;
    const maxTemp = Math.max(...fc.temps);
    if (maxTemp >= thresholdF) {
      const peakIdx = fc.temps.indexOf(maxTemp);
      hot.push({ ...r, place: info.place, maxTemp: Math.round(maxTemp), peakDay: fc.days[peakIdx] || null });
    }
  }
  hot.sort((a, b) => b.maxTemp - a.maxTemp);
  return { hot, checked, total: recips.length, failed };
}
