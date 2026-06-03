// Update checker for the macOS Bridge app.
//
// There's deliberately no silent in-place auto-update: the app ships
// unsigned (see package.json build.mac.identity = null), and macOS won't
// let an unsigned bundle replace itself — Squirrel.Mac, which every
// Electron auto-updater drives, refuses to apply an update that doesn't
// carry a valid code signature. So instead of pretending, we poll the
// Folia API for the latest published build and, when a newer one exists,
// hand the operator a Download button. They drag the fresh app over the
// old one in /Applications — the same manual step, minus the "is there
// even a new build?" guesswork.
//
// Release info comes from GET {apiBase}/api/bridge?action=mac-version,
// which returns { version, url, notes } (all null when nothing's
// published yet).

const TIMEOUT_MS = 8000;

// Compare two dotted version strings ("0.2.10" vs "0.2.2"). Numeric per
// segment so 10 > 2, with missing trailing segments treated as 0. Returns
// 1 if a > b, -1 if a < b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Resolve to one of:
//   { status: 'update-available', current, latest, url, notes }
//   { status: 'up-to-date',       current, latest }
//   { status: 'unknown',          current, reason }   ← nothing published / not configured
//   { status: 'error',            current, reason }   ← network / server failure
// Never rejects — the caller renders whatever comes back.
async function checkForUpdate({ apiBase, currentVersion }) {
  if (!apiBase) {
    return { status: 'unknown', current: currentVersion, reason: 'No FOLIA_API_URL configured yet' };
  }
  const base = apiBase.replace(/\/+$/, '');
  const url = `${base}/api/bridge?action=mac-version`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!resp.ok) {
      return { status: 'error', current: currentVersion, reason: `HTTP ${resp.status}` };
    }
    const body = await resp.json();
    const latest = body?.version || null;
    if (!latest) {
      return { status: 'unknown', current: currentVersion, reason: 'No build published yet' };
    }
    if (compareVersions(latest, currentVersion) > 0) {
      return {
        status: 'update-available',
        current: currentVersion,
        latest,
        url: body?.url || null,
        notes: body?.notes || null,
      };
    }
    return { status: 'up-to-date', current: currentVersion, latest };
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'Timed out' : (e.message || 'Network error');
    return { status: 'error', current: currentVersion, reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkForUpdate, compareVersions };
