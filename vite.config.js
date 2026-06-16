import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { apiPlugin } from './vite-plugin-api.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('xlsx')) return 'vendor-xlsx';
          // pdfjs + tesseract are only pulled by the Import Labels modal
          // (dynamic import), so they get their own lazily-loaded chunks.
          if (id.includes('pdfjs-dist')) return 'vendor-pdfjs';
          if (id.includes('tesseract.js')) return 'vendor-tesseract';
          if (id.includes('jspdf') || id.includes('html2canvas')) return 'vendor-pdf';
          if (id.includes('jsbarcode')) return 'vendor-barcode';
          if (id.includes('@supabase')) return 'vendor-supabase';
          if (id.includes('react-dom')) return 'vendor-react';
        },
      },
    },
  },
})
