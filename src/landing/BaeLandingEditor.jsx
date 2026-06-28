import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { F, FILTERS, INK, RED, defaultContent, mergeContent } from './baeContent.js';

// ░░ BAE landing-page content editor (in-app tab) ░░
//
// Loads the published landing blob from the API (falling back to built-in
// defaults), edits a working draft, then publishes it back through
// /api/settings (action=landing-save). The public BAE landing site reads the
// same blob (action=landing-public) and renders it for every visitor — so
// Publish here goes live for everyone, not just this browser.
//
// Ported from the bae-landing repo's app/edit/page.tsx; keep the field set in
// sync with src/landing/baeContent.js when the schema changes.

const SITE_URL = 'https://bae-landing-sand.vercel.app';

const CREAM = '#F4F0E6';
const MUTE = '#9B9488';
const FAINT = '#6B6459';
const LINE = 'rgba(244,240,230,0.16)';
const PANEL = '#0F0C0B';

const labelStyle = {
  display: 'block',
  fontFamily: F.mono,
  fontSize: 10,
  letterSpacing: '0.14em',
  color: MUTE,
  marginBottom: 6,
  textTransform: 'uppercase',
};

const inputBase = {
  width: '100%',
  background: '#070504',
  color: CREAM,
  border: `1px solid ${LINE}`,
  fontSize: 14,
  padding: '10px 12px',
  outline: 'none',
};

// Human-readable description of the exact countdown target.
function fmtTarget(target) {
  const d = new Date(target);
  if (Number.isNaN(d.getTime())) return 'Pick a valid date and time.';
  return `Counts down to ${d.toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })} (your local time).`;
}

function Field({ label, value, onChange, mono, placeholder }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <span style={labelStyle}>{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputBase, fontFamily: mono ? F.mono : F.archivo }}
      />
    </label>
  );
}

function Area({ label, value, onChange, hint, rows = 3 }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <span style={labelStyle}>{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputBase, fontFamily: F.archivo, lineHeight: 1.5, resize: 'vertical' }}
      />
      {hint && (
        <span
          style={{
            display: 'block',
            fontFamily: F.mono,
            fontSize: 10,
            color: FAINT,
            marginTop: 6,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

function Section({ n, title, children }) {
  return (
    <section style={{ border: `1px solid ${LINE}`, background: PANEL, padding: '20px 18px', marginBottom: 16 }}>
      <div style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: '0.2em', color: RED, marginBottom: 16 }}>
        {n} — {title}
      </div>
      {children}
    </section>
  );
}

function SmallBtn({ label, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 'none',
        background: 'transparent',
        color: danger ? RED : MUTE,
        border: `1px solid ${danger ? RED : LINE}`,
        fontFamily: F.mono,
        fontSize: 10,
        letterSpacing: '0.1em',
        padding: '8px 12px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function StringList({ items, onChange, placeholder, addLabel }) {
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            value={it}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, idx) => (idx === i ? e.target.value : x)))}
            style={{ ...inputBase, fontFamily: F.mono }}
          />
          <SmallBtn label="✕" danger onClick={() => onChange(items.filter((_, idx) => idx !== i))} />
        </div>
      ))}
      <SmallBtn label={`+ ${addLabel}`} onClick={() => onChange([...items, ''])} />
    </div>
  );
}

export function BaeLandingEditor({ showToast }) {
  const [draft, setDraft] = useState(defaultContent);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef(null);

  // Load the published content (brand-scoped to BAE server-side), falling back
  // to built-in defaults when nothing is published yet.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const published = await api.getLanding();
        if (alive) setDraft(published ? mergeContent(defaultContent, published) : defaultContent);
      } catch (e) {
        if (alive) { setLoadError(e.message || 'Failed to load'); setDraft(defaultContent); }
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  function mutate(fn) {
    setDraft((d) => fn(d));
    setDirty(true);
    setSaved(false);
  }
  function patch(key, p) {
    mutate((d) => ({ ...d, [key]: { ...d[key], ...p } }));
  }

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await api.saveLanding(draft);
      setDirty(false);
      setSaved(true);
      showToast?.('Landing page published — live for visitors');
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2400);
    } catch (e) {
      showToast?.(e.message || 'Publish failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!window.confirm('Reset all fields to the original defaults? You still need to Publish to make it live.')) return;
    setDraft(defaultContent);
    setDirty(true);
    setSaved(false);
  }

  const updateSpecimen = (i, p) =>
    mutate((d) => ({ ...d, specimens: d.specimens.map((s, idx) => (idx === i ? { ...s, ...p } : s)) }));
  const addSpecimen = () =>
    mutate((d) => ({
      ...d,
      specimens: [
        ...d.specimens,
        {
          slug: 'new-' + (d.specimens.length + 1) + '-' + Date.now().toString(36),
          name: 'Anthurium sp.',
          brandKey: 'BAE',
          brand: 'BAE LABEL',
          origin: 'ORIGIN',
          code: 'BAE-000',
          tag: 'NEW',
        },
      ],
    }));
  const removeSpecimen = (i) => mutate((d) => ({ ...d, specimens: d.specimens.filter((_, idx) => idx !== i) }));

  const brandKeys = FILTERS.filter((f) => f.key !== 'ALL');

  if (!ready) {
    return (
      <div
        style={{
          minHeight: 240,
          background: '#070504',
          color: MUTE,
          fontFamily: F.mono,
          fontSize: 12,
          letterSpacing: '0.18em',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 12,
        }}
      >
        LOADING EDITOR…
      </div>
    );
  }

  const publishBtn = (big) => (
    <button
      type="button"
      onClick={save}
      disabled={!dirty || saving}
      style={{
        fontFamily: F.mono,
        fontWeight: 700,
        fontSize: big ? 12 : 11,
        letterSpacing: '0.1em',
        color: INK,
        background: dirty && !saving ? RED : '#3a302e',
        border: 'none',
        padding: big ? '12px 22px' : '10px 16px',
        cursor: dirty && !saving ? 'pointer' : 'default',
      }}
    >
      {saving ? 'PUBLISHING…' : big ? 'PUBLISH CHANGES' : 'PUBLISH'}
    </button>
  );

  return (
    <div style={{ background: '#070504', color: CREAM, fontFamily: F.archivo, borderRadius: 12, overflow: 'hidden' }}>
      {/* ░░ Action bar ░░ */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '14px 18px',
          background: 'rgba(9,7,6,0.9)',
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: F.anton, fontSize: 24, color: RED, lineHeight: 1 }}>BAE</span>
          <span
            style={{
              fontFamily: F.mono,
              fontSize: 9,
              letterSpacing: '0.16em',
              color: MUTE,
              borderLeft: `1px solid ${LINE}`,
              paddingLeft: 10,
            }}
          >
            LANDING
            <br />
            EDITOR
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {saved && (
            <span style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: '0.1em', color: '#7BB661' }}>
              PUBLISHED ✓
            </span>
          )}
          {dirty && !saved && (
            <span style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: '0.1em', color: FAINT }}>UNSAVED</span>
          )}
          <a
            href={SITE_URL}
            target="_blank"
            rel="noreferrer"
            style={{
              fontFamily: F.mono,
              fontSize: 10,
              letterSpacing: '0.1em',
              color: CREAM,
              textDecoration: 'none',
              border: `1px solid ${LINE}`,
              padding: '9px 12px',
            }}
          >
            VIEW SITE ↗
          </a>
          {publishBtn(false)}
        </div>
      </header>

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 18px 40px' }}>
        <p style={{ fontFamily: F.mono, fontSize: 11, lineHeight: 1.6, color: FAINT, margin: '0 0 14px' }}>
          Publishing saves to the BAE landing site for <span style={{ color: CREAM }}>every visitor</span> and
          syncs across devices. Use <span style={{ color: CREAM }}>*asterisks*</span> to highlight words in brand
          red; press Enter for a line break in headlines.
        </p>
        {loadError && (
          <p style={{ fontFamily: F.mono, fontSize: 11, color: RED, margin: '0 0 18px' }}>
            Couldn’t load the published copy ({loadError}). Showing defaults — publishing will overwrite.
          </p>
        )}

        {/* ░░ HERO ░░ */}
        <Section n="01" title="HERO">
          <Field label="Eyebrow" mono value={draft.hero.eyebrow} onChange={(v) => patch('hero', { eyebrow: v })} />
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Field label="Headline line 1" value={draft.hero.titleLine1} onChange={(v) => patch('hero', { titleLine1: v })} />
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Headline line 2" value={draft.hero.titleLine2} onChange={(v) => patch('hero', { titleLine2: v })} />
            </div>
          </div>
          <Field label="Script word" value={draft.hero.script} onChange={(v) => patch('hero', { script: v })} />
          <Area
            label="Intro paragraph"
            value={draft.hero.copy1}
            onChange={(v) => patch('hero', { copy1: v })}
            hint="Tip: *wrap* the phrase you want in red."
          />
          <Area label="Sub paragraph" value={draft.hero.copy2} onChange={(v) => patch('hero', { copy2: v })} />
          <Field label="Primary button" mono value={draft.hero.ctaPrimary} onChange={(v) => patch('hero', { ctaPrimary: v })} />
        </Section>

        {/* ░░ DROPS & COUNTDOWN ░░ */}
        <Section n="02" title="DROPS & COUNTDOWN">
          <Field label="Tagline" mono value={draft.drops.tagline} onChange={(v) => patch('drops', { tagline: v })} />
          <label style={{ display: 'block', marginBottom: 6 }}>
            <span style={labelStyle}>Countdown date &amp; time</span>
            <input
              type="datetime-local"
              value={draft.drops.target}
              onChange={(e) => patch('drops', { target: e.target.value })}
              style={{ ...inputBase, fontFamily: F.mono }}
            />
          </label>
          <p style={{ fontFamily: F.mono, fontSize: 10, color: FAINT, margin: '0 0 18px' }}>{fmtTarget(draft.drops.target)}</p>

          <span style={labelStyle}>Drop schedule rows</span>
          {draft.drops.items.map((d, i) => (
            <div key={i} style={{ border: `1px solid ${LINE}`, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <SmallBtn
                  label="Remove"
                  danger
                  onClick={() => patch('drops', { items: draft.drops.items.filter((_, idx) => idx !== i) })}
                />
              </div>
              <Field
                label="Title"
                value={d.title}
                onChange={(v) => patch('drops', { items: draft.drops.items.map((x, idx) => (idx === i ? { ...x, title: v } : x)) })}
              />
              <Field
                label="Subtitle"
                mono
                value={d.sub}
                onChange={(v) => patch('drops', { items: draft.drops.items.map((x, idx) => (idx === i ? { ...x, sub: v } : x)) })}
              />
              <Field
                label="Time label"
                mono
                value={d.time}
                onChange={(v) => patch('drops', { items: draft.drops.items.map((x, idx) => (idx === i ? { ...x, time: v } : x)) })}
              />
            </div>
          ))}
          <SmallBtn
            label="+ Add drop row"
            onClick={() =>
              patch('drops', { items: [...draft.drops.items, { title: 'New Drop', sub: 'DETAILS', time: 'DAY 0PM PST' }] })
            }
          />
        </Section>

        {/* ░░ THE COLLECTION ░░ */}
        <Section n="03" title="THE COLLECTION">
          {draft.specimens.map((s, i) => (
            <div key={s.slug} style={{ border: `1px solid ${LINE}`, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: '0.1em', color: FAINT }}>#{i + 1}</span>
                <SmallBtn label="Remove" danger onClick={() => removeSpecimen(i)} />
              </div>
              <Field label="Name" value={s.name} onChange={(v) => updateSpecimen(i, { name: v })} />
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ flex: 1, display: 'block', marginBottom: 14 }}>
                  <span style={labelStyle}>Brand (filter)</span>
                  <select
                    value={s.brandKey}
                    onChange={(e) => updateSpecimen(i, { brandKey: e.target.value })}
                    style={{ ...inputBase, fontFamily: F.mono }}
                  >
                    {brandKeys.map((b) => (
                      <option key={b.key} value={b.key}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div style={{ flex: 1 }}>
                  <Field label="Brand badge" mono value={s.brand} onChange={(v) => updateSpecimen(i, { brand: v })} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <Field label="Origin" mono value={s.origin} onChange={(v) => updateSpecimen(i, { origin: v })} />
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Code" mono value={s.code} onChange={(v) => updateSpecimen(i, { code: v })} />
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Tag" mono value={s.tag} onChange={(v) => updateSpecimen(i, { tag: v })} />
                </div>
              </div>
            </div>
          ))}
          <SmallBtn label="+ Add specimen" onClick={addSpecimen} />
        </Section>

        {/* ░░ BRAND & CONTACT ░░ */}
        <Section n="04" title="BRAND & CONTACT">
          <Field label="Model section label" mono value={draft.model.label} onChange={(v) => patch('model', { label: v })} />
          <Area
            label="Model heading"
            rows={2}
            value={draft.model.heading}
            onChange={(v) => patch('model', { heading: v })}
            hint="*red* + Enter for line breaks."
          />
          <Area label="Model body" value={draft.model.body} onChange={(v) => patch('model', { body: v })} />
          <Field label="Own-label name" value={draft.model.houseTitle} onChange={(v) => patch('model', { houseTitle: v })} />

          <span style={labelStyle}>Guest brand rows (the house)</span>
          {draft.model.houseRows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                value={r.name}
                placeholder="Name"
                onChange={(e) =>
                  patch('model', { houseRows: draft.model.houseRows.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)) })
                }
                style={{ ...inputBase, flex: 2 }}
              />
              <input
                value={r.region}
                placeholder="Region"
                onChange={(e) =>
                  patch('model', { houseRows: draft.model.houseRows.map((x, idx) => (idx === i ? { ...x, region: e.target.value } : x)) })
                }
                style={{ ...inputBase, flex: 1, fontFamily: F.mono }}
              />
              <SmallBtn
                label="✕"
                danger
                onClick={() => patch('model', { houseRows: draft.model.houseRows.filter((_, idx) => idx !== i) })}
              />
            </div>
          ))}
          <div style={{ marginBottom: 18 }}>
            <SmallBtn
              label="+ Add brand row"
              onClick={() => patch('model', { houseRows: [...draft.model.houseRows, { name: 'New Brand', region: 'REGION' }] })}
            />
          </div>

          <span style={labelStyle}>Brands marquee</span>
          <div style={{ marginBottom: 18 }}>
            <StringList
              items={draft.brands}
              addLabel="Add brand"
              placeholder="BRAND NAME"
              onChange={(b) => mutate((d) => ({ ...d, brands: b }))}
            />
          </div>

          <Area
            label="Newsletter heading"
            rows={2}
            value={draft.newsletter.heading}
            onChange={(v) => patch('newsletter', { heading: v })}
            hint="Enter for a line break."
          />
          <Area label="Newsletter body" value={draft.newsletter.body} onChange={(v) => patch('newsletter', { body: v })} />

          <span style={labelStyle}>Footer contact lines</span>
          <StringList
            items={draft.footer.connect}
            addLabel="Add line"
            placeholder="@handle or email"
            onChange={(c) => mutate((d) => ({ ...d, footer: { ...d.footer, connect: c } }))}
          />
        </Section>

        {/* ░░ Footer actions ░░ */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <SmallBtn label="Reset to defaults" danger onClick={reset} />
          {publishBtn(true)}
        </div>
      </div>
    </div>
  );
}
