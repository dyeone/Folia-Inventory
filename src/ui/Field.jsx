export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700 block mb-1.5">{label}</span>
      {children}
    </label>
  );
}
