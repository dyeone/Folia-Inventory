// Match a parsed shipping label to one of the open boxes by OCR text.
//
// We don't trust OCR to cleanly segment the label into fields, so instead of
// parsing the label into {name, street, …} we score each known box against
// the label's full OCR text by containment. The strongest signal by far is
// the Palmstreet username — it's printed on the label (as address line 2 on
// these Shippo labels) and is unique per buyer, so a username hit is a near-
// certain match. ZIP, recipient-name tokens, and the street add corroboration
// and disambiguate buyers who share a name.

// Compact form (no separators) for substring hits like usernames/ZIPs.
function compact(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// Space-delimited tokens for whole-word name/street matching.
function tokens(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

export function scoreBoxAgainstLabel(box, label) {
  const text = ` ${tokens(label.ocrText).join(' ')} `; // padded for word-boundary checks
  const blob = compact(label.ocrText);
  const reasons = [];
  let score = 0;

  // Username is the strongest signal — it's printed on the label and unique
  // per buyer. An exact compact hit scores full; if OCR garbled a character
  // (e.g. PALMER3 → PALMERS3), fall back to matching its separator-delimited
  // parts so a near-miss still counts.
  const username = compact(box.buyerUsername);
  if (username.length >= 3 && blob.includes(username)) {
    score += 100;
    reasons.push('username');
  } else {
    const userParts = tokens(box.buyerUsername).filter((t) => t.length >= 3);
    const partHits = userParts.filter((t) => blob.includes(t)).length;
    if (userParts.length >= 2 && partHits >= userParts.length - 1) {
      score += 70;
      reasons.push(`username~${partHits}/${userParts.length}`);
    }
  }

  const zip = compact(box.buyerAddress?.zip).slice(0, 5);
  if (zip.length === 5 && blob.includes(zip)) {
    score += 30;
    reasons.push('ZIP');
  }

  const nameToks = tokens(box.buyer).filter((t) => t.length >= 2);
  const nameHits = nameToks.filter((t) => text.includes(` ${t} `) || blob.includes(t)).length;
  if (nameToks.length) {
    score += Math.min(45, nameHits * 18);
    if (nameHits) reasons.push(`name×${nameHits}`);
  }

  const street1 = box.buyerAddress?.street1 || '';
  const streetNum = (String(street1).match(/\d+/) || [])[0];
  if (streetNum && streetNum.length >= 2 && blob.includes(streetNum)) {
    score += 12;
    reasons.push('street#');
  }
  const streetToks = tokens(street1).filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  if (streetToks.some((t) => text.includes(` ${t} `))) {
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
export function matchLabelToBoxes(label, boxes) {
  const ranked = boxes
    .map((box) => ({ box, ...scoreBoxAgainstLabel(box, label) }))
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

  return {
    boxId: confidence === 'none' ? null : best.box.id,
    confidence,
    reasons: best?.reasons || [],
    ranked,
  };
}
