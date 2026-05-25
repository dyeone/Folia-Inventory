# Purchase plant-name autocomplete + paste-image fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Catalog "New plant" modal, surface existing plants in the same variety as the user types and let them switch into editing the matched plant with one click; and fix the paste-image bug where ⌘V silently fails until a text field is focused.

**Architecture:** Two coordinated changes in `src/purchasing/`. The paste fix simplifies `ImageDropZone` to listen on `window` (the component lifecycle already scopes the listener to modal open/close). The autocomplete adds a new `NameAutocomplete` component, wires it into both name fields, and adds `matchedSpeciesId` + the full matched species object to `PlantDetailModal` state so the modal can flip from create mode into edit mode on pick.

**Tech Stack:** React 19, Vite, Tailwind, lucide-react. **No test runner** is installed in this project — verification is `npm run lint` + manual browser checks. Each task ends with lint + a manual checklist + commit.

**Spec:** `docs/superpowers/specs/2026-05-25-purchase-plant-name-autocomplete-and-paste-fix-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/purchasing/ImageDropZone.jsx` | Modify | Drop `pasteScope` prop; listen on `window`. |
| `src/purchasing/PhotoGallery.jsx` | Modify | Stop accepting/forwarding `pasteScope`. |
| `src/purchasing/ParentPhotoSlot.jsx` | Modify | Stop accepting/forwarding `pasteScope`. |
| `src/purchasing/PlantDetailModal.jsx` | Modify | Remove `modalRef`; add `matchedSpeciesId` + `matchedSpecies` state; derive `effective` species; wire autocomplete; switch-to-edit on pick; Save branches on matched. |
| `src/purchasing/CatalogPane.jsx` | Modify | Pass `existingSpecies={plants}` to the modal. |
| `src/purchasing/NameAutocomplete.jsx` | Create | Self-contained dropdown anchored under a name input — filter, rank, keyboard nav, click-to-pick. |

---

## Task 1: Paste-image fix

**Files:**
- Modify: `src/purchasing/ImageDropZone.jsx`
- Modify: `src/purchasing/PhotoGallery.jsx`
- Modify: `src/purchasing/ParentPhotoSlot.jsx`
- Modify: `src/purchasing/PlantDetailModal.jsx`

The bug: `ImageDropZone` attaches its paste listener to a scoping element (the modal `<div>`). Paste events fire on `document.activeElement` and bubble up — so the modal div never receives the event unless an element inside it is focused. Fix: listen on `window`. The dropzone component only mounts while the modal is open, so the effect's mount/unmount lifecycle already provides the scoping.

- [ ] **Step 1: Update `ImageDropZone.jsx` — drop `pasteScope`, listen on window**

Edit `src/purchasing/ImageDropZone.jsx`. Replace the prop comment block, the props destructuring, and the `useEffect` paste handler. The new file in full:

```jsx
import { useEffect, useRef, useState } from 'react';
import { Upload, ImagePlus } from 'lucide-react';

// One unified surface for picking an image — supports three input modes:
//   1. Click → hidden <input type="file"> file picker
//   2. Drag-and-drop onto the surface
//   3. Paste an image from the clipboard while the component is mounted
//
// Calls onFile(file) with each File the user provides. Multi-file drops
// are forwarded one File at a time so the caller decides how to handle
// them (a gallery may want all, a single-slot may want only the first).
//
// Paste listens on window for the lifetime of this component. We don't
// scope to a DOM element because paste events fire on document.activeElement
// and bubble up — scoping to a modal <div> means paste silently fails until
// the user focuses something inside the modal. The component's own mount
// lifecycle (it only renders while the modal is open) handles teardown.
//
// Props:
//   onFile(file)   — required, called per selected/dropped/pasted File
//   accept         — file input accept attribute (default 'image/*')
//   multiple       — allow multi-file file-picker (default true)
//   disabled       — disable all input
//   children       — content rendered inside the zone (the visual UI).
//                    If null, renders the default "Drop / click / paste"
//                    placeholder.

export function ImageDropZone({
  onFile,
  accept = 'image/*',
  multiple = true,
  disabled = false,
  children,
}) {
  const fileRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (disabled) return undefined;
    const handler = (e) => {
      const items = e.clipboardData?.items || [];
      let consumed = false;
      for (const it of items) {
        if (it.kind === 'file') {
          const file = it.getAsFile();
          if (file && file.type.startsWith('image/')) {
            consumed = true;
            onFile(file);
            if (!multiple) break;
          }
        }
      }
      if (consumed) e.preventDefault();
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [onFile, multiple, disabled]);

  const handlePicked = (files) => {
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    for (const f of arr) {
      if (!f.type.startsWith('image/')) continue;
      onFile(f);
      if (!multiple) break;
    }
  };

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (disabled) return;
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(false);
        handlePicked(e.dataTransfer?.files);
      }}
      onClick={() => !disabled && fileRef.current?.click()}
      className={`relative cursor-pointer rounded-lg border-2 border-dashed transition ${
        dragging ? 'border-emerald-500 bg-emerald-50' : 'border-gray-300 hover:border-emerald-400 bg-gray-50'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => handlePicked(e.target.files)}
      />
      {children ?? (
        <div className="p-6 text-center text-sm text-gray-500 space-y-1">
          <ImagePlus className="w-6 h-6 mx-auto text-gray-400" />
          <div className="flex items-center justify-center gap-1 text-gray-700">
            <Upload className="w-3.5 h-3.5" /> Click, drag, or paste an image
          </div>
          <div className="text-[11px] text-gray-400">PNG, JPG, WebP</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update `PhotoGallery.jsx` — drop `pasteScope`**

In `src/purchasing/PhotoGallery.jsx`:

1. Remove `pasteScope,` from the props destructuring (currently line 25). The block becomes:

```jsx
export function PhotoGallery({
  speciesId,
  photos,                  // gallery photos for this species (kind='gallery')
  primaryPhotoId,
  onChanged,
  showToast,
  // Staged-mode props (used while creating the species). The gallery
  // becomes a write-only preview surface: existing 'photos' is empty,
  // and the dropzone forwards each file to onStaged.
  staged,                  // [{ id, previewUrl, file }] | undefined
  onStaged,                // (file) → void — caller stages
  onClearStaged,           // (id) → void — caller drops a staged item
}) {
```

2. Remove `pasteScope={pasteScope}` from the `<ImageDropZone>` (currently line 134). The element becomes:

```jsx
      <ImageDropZone
        onFile={(f) => (stagedMode ? onStaged?.(f) : liveUpload(f))}
        disabled={busy}
      />
```

- [ ] **Step 3: Update `ParentPhotoSlot.jsx` — drop `pasteScope`**

In `src/purchasing/ParentPhotoSlot.jsx`:

1. Remove `pasteScope,` from the props destructuring (currently line 23). The block becomes:

```jsx
export function ParentPhotoSlot({
  kind,
  label,
  speciesId,
  photos,              // species.photos (filtered to this kind, optional in staged mode)
  showToast,
  onChanged,           // live mode — called after a successful mutation
  stagedPreviewUrl,    // staged mode — local preview to render
  onStaged,            // staged mode — caller wires this to handle a File
  onClearStaged,       // staged mode — caller wires this to clear the staged file
}) {
```

2. Remove `pasteScope={pasteScope}` from the `<ImageDropZone>` (currently line 125). The element becomes:

```jsx
      <ImageDropZone
        onFile={(f) => (stagedMode ? onStaged?.(f) : liveUpload(f))}
        multiple={false}
        disabled={busy}
      >
        {inner}
      </ImageDropZone>
```

- [ ] **Step 4: Update `PlantDetailModal.jsx` — remove `modalRef` and stop forwarding `pasteScope`**

In `src/purchasing/PlantDetailModal.jsx`:

1. Remove the `useRef` import (only used by `modalRef`). The first import line becomes:

```jsx
import { useEffect, useMemo, useState } from 'react';
```

2. Delete the `modalRef` declaration and its comment block (currently lines 39–41):

```jsx
  // Used to scope the ImageDropZone paste handler to this modal so
  // clipboard images don't get consumed while the modal is closed.
  const modalRef = useRef(null);
```

3. Remove `ref={modalRef}` from the inner modal `<div>` (currently line 146). The div opening becomes:

```jsx
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
```

4. Remove `pasteScope={modalRef}` from `<PhotoGallery>` (currently line 173) and from both `<ParentPhotoSlot>` instances (currently lines 189 and 201). The three resulting elements:

```jsx
            <PhotoGallery
              speciesId={isCreate ? null : initial.id}
              photos={galleryPhotos}
              primaryPhotoId={initial?.primaryPhotoId}
              onChanged={() => onSaved?.(initial)}
              showToast={showToast}
              staged={isCreate ? stagedGallery : undefined}
              onStaged={isCreate ? stageGallery : undefined}
              onClearStaged={isCreate ? removeStagedGallery : undefined}
            />
```

```jsx
              <ParentPhotoSlot
                kind="mother"
                label="Mother plant"
                speciesId={isCreate ? null : initial.id}
                photos={parentPhotos}
                showToast={showToast}
                onChanged={() => onSaved?.(initial)}
                stagedPreviewUrl={isCreate ? stagedMother?.previewUrl : null}
                onStaged={isCreate ? ((f) => stageParent('mother', f)) : undefined}
                onClearStaged={isCreate ? (() => clearStagedParent('mother')) : undefined}
              />
              <ParentPhotoSlot
                kind="father"
                label="Father plant"
                speciesId={isCreate ? null : initial.id}
                photos={parentPhotos}
                showToast={showToast}
                onChanged={() => onSaved?.(initial)}
                stagedPreviewUrl={isCreate ? stagedFather?.previewUrl : null}
                onStaged={isCreate ? ((f) => stageParent('father', f)) : undefined}
                onClearStaged={isCreate ? (() => clearStagedParent('father')) : undefined}
              />
```

- [ ] **Step 5: Lint**

Run: `npm run lint`

Expected: no new errors. (Pre-existing warnings in unrelated files are fine.)

- [ ] **Step 6: Manual browser verification**

Run: `npm run dev`, open the Catalog tab, click "New plant".

Check:
1. Without clicking anywhere inside the modal, copy an image from another window (e.g. right-click an image in Finder → Copy, or screenshot to clipboard with ⌃⌘⇧4) and press ⌘V → image appears in the photo gallery.
2. Existing flow still works: drag-and-drop an image, click-to-pick from file dialog.
3. Close the modal, open it again, paste another image → still works.
4. Anthurium variety: paste also works into the Mother and Father slots without prior focus.
5. Edit mode (open an existing plant): paste still uploads photos live as before.

- [ ] **Step 7: Commit**

```bash
git add src/purchasing/ImageDropZone.jsx src/purchasing/PhotoGallery.jsx src/purchasing/ParentPhotoSlot.jsx src/purchasing/PlantDetailModal.jsx
git commit -m "$(cat <<'EOF'
purchasing: fix paste-image dead-until-focus in plant modal

ImageDropZone scoped paste to a DOM element (the modal div via
modalRef). Paste events fire on activeElement and bubble up, so the
modal never received them until the user clicked into a field. Listen
on window instead — the dropzone's own mount lifecycle scopes the
listener to the modal's open state.
EOF
)"
```

---

## Task 2: Create `NameAutocomplete` component

**Files:**
- Create: `src/purchasing/NameAutocomplete.jsx`

Self-contained dropdown anchored under a name input. Stays unused at end of this task; wiring into the modal happens in Task 3.

- [ ] **Step 1: Create `src/purchasing/NameAutocomplete.jsx`**

```jsx
import { useEffect, useMemo, useRef, useState } from 'react';

// Inline autocomplete dropdown for plant-name fields in the create-plant
// modal. Wraps a single input (epithet OR commonName) and renders a
// floating menu of matching existing plants while the user types.
//
// Matching is case-insensitive substring on epithet OR commonName,
// restricted to the variety the caller scopes via `candidates`. Prefix
// matches on the field the user is typing into rank first; substring
// matches come next; ties break alphabetically by epithet.
//
// Props:
//   value          — current input value (the parent owns the input state)
//   onChange(v)    — input change handler
//   onPick(species)— called with the full species object when a row is picked
//   candidates     — array of { id, epithet, commonName, varietyId, ... } scoped to variety
//   matchField     — 'epithet' | 'commonName' — used for prefix-ranking only
//   inputProps     — additional props spread onto the <input> (className, placeholder, etc.)
//   disabled       — when true, no dropdown shown (e.g. edit mode)

const MIN_CHARS = 2;
const MAX_RESULTS = 5;

export function NameAutocomplete({ value, onChange, onPick, candidates, matchField, inputProps, disabled }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef(null);

  const matches = useMemo(() => {
    if (disabled) return [];
    const q = (value || '').trim().toLowerCase();
    if (q.length < MIN_CHARS) return [];
    const list = candidates || [];
    const scored = [];
    for (const s of list) {
      const ep = (s.epithet || '').toLowerCase();
      const cn = (s.commonName || '').toLowerCase();
      const inEp = ep.includes(q);
      const inCn = cn.includes(q);
      if (!inEp && !inCn) continue;
      // Rank: prefix on the matchField field = 0; prefix on the other field = 1;
      // substring-only = 2. Lower is better.
      const primary = matchField === 'epithet' ? ep : cn;
      const secondary = matchField === 'epithet' ? cn : ep;
      let rank;
      if (primary.startsWith(q)) rank = 0;
      else if (secondary.startsWith(q)) rank = 1;
      else rank = 2;
      scored.push({ species: s, rank });
    }
    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return (a.species.epithet || '').localeCompare(b.species.epithet || '');
    });
    return scored.slice(0, MAX_RESULTS).map(x => x.species);
  }, [value, candidates, matchField, disabled]);

  // Reset highlight when the result set changes.
  useEffect(() => { setHighlight(0); }, [matches.length, value]);

  // Close the dropdown when clicking outside the wrapper.
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const visible = open && matches.length > 0;

  const pick = (s) => {
    setOpen(false);
    onPick?.(s);
  };

  const onKeyDown = (e) => {
    if (!visible) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(matches.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(matches[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <input
        {...(inputProps || {})}
        value={value}
        onChange={(e) => { onChange?.(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {visible && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {matches.map((s, i) => (
            <button
              key={s.id}
              type="button"
              // onMouseDown so the pick fires before the input's blur closes us.
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setHighlight(i)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                i === highlight ? 'bg-emerald-50' : 'bg-white hover:bg-gray-50'
              }`}
            >
              <span className="font-medium text-gray-900">{s.epithet}</span>
              {s.commonName && (
                <span className="text-gray-500">({s.commonName})</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/purchasing/NameAutocomplete.jsx
git commit -m "$(cat <<'EOF'
purchasing: add NameAutocomplete dropdown component

Inline autocomplete that wraps a single name input and shows matching
existing plants. Case-insensitive substring match on epithet or
common name, prefix-on-matchField ranked first, capped at 5. Not yet
wired into PlantDetailModal — that's the next commit.
EOF
)"
```

---

## Task 3: Wire autocomplete into PlantDetailModal; switch-to-edit on pick

**Files:**
- Modify: `src/purchasing/CatalogPane.jsx`
- Modify: `src/purchasing/PlantDetailModal.jsx`

This is the largest task. It threads the existing species list from `CatalogPane` into the modal, adds two state fields (`matchedSpeciesId` + `matchedSpecies`), derives an `effective` species from `initial || matchedSpecies`, wraps both name inputs in `NameAutocomplete`, implements the on-pick switch-to-edit handler (with immediate photo upload), and updates the Save flow to call `updateSpecies` when matched.

- [ ] **Step 1: Update `CatalogPane.jsx` — pass `existingSpecies` to the modal**

In `src/purchasing/CatalogPane.jsx`, the modal mount block (currently lines 161–169) becomes:

```jsx
      {selectedSpeciesId && (
        <PlantDetailModal
          initial={selectedSpeciesId === 'NEW' ? null : plants.find(p => p.id === selectedSpeciesId)}
          varieties={varieties}
          existingSpecies={plants}
          showToast={showToast}
          onClose={() => setSelectedSpeciesId(null)}
          onSaved={() => onSpeciesChanged?.()}
        />
      )}
```

(The only change is adding `existingSpecies={plants}`.)

- [ ] **Step 2: Update `PlantDetailModal.jsx` — accept `existingSpecies`, add matched state, derive effective species**

In `src/purchasing/PlantDetailModal.jsx`:

1. Add the import for the new component at the top alongside the other imports:

```jsx
import { useEffect, useMemo, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { PhotoGallery } from './PhotoGallery.jsx';
import { ParentPhotoSlot } from './ParentPhotoSlot.jsx';
import { NameAutocomplete } from './NameAutocomplete.jsx';
```

2. Update the function signature to accept `existingSpecies`:

```jsx
export function PlantDetailModal({ initial, varieties, existingSpecies, onClose, onSaved, showToast }) {
```

3. Right below the existing `useState` declarations and the `[err, setErr]` state (around line 31), add the matched-species state. Then change the derivation of `isCreate` and add the `effective` species:

```jsx
  // After picking an autocomplete suggestion, the modal pivots from create
  // mode to "edit this matched species" mode. We keep the full matched
  // species in state so PhotoGallery / ParentPhotoSlot can show its
  // existing photos and Save knows which species to update.
  const [matchedSpecies, setMatchedSpecies] = useState(null);

  const effective = initial || matchedSpecies;
  const isCreate = !effective;
```

4. Delete the old single-line `const isCreate = !initial;` (originally line 16). The replacement above subsumes it.

- [ ] **Step 3: Update photo-widget props in `PlantDetailModal.jsx` to use `effective`**

In the same file, replace the `<PhotoGallery>` element (currently in lines 168–180 region, post-Task-1 edits) with this version that uses `effective`:

```jsx
          <Field label="Photos">
            <PhotoGallery
              speciesId={effective?.id || null}
              photos={(effective?.photos || []).filter(p => (p.kind || 'gallery') === 'gallery')}
              primaryPhotoId={effective?.primaryPhotoId}
              onChanged={() => onSaved?.(effective)}
              showToast={showToast}
              staged={isCreate ? stagedGallery : undefined}
              onStaged={isCreate ? stageGallery : undefined}
              onClearStaged={isCreate ? removeStagedGallery : undefined}
            />
          </Field>
```

And both `<ParentPhotoSlot>` elements (in the Anthurium block) with these:

```jsx
              <ParentPhotoSlot
                kind="mother"
                label="Mother plant"
                speciesId={effective?.id || null}
                photos={(effective?.photos || []).filter(p => p.kind === 'mother' || p.kind === 'father')}
                showToast={showToast}
                onChanged={() => onSaved?.(effective)}
                stagedPreviewUrl={isCreate ? stagedMother?.previewUrl : null}
                onStaged={isCreate ? ((f) => stageParent('mother', f)) : undefined}
                onClearStaged={isCreate ? (() => clearStagedParent('mother')) : undefined}
              />
              <ParentPhotoSlot
                kind="father"
                label="Father plant"
                speciesId={effective?.id || null}
                photos={(effective?.photos || []).filter(p => p.kind === 'mother' || p.kind === 'father')}
                showToast={showToast}
                onChanged={() => onSaved?.(effective)}
                stagedPreviewUrl={isCreate ? stagedFather?.previewUrl : null}
                onStaged={isCreate ? ((f) => stageParent('father', f)) : undefined}
                onClearStaged={isCreate ? (() => clearStagedParent('father')) : undefined}
              />
```

Now delete the two old precomputed-arrays lines just above the return (currently lines 140–141):

```jsx
  // Pre-filter photos to the relevant kinds for the live-mode widgets.
  const galleryPhotos = (initial?.photos || []).filter(p => (p.kind || 'gallery') === 'gallery');
  const parentPhotos  = (initial?.photos || []).filter(p => p.kind === 'mother' || p.kind === 'father');
```

(Their callers now inline the filter against `effective?.photos`.)

- [ ] **Step 4: Update the title to use `effective`**

In `src/purchasing/PlantDetailModal.jsx`, the modal header (currently around line 151) becomes:

```jsx
          <h2 className="text-base font-semibold">{isCreate ? 'New plant' : 'Edit plant'}</h2>
```

(`isCreate` is already derived from `effective`, so the title flips automatically when a match is picked. This line probably already reads that way — verify it matches exactly.)

Also update the profit-rate field gate (currently around line 231) — `!isCreate` already covers it correctly. No code change needed; just confirm the existing `{!isCreate && (...)}` block still wraps the Profit-rate field.

- [ ] **Step 5: Implement the `onPickMatch` handler**

In `src/purchasing/PlantDetailModal.jsx`, add this handler below `clearStagedParent` (around line 86, before `const save = async () => {`):

```jsx
  // Called when the user picks an autocomplete suggestion. Switches the
  // modal from create mode into "edit matched species" mode: repopulates
  // all form fields from the matched species, then immediately uploads
  // any staged photos to it (so the photo widgets can switch to live
  // mode without a hybrid state). Anthurium-only stages are only
  // uploaded if the matched species is Anthurium too — but since
  // autocomplete is variety-scoped, that's guaranteed.
  const onPickMatch = async (s) => {
    setMatchedSpecies(s);
    setEpithet(s.epithet || '');
    setCommonName(s.commonName || '');
    setWholesalePrice(s.wholesalePrice != null ? String(s.wholesalePrice) : '');
    setIdealSellingPrice(s.idealSellingPrice != null ? String(s.idealSellingPrice) : '');
    setProfitRate(s.profitRate != null ? String(s.profitRate) : '');
    setNotes(s.notes || '');

    // Flush any staged photos to the matched species so the gallery /
    // parent slots can transition to live mode. Failures surface as a
    // toast but don't block — the species still exists and the user can
    // retry from the now-live widgets.
    const uploads = [];
    for (const g of stagedGallery) uploads.push(uploadStaged(s.id, g.file, 'gallery'));
    if (stagedMother) uploads.push(uploadStaged(s.id, stagedMother.file, 'mother'));
    if (stagedFather) uploads.push(uploadStaged(s.id, stagedFather.file, 'father'));
    const stagedCount = uploads.length;

    // Clear staged state regardless of upload outcome — the live widgets
    // will show whatever made it onto the server.
    for (const g of stagedGallery) URL.revokeObjectURL(g.previewUrl);
    if (stagedMother?.previewUrl) URL.revokeObjectURL(stagedMother.previewUrl);
    if (stagedFather?.previewUrl) URL.revokeObjectURL(stagedFather.previewUrl);
    setStagedGallery([]);
    setStagedMother(null);
    setStagedFather(null);

    if (stagedCount > 0) {
      try {
        const results = await Promise.allSettled(uploads);
        const failed = results.filter(r => r.status === 'rejected').length;
        const ok = stagedCount - failed;
        const label = s.commonName || s.epithet;
        if (failed === 0) {
          showToast?.(`Switched to edit mode for ${label} — ${ok} photo${ok === 1 ? '' : 's'} added`, 2500);
        } else {
          showToast?.(`Switched to edit mode for ${label} — ${ok} of ${stagedCount} photo${stagedCount === 1 ? '' : 's'} uploaded`, 3500);
        }
        // Surface fresh photos via the parent's species refresh.
        onSaved?.(s);
      } catch {
        showToast?.('Some photos failed to upload', 3000);
      }
    } else {
      showToast?.(`Switched to edit mode for ${s.commonName || s.epithet}`, 2000);
    }
  };
```

- [ ] **Step 6: Update Save to branch on `matchedSpecies`**

In `src/purchasing/PlantDetailModal.jsx`, replace the entire `save` function (currently lines 88–137 region, post-Task-1 edits) with:

```jsx
  const save = async () => {
    setErr('');
    if (!varietyId) { setErr('Variety required'); return; }
    if (!epithet.trim()) { setErr('Name required'); return; }
    setSaving(true);
    try {
      const body = {
        varietyId,
        epithet: epithet.trim(),
        commonName: commonName.trim() || null,
        wholesalePrice: wholesalePrice === '' ? null : parseFloat(wholesalePrice),
        idealSellingPrice: idealSellingPrice === '' ? null : parseFloat(idealSellingPrice),
        notes: notes || null,
      };
      let saved;
      if (effective) {
        // Edit mode — either we opened on an existing species (initial)
        // or the user picked an autocomplete match (matchedSpecies).
        await api.updateSpecies({
          id: effective.id,
          patch: {
            ...body,
            profitRate: profitRate === '' ? null : parseFloat(profitRate),
          },
        });
        saved = {
          ...effective,
          ...body,
          profitRate: profitRate === '' ? null : parseFloat(profitRate),
        };
      } else {
        // True create — no initial, no matched.
        saved = await api.createSpecies(body);
        const uploads = [];
        for (const g of stagedGallery) uploads.push(uploadStaged(saved.id, g.file, 'gallery'));
        if (isAnthurium && stagedMother) uploads.push(uploadStaged(saved.id, stagedMother.file, 'mother'));
        if (isAnthurium && stagedFather) uploads.push(uploadStaged(saved.id, stagedFather.file, 'father'));
        const results = await Promise.allSettled(uploads);
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
          showToast?.(`Plant created, but ${failed} photo${failed === 1 ? '' : 's'} failed to upload`, 4000);
        }
      }
      onSaved?.(saved);
      showToast?.(effective ? 'Saved' : 'Plant created', 2000);
      onClose();
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };
```

The key change: the create-vs-update branch now checks `effective` (covers both `initial` and `matchedSpecies` cases) rather than `isCreate`/`!isCreate` against `initial` alone.

- [ ] **Step 7: Wrap the epithet input in `NameAutocomplete`**

In `src/purchasing/PlantDetailModal.jsx`, the Name/epithet `<Field>` (currently around line 211) becomes:

```jsx
          <Field label="Name / epithet">
            <NameAutocomplete
              value={epithet}
              onChange={setEpithet}
              onPick={onPickMatch}
              candidates={(existingSpecies || []).filter(s => s.varietyId === varietyId)}
              matchField="epithet"
              disabled={!isCreate}
              inputProps={{
                className: 'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg',
              }}
            />
          </Field>
```

- [ ] **Step 8: Wrap the common-name input in `NameAutocomplete`**

In the same file, the Common name `<Field>` (currently around line 215) becomes:

```jsx
          <Field label="Common name">
            <NameAutocomplete
              value={commonName}
              onChange={setCommonName}
              onPick={onPickMatch}
              candidates={(existingSpecies || []).filter(s => s.varietyId === varietyId)}
              matchField="commonName"
              disabled={!isCreate}
              inputProps={{
                className: 'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg',
              }}
            />
          </Field>
```

- [ ] **Step 9: Lint**

Run: `npm run lint`

Expected: no new errors.

- [ ] **Step 10: Manual browser verification**

Run: `npm run dev`, open the Catalog tab, click "New plant".

Check, in order:
1. With variety set to (e.g.) Anthurium and zero typed → no dropdown.
2. Type one character → no dropdown (below MIN_CHARS).
3. Type two characters matching an existing Anthurium plant's epithet → dropdown shows up to 5 matches, ordered prefix-first. Common name shows in parens after the epithet.
4. Use ↓ / ↑ to move highlight, press Enter on a row → modal title flips to "Edit plant", all fields populate from the picked plant, dropdown closes.
5. Open "New plant" again. Paste an image (⌘V) first → preview appears in staged gallery. Then type to filter and pick a suggestion → toast says "Switched to edit mode for X — 1 photo added"; the photo appears in the live gallery (with primary-star and delete buttons); the matched plant's existing photos also appear.
6. After switch, edit a field (e.g. notes) and press Save → toast says "Saved"; catalog refreshes; the matched plant shows the new note and any added photos. No new duplicate plant was created.
7. Type 2+ chars in the **Common name** field instead → autocomplete also fires there; pick a suggestion → same switch-to-edit behavior.
8. Type a name with no matches → no dropdown; Save creates a new plant as before.
9. Type a match, hit Esc → dropdown closes, value remains.
10. Type a match, click outside the input → dropdown closes.
11. Switch variety after picking? Edge case — picked plant's variety stays as matched; user can still Save. (Not a problem in practice — autocomplete is disabled after switch, and varieties match by construction at the time of pick.)
12. Open an existing plant directly (click a card, not "New plant") → autocomplete is disabled (`!isCreate` is false), name field behaves like a plain input.
13. Run server-side 409 check: type a name that exists, ignore the dropdown, hit Save → backend returns "Species already exists in this variety" via the `err` state. (Safety net still works.)

- [ ] **Step 11: Commit**

```bash
git add src/purchasing/CatalogPane.jsx src/purchasing/PlantDetailModal.jsx
git commit -m "$(cat <<'EOF'
purchasing: autocomplete existing plants in New plant modal

As the user types into the epithet or common-name field, suggest
matching plants in the same variety from the catalog's already-loaded
species list. Picking a suggestion switches the modal to edit mode for
the matched species: form fields repopulate, any staged photos upload
immediately to the matched species, and Save now updates instead of
creating. The server-side 409 on duplicate epithet stays as a safety
net for ignored suggestions.
EOF
)"
```

---

## Self-review notes

**Spec coverage check:**
- Paste-image fix → Task 1. ✓
- Name autocomplete (trigger on either field, 2-char min, variety-scoped, both columns, prefix-first ranking, capped at 5) → Task 2 (`NameAutocomplete.jsx` logic). ✓
- Inline dropdown UI with keyboard/mouse nav → Task 2. ✓
- On pick: switch to edit mode, repopulate, immediate photo upload, widgets transition to live mode, title flip, Save updates → Task 3 (Steps 4–8). ✓
- Existing species list passed from `CatalogPane` → Task 3 (Step 1). ✓
- 409 safety net preserved → Save still calls `createSpecies` when no match, server still 409s. ✓
- No autocomplete in edit mode → `disabled={!isCreate}` on both inputs (Steps 7–8). ✓

**Type/name consistency:**
- `matchedSpecies` (full object) — used in `setMatchedSpecies`, `onPickMatch`, derivation of `effective`. Consistent.
- `effective = initial || matchedSpecies` — used in PhotoGallery/ParentPhotoSlot props, Save branch, title. Consistent.
- `existingSpecies` prop on `PlantDetailModal` — passed by `CatalogPane`, filtered to `candidates` in both autocomplete wraps. Consistent.
- `onPickMatch` signature `(s) => void` where `s` is the full species — matches `NameAutocomplete`'s `onPick(species)` contract. Consistent.

**Placeholder scan:** No TBDs, no "implement later", every code-changing step shows the exact code. ✓
