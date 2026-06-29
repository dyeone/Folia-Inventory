import { useState, useEffect } from 'react';
import { MarqueeStudio } from './MarqueeStudio.jsx';

// BAE Video tab — a hub for live-sales video tools. Tools live in the TOOLS
// list; add an entry to surface a new one in the selector. First tool is the
// Marquee Studio (looping ticker exporter). Styled to match the BAE studio
// aesthetic (dark, Anton / Space Mono, red accents).

const RED = '#F0382E';
const INK = '#0B0B0B';
const MUTE = '#9B9488';
const C7 = '#C7C0B4';
const MONO = "'Space Mono', monospace";
const DISPLAY = "'Anton', sans-serif";

const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;600;700;800&family=Space+Mono:wght@400;700&display=swap';

const TOOLS = [
  { id: 'marquee', name: 'Marquee Studio', tag: 'Looping ticker exporter', Component: MarqueeStudio },
];

export function BaeVideoStudio() {
  const [active, setActive] = useState(TOOLS[0].id);

  // Load the studio fonts once (Anton / Archivo / Space Mono) for the canvas
  // and labels; the inventory app itself doesn't ship them.
  useEffect(() => {
    const id = 'bae-video-fonts';
    if (!document.getElementById(id)) {
      const pre1 = document.createElement('link');
      pre1.rel = 'preconnect'; pre1.href = 'https://fonts.googleapis.com';
      const pre2 = document.createElement('link');
      pre2.rel = 'preconnect'; pre2.href = 'https://fonts.gstatic.com'; pre2.crossOrigin = 'anonymous';
      const link = document.createElement('link');
      link.id = id; link.rel = 'stylesheet'; link.href = FONTS_HREF;
      document.head.appendChild(pre1); document.head.appendChild(pre2); document.head.appendChild(link);
    }
  }, []);

  const Tool = (TOOLS.find((t) => t.id === active) || TOOLS[0]).Component;

  return (
    <div
      className="bae-mq"
      style={{
        background: '#0B0B0B',
        backgroundImage: 'repeating-linear-gradient(117deg, rgba(150,52,42,0.05) 0 1px, transparent 1px 130px)',
        borderRadius: 16,
        padding: '24px 28px 48px',
        minHeight: 'calc(100vh - 180px)',
        fontFamily: "'Archivo', sans-serif",
      }}
    >
      <style>{`
        @media (max-width: 860px){ .bae-mq-cols{ grid-template-columns:1fr !important; } }
        .bae-mq input[type=range]{ accent-color:${RED}; height:4px; }
        .bae-mq input[type=text]::selection{ background:${RED}; color:${INK}; }
      `}</style>

      {/* TOOL SELECTOR */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 22 }}>
        <span style={{ fontFamily: DISPLAY, fontSize: 18, color: RED, letterSpacing: '0.04em' }}>BAE VIDEO</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {TOOLS.map((t) => {
            const on = t.id === active;
            return (
              <button
                key={t.id}
                onClick={() => setActive(t.id)}
                title={t.tag}
                style={{
                  cursor: 'pointer', fontFamily: MONO, fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.08em', padding: '8px 13px',
                  border: '1px solid ' + (on ? RED : 'rgba(244,240,230,0.22)'),
                  background: on ? RED : 'transparent',
                  color: on ? INK : C7, textTransform: 'uppercase', transition: 'all .12s ease',
                }}
              >{t.name}</button>
            );
          })}
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: MUTE, alignSelf: 'center' }}>MORE TOOLS COMING</span>
        </div>
      </div>

      <Tool />
    </div>
  );
}
