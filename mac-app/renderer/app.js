// Renderer — talks to the main process via window.bridge / window.app
// (set up in preload.js). Pure DOM, no framework, ~100 lines.

const $ = (id) => document.getElementById(id);

const els = {
  statePill:     $('state-pill'),
  bridge:        $('status-bridge'),
  phone:         $('status-phone'),
  queue:         $('status-queue'),
  error:         $('status-error'),
  btnStart:      $('btn-start'),
  btnStop:       $('btn-stop'),
  btnRestart:    $('btn-restart'),
  btnReconnect:  $('btn-reconnect'),
  cfgView:       $('cfg-view'),
  cfgEdit:       $('cfg-edit'),
  btnEditCfg:    $('btn-edit-cfg'),
  cfgUrl:        $('cfg-url'),
  cfgToken:      $('cfg-token'),
  cfgDevice:     $('cfg-device'),
  inUrl:         $('in-url'),
  inToken:       $('in-token'),
  btnSaveCfg:    $('btn-save-cfg'),
  btnCancelCfg:  $('btn-cancel-cfg'),
  log:           $('log'),
  btnOpenLog:    $('btn-open-log'),
  btnClearLog:   $('btn-clear-log'),
  chkAutoscroll: $('chk-autoscroll'),
};

// ── State rendering ──────────────────────────────────────────────────
function maskToken(t) {
  if (!t) return '—';
  if (t.length < 12) return '••••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function applyState(s) {
  els.bridge.textContent = s.running ? 'running' : 'stopped';
  els.phone.textContent  = s.phoneConnected ? (s.phoneTarget || 'connected') : 'disconnected';
  els.queue.textContent  = String(s.queued ?? 0);
  els.error.textContent  = s.lastError || 'none';
  els.btnStart.disabled  = !!s.running;
  els.btnStop.disabled   = !s.running;
  els.btnRestart.disabled = false;

  els.statePill.className = 'pill ' + (
    s.lastError ? 'pill-red' :
    (s.running && s.phoneConnected) ? 'pill-emerald' :
    'pill-gray'
  );
  els.statePill.textContent =
    s.lastError ? 'error' :
    (s.running && s.phoneConnected) ? 'live' :
    s.running ? 'starting' : 'idle';
}

function applyConfig(cfg) {
  els.cfgUrl.textContent    = cfg.BRIDGE_URL    || '—';
  els.cfgToken.textContent  = maskToken(cfg.BRIDGE_TOKEN);
  els.cfgDevice.textContent = cfg.BRIDGE_DEVICE || '(auto)';
}

// ── Log buffer ───────────────────────────────────────────────────────
const MAX_LINES = 1000;
function appendLog(line) {
  els.log.textContent += line + '\n';
  // Trim from the top if we exceed the cap — keeps DOM cheap.
  if (els.log.textContent.length > 200_000) {
    const lines = els.log.textContent.split('\n');
    els.log.textContent = lines.slice(-MAX_LINES).join('\n');
  }
  if (els.chkAutoscroll.checked) {
    els.log.scrollTop = els.log.scrollHeight;
  }
}

// ── Wire it up ───────────────────────────────────────────────────────
window.bridge.onState(applyState);
window.bridge.onLog(appendLog);

els.btnStart.addEventListener('click',     () => window.bridge.start());
els.btnStop.addEventListener('click',      () => window.bridge.stop());
els.btnRestart.addEventListener('click',   () => window.bridge.restart());
els.btnReconnect.addEventListener('click', async () => {
  els.btnReconnect.disabled = true;
  try { await window.bridge.reconnectPhone(); }
  finally { els.btnReconnect.disabled = false; }
});

els.btnEditCfg.addEventListener('click', async () => {
  const cfg = await window.bridge.getConfig();
  els.inUrl.value   = cfg.BRIDGE_URL   || '';
  els.inToken.value = cfg.BRIDGE_TOKEN || '';
  els.cfgView.classList.add('hidden');
  els.cfgEdit.classList.remove('hidden');
});
els.btnCancelCfg.addEventListener('click', () => {
  els.cfgView.classList.remove('hidden');
  els.cfgEdit.classList.add('hidden');
});
els.btnSaveCfg.addEventListener('click', async () => {
  const cfg = await window.bridge.saveConfig({
    BRIDGE_URL:   els.inUrl.value.trim(),
    BRIDGE_TOKEN: els.inToken.value.trim(),
  });
  applyConfig(cfg);
  els.cfgView.classList.remove('hidden');
  els.cfgEdit.classList.add('hidden');
});

els.btnClearLog.addEventListener('click', () => { els.log.textContent = ''; });
els.btnOpenLog.addEventListener('click',  () => window.app.openLogFile());

// Initial paint — pull current state + config from main.
(async () => {
  applyState(await window.bridge.getState());
  applyConfig(await window.bridge.getConfig());
})();
