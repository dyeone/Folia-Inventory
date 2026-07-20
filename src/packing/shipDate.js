// Ship-date helpers shared by every label-buy flow (see ShipDateField.jsx
// for the input component and the why).

// Local calendar date (not UTC — buying at 6pm PT must not say tomorrow).
export function localDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// null when the date is usable, else a short problem string — callers AND
// buy-button gates share this so the rule can't drift.
export function shipDateProblem(value) {
  if (!value) return 'set the ship date';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'invalid ship date';
  if (value < localDateStr(0)) return 'ship date is in the past';
  return null;
}
