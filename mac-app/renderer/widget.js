// Floating desktop widget renderer — the compact twin of the main window's
// status card. Main pushes the same printers:status / packing:status
// snapshots to both windows; this one just renders less of them. DOM-built
// (no string HTML) so printer/brand names can never inject markup.

const $ = (id) => document.getElementById(id);

const els = {
  close:    $('dw-close'),
  ready:    $('dw-ready'),
  total:    $('dw-total'),
  sub:      $('dw-sub'),
  bar:      $('dw-bar'),
  plants:   $('dw-plants'),
  shipped:  $('dw-shipped'),
  printers: $('dw-printers'),
  note:     $('dw-note'),
};

const STATE_TEXT = {
  idle: 'ready',
  printing: 'printing',
  paused: 'PAUSED',
  missing: 'not found',
  unset: 'not set',
};

function renderPrinters(st) {
  els.printers.replaceChildren();
  for (const r of st?.roles || []) {
    const row = document.createElement('div');
    row.className = 'dw-row';
    // Queue name + failure reason live in the tooltip — the card is too
    // narrow to print them, but the operator can hover.
    row.title = [r.printer, r.reason].filter(Boolean).join(' — ');

    const dot = document.createElement('span');
    dot.className = `printer-dot is-${r.state}`;
    const role = document.createElement('span');
    role.className = 'dw-role';
    role.textContent = r.title;
    const state = document.createElement('span');
    state.className = `printer-state is-${r.state}`;
    state.textContent = STATE_TEXT[r.state] || r.state;

    row.append(dot, role, state);
    if (r.jobs > 0) {
      const jobs = document.createElement('span');
      jobs.className = 'printer-jobs' +
        (r.state === 'paused' || r.state === 'missing' ? ' is-stuck' : '');
      jobs.textContent = String(r.jobs);
      jobs.title = `${r.jobs} in queue`;
      row.append(jobs);
    }
    els.printers.appendChild(row);
  }
  if (st?.error) {
    els.note.textContent = `Printers: ${st.error}`;
    els.note.classList.remove('hidden');
  } else {
    els.note.classList.add('hidden');
  }
}

function renderPacking(st) {
  if (st?.error) return;   // keep last good numbers through a blip

  const brands = st?.brands || [];
  const sum = (k) => brands.reduce((s, b) => s + (b[k] || 0), 0);
  const boxesOpen = sum('boxesOpen');
  const boxesReady = sum('boxesReady');
  const plantsTotal = sum('plantsTotal');
  const plantsPacked = sum('plantsPacked');
  const boxesShipped = sum('boxesShipped');

  els.ready.textContent = String(boxesReady);
  els.total.textContent = String(boxesOpen);
  els.ready.classList.toggle('is-done', boxesOpen > 0 && boxesReady === boxesOpen);
  els.sub.textContent =
    boxesOpen === 0 ? 'no open boxes' :
    boxesReady === boxesOpen ? 'all packed — ship!' :
    'ready to ship';
  const pct = plantsTotal > 0 ? Math.round((plantsPacked / plantsTotal) * 100) : 0;
  els.bar.style.width = `${pct}%`;
  els.plants.textContent = plantsTotal > 0 ? `${plantsPacked}/${plantsTotal} plants` : '—';
  els.shipped.textContent = boxesShipped > 0 ? `${boxesShipped} shipped today` : '';
  els.shipped.classList.toggle('hidden', boxesShipped === 0);
}

window.printers.onStatus(renderPrinters);
window.packing.onStatus(renderPacking);
els.close.addEventListener('click', () => window.desktopWidget.hide());

// First paint; steady state arrives via the pushes.
window.printers.getStatus().then(renderPrinters).catch(() => {});
window.packing.getStatus().then(renderPacking).catch(() => {});
