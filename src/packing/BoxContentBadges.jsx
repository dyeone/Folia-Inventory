import { Sprout, Flower2 } from 'lucide-react';

// Small inline chips marking the contents of a box. Used in the
// Shipping tab (admin Ready/Shipped cards) and on the packer's mobile
// box header. `size` controls glanceability:
//   'sm' (default) — sits next to the carrier badge in the admin cards
//   'lg'           — big chip for the packer's worktable view
//
// Detection is intentionally local — both files that render this widget
// pass the whole box, and we derive flags from its items here.
export function BoxContentBadges({ box, size = 'sm' }) {
  let hasTc = false;
  let hasAnthurium = false;
  for (const it of (box?.items || [])) {
    if (it.type === 'tc') hasTc = true;
    if ((it.variety || '').toLowerCase() === 'anthurium') hasAnthurium = true;
    if (hasTc && hasAnthurium) break;
  }
  if (!hasTc && !hasAnthurium) return null;
  return (
    <>
      {hasTc && <ContentChip kind="tc" size={size} />}
      {hasAnthurium && <ContentChip kind="anthurium" size={size} />}
    </>
  );
}

function ContentChip({ kind, size }) {
  const palette = kind === 'tc'
    ? { bg: 'bg-violet-100', text: 'text-violet-800', ring: 'ring-violet-300', Icon: Sprout, label: 'TC' }
    : { bg: 'bg-pink-100',   text: 'text-pink-800',   ring: 'ring-pink-300',   Icon: Flower2, label: 'Anthurium' };
  const cls = size === 'lg'
    ? `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-base font-bold tracking-wider ring-1 ${palette.bg} ${palette.text} ${palette.ring}`
    : `inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border ${palette.bg} ${palette.text} ${palette.ring} border-transparent`;
  const iconSize = size === 'lg' ? 'w-5 h-5' : 'w-3 h-3';
  return (
    <span className={cls}>
      <palette.Icon className={iconSize} /> {palette.label}
    </span>
  );
}
