// Lazy pdfjs-dist singleton with the worker configured. pdfjs is big, so it's
// dynamically imported on first use and shared by every caller (label OCR in
// the Import Labels modal, label printing in the packer view).
let pdfjsPromise = null;
export async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}
