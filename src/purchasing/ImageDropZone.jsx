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
