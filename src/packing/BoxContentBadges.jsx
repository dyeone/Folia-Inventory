import { Sprout, Flower2, Music2, Palmtree, Store } from 'lucide-react';
import { boxPlatform } from './platform.js';

// Small inline chips marking the contents of a box. Used in the
// Shipping tab (admin Ready/Shipped cards) and on the packer's mobile
// box header. `size` controls glanceability:
//   'sm' (default) — sits next to the carrier badge in the admin cards
//   'lg'           — big chip for the packer's worktable view
//
// Detection is intentionally local — both files that render this widget
// pass the whole box, and we derive flags from its items here.
//
// The platform chip renders FIRST: TikTok boxes (tt… box ids, see
// platform.js) get the black TikTok mark, Nigel's BoyGardening boxes
// (ng…) the hot-pink store mark, everything else the green Palmstreet
// palm — the operator's rule is that platforms never share a box, so the
// chip is the box's identity at a glance. Fixed palettes on purpose:
// emerald-* re-themes per brand, and this mark must look the same under
// every brand. Hot pink is a literal (#ff69b4) rather than pink-*: the
// Anthurium chip already owns the light pink-100 palette and the packer
// must never confuse the two.
export function BoxContentBadges({ box, size = 'sm' }) {
  let hasTc = false;
  let hasAnthurium = false;
  for (const it of (box?.items || [])) {
    if (it.type === 'tc') hasTc = true;
    if ((it.variety || '').toLowerCase() === 'anthurium') hasAnthurium = true;
    if (hasTc && hasAnthurium) break;
  }
  return (
    <>
      <ContentChip kind={boxPlatform(box?.id)} size={size} />
      {hasTc && <ContentChip kind="tc" size={size} />}
      {hasAnthurium && <ContentChip kind="anthurium" size={size} />}
    </>
  );
}

const CHIP_PALETTES = {
  tc:         { bg: 'bg-violet-100', text: 'text-violet-800', ring: 'ring-violet-300', Icon: Sprout,   label: 'TC' },
  anthurium:  { bg: 'bg-pink-100',   text: 'text-pink-800',   ring: 'ring-pink-300',   Icon: Flower2,  label: 'Anthurium' },
  tiktok:     { bg: 'bg-black',      text: 'text-white',      ring: 'ring-gray-700',   Icon: Music2,   label: 'TikTok', iconClass: 'text-cyan-300' },
  nigel:      { bg: 'bg-[#ff69b4]',  text: 'text-white',      ring: 'ring-[#ff1493]',  Icon: Store,    label: 'Nigel', title: "Nigel's order (BoyGardening) — never combined with other boxes" },
  palmstreet: { bg: 'bg-green-100',  text: 'text-green-800',  ring: 'ring-green-300',  Icon: Palmtree, label: 'PS', title: 'Palmstreet order' },
};

function ContentChip({ kind, size }) {
  const palette = CHIP_PALETTES[kind] || CHIP_PALETTES.palmstreet;
  const cls = size === 'lg'
    ? `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-base font-bold tracking-wider ring-1 ${palette.bg} ${palette.text} ${palette.ring}`
    : `inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border ${palette.bg} ${palette.text} ${palette.ring} border-transparent`;
  const iconSize = size === 'lg' ? 'w-5 h-5' : 'w-3 h-3';
  return (
    <span className={cls} title={palette.title || (kind === 'tiktok' ? 'TikTok order — never combined with Palmstreet boxes' : undefined)}>
      <palette.Icon className={`${iconSize} ${palette.iconClass || ''}`} /> {palette.label}
    </span>
  );
}
