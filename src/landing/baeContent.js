// ░░ BAE landing-page content model ░░
//
// Mirror of the schema in the bae-landing project (app/lib/content.ts +
// app/lib/bae.ts). This is the editable content for the public BAE landing
// page. The in-app editor (BaeLandingEditor) loads the published blob from the
// API, falling back to `defaultContent` when nothing is published yet, and
// saves edits back through /api/settings (action=landing-save). The landing
// site reads the published blob via action=landing-public.
//
// Keep this in sync with the bae-landing repo's content.ts when the schema
// changes. After the first publish, the API blob is the source of truth, so
// these defaults only seed an unpublished brand.
//
// Text-field conventions (rendered by the landing's <Rich> component):
//   *like this*  → highlighted in brand red
//   a newline    → a line break

export const RED = '#F0392E';
export const INK = '#0B0B0B';

// The landing site loads brand fonts via next/font; in this admin editor those
// CSS vars don't exist, so each falls back to the quoted family or a generic.
export const F = {
  anton: 'var(--font-anton), "Anton", sans-serif',
  archivo: 'var(--font-archivo), "Archivo", system-ui, sans-serif',
  script: 'var(--font-yellowtail), "Yellowtail", cursive',
  mono: 'var(--font-mono), "Space Mono", ui-monospace, monospace',
};

// Filter rail on the shop grid. `key` must match a specimen's `brandKey`
// (except ALL). The editor's specimen brand dropdown picks from these.
export const FILTERS = [
  { key: 'ALL', label: 'ALL HOUSE' },
  { key: 'BAE', label: 'BAE LABEL' },
  { key: 'ANDEAN', label: 'ANDEAN GROWERS' },
  { key: 'SEA', label: 'SE ASIA STUDIO' },
  { key: 'INDIE', label: 'INDIE HYBRIDIZERS' },
];

export const defaultContent = {
  hero: {
    eyebrow: 'A HOUSE OF ANTHURIUM BRANDS',
    titleLine1: 'BEST',
    titleLine2: 'EVER',
    script: 'Anthuriums',
    copy1:
      "One house. *Every great anthurium on earth* — our own label and the world's best growers, under one roof.",
    copy2:
      "Think Sephora, for collectors. We don't compete with the growers we love. We carry them.",
    ctaPrimary: 'ENTER THE HOUSE',
  },
  model: {
    label: '01 — THE MODEL',
    heading: 'Sephora,\nfor *anthuriums.*',
    body: 'We carry our own label and the best growers and independent brands we can find anywhere on earth — under one standard, one checkout, one guarantee.',
    houseTitle: 'BAE Own Label',
    houseRows: [
      { name: 'Andean Growers', region: 'SOUTH AMERICA' },
      { name: 'SE Asia Studios', region: 'INDONESIA · TH' },
      { name: 'Indie Hybridizers', region: 'WORLDWIDE' },
    ],
  },
  drops: {
    tagline: '#THEBAESHOW · PALMSTREET LIVE',
    target: '2026-07-03T15:00',
    items: [
      { title: 'Friday Rare Drop', sub: '12 SPECIMENS · ONE EACH', time: 'FRI 3PM PST' },
      { title: 'Guest Grower Spotlight', sub: 'ANDEAN GROWERS, LIVE', time: 'SUN 5PM PST' },
    ],
  },
  specimens: [
    { slug: 'forgetii', name: 'Anthurium forgetii', brandKey: 'BAE', brand: 'BAE LABEL', origin: 'ECUADOR', code: 'BAE-0042', tag: 'SEED-GROWN' },
    { slug: 'clarinervium', name: 'Anthurium clarinervium', brandKey: 'BAE', brand: 'BAE LABEL', origin: 'MEXICO', code: 'BAE-0067', tag: 'VELVET' },
    { slug: 'luxurians', name: 'Anthurium luxurians', brandKey: 'ANDEAN', brand: 'ANDEAN', origin: 'COLOMBIA', code: 'AND-018', tag: 'BULLATE' },
    { slug: 'warocqueanum', name: 'Anthurium warocqueanum', brandKey: 'ANDEAN', brand: 'ANDEAN', origin: 'COLOMBIA', code: 'AND-006', tag: 'QUEEN' },
    { slug: 'regale', name: 'Anthurium regale', brandKey: 'ANDEAN', brand: 'ANDEAN', origin: 'PERU', code: 'AND-011', tag: 'VELVET' },
    { slug: 'veitchii', name: 'Anthurium veitchii', brandKey: 'SEA', brand: 'SE ASIA', origin: 'CULTIVATED', code: 'SEA-031', tag: 'KING' },
    { slug: 'crystallinum', name: 'Anthurium crystallinum', brandKey: 'SEA', brand: 'SE ASIA', origin: 'CULTIVATED', code: 'SEA-024', tag: 'SILVER' },
    { slug: 'redcrystal', name: "Anthurium 'Red Crystal'", brandKey: 'INDIE', brand: 'INDIE', origin: 'HYBRID', code: 'IND-002', tag: '1 OF 1' },
  ],
  brands: [
    'BAE LABEL',
    'ANDEAN GROWERS',
    'SE ASIA STUDIOS',
    'INDIE HYBRIDIZERS',
    'CLOUD FOREST CO.',
    'ROOTED MEDELLÍN',
  ],
  newsletter: {
    heading: 'Never miss\na drop.',
    body: 'First access to every release, guest spotlight and one-of-one specimen. No spam — just the rare stuff.',
  },
  footer: {
    connect: ['@bestanthuriumsever', '#TheBAEShow', 'PalmStreet Live', 'hello@bae.com'],
  },
};

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge an override onto a base. Plain objects merge key-by-key; arrays and
// primitives are replaced wholesale. Iterating base keys means a published blob
// that predates a schema change still picks up new default fields.
export function mergeContent(base, override) {
  if (!isObj(base) || !isObj(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (k in override) out[k] = mergeContent(base[k], override[k]);
  }
  return out;
}
