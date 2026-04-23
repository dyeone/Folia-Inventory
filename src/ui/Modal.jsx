import { X } from 'lucide-react';

export function Modal({ title, children, onClose, size = 'md' }) {
  const widths = {
    sm: 'max-w-md',
    md: 'max-w-lg md:max-w-xl',
    lg: 'max-w-lg md:max-w-2xl',
    xl: 'max-w-lg md:max-w-3xl',
  };
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-t-2xl sm:rounded-2xl w-full ${widths[size] || widths.md} max-h-[92vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 text-base sm:text-lg">{title}</h3>
          <button
            onClick={onClose}
            className="p-2 -mr-2 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 sm:p-5">{children}</div>
      </div>
    </div>
  );
}
