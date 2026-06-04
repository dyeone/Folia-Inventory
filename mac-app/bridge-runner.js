const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// BridgeRunner wraps the Node bridge subprocess + the ADB reconnect
// shell script so the Electron main process can manage them from one
// object.
//
// State surface:
//   { running, phoneConnected, phoneTarget, queued, lastError, lastLogAt }
//
// Events:
//   'log'   (string)  — every line of bridge stdout/stderr
//   'state' (object)  — emitted whenever any field above changes
//
// Logs are also tee'd to ~/Library/Logs/folia-bridge/bridge.log so the
// operator can grep through them after a long shift.

class BridgeRunner extends EventEmitter {
  constructor({ bridgeDir }) {
    super();
    this.bridgeDir = bridgeDir;
    this.proc = null;
    this.reconnectProc = null;
    this.state = {
      running: false,
      phoneConnected: false,
      phoneTarget: null,
      queued: 0,
      lastError: null,
      lastLogAt: null,
    };

    // Persistent log file — tail-friendly for an operator wanting to
    // diagnose without keeping the app window open.
    const logDir = path.join(os.homedir(), 'Library', 'Logs', 'folia-bridge');
    fs.mkdirSync(logDir, { recursive: true });
    this._logFile = path.join(logDir, 'bridge.log');
    this._logStream = fs.createWriteStream(this._logFile, { flags: 'a' });
  }

  logFilePath() { return this._logFile; }

  getState() { return { ...this.state }; }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  _line(line, fromStderr = false) {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    this._logStream.write(stamped + '\n');
    this.emit('log', line);

    // Sniff well-known patterns from bridge/index.js + start.sh /
    // reconnect.sh prep scripts to keep the UI state in sync without
    // a separate IPC channel.

    // Device presence. A serial-bearing line (startup pin / reconnect) is
    // the authoritative "connected" signal. The bridge also logs device
    // drop/return events mid-session that carry no serial — sniff those
    // too, or the UI keeps showing "live" while the phone is unplugged.
    const usbMatch = line.match(/(?:Bridge\s+(?:pinned to|will use)\s+device|Found USB device)\s+(\S+)/i);
    if (usbMatch) {
      this._setState({ phoneConnected: true, phoneTarget: usbMatch[1] });
    } else if (/device back\b|device link restored/i.test(line)) {
      this._setState({ phoneConnected: true });
    } else if (/device dropped|device link lost|device unresponsive|no devices\/emulators found|device offline|device not found/i.test(line)) {
      this._setState({ phoneConnected: false });
    }

    if (/queued/i.test(line)) {
      const m = line.match(/(\d+)\s+queued/i);
      if (m) this._setState({ queued: parseInt(m[1], 10) });
    }
    if (fromStderr && /error|fail|✗/i.test(line)) {
      this._setState({ lastError: line.slice(0, 200) });
    }
    // Clear a stale error once the bridge demonstrably recovers — a
    // completed job or an explicit recovery line. Without this, a single
    // transient warning (a u2 hiccup, a Vercel cold-start blip, a cable
    // jiggle) latches the status pill red forever even though the bridge
    // is fine, so the operator can't tell a live outage from old news.
    if (this.state.lastError &&
        (/\bjob\s+\S+\s+done\s*$/i.test(line) ||
         /recovered|resuming fast path|re-kicked|back on fast path|device back\b|device link restored/i.test(line))) {
      this._setState({ lastError: null });
    }
    this._setState({ lastLogAt: new Date().toISOString() });
  }

  // Build the env for spawned children. macOS GUI apps inherit a
  // stripped PATH (no /opt/homebrew/bin, no /usr/local/bin), so `node`
  // and `adb` aren't reachable from the bridge subprocess unless we
  // prepend the common Homebrew + system paths ourselves. Without this
  // patch the bridge dies with exit 127 (command not found) from the
  // very first call.
  _childEnv() {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const seen = new Set();
    const cur = (process.env.PATH || '').split(':').filter(Boolean);
    const merged = [...extra, ...cur].filter(p => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });
    return {
      ...process.env,
      PATH: merged.join(':'),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --unhandled-rejections=warn`.trim(),
    };
  }

  // Sniff for stale `node .../bridge/index.js` processes that aren't
  // owned by this mac-app (e.g., one the operator launched from a
  // terminal a week ago and forgot about). Two competing bridges
  // race for jobs on Vercel; the stale one usually has no working
  // device pin and fails every job it claims. Kill them before
  // starting our own.
  _killStaleBridges() {
    try {
      const out = require('node:child_process')
        .execFileSync('pgrep', ['-f', 'node.*bridge/index\\.js'], { encoding: 'utf8' });
      const pids = out.split('\n').map(s => s.trim()).filter(Boolean)
        .map(s => parseInt(s, 10))
        .filter(p => Number.isFinite(p) && p !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
          this._line(`→ Killed stale bridge process pid=${pid}`);
        } catch { /* permission / already dead */ }
      }
    } catch { /* pgrep returns 1 when no matches — normal */ }
  }

  // Start the bridge subprocess. If already running, no-op.
  start() {
    if (this.proc) return { ok: true, already: true };
    this._killStaleBridges();
    const startScript = path.join(this.bridgeDir, 'start.sh');
    const indexJs = path.join(this.bridgeDir, 'index.js');
    const cmd = fs.existsSync(startScript) ? 'bash' : 'node';
    const args = fs.existsSync(startScript) ? [startScript] : [indexJs];
    this._line(`→ Starting bridge: ${cmd} ${args.join(' ')}`);
    try {
      this.proc = spawn(cmd, args, {
        cwd: this.bridgeDir,
        env: this._childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this._line(`✗ Spawn failed: ${e.message}`, true);
      this._setState({ running: false, lastError: e.message });
      return { ok: false, error: e.message };
    }
    this._setState({ running: true, lastError: null });
    this._wireLines(this.proc.stdout, false);
    this._wireLines(this.proc.stderr, true);
    this.proc.on('exit', (code, signal) => {
      this._line(`→ Bridge exited (code=${code} signal=${signal || 'none'})`);
      this.proc = null;
      this._setState({ running: false, phoneConnected: false });
    });
    return { ok: true };
  }

  // Returns a Promise that resolves only once the child has actually
  // exited. restart() (main.js) does `await stop(); start()`, and start()
  // no-ops when this.proc is still set — so stop() MUST NOT resolve until
  // the start()-registered 'exit' handler has cleared this.proc, or the
  // restart silently leaves the bridge stopped. The 'exit' handler runs
  // first (registered earlier), then our once('exit') resolves, so by the
  // time the caller's await returns this.proc === null.
  stop() {
    if (!this.proc) return Promise.resolve({ ok: true, already: true });
    this._line('→ Stopping bridge');
    const proc = this.proc;
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => { if (!settled) { settled = true; resolve(res); } };
      // Resolve however the process dies — clean SIGTERM exit or the
      // SIGKILL fallback below (uncatchable, so 'exit' always fires).
      proc.once('exit', () => done({ ok: true }));
      try {
        // SIGTERM asks the bridge to terminate; SIGKILL after 4s is the
        // safety net for a process that's wedged and ignores it.
        proc.kill('SIGTERM');
      } catch (e) {
        this._line(`✗ Stop failed: ${e.message}`, true);
        return done({ ok: false, error: e.message });
      }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 4000);
    });
  }

  // Re-run bridge/reconnect.sh — re-pins the USB device, refreshes the
  // tcp:9008 forward, and bounces u2 if it died. Useful after a cable
  // blip without bouncing the whole bridge.
  reconnectPhone() {
    return new Promise((resolve) => {
      if (this.reconnectProc) {
        return resolve({ ok: false, error: 'Reconnect already running' });
      }
      const script = path.join(this.bridgeDir, 'reconnect.sh');
      if (!fs.existsSync(script)) {
        return resolve({ ok: false, error: 'reconnect.sh not found' });
      }
      this._line('→ Running reconnect.sh');
      this.reconnectProc = spawn('bash', [script], {
        cwd: this.bridgeDir,
        env: this._childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._wireLines(this.reconnectProc.stdout, false);
      this._wireLines(this.reconnectProc.stderr, true);
      this.reconnectProc.on('exit', (code) => {
        this.reconnectProc = null;
        this._line(`→ reconnect.sh exited (code=${code})`);
        resolve({ ok: code === 0 });
      });
    });
  }

  _wireLines(stream, fromStderr) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.length) this._line(line, fromStderr);
      }
    });
    stream.on('end', () => {
      if (buf.length) this._line(buf, fromStderr);
    });
  }

  // bridge/.env config: BRIDGE_URL + BRIDGE_TOKEN (+ optional others).
  // The mac app reads + edits this file directly so the operator never
  // has to touch the terminal to configure the bridge.
  envPath() { return path.join(this.bridgeDir, '.env'); }

  readEnv() {
    const out = {};
    try {
      const txt = fs.readFileSync(this.envPath(), 'utf-8');
      for (const raw of txt.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        out[k] = v;
      }
    } catch { /* file might not exist yet */ }
    return out;
  }

  writeEnv(cfg) {
    const lines = [];
    for (const [k, v] of Object.entries(cfg)) {
      if (v == null || v === '') continue;
      // Quote if value contains whitespace or special chars.
      const needsQuote = /[\s#"]/.test(v);
      lines.push(`${k}=${needsQuote ? JSON.stringify(v) : v}`);
    }
    fs.writeFileSync(this.envPath(), lines.join('\n') + '\n', 'utf-8');
  }
}

module.exports = { BridgeRunner };
