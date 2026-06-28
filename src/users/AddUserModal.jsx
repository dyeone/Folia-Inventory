import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { BRANDS, DEFAULT_BRAND } from '../brands.js';

const ALL_BRANDS = Object.entries(BRANDS).map(([id, b]) => ({ id, name: b.name, accent: b.accent }));

export function AddUserModal({ existingUsers, onSave, onClose }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('staff');
  const [brandIds, setBrandIds] = useState([DEFAULT_BRAND]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const toggleBrand = (id) =>
    setBrandIds(prev => prev.includes(id) ? prev.filter(b => b !== id) : [...prev, id]);

  const handleSave = async () => {
    setErr('');
    if (!username.trim()) return setErr('Username required');
    if (password.length < 6) return setErr('Password must be at least 6 characters');
    if (brandIds.length === 0) return setErr('Select at least one brand');
    const normalized = username.trim().toLowerCase();
    if (existingUsers.find(u => u.username === normalized)) return setErr('Username already taken');

    setLoading(true);
    try {
      await onSave({
        username: username.trim(),
        password,
        displayName: displayName.trim() || username.trim(),
        role,
        brandIds,
      });
    } catch (e) {
      setErr(e.message || 'Failed to create user');
    }
    setLoading(false);
  };

  return (
    <Modal title="Add New User" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Username *">
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="input" placeholder="username" />
        </Field>
        <Field label="Display Name">
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" placeholder="Full name" />
        </Field>
        <Field label="Initial Password *">
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="input" placeholder="At least 6 characters" />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)} className="input">
            <option value="staff">Staff — view/edit inventory</option>
            <option value="admin">Admin — full access</option>
            <option value="packer">Packer — Shipping tab only, pack workflow</option>
          </select>
        </Field>
        <Field label="Brand access *">
          <div className="flex flex-wrap gap-2">
            {ALL_BRANDS.map(b => {
              const on = brandIds.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => toggleBrand(b.id)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition"
                  style={on
                    ? { background: `${b.accent}1a`, color: b.accent, borderColor: b.accent }
                    : { background: '#fff', color: '#6b7280', borderColor: '#d1d5db' }}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: b.accent, opacity: on ? 1 : 0.35 }} />
                  {b.name}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2">
          Share the username and password with the new user. They should change it after first login.
        </div>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg">
            {loading ? 'Creating...' : 'Create User'}
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:rgb(var(--brand-600));box-shadow:0 0 0 3px rgb(var(--brand-600)/.1)}`}</style>
    </Modal>
  );
}
