import { useMemo } from 'react';
import { FileText, FileDown, Users, Info } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { computeSellerSettlement } from './sellerSettlement.js';

// End-of-event per-seller settlement: what each seller's plants sold for, the
// commission we keep, and the amount we owe them. Read-only — it reads the sale's
// inventory items (already marked sold + priced by Validate Sales). Exports a
// per-seller CSV and PDF the operator can hand to the seller.

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const slug = (s) => (s || 'sale').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportCsvFor(sale, g) {
  const headers = ['SKU', 'Plant', 'Variety', 'Status', 'Sale Price', 'Commission %', 'Our commission', 'Owed to seller'];
  const rows = g.lines.map(l => [
    l.sku, l.name, l.variety, l.status,
    l.sold ? l.price.toFixed(2) : '', l.pct,
    l.sold ? l.ourCommission.toFixed(2) : '', l.sold ? l.owed.toFixed(2) : '',
  ]);
  rows.push([]);
  rows.push([`TOTALS · ${g.sold}/${g.listed} sold`, '', '', '', g.gross.toFixed(2), '', g.ourCommission.toFixed(2), g.owed.toFixed(2)]);
  const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${slug(sale.name)}-${slug(g.seller.name)}-settlement.csv`);
}

async function exportPdfFor(sale, g) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const M = 40;
  let y = M;
  pdf.setFontSize(16); pdf.setFont('helvetica', 'bold');
  pdf.text(`${g.seller.name} — settlement`, M, y); y += 20;
  pdf.setFontSize(10); pdf.setFont('helvetica', 'normal'); pdf.setTextColor(90);
  pdf.text(`${sale.name || 'Sale event'}${sale.date ? ` · ${sale.date}` : ''}  ·  seller code ${g.seller.code}`, M, y); y += 22;

  pdf.setTextColor(0); pdf.setFontSize(9); pdf.setFont('helvetica', 'bold');
  const cols = [M, M + 90, M + 260, M + 330, M + 400, M + 480];
  const head = ['SKU', 'Plant', 'Price', 'Comm%', 'Our cut', 'Owed'];
  head.forEach((h, i) => pdf.text(h, cols[i], y));
  y += 4; pdf.setDrawColor(210); pdf.line(M, y, 555, y); y += 12;
  pdf.setFont('helvetica', 'normal');
  for (const l of g.lines) {
    if (y > 780) { pdf.addPage(); y = M; }
    const cells = [
      String(l.sku || ''),
      String(l.name || '').slice(0, 26),
      l.sold ? money(l.price) : '—',
      `${l.pct}%`,
      l.sold ? money(l.ourCommission) : '—',
      l.sold ? money(l.owed) : '—',
    ];
    pdf.setTextColor(l.sold ? 0 : 150);
    cells.forEach((c, i) => pdf.text(c, cols[i], y));
    y += 14;
  }
  y += 4; pdf.setDrawColor(180); pdf.line(M, y, 555, y); y += 16;
  pdf.setFont('helvetica', 'bold'); pdf.setTextColor(0);
  pdf.text(`${g.sold}/${g.listed} sold`, cols[0], y);
  pdf.text(money(g.gross), cols[2], y);
  pdf.text(money(g.ourCommission), cols[4], y);
  pdf.text(money(g.owed), cols[5], y);
  pdf.save(`${slug(sale.name)}-${slug(g.seller.name)}-settlement.pdf`);
}

export function SellerSettlementModal({ sale, items, sellers, onClose }) {
  const groups = useMemo(
    () => computeSellerSettlement(sale, items, sellers),
    [sale, items, sellers],
  );

  const totalOwed = groups.reduce((s, g) => s + g.owed, 0);
  const totalKept = groups.reduce((s, g) => s + g.ourCommission, 0);

  return (
    <Modal title={`Seller settlement · ${sale?.name || ''}`} onClose={onClose} size="xl">
      {groups.length === 0 ? (
        <div className="py-10 text-center">
          <Users className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No seller-consignment plants in this event.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            Sold figures come from what Validate Sales recorded. Our commission is kept; the rest is owed to the seller.
            Palmstreet fees are absorbed by the house (not deducted from payouts).
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-emerald-50 rounded-lg p-3">
              <div className="text-xs text-emerald-700">We keep (commission)</div>
              <div className="text-lg font-bold text-emerald-800">{money(totalKept)}</div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3">
              <div className="text-xs text-amber-700">Total owed to sellers</div>
              <div className="text-lg font-bold text-amber-800">{money(totalOwed)}</div>
            </div>
          </div>

          {groups.map(g => (
            <div key={g.seller.id} className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2.5 bg-gray-50 border-b border-gray-100">
                <span className="font-mono text-xs font-bold text-emerald-700 bg-emerald-100 rounded px-1.5 py-0.5">{g.seller.code}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900 truncate">{g.seller.name}</span>
                  <span className="block text-xs text-gray-500">{g.sold}/{g.listed} sold · gross {money(g.gross)}</span>
                </span>
                <span className="text-right">
                  <span className="block text-xs text-gray-500">Owe seller</span>
                  <span className="block text-sm font-bold text-amber-700">{money(g.owed)}</span>
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => exportCsvFor(sale, g)}
                    className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50"
                    title="Export CSV"
                  >
                    <FileDown className="w-3.5 h-3.5" /> CSV
                  </button>
                  <button
                    onClick={() => exportPdfFor(sale, g)}
                    className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
                    title="Export PDF"
                  >
                    <FileText className="w-3.5 h-3.5" /> PDF
                  </button>
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="text-[11px] text-gray-500 uppercase tracking-wide">
                    <tr className="border-b border-gray-100">
                      <th className="text-left font-medium px-3 py-1.5">SKU</th>
                      <th className="text-left font-medium px-3 py-1.5">Plant</th>
                      <th className="text-right font-medium px-3 py-1.5">Price</th>
                      <th className="text-right font-medium px-3 py-1.5">Comm%</th>
                      <th className="text-right font-medium px-3 py-1.5">Our cut</th>
                      <th className="text-right font-medium px-3 py-1.5">Owed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.lines.map(l => (
                      <tr key={l.id} className={`border-b border-gray-50 ${l.sold ? '' : 'text-gray-400'}`}>
                        <td className="px-3 py-1.5 font-mono text-xs">{l.sku}</td>
                        <td className="px-3 py-1.5 truncate max-w-[10rem]">{l.name}{l.variety ? ` · ${l.variety}` : ''}</td>
                        <td className="px-3 py-1.5 text-right">{l.sold ? money(l.price) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">{l.pct}%</td>
                        <td className="px-3 py-1.5 text-right">{l.sold ? money(l.ourCommission) : '—'}</td>
                        <td className="px-3 py-1.5 text-right font-medium">{l.sold ? money(l.owed) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
