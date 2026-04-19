import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';

export function ChangePasswordModal({ user, onClose, onSuccess }) {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    setErr('');
    if (!currentPw) return setErr('Enter current password');
    if (newPw.length < 6) return setErr('New password must be at least 6 characters');
    if (newPw !== confirmPw) return setErr('New passwords do not match');

    setLoading(true);
    try {
      await api.changePassword(user.id, currentPw, newPw);
      onSuccess();
    } catch (e) {
      setErr(e.message || 'Failed to change password');
    }
    setLoading(false);
  };

  return (
    <Modal title="Change Password" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Current Password">
          <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="input" autoFocus />
        </Field>
        <Field label="New Password">
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="input" />
        </Field>
        <Field label="Confirm New Password">
          <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className="input" />
        </Field>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg">
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}
