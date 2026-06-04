// One-click updater for the (unsigned) macOS Bridge app.
//
// We can't use Squirrel.Mac auto-update — it refuses unsigned bundles (see
// updater.js). But we CAN do the manual drag-to-Applications dance for the
// operator: download the published DMG with progress, mount it, swap the
// new .app over the running bundle, strip quarantine, and relaunch. No
// code signature needed because we're just replacing files, not asking
// Squirrel to verify them.
//
// Safety is the whole game here — corrupting the operator's only bridge
// mid-live would be far worse than a clunky manual update. So the swap is
// staged: copy the new app *beside* the old one first (old stays intact if
// the copy fails), then do fast same-volume renames with rollback, and on
// ANY failure throw so main.js can fall back to opening the DMG for a
// manual drag. The operator is never left without a working app.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

// Stream the DMG to a temp file, reporting download progress. `total` is 0
// when the server omits content-length (rare for GitHub release assets);
// the caller renders an indeterminate bar in that case.
async function downloadDmg(url, onProgress) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
  const total = Number(resp.headers.get('content-length')) || 0;
  const tmp = path.join(os.tmpdir(), `folia-bridge-update-${Date.now()}.dmg`);
  const out = fs.createWriteStream(tmp);
  const reader = resp.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      await new Promise((res, rej) => out.write(Buffer.from(value), (e) => (e ? rej(e) : res())));
      onProgress?.({ phase: 'downloading', received, total, percent: total ? Math.round((received / total) * 100) : null });
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  if (received === 0) throw new Error('download was empty');
  return tmp;
}

// Mount the DMG, run fn(pathToMountedApp), always detach. Throws if the DMG
// holds no .app.
async function withMountedApp(dmgPath, fn) {
  const mountPoint = path.join(os.tmpdir(), `folia-bridge-mnt-${Date.now()}`);
  await execFileP('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint]);
  try {
    const appName = fs.readdirSync(mountPoint).find((e) => e.endsWith('.app'));
    if (!appName) throw new Error('no .app inside the downloaded DMG');
    return await fn(path.join(mountPoint, appName));
  } finally {
    // Detach can fail transiently if Finder/Spotlight is still poking the
    // volume; retry once after a beat, then give up (it auto-detaches on
    // unmount/restart anyway).
    try { await execFileP('hdiutil', ['detach', mountPoint, '-quiet']); }
    catch {
      await new Promise((r) => setTimeout(r, 1500));
      try { await execFileP('hdiutil', ['detach', mountPoint, '-force', '-quiet']); } catch { /* leaked mount; harmless */ }
    }
  }
}

// Swap `srcApp` over `targetApp` with rollback. Order matters:
//   1. ditto srcApp → target.new      (old bundle untouched; abort safely)
//   2. mv target → target.old         (fast rename, same volume)
//   3. mv target.new → target         (fast rename; new app live)
//   4. xattr -dr quarantine target    (so Gatekeeper doesn't block it)
//   5. rm -rf target.old              (best-effort cleanup)
// If step 3 throws after step 2, restore the old bundle so we never leave
// the operator with no app.
async function swapInPlace(srcApp, targetApp) {
  const dotNew = `${targetApp}.new`;
  const dotOld = `${targetApp}.old`;
  await execFileP('rm', ['-rf', dotNew, dotOld]).catch(() => {});      // clear stale leftovers
  await execFileP('ditto', [srcApp, dotNew]);                         // 1
  if (!fs.existsSync(path.join(dotNew, 'Contents', 'MacOS'))) {
    await execFileP('rm', ['-rf', dotNew]).catch(() => {});
    throw new Error('copied app looks incomplete');
  }
  await execFileP('mv', [targetApp, dotOld]);                         // 2
  try {
    await execFileP('mv', [dotNew, targetApp]);                       // 3
  } catch (e) {
    await execFileP('mv', [dotOld, targetApp]).catch(() => {});       // rollback
    throw e;
  }
  try { await execFileP('xattr', ['-dr', 'com.apple.quarantine', targetApp]); } catch { /* not fatal */ } // 4
  await execFileP('rm', ['-rf', dotOld]).catch(() => {});             // 5
}

// Full flow: download → mount → swap. Returns { ok, dmgPath }. On success
// the caller should relaunch. On failure it throws with `dmgPath` attached
// (when the download got that far) so main.js can open the DMG for a
// manual drag. `targetApp` is the running .app bundle (…/Foo.app).
async function downloadAndInstall({ url, targetApp, onProgress }) {
  const dmgPath = await downloadDmg(url, onProgress);
  try {
    onProgress?.({ phase: 'installing' });
    await withMountedApp(dmgPath, (srcApp) => swapInPlace(srcApp, targetApp));
    return { ok: true, dmgPath };
  } catch (e) {
    e.dmgPath = dmgPath;   // let the caller fall back to manual install
    throw e;
  }
}

module.exports = { downloadDmg, withMountedApp, swapInPlace, downloadAndInstall };
