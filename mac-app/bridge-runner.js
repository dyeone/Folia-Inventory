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

    // Sniff a few well-known patterns from bridge/index.js output to
    // keep the UI state in sync without a separate IPC channel:
    if (/connected to .*:[0-9]+/i.test(line) || /Already connected:/i.test(line)) {
      const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+)/);
      if (m) this._setState({ phoneConnected: true, phoneTarget: m[1] });
    }
    if (/queued/i.test(line)) {
      const m = line.match(/(\d+)\s+queued/i);
      if (m) this._setState({ queued: parseInt(m[1], 10) });
    }
    if (fromStderr && /error|fail|✗/i.test(line)) {
      this._setState({ lastError: line.slice(0, 200) });
    }
    this._setState({ lastLogAt: new Date().toISOString() });
  }

  // Start the bridge subprocess. If already running, no-op.
  start() {
    if (this.proc) return { ok: true, already: true };
    const startScript = path.join(this.bridgeDir, 'start.sh');
    const indexJs = path.join(this.bridgeDir, 'index.js');
    const cmd = fs.existsSync(startScript) ? 'bash' : 'node';
    const args = fs.existsSync(startScript) ? [startScript] : [indexJs];
    this._line(`→ Starting bridge: ${cmd} ${args.join(' ')}`);
    try {
      this.proc = spawn(cmd, args, {
        cwd: this.bridgeDir,
        env: {
          ...process.env,
          // Force unbuffered output so we get lines in real time.
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --unhandled-rejections=warn`.trim(),
        },
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

  stop() {
    if (!this.proc) return { ok: true, already: true };
    this._line('→ Stopping bridge');
    try {
      // SIGTERM gives the bridge a chance to flush its current job;
      // SIGKILL after 4s as a safety net for a stuck process.
      this.proc.kill('SIGTERM');
      const proc = this.proc;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 4000);
    } catch (e) {
      this._line(`✗ Stop failed: ${e.message}`, true);
      return { ok: false, error: e.message };
    }
    return { ok: true };
  }

  // Re-run bridge/reconnect.sh — discovers + adb-connects the phone
  // independently of the polling bridge process. Useful when the phone
  // dropped off WiFi and the operator wants to retry without bouncing
  // the whole bridge.
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
        env: process.env,
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
