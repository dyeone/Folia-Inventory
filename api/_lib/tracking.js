// Server mirror of trackingLooksMisread in src/labels/tracking.js (keep the
// two identical). Saving a tracking # that was read or typed wrong gives the
// box a number no label scan will ever match — the packer gets "this label
// isn't assigned to any open box" (2026-11-08: 17 bae-gin imports OCR-misread
// a 9 as a 0). USPS package numbers (IMpb PICs: 20, 22 or 26 digits) end in a
// mod-10 check digit (weights 3,1 from the rightmost body digit), and any
// single wrong digit fails it.

const UPS_1Z = /1Z[0-9A-Z]{16}/;
const PIC_LENGTHS = [22, 26, 20];

const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

function mod10Ok(d) {
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(d[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}

// "420"+ZIP5 (8 digits) or "420"+ZIP9 (12) is dropped when a check-valid PIC remains.
function uspsPic(digits) {
  if (digits.startsWith('420')) {
    for (const cut of [8, 12]) {
      const rest = digits.slice(cut);
      if (PIC_LENGTHS.includes(rest.length) && mod10Ok(rest)) return rest;
    }
  }
  return digits;
}

//   • UPS 1Z…: never judged here.
//   • A letter inside a long number (an O typed for a 0): misread.
//   • 19–26 digits: valid only as a 20-, 22- or 26-digit PIC that passes the
//     check digit; a dropped/added digit or a failing check is a misread.
//   • 12–18 digits starting with 9: a USPS number cut short — misread.
//   • Anything shorter or longer (FedEx, DHL, S10 international…): not judged.
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
