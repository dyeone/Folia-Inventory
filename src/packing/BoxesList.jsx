import { useState } from 'react';
import {
  ChevronDown, ChevronRight, Truck, MapPin, Check, AlertCircle, Link2,
} from 'lucide-react';

// Renders the parsed/matched preview of a Palmstreet orders upload.
// Used by the Validate Sales modal (SalesUploadModal). Each box shows
// its items + match confidence; "Link" / "Reset" buttons let the user
// override the match.
export function BoxesList({ boxes, onPick, onClearOverride }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  return (
    <div className="space-y-3">
      {boxes.map(box => {
        const isCollapsed = collapsed.has(box.id);
        const matched = box.items.filter(i => i.match?.item).length;
        const a = box;
        return (
          <div key={box.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <button
              onClick={() => setCollapsed(prev => {
                const next = new Set(prev);
                if (next.has(box.id)) next.delete(box.id); else next.add(box.id);
                return next;
              })}
              className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left"
            >
              <div className="mt-0.5 text-gray-400">
                {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900">{box.recipientName}</span>
                  {box.username && <span className="text-xs text-gray-500">@{box.username}</span>}
                  {a.shipmentMethod && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                      <Truck className="w-3 h-3" /> {a.shipmentMethod}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-0.5 flex items-start gap-1">
                  <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
                  <span>
                    {[a.street1, a.street2, [a.city, a.state, a.zip].filter(Boolean).join(', ')]
                      .filter(Boolean).join(' · ')}
                  </span>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-medium text-gray-900">
                  {box.items.length} {box.items.length === 1 ? 'item' : 'items'}
                </div>
                <div className={`text-xs ${matched === box.items.length ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {matched}/{box.items.length} matched
                </div>
              </div>
            </button>

            {!isCollapsed && (
              <div className="border-t border-gray-100 divide-y divide-gray-100">
                {box.items.map(item => (
                  <BoxItemRow
                    key={item.rowKey}
                    item={item}
                    onPick={() => onPick(box.id, item.rowKey, item.title)}
                    onClear={() => onClearOverride(box.id, item.rowKey)}
                  />
                ))}
                {box.notes?.length > 0 && (
                  <div className="px-4 py-2 bg-amber-50 text-xs text-amber-900">
                    <span className="font-medium">Notes:</span> {box.notes.join(' · ')}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BoxItemRow({ item, onPick, onClear }) {
  const match = item.match?.item;
  const confidence = item.match?.confidence;
  return (
    <div className="px-4 py-2.5 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-900 truncate">{item.title}</div>
        <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
          <span>Qty {item.quantity}</span>
          <span>·</span>
          <span>${item.price.toFixed(2)}</span>
          {item.sku && <><span>·</span><span className="font-mono">SKU {item.sku}</span></>}
        </div>
        {match ? (
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs bg-emerald-50 text-emerald-800 px-2 py-0.5 rounded border border-emerald-200">
            <Check className="w-3 h-3" />
            <span className="font-mono">{match.sku}</span>
            <span className="opacity-70">·</span>
            <span className="truncate max-w-[200px]">{match.name}{match.variety ? ` · ${match.variety}` : ''}</span>
            <span className="opacity-60 ml-1">({confidenceLabel(confidence)})</span>
          </div>
        ) : (
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs bg-amber-50 text-amber-800 px-2 py-0.5 rounded border border-amber-200">
            <AlertCircle className="w-3 h-3" /> No inventory match
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 flex-shrink-0">
        <button
          onClick={onPick}
          className="text-xs px-3 py-1.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-100 active:bg-gray-200 rounded-lg inline-flex items-center gap-1 font-medium"
        >
          <Link2 className="w-3.5 h-3.5" /> {match ? 'Change' : 'Link'}
        </button>
        {item.manual && (
          <button onClick={onClear} className="text-xs px-2 py-1 text-gray-500 hover:text-gray-900">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function confidenceLabel(c) {
  if (c === 'sku') return 'SKU';
  if (c === 'lot') return 'lot #';
  if (c === 'fuzzy') return 'fuzzy';
  if (c === 'manual') return 'manual';
  return c;
}
