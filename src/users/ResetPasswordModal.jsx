import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';

export function ResetPasswordModal({ user, onSave, onClose }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    setErr('');
    if (password.length < 6) return setErr('Password must be at least 6 characters');
    setLoading(true);
    try {
      await onSave(password);
    } catch (e) {
      setErr(e.message || 'Failed to reset password');
    }
    setLoading(false);
  };

  return (
    <Modal title={`Reset Password for ${user.displayName}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2">
          Set a new password for this user. Share it with them securely.
        </div>
        <Field label="New Password">
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="input" autoFocus />
        </Field>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg">
            Reset Password
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}
