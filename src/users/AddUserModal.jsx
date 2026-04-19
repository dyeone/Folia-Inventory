import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';

export function AddUserModal({ existingUsers, onSave, onClose }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('staff');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    setErr('');
    if (!username.trim()) return setErr('Username required');
    if (password.length < 6) return setErr('Password must be at least 6 characters');
    const normalized = username.trim().toLowerCase();
    if (existingUsers.find(u => u.username === normalized)) return setErr('Username already taken');

    setLoading(true);
    try {
      await onSave({
        username: username.trim(),
        password,
        displayName: displayName.trim() || username.trim(),
        role,
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
          </select>
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
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}
