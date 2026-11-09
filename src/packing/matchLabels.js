// Match a parsed shipping label to one of the open boxes by OCR text.
//
// We don't trust OCR to cleanly segment the label into fields, so instead of
// parsing the label into {name, street, …} we score each known box against
// the label's OCR text by containment. The strongest signal by far is the
// Palmstreet username — it's printed on the label (as address line 2 on
// these Shippo labels) and is unique per buyer, so a username hit is a near-
// certain match. ZIP, recipient-name tokens, and the street add corroboration
// and disambiguate buyers who share a name.
//
// Only text that can describe the BUYER is scored (recipientText). Scoring
// the whole label once auto-assigned labels to the wrong box: a username
// part like PLANT matched our own sender line "BAEGIN PLANTS", KING matched
// "USPS TRACKING", and an "… AVE" street matched our "ALMA AVE" — a green
// "Auto-matched" row with Save ticked, and the packer then printed another
// customer's label for that box (its scan passed, matching what was stored).

// Compact form (no separators) for substring hits like usernames/ZIPs.
function compact(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// Space-delimited tokens for whole-word name/street matching.
function tokens(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

// Lines printed on every label that never name the buyer: the carrier
// banner, postage indicia, the tracking line, ship date and weight.
const NOT_RECIPIENT = / (?:USPS|POSTAGE|PAID|PRIORITY|GROUND|ADVANTAGE|FIRST CLASS|EXPRESS|TRACKING|SHIPPO|DATE|WEIGHT|LBS?|OZ) /;
// Street words that say nothing about WHICH street.
const GENERIC_STREET = new Set(['AVE', 'AVENUE', 'STREET', 'ROAD', 'DRIVE', 'LANE', 'COURT', 'BLVD', 'BOULEVARD', 'WAY', 'CIRCLE', 'PLACE', 'TRAIL', 'PARKWAY', 'HIGHWAY', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'APT', 'UNIT', 'SUITE', 'STE']);

// The label text that can describe the buyer: OCR lines minus the ones above,
// minus our own sender block (the line naming the ship-from street — with
// the name line before it and the city line after — and any line with the
// ship-from ZIP), with long digit runs (the tracking number, the routing
// block) blanked so a ZIP or house number can't "match" inside them.
export function recipientText(ocrText, shipFrom) {
  const lines = String(ocrText || '').toUpperCase().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const fromNum = (String(shipFrom?.street1 || '').match(/\d+/) || [])[0];
  const fromWords = tokens(shipFrom?.street1).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC_STREET.has(t));
  const fromZip = compact(shipFrom?.zip).slice(0, 5);
  const drop = new Set();
  lines.forEach((line, i) => {
    const padded = ` ${tokens(line).join(' ')} `;
    if (NOT_RECIPIENT.test(padded)) drop.add(i);
    if (fromNum && padded.includes(` ${fromNum} `) && fromWords.some((w) => padded.includes(` ${w} `))) {
      drop.add(i - 1); drop.add(i); drop.add(i + 1);
    }
    if (fromZip.length === 5 && padded.includes(` ${fromZip} `)) drop.add(i);
  });
  // Blank per line: across a line break the recipient's ZIP would join the
  // tracking digits below it and be blanked with them.
  return lines.filter((_, i) => !drop.has(i)).map((l) => l.replace(/\d[\d \t-]{10,}\d/g, ' ')).join('\n');
}

export function scoreBoxAgainstLabel(box, label, { shipFrom } = {}) {
  const recipient = recipientText(label.ocrText, shipFrom);
  const text = ` ${tokens(recipient).join(' ')} `; // padded for word-boundary checks
  const blob = compact(recipient);
  const hasWord = (t) => text.includes(` ${t} `);
  const reasons = [];
  let score = 0;

  // Username is the strongest signal — it's printed on the label and unique
  // per buyer. An exact compact hit scores full; if OCR garbled a character
  // (e.g. PALMER3 → PALMERS3), its separator-delimited parts can still count
  // — but only as whole words, and only when at least two parts hit and at
  // most one is missing, so a single common word can never carry a match.
  const username = compact(box.buyerUsername);
  if (username.length >= 3 && blob.includes(username)) {
    score += 100;
    reasons.push('username');
  } else {
    const userParts = tokens(box.buyerUsername).filter((t) => t.length >= 3);
    const partHits = userParts.filter(hasWord).length;
    if (userParts.length >= 2 && partHits >= 2 && partHits >= userParts.length - 1) {
      score += 70;
      reasons.push(`username~${partHits}/${userParts.length}`);
    }
  }

  const zip = compact(box.buyerAddress?.zip).slice(0, 5);
  if (zip.length === 5 && hasWord(zip)) {
    score += 30;
    reasons.push('ZIP');
  }

  const nameToks = tokens(box.buyer).filter((t) => t.length >= 2);
  const nameHits = nameToks.filter((t) => hasWord(t) || (t.length >= 4 && blob.includes(t))).length;
  if (nameToks.length) {
    score += Math.min(45, nameHits * 18);
    if (nameHits) reasons.push(`name×${nameHits}`);
  }

  const street1 = box.buyerAddress?.street1 || '';
  const streetNum = (String(street1).match(/\d+/) || [])[0];
  if (streetNum && streetNum.length >= 2 && hasWord(streetNum)) {
    score += 12;
    reasons.push('street#');
  }
  const streetToks = tokens(street1).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC_STREET.has(t));
  if (streetToks.some(hasWord)) {
    score += 13;
    reasons.push('street');
  }

  return { score, reasons };
}

// Rank all boxes for one label and pick a best guess + confidence tier.
//   high   → username hit, or a strong score with clear separation from #2
//   medium → solid corroboration (name + ZIP/street) but no username
//   low    → a weak single signal; operator should eyeball it
//   none   → nothing matched (OCR failed or buyer not among open boxes)
// autoAssign — pre-tick Save — only on an exact username hit, or a username
// that OCR garbled but whose parts, ZIP and name all agree: a wrong
// assignment ships another customer's label, so anything weaker waits for
// the operator.
export function matchLabelToBoxes(label, boxes, opts = {}) {
  const ranked = boxes
    .map((box) => ({ box, ...scoreBoxAgainstLabel(box, label, opts) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];
  let confidence = 'none';
  if (best && best.score > 0) {
    const margin = best.score - (second?.score || 0);
    if (best.reasons.includes('username') || (best.score >= 70 && margin >= 25)) confidence = 'high';
    else if (best.score >= 40) confidence = 'medium';
    else confidence = 'low';
  }
  const r = best?.reasons || [];
  const autoAssign = confidence === 'high' && (
    r.includes('username')
    || (r.some((x) => x.startsWith('username~')) && r.includes('ZIP') && r.some((x) => x.startsWith('name×')))
  );

  return {
    boxId: confidence === 'none' ? null : best.box.id,
    confidence,
    autoAssign,
    reasons: r,
    ranked,
  };
}
