# Purchase tab — plant-name autocomplete + paste-image fix

**Date:** 2026-05-25
**Scope:** `src/purchasing/` — the catalog's "New plant" modal

## Problem

In the purchase tab's Catalog pane, "New plant" opens a modal where users fill in a variety, name, photos, prices, and notes. Two problems make this flow worse than it should be:

1. **Duplicate plants are easy to create.** Nothing in the create modal tells the user that a plant with the same name already exists in the chosen variety. The only check is a server-side 409 on duplicate epithet — which surfaces as an error after the user has filled out the entire form and uploaded photos. Common-name variations ("Queen Anthurium" vs "Queen") slip through entirely.
2. **Paste-to-add-image doesn't work until the user clicks into a text field.** Pasting an image is the fastest way to attach a photo, but it silently fails if no input is focused. The bug is invisible — the user just thinks paste isn't supported.

## Goals

- When creating a new plant, surface existing plants in the same variety that match what the user is typing. Make it one click to switch into editing the matched plant instead of creating a duplicate.
- Make `⌘V` paste an image into the create modal work the moment the modal opens, without requiring a click into a field first.

## Non-goals

- No fuzzy / typo-tolerant matching. Case-insensitive substring is enough.
- No cross-variety matching. Suggestions are scoped to the currently selected variety.
- No new server-side search endpoint. The Catalog already loads the full species list client-side; the autocomplete reuses it.
- No autocomplete in edit mode. Only create mode benefits.

---

## Design

### Part A — Paste-image bug fix

**Root cause.** `src/purchasing/ImageDropZone.jsx` attaches its `paste` listener to a scoping element (the modal `<div>`, via `modalRef`). Paste events fire on `document.activeElement` and bubble *up*. The modal `<div>` is a parent of the inputs inside it but a child of `<body>`. So:

- Active element is an input inside the modal → paste bubbles up to the modal div → handler fires. ✓
- Active element is `<body>` (nothing in the modal clicked yet) → paste fires on `<body>` → does **not** propagate down to the modal div → handler never fires. ✗

**Fix.** Attach the paste listener to `window` instead of the modal element. The `ImageDropZone` component only mounts while the modal is open — the effect's mount/unmount lifecycle already scopes the listener to the modal's lifetime, so DOM-element scoping was redundant *and* the source of the bug.

**Changes:**
- `src/purchasing/ImageDropZone.jsx`: drop the `pasteScope` prop, always listen on `window`.
- `src/purchasing/PhotoGallery.jsx`: stop accepting and forwarding `pasteScope`.
- `src/purchasing/ParentPhotoSlot.jsx`: stop accepting and forwarding `pasteScope`.
- `src/purchasing/PlantDetailModal.jsx`: remove `modalRef` (no other consumer — the click-outside-to-close uses `e.stopPropagation()` on the modal div, not the ref).

### Part B — Name autocomplete in create mode

#### Data source

`CatalogPane` already holds the full species list in client state (decorated with `varietyName`). No new API endpoint. The autocomplete filters that list client-side, scoped to the modal's currently selected `varietyId`.

**Wire-up:** `CatalogPane` passes `existingSpecies={plants}` to `PlantDetailModal` in create mode.

#### Trigger and matching

- Fires while typing in **either** the *Name / epithet* field or the *Common name* field.
- Minimum 2 characters before suggestions appear (1 char would be too noisy across a large catalog).
- Match: case-insensitive substring on **either** `epithet` OR `commonName`, restricted to species where `varietyId === selectedVarietyId`.
- Up to 5 results. Ranking: prefix matches first (matched against whichever field the user is typing in), then mid-string matches, then alphabetical by epithet.
- If the modal is not in create mode, or no varietyId is selected, autocomplete is disabled.

#### UI

A new component, `src/purchasing/NameAutocomplete.jsx`, encapsulates the dropdown so it can be wrapped around either the epithet or the common-name `<input>` without duplicating logic.

- Renders the dropdown anchored below the focused input, full width of the field.
- Each row: primary photo thumbnail (24×24, falling back to a placeholder if no photo loaded), epithet in normal weight, common name in muted text and parentheses.
- Keyboard: ↑/↓ to move highlight, Enter to pick the highlighted row, Esc to dismiss.
- Mouse: hover to highlight, click to pick.
- Dropdown dismisses on blur (with a short delay so click-to-pick fires first), Esc, or when the input is cleared / below the minimum char count.

#### On pick — "switch into edit mode for existing"

When the user picks a suggestion, the modal stops being "create" and becomes "edit" for that species:

1. Toast: *"Switched to edit mode for {epithet} — {N} photos added"* (omit the "N photos added" clause if no photos were staged).
2. All form fields re-populate from the matched species: `epithet`, `commonName`, `wholesalePrice`, `idealSellingPrice`, `profitRate`, `notes`. (`varietyId` stays — it already matched.)
3. Any staged photos (gallery / mother / father) upload **immediately** to the matched species via the same `uploadStaged` helper that the Save flow uses.
4. After uploads finish (or settle — failed uploads surface a toast like the existing flow), `stagedGallery` / `stagedMother` / `stagedFather` clear.
5. `PhotoGallery` and `ParentPhotoSlot` transition to live mode — the matched species's existing photos appear alongside the just-uploaded ones.
6. The modal title flips from "New plant" to "Edit plant".
7. Save now calls `api.updateSpecies({ id: matched.id, patch })` instead of `api.createSpecies(body)`.

**State representation.** A single new state field — `matchedSpeciesId` (initially `null`) — captures the switched-to-edit state. Derived: `isCreate = !initial && !matchedSpeciesId`. When `matchedSpeciesId` is set, the modal treats it the same way it currently treats `initial?.id`.

**Why upload-on-switch rather than defer to Save.** Keeps the photo widgets binary (staged-mode XOR live-mode) instead of introducing a hybrid mode. If the user changes their mind about a pasted photo after switching, the live gallery's `×` button removes it in one click — nothing is unrecoverable.

#### No name match → existing behavior unchanged

Save calls `createSpecies` as today. The server-side 409 on duplicate `(varietyId, epithet)` stays as a safety net for race conditions or for cases where the user dismissed/ignored the suggestion.

---

## Files touched

| File | Change |
|------|--------|
| `src/purchasing/ImageDropZone.jsx` | Drop `pasteScope` prop; listen on `window`. |
| `src/purchasing/PhotoGallery.jsx` | Drop `pasteScope` prop. |
| `src/purchasing/ParentPhotoSlot.jsx` | Drop `pasteScope` prop. |
| `src/purchasing/PlantDetailModal.jsx` | Remove `modalRef`; add `matchedSpeciesId` state; wire autocomplete into epithet + common-name fields; switch-to-edit handler; update Save to branch on `matchedSpeciesId`. |
| `src/purchasing/CatalogPane.jsx` | Pass `existingSpecies={plants}` to the modal. |
| `src/purchasing/NameAutocomplete.jsx` | **New.** Reusable dropdown component for both name fields. |

## Testing

This is UI-only and tested in the browser. Manual checks:

1. Open Catalog → "New plant". Without clicking anything, ⌘V an image from clipboard → image appears in the photo gallery. (Fixes Part A.)
2. Type 2+ characters of an existing plant's epithet (within the same variety) → suggestions appear. Pick one → modal switches to "Edit plant" with all fields populated. Any staged photos appear in the live gallery.
3. Same as #2 but typing in the common-name field — suggestions still appear.
4. Type 2+ characters that match nothing → no dropdown. Saving creates a new species as today.
5. Switch to "Edit plant" via autocomplete, then Save → matched species is updated, no duplicate created.
6. With a staged photo, switch to "Edit plant" → toast says "N photos added"; photo appears in live gallery; species was updated, not created.
