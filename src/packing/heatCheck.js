// Heat check for outgoing boxes: live plants cook in transit above ~90°F,
// so before shipping, the desk scans every recipient's 5-day forecast and
// flags the hot destinations to contact. Free, key-less, CLIENT-side
// sources — api.zippopotam.us (US zip → lat/lon) and open-meteo.com (daily
// highs) — so the Vercel 12-function cap is untouched and no secrets are
// needed.

// Heat flags stashed for the packer (app_settings heat-check:<brandId>) are
// honored this long after the desk's scan — forecasts drift, and a flag
// from last week must not demand insulation in a cold snap. Matches the
// transit window the 5-day forecast covers.
export const HEAT_FLAG_TTL_MS = 4 * 24 * 60 * 60 * 1000;
export function heatFlagsFresh(checkedAt) {
  const t = new Date(checkedAt || 0).getTime();
  return Number.isFinite(t) && t > 0 && Date.now() - t < HEAT_FLAG_TTL_MS;
}

// zip5 → {lat, lon, place} | null (null = zip is unresolvable, cached so a
// bad zip isn't re-fetched every run; transient network errors are NOT
// cached).
const zipCache = new Map();

function zip5(address) {
  let raw = String(address?.zip || address?.zipCode || '').trim();
  // XLSX imports can deliver leading-zero zips as bare numbers ("2134" for
  // Boston's 02134) — restore the zeros before parsing.
  if (/^\d{3,4}$/.test(raw)) raw = raw.padStart(5, '0');
  const m = /^(\d{5})/.exec(raw);
  return m ? m[1] : null;
}

async function resolveZip(zip) {
  if (zipCache.has(zip)) return zipCache.get(zip);
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${zip}`);
    // Only a 404 (zip doesn't exist) is a durable fact worth caching —
    // 429/5xx are transient and must stay retryable within the session.
    if (!r.ok) { if (r.status === 404) zipCache.set(zip, null); return null; }
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
      // forecast_days=5 (today + 4), not the literal 3: the check runs at
      // ship time and 2-3-day transit means the arrival day — the hot-porch
      // day — falls outside a 3-day window.
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`
        + '&daily=temperature_2m_max&temperature_unit=fahrenheit&forecast_days=5&timezone=auto',
      );
      if (!r.ok) continue;
      const j = await r.json();
      const list = Array.isArray(j) ? j : [j];
      list.forEach((loc, idx) => {
        const rawTemps = loc?.daily?.temperature_2m_max;
        const rawDays = loc?.daily?.time || [];
        if (!Array.isArray(rawTemps) || !rawTemps.length) return;
        // Filter (temp, day) PAIRS so a null gap in the API data can't
        // misalign the peak-day lookup downstream.
        const temps = [];
        const days = [];
        rawTemps.forEach((t, k) => {
          if (Number.isFinite(t)) { temps.push(t); days.push(rawDays[k] || null); }
        });
        if (temps.length) out[i + idx] = { temps, days };
      });
    } catch { /* chunk failed — its recipients report as unchecked */ }
  }
  return out;
}

// Scan the given boxes' recipients (one entry per buyer+zip, boxes merged).
// Returns { hot, checked, total, failed }: hot = recipients whose 5-day max
// meets the threshold, hottest first, each { buyer, buyerUsername, place,
// zip, boxCodes, maxTemp, peakDay('YYYY-MM-DD') }; failed = recipients whose
// zip couldn't be parsed/located/forecast.
export async function scanRecipientHeat(boxes, thresholdF = 90) {
  const byRecipient = new Map();
  const noZip = new Map();
  for (const box of boxes || []) {
    // The username disambiguates two buyers who share a display name (same
    // rule as the desk's buyer grouping) — keying on the name alone would
    // silently merge them and drop one from the contact list.
    const who = `${((box.buyerUsername || box.buyer) || '').trim().toLowerCase()}`;
    const zip = zip5(box.buyerAddress);
    const bucket = zip ? byRecipient : noZip;
    const key = zip ? `${who}|${zip}` : who;
    let r = bucket.get(key);
    if (!r) {
      r = { buyer: box.buyer || '(no name)', buyerUsername: box.buyerUsername || '', zip, boxCodes: [], boxIds: [] };
      bucket.set(key, r);
    }
    r.boxCodes.push(box.code);
    r.boxIds.push(box.id);
  }
  const recips = [...byRecipient.values()];
  const failed = [...noZip.values()];

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
