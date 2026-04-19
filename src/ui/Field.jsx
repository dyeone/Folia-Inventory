export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-700 block mb-1">{label}</span>
      {children}
    </label>
  );
}
