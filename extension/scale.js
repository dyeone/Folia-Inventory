// Read weight from a HID-class USB postal scale via WebHID.
//
// Most consumer USB scales (DYMO M10/M25, Stamps.com 510, generic POS
// scales) follow the USB HID Point of Sale Scale spec — usagePage 0x008D.
// The standard input report is 6 bytes:
//   [0] reportId (typically 0x03)
//   [1] status      (1=fault, 2=stable@zero, 3=in motion, 4=stable,
//                    5=under zero, 6=over weight, 7=cal needed, 8=re-zero needed)
//   [2] weight unit (2=g, 3=kg, 4=oz, 5=lb, 11=tenths-of-oz on some scales)
//   [3] data scaling (signed exponent, base 10 — almost always -1 or 0)
//   [4..5] weight value (little-endian, unsigned)
//
// We only read the latest report; the scale broadcasts continuously.

const SCALE_USAGE_PAGE = 0x008D; // POS scale page
const SCALE_USAGE      = 0x0040; // POS scale device

let lastReport = null;
let openedDevice = null;

async function listPaired() {
  if (!('hid' in navigator)) return [];
  return await navigator.hid.getDevices();
}

// Prompt the user to pick a scale from Chrome's device picker. Must be
// called from a user-gesture handler. The device is remembered across
// extension reloads.
async function pair() {
  if (!('hid' in navigator)) {
    throw new Error('WebHID not available — Chrome 89+ required');
  }
  const devices = await navigator.hid.requestDevice({
    filters: [
      { usagePage: SCALE_USAGE_PAGE, usage: SCALE_USAGE },
      { usagePage: SCALE_USAGE_PAGE },
    ],
  });
  if (!devices.length) throw new Error('No scale picked');
  return devices[0];
}

async function open(device) {
  if (openedDevice && openedDevice !== device) {
    try { await openedDevice.close(); } catch { /* ignore */ }
  }
  if (!device.opened) await device.open();
  openedDevice = device;
  device.addEventListener('inputreport', (event) => {
    const v = new DataView(event.data.buffer);
    if (v.byteLength < 5) return;
    // Some scales include the report id in event.reportId, not in the buffer.
    const status = v.getUint8(0);
    const unit   = v.getUint8(1);
    const scale  = v.getInt8(2);
    const raw    = v.getUint16(3, true);
    lastReport = { status, unit, scale, raw, at: Date.now() };
  });
  return device;
}

function reportToOunces(r) {
  if (!r) return null;
  const value = r.raw * Math.pow(10, r.scale);
  // Status: 2=stable-at-zero, 4=stable. 3=in-motion is acceptable but warn.
  if (r.status === 5 || r.status === 6 || r.status === 1 || r.status === 7 || r.status === 8) return null;
  switch (r.unit) {
    case 2:  return value * 0.0352739619; // g → oz
    case 3:  return value * 35.2739619;   // kg → oz
    case 4:  return value;                // oz
    case 5:  return value * 16;           // lb → oz
    case 11: return value / 10;           // tenths of oz
    default: return value; // best-effort: assume oz
  }
}

// Return the latest reading in ounces, waiting briefly for the scale to
// push a fresh report. Resolves null if no reading was received within
// the timeout (so callers can fall through to manual entry).
async function readOnceOz({ timeoutMs = 1500 } = {}) {
  if (!('hid' in navigator)) return null;
  const devices = await listPaired();
  if (!devices.length) return null;
  await open(devices[0]).catch(() => {});

  const start = Date.now();
  const since = lastReport?.at || 0;
  while (Date.now() - start < timeoutMs) {
    if (lastReport && lastReport.at > since) {
      const oz = reportToOunces(lastReport);
      if (oz != null && oz >= 0) return oz;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  // Last-resort: return whatever we last saw (might be stale by < 1s
  // depending on the scale).
  return reportToOunces(lastReport);
}

// Expose to the popup + options pages via a tiny global.
window.FoliaScale = { pair, open, listPaired, readOnceOz };
