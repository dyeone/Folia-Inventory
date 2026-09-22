// Keeps a copy of the Chrome extension (bundled into the app's resources by
// electron-builder, see package.json extraResources) under the user's
// Application Support, at a path that survives app updates. Chrome loads it
// from there as an unpacked extension — a one-time "Load unpacked" click —
// and after that every app update refreshes the folder and the extension
// reloads itself (extension/background.js). Pure fs, no Electron, so it's
// unit-testable with plain node.

const fs = require('node:fs');
const path = require('node:path');

function readManifestVersion(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return typeof m?.version === 'string' ? m.version : null;
  } catch {
    return null;
  }
}

const SKIP = /(^|\/)(node_modules|\.git|\.DS_Store)(\/|$)/;

// Copy src → dest atomically: build a sibling temp dir, then swap it into
// place. Chrome holds the PATH of an unpacked extension, not open file
// handles, so the running extension keeps working until it reloads itself
// and reads the new files. No-op when the versions already match (unless
// forced). Returns { changed, version, previous }.
function syncExtension({ srcDir, destDir, force = false }) {
  const version = readManifestVersion(srcDir);
  if (!version) throw new Error(`No manifest.json in ${srcDir}`);
  const previous = readManifestVersion(destDir);
  if (!force && previous === version) return { changed: false, version, previous };

  const parent = path.dirname(destDir);
  const base = path.basename(destDir);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.${base}.tmp-${process.pid}`);
  const old = path.join(parent, `.${base}.old-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  fs.cpSync(srcDir, tmp, { recursive: true, filter: (p) => !SKIP.test(p) });
  if (fs.existsSync(destDir)) fs.renameSync(destDir, old);
  fs.renameSync(tmp, destDir);
  fs.rmSync(old, { recursive: true, force: true });
  return { changed: true, version, previous };
}

module.exports = { readManifestVersion, syncExtension };
