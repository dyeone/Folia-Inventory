// Calendar helpers for the shift schedule. Weeks start on Monday. Dates are
// plain YYYY-MM-DD strings and times HH:MM, the same shapes the API stores,
// so nothing here depends on the device's time zone except "today".

const pad2 = (n) => String(n).padStart(2, '0');

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Monday of the week holding `dateStr`.
export function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export const weekDays = (weekStart) => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayName(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DOW[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}
export function shortDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MON[m - 1]} ${d}`;
}
export function weekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const [y1, m1] = weekStart.split('-').map(Number);
  const [y2, m2] = end.split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${shortDate(weekStart)} – ${end.split('-')[2].replace(/^0/, '')}, ${y1}`;
  return `${shortDate(weekStart)} – ${shortDate(end)}${y1 === y2 ? `, ${y1}` : ''}`;
}

export const minutesOf = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : 0);
export const hoursBetween = (from, to) => (from && to ? Math.max(0, (minutesOf(to) - minutesOf(from)) / 60) : 0);
export function fmtTime(t) {
  if (!t) return '';
  const h = Number(t.slice(0, 2)), m = t.slice(3, 5);
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 || 12;
  return m === '00' ? `${hh}${ap}` : `${hh}:${m}${ap}`;
}
export const fmtRange = (from, to) => (from && to ? `${fmtTime(from)}–${fmtTime(to)}` : '');
export const fmtHours = (h) => (Number.isInteger(h) ? `${h}h` : `${h.toFixed(1).replace(/\.0$/, '')}h`);

export const DEFAULT_FROM = '09:00';
export const DEFAULT_TO = '17:00';
