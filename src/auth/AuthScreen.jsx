import { useState, useEffect } from 'react';
import { AlertCircle, Lock, UserPlus, Eye, EyeOff } from 'lucide-react';
import { api } from '../api.js';
import { Field } from '../ui/Field.jsx';

export function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [hasAnyUsers, setHasAnyUsers] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const hasUsers = await api.hasAnyUsers();
        setHasAnyUsers(hasUsers);
        if (!hasUsers) setMode('register');
      } catch (e) {
        setHasAnyUsers(false);
        setMode('register');
      }
    })();
  }, []);

  const handleSubmit = async () => {
    setErr('');
    if (!username.trim()) return setErr('Username required');
    if (!password) return setErr('Password required');

    setLoading(true);
    try {
      if (mode === 'register') {
        if (password.length < 6) {
          setErr('Password must be at least 6 characters');
          setLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setErr('Passwords do not match');
          setLoading(false);
          return;
        }
        const user = await api.register({
          username: username.trim(),
          password,
          displayName: displayName.trim() || username.trim(),
        });
        onLogin(user);
      } else {
        const user = await api.login({ username: username.trim(), password });
        onLogin(user);
      }
    } catch (e) {
      setErr(e.message || 'Sign-in failed. Please try again.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-sky-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="bg-[#d4e9c7] px-6 py-6">
          <img src="/logo.png" alt="Folia Society" className="h-16 w-auto mx-auto block mb-3" />
          <p className="text-center text-sm text-[#2d3f5e]">
            {mode === 'register'
              ? (hasAnyUsers === false ? 'Create the first admin account' : 'Register a new staff account')
              : 'Sign in to continue'}
          </p>
        </div>

        <div className="p-6 space-y-3">
          {hasAnyUsers === false && mode === 'register' && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-800">
              You're the first user — you'll be set up as the Admin.
            </div>
          )}

          <Field label="Username">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              className="input"
              autoComplete="username"
              placeholder="yourname"
            />
          </Field>

          {mode === 'register' && (
            <Field label="Display Name (optional)">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input"
                placeholder="How you'll appear to teammates"
              />
            </Field>
          )}

          <Field label="Password">
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                className="input pr-10"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder={mode === 'register' ? 'At least 6 characters' : ''}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>

          {mode === 'register' && (
            <Field label="Confirm Password">
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                className="input"
                autoComplete="new-password"
              />
            </Field>
          )}

          {err && (
            <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {err}
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white text-sm font-medium rounded-lg transition flex items-center justify-center gap-2"
          >
            {loading ? 'Please wait...' : (mode === 'register' ? <><UserPlus className="w-4 h-4" /> Create Account</> : <><Lock className="w-4 h-4" /> Sign In</>)}
          </button>

          {hasAnyUsers !== false && (
            <div className="text-center text-xs text-gray-500 pt-2 border-t border-gray-100">
              {mode === 'login' ? (
                <>Need an account? <button onClick={() => { setMode('register'); setErr(''); }} className="text-emerald-600 hover:text-emerald-700 font-medium">Register</button></>
              ) : (
                <>Already have an account? <button onClick={() => { setMode('login'); setErr(''); }} className="text-emerald-600 hover:text-emerald-700 font-medium">Sign In</button></>
              )}
            </div>
          )}
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </div>
  );
}
