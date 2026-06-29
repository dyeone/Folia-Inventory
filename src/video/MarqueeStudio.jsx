import { useState, useRef, useEffect, useMemo, useCallback } from 'react';

// BAE Marquee Studio — a looping ticker exporter for live sales (#THEBAESHOW).
// Draws a scrolling marquee on a canvas and records it to a looping WebM that
// plays as an OBS / Streamlabs media source. Ported from the Claude Design
// "BAE Marquee Studio.dc.html" canvas component to a plain React component.

const RED = '#F0382E';
const INK = '#0B0B0B';
const ECRU = '#ECE6D8';
const MUTE = '#9B9488';
const FAINT = '#6B6459';
const C7 = '#C7C0B4';
const MONO = "'Space Mono', monospace";
const DISPLAY = "'Anton', sans-serif";

const PAL = [
  { name: 'INK', bg: '#0B0B0B', fg: '#ECE6D8', sep: '#F0382E' },
  { name: 'SIGNAL', bg: '#F0382E', fg: '#0B0B0B', sep: '#0B0B0B' },
  { name: 'ALARM', bg: '#0B0B0B', fg: '#F0382E', sep: '#ECE6D8' },
  { name: 'BONE', bg: '#ECE6D8', fg: '#0B0B0B', sep: '#F0382E' },
];

const SEPS = [
  { type: 'star4', glyph: '✦' },
  { type: 'diamond', glyph: '◆' },
  { type: 'dot', glyph: '●' },
  { type: 'cross', glyph: '✚' },
  { type: 'slash', glyph: '/' },
];

function buildParams(st) {
  let items = (st.text || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (st.upper) items = items.map((s) => s.toUpperCase());
  if (!items.length) items = ['BEST ANTHURIUMS EVER'];
  const pal = PAL[st.paletteIndex];
  return {
    W: st.width, H: st.height, fontSize: st.fontSize, speed: st.speed,
    tracking: st.tracking, dir: st.dir, items,
    bg: pal.bg, fg: pal.fg, sep: pal.sep, transparent: st.transparent,
    sepType: st.sep, sepSize: st.fontSize * 0.5, cy: st.height / 2,
  };
}

function layout(ctx, p) {
  const gap = p.fontSize * 0.5;
  const sepW = p.sepSize * 1.5;
  let x = 0;
  const segs = [];
  for (const it of p.items) {
    const w = ctx.measureText(it).width;
    segs.push({ kind: 'text', text: it, x, w }); x += w + gap;
    segs.push({ kind: 'sep', x, w: sepW }); x += sepW + gap;
  }
  return { unitWidth: x || 1, segs };
}

function drawSep(ctx, type, cx, cy, s, color) {
  ctx.fillStyle = color;
  if (type === 'dot') {
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.42, 0, 7); ctx.fill();
  } else if (type === 'diamond') {
    const R = s * 0.6;
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx + R, cy); ctx.lineTo(cx, cy + R); ctx.lineTo(cx - R, cy); ctx.closePath(); ctx.fill();
  } else if (type === 'cross') {
    const a = s * 0.62, t = s * 0.2;
    ctx.fillRect(cx - t, cy - a, 2 * t, 2 * a);
    ctx.fillRect(cx - a, cy - t, 2 * a, 2 * t);
  } else if (type === 'slash') {
    ctx.save(); ctx.font = (s * 1.7) + 'px "Anton", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('/', cx, cy); ctx.restore();
  } else { // star4 sparkle
    const R = s * 0.92, r = R * 0.3;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = -Math.PI / 2 + i * Math.PI / 4;
      const rad = (i % 2 === 0) ? R : r;
      const px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
}

function drawUnit(ctx, p, L, originX) {
  for (const seg of L.segs) {
    if (seg.kind === 'text') {
      ctx.fillStyle = p.fg;
      ctx.fillText(seg.text, originX + seg.x, p.cy);
    } else {
      drawSep(ctx, p.sepType, originX + seg.x + seg.w / 2, p.cy, p.sepSize, p.sep);
    }
  }
}

const labelStyle = { fontFamily: MONO, fontSize: 11, letterSpacing: '0.2em', color: MUTE };

function tBtn(active) {
  return {
    cursor: 'pointer', fontFamily: MONO, fontSize: 11, fontWeight: 700,
    letterSpacing: '0.08em', padding: '9px 12px',
    border: '1px solid ' + (active ? RED : 'rgba(244,240,230,0.22)'),
    background: active ? RED : 'transparent',
    color: active ? INK : C7, transition: 'all .12s ease',
  };
}

function SliderField({ label, value, unit, min, max, step, onChange }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 11, letterSpacing: '0.14em', color: C7, marginBottom: 7 }}>
        <span>{label}</span><span style={{ color: MUTE }}>{value} {unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={onChange} style={{ width: '100%' }} />
    </div>
  );
}

export function MarqueeStudio() {
  const [st, setSt] = useState({
    text: 'ANDEAN GROWERS, SE ASIA STUDIOS, INDIE HYBRIDIZERS, BAE LABEL, CLOUD FOREST CO.',
    upper: true, speed: 140, fontSize: 104, height: 200, tracking: 2,
    dir: 'left', paletteIndex: 0, sep: 'star4', transparent: false,
    width: 1920, fps: 30, loops: 1,
  });
  const patch = useCallback((p) => setSt((s) => ({ ...s, ...p })), []);

  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [msg, setMsg] = useState('');

  const canvasRef = useRef(null);
  const stateRef = useRef(st);
  const rafRef = useRef(0);
  const recRef = useRef(null);
  const recordingRef = useRef(false);
  const recStartRef = useRef(0);
  const recTotalRef = useRef(0);
  const progressRef = useRef(0);

  // Mirror the latest config into a ref so the animation loop reads current
  // values without restarting. Synced in an effect (never written in render).
  useEffect(() => { stateRef.current = st; }, [st]);

  const exportLoop = useCallback(() => {
    if (recordingRef.current) return;
    const cv = canvasRef.current;
    if (!cv || !window.MediaRecorder) { setMsg('Recording not supported in this browser.'); return; }
    const ctx = cv.getContext('2d');
    const p = buildParams(stateRef.current);
    ctx.font = p.fontSize + 'px "Anton", sans-serif';
    try { ctx.letterSpacing = p.tracking + 'px'; } catch { /* not supported */ }
    const L = layout(ctx, p);
    const T = L.unitWidth / p.speed;
    const total = T * stateRef.current.loops;
    const cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = cands.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) { setMsg('WebM recording not supported here.'); return; }
    const stream = cv.captureStream(stateRef.current.fps);
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 }); }
    catch (e) { setMsg('Recorder error: ' + e.message); return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const slug = (stateRef.current.text || 'marquee').split(',')[0].trim().replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 24) || 'marquee';
      a.href = url; a.download = 'BAE-marquee-' + slug + '.webm';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      recordingRef.current = false;
      progressRef.current = 1;
      setRecording(false); setProgress(1);
      setMsg('Saved · ' + (blob.size / 1048576).toFixed(1) + ' MB · ' + total.toFixed(1) + 's loop');
    };
    recRef.current = rec;
    recordingRef.current = true;
    recStartRef.current = performance.now();
    recTotalRef.current = total * 1000;
    setRecording(true); progressRef.current = 0; setProgress(0);
    setMsg('Recording ' + stateRef.current.loops + ' loop(s) — ' + total.toFixed(1) + 's…');
    rec.start();
  }, []);

  useEffect(() => {
    if (document.fonts && document.fonts.load) {
      document.fonts.load('104px "Anton"').catch(() => {});
    }
    // Defined here (not a useCallback) so the recursive requestAnimationFrame
    // self-reference is a hoisted declaration, and ref reads happen outside render.
    function draw(ts) {
      const cv = canvasRef.current;
      if (cv) {
        const ctx = cv.getContext('2d');
        const p = buildParams(stateRef.current);
        if (cv.width !== p.W) cv.width = p.W;
        if (cv.height !== p.H) cv.height = p.H;
        ctx.clearRect(0, 0, p.W, p.H);
        if (!p.transparent) { ctx.fillStyle = p.bg; ctx.fillRect(0, 0, p.W, p.H); }
        ctx.font = p.fontSize + 'px "Anton", system-ui, sans-serif';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        try { ctx.letterSpacing = p.tracking + 'px'; } catch { /* not supported */ }
        const L = layout(ctx, p);
        const phase = (ts / 1000) * p.speed;
        const base = p.dir === 'left' ? -(phase % L.unitWidth) : (phase % L.unitWidth) - L.unitWidth;
        for (let x = base - L.unitWidth; x < p.W + L.unitWidth; x += L.unitWidth) {
          drawUnit(ctx, p, L, x);
        }
        if (recordingRef.current) {
          const el = performance.now() - recStartRef.current;
          if (el >= recTotalRef.current) {
            if (recRef.current && recRef.current.state === 'recording') recRef.current.stop();
          } else {
            const pr = el / recTotalRef.current;
            if (Math.abs(pr - progressRef.current) > 0.02) { progressRef.current = pr; setProgress(pr); }
          }
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    }
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (recRef.current && recRef.current.state === 'recording') recRef.current.stop();
    };
  }, []);

  const durationText = useMemo(() => {
    try {
      const mctx = document.createElement('canvas').getContext('2d');
      mctx.font = st.fontSize + 'px "Anton", sans-serif';
      try { mctx.letterSpacing = st.tracking + 'px'; } catch { /* not supported */ }
      let items = (st.text || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (st.upper) items = items.map((s) => s.toUpperCase());
      if (!items.length) items = ['BEST ANTHURIUMS EVER'];
      const gap = st.fontSize * 0.5, sepW = st.fontSize * 0.5 * 1.5;
      let x = 0; items.forEach((it) => { x += mctx.measureText(it).width + gap + sepW + gap; });
      const T = (x || 1) / st.speed;
      return 'LOOP ' + T.toFixed(1) + 's · FILE ' + (T * st.loops).toFixed(1) + 's @ ' + st.fps + 'FPS';
    } catch { return '—'; }
  }, [st.text, st.fontSize, st.tracking, st.upper, st.speed, st.loops, st.fps]);

  const checker = {
    backgroundColor: '#242424',
    backgroundImage: 'linear-gradient(45deg,#1a1a1a 25%,transparent 25%),linear-gradient(-45deg,#1a1a1a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#1a1a1a 75%),linear-gradient(-45deg,transparent 75%,#1a1a1a 75%)',
    backgroundSize: '26px 26px',
    backgroundPosition: '0 0,0 13px,13px -13px,-13px 0',
  };
  const stageStyle = {
    border: '1px solid rgba(244,240,230,0.16)', overflow: 'hidden',
    ...(st.transparent ? checker : { background: '#161310' }),
  };

  return (
    <div style={{ color: '#F4F0E6', fontFamily: "'Archivo', sans-serif" }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(244,240,230,0.14)', paddingBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span style={{ fontFamily: DISPLAY, fontSize: 34, color: RED, lineHeight: 1 }}>BAE</span>
          <span style={{ fontFamily: DISPLAY, fontSize: 34, textTransform: 'uppercase', lineHeight: 1 }}>Marquee Studio</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.2em', color: MUTE, textAlign: 'right', lineHeight: 1.5 }}>
          LOOPING TICKER EXPORTER<br />FOR LIVE SALES &middot; #THEBAESHOW
        </div>
      </div>

      {/* PREVIEW STAGE */}
      <div style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.2em', color: RED }}>LIVE PREVIEW</div>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.12em', color: MUTE }}>{durationText}</div>
        </div>
        <div style={stageStyle}>
          <canvas ref={canvasRef} width={1920} height={200} style={{ display: 'block', width: '100%', height: 'auto' }} />
        </div>
      </div>

      {/* CONTROLS GRID */}
      <div className="bae-mq-cols" style={{ marginTop: 26, display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 26, alignItems: 'start' }}>

        {/* LEFT: CONTENT + MOTION */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

          <div>
            <div style={{ ...labelStyle, marginBottom: 10 }}>TICKER TEXT</div>
            <input
              type="text"
              value={st.text}
              onChange={(e) => patch({ text: e.target.value })}
              placeholder="ANDEAN GROWERS, SE ASIA STUDIOS, ..."
              style={{ width: '100%', background: '#15110F', color: '#F4F0E6', border: '1px solid rgba(244,240,230,0.2)', fontFamily: MONO, fontSize: 14, padding: '14px 15px', outline: 'none' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 }}>
              <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.1em', color: FAINT }}>SEPARATE ITEMS WITH COMMAS</span>
              <button onClick={() => patch({ upper: !st.upper })} style={tBtn(st.upper)}>UPPERCASE</button>
            </div>
          </div>

          <div>
            <div style={{ ...labelStyle, marginBottom: 12 }}>SEPARATOR</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {SEPS.map((s) => (
                <button
                  key={s.type}
                  onClick={() => patch({ sep: s.type })}
                  style={{ ...tBtn(st.sep === s.type), fontFamily: 'system-ui, sans-serif', fontSize: 16, minWidth: 42, lineHeight: 1 }}
                >{s.glyph}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px 24px' }}>
            <SliderField label="SPEED" value={st.speed} unit="px/s" min={20} max={420} step={5} onChange={(e) => patch({ speed: +e.target.value })} />
            <SliderField label="FONT SIZE" value={st.fontSize} unit="px" min={40} max={170} step={2} onChange={(e) => patch({ fontSize: +e.target.value })} />
            <SliderField label="BAR HEIGHT" value={st.height} unit="px" min={90} max={320} step={2} onChange={(e) => patch({ height: +e.target.value })} />
            <SliderField label="TRACKING" value={st.tracking} unit="px" min={-4} max={16} step={1} onChange={(e) => patch({ tracking: +e.target.value })} />
          </div>

          <div>
            <div style={{ ...labelStyle, marginBottom: 12 }}>DIRECTION</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[{ label: '◀ LEFT', key: 'left' }, { label: 'RIGHT ▶', key: 'right' }].map((d) => (
                <button key={d.key} onClick={() => patch({ dir: d.key })} style={{ ...tBtn(st.dir === d.key), flex: 1 }}>{d.label}</button>
              ))}
            </div>
          </div>

        </div>

        {/* RIGHT: COLOR + EXPORT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

          <div>
            <div style={{ ...labelStyle, marginBottom: 12 }}>COLOR PRESET</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {PAL.map((p, i) => (
                <button
                  key={p.name}
                  onClick={() => patch({ paletteIndex: i })}
                  style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', padding: '12px 13px', border: '2px solid ' + (i === st.paletteIndex ? RED : 'rgba(244,240,230,0.18)'), background: p.bg, color: p.fg }}
                >
                  <span style={{ width: 14, height: 14, flex: 'none', background: p.sep }} />{p.name}
                </button>
              ))}
            </div>
          </div>

          <div style={{ border: '1px solid rgba(244,240,230,0.16)', padding: 20 }}>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.2em', color: RED, marginBottom: 16 }}>EXPORT LOOP</div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.14em', color: MUTE, marginBottom: 8 }}>BACKGROUND</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {[{ label: 'SOLID', val: false }, { label: 'TRANSPARENT', val: true }].map((b) => (
                  <button key={b.label} onClick={() => patch({ transparent: b.val })} style={{ ...tBtn(st.transparent === b.val), flex: 1 }}>{b.label}</button>
                ))}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.14em', color: MUTE, marginBottom: 8 }}>WIDTH</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1920, 1280, 1080].map((w) => (
                    <button key={w} onClick={() => patch({ width: w })} style={{ ...tBtn(st.width === w), flex: 1 }}>{w}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.14em', color: MUTE, marginBottom: 8 }}>FPS</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[30, 60].map((f) => (
                    <button key={f} onClick={() => patch({ fps: f })} style={{ ...tBtn(st.fps === f), flex: 1 }}>{f}</button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.14em', color: C7, marginBottom: 7 }}>
                <span>LOOPS IN FILE</span><span style={{ color: MUTE }}>&times;{st.loops}</span>
              </div>
              <input type="range" min={1} max={8} step={1} value={st.loops} onChange={(e) => patch({ loops: +e.target.value })} style={{ width: '100%' }} />
            </div>

            <button
              onClick={exportLoop}
              style={{ width: '100%', cursor: recording ? 'default' : 'pointer', border: 'none', fontFamily: MONO, fontWeight: 700, fontSize: 14, letterSpacing: '0.12em', padding: 17, background: recording ? FAINT : RED, color: INK, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}
            >{recording ? 'RECORDING…' : '●  REC & EXPORT LOOP'}</button>

            <div style={{ marginTop: 12, height: 5, background: 'rgba(244,240,230,0.12)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: (progress * 100).toFixed(1) + '%', background: RED, transition: 'width .1s linear' }} />
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.06em', color: MUTE, marginTop: 10, minHeight: 15, lineHeight: 1.5 }}>{msg}</div>
          </div>

          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.06em', color: FAINT, lineHeight: 1.8 }}>
            WEBM PLAYS IN OBS / STREAMLABS AS A MEDIA SOURCE.<br />ENABLE &ldquo;LOOP&rdquo; ON THE SOURCE. TRANSPARENT USES VP9 ALPHA.
          </div>

        </div>
      </div>
    </div>
  );
}
