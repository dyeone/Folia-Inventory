import { useState, useEffect } from 'react';
import { UserPlus, Key, Eye, EyeOff, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { AddUserModal } from './AddUserModal.jsx';
import { ResetPasswordModal } from './ResetPasswordModal.jsx';

export function UsersView({ currentUser, setConfirmDialog, showToast }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddUser, setShowAddUser] = useState(false);
  const [resetPasswordFor, setResetPasswordFor] = useState(null);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (e) {
      showToast(e.message || 'Failed to load users', 'error');
    }
    setLoading(false);
  };

  const changeRole = async (userId, newRole) => {
    if (userId === currentUser.id) return showToast("You can't change your own role", 'error');
    try {
      await api.updateUser({ id: userId, patch: { role: newRole }, adminUserId: currentUser.id });
      setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
      showToast('Role updated');
    } catch (e) {
      showToast(e.message || 'Failed to update role', 'error');
    }
  };

  const toggleActive = async (userId) => {
    if (userId === currentUser.id) return showToast("You can't deactivate your own account", 'error');
    const user = users.find(u => u.id === userId);
    try {
      await api.updateUser({ id: userId, patch: { active: !user.active }, adminUserId: currentUser.id });
      setUsers(users.map(u => u.id === userId ? { ...u, active: !u.active } : u));
      showToast(user.active ? 'User deactivated' : 'User activated');
    } catch (e) {
      showToast(e.message || 'Failed to update user', 'error');
    }
  };

  const deleteUser = (userId) => {
    if (userId === currentUser.id) return showToast("You can't delete your own account", 'error');
    const user = users.find(u => u.id === userId);
    setConfirmDialog({
      title: 'Delete user?',
      message: `Permanently delete "${user.displayName}" (@${user.username})? They'll lose all access. Items they created stay in the system.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api.deleteUsers([userId], currentUser.id);
          setUsers(users.filter(u => u.id !== userId));
          showToast('User deleted');
        } catch (e) {
          showToast(e.message || 'Failed to delete user', 'error');
        }
      },
    });
  };

  if (loading) {
    return <div className="text-sm text-gray-500">Loading users...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">User Management</h2>
          <p className="text-xs text-gray-500 mt-0.5">{users.length} {users.length === 1 ? 'user' : 'users'} total</p>
        </div>
        <button onClick={() => setShowAddUser(true)} className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg self-start sm:self-auto">
          <UserPlus className="w-4 h-4" /> Add User
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900">
        <strong>Note:</strong> User accounts and data are stored per-device. Team members will need to register on this same device/browser or share a sync method.
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-xs font-medium text-gray-600 uppercase tracking-wide">
              <th className="px-3 py-2.5">User</th>
              <th className="px-3 py-2.5">Role</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Joined</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map(user => {
              const isSelf = user.id === currentUser.id;
              return (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-semibold">
                        {user.displayName?.[0]?.toUpperCase() || 'U'}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 flex items-center gap-1.5">
                          {user.displayName}
                          {isSelf && <span className="text-xs text-gray-500">(you)</span>}
                        </div>
                        <div className="text-xs text-gray-500">@{user.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={user.role}
                      onChange={(e) => changeRole(user.id, e.target.value)}
                      disabled={isSelf}
                      className={`text-xs font-medium rounded px-2 py-1 border-0 focus:ring-2 focus:ring-emerald-500 ${
                        user.role === 'admin' ? 'bg-violet-100 text-violet-800' : 'bg-sky-100 text-sky-800'
                      } ${isSelf ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <option value="admin">Admin</option>
                      <option value="staff">Staff</option>
                    </select>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      user.active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-600'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${user.active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                      {user.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-600">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => setResetPasswordFor(user)}
                        title="Reset password"
                        className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
                      >
                        <Key className="w-3.5 h-3.5" />
                      </button>
                      {!isSelf && (
                        <>
                          <button
                            onClick={() => toggleActive(user.id)}
                            title={user.active ? 'Deactivate' : 'Activate'}
                            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
                          >
                            {user.active ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => deleteUser(user.id)}
                            title="Delete user"
                            className="p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {showAddUser && (
        <AddUserModal
          existingUsers={users}
          onSave={async (fields) => {
            const newUser = await api.createUser({ ...fields, adminUserId: currentUser.id });
            setUsers([...users, newUser]);
            setShowAddUser(false);
            showToast(`Added ${newUser.displayName}`);
          }}
          onClose={() => setShowAddUser(false)}
        />
      )}

      {resetPasswordFor && (
        <ResetPasswordModal
          user={resetPasswordFor}
          onSave={async (newPassword) => {
            await api.updateUser({ id: resetPasswordFor.id, newPassword, adminUserId: currentUser.id });
            setResetPasswordFor(null);
            showToast('Password reset');
          }}
          onClose={() => setResetPasswordFor(null)}
        />
      )}
    </div>
  );
}
