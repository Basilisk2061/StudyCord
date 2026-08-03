import { useState } from 'react';
import { Link } from 'react-router-dom';
import EtherealBackground from '../components/EtherealBackground';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabase';

export default function ResetPasswordPage() {
  const { session, loading, recoveryMode, clearRecoveryMode } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    setError('');

    if (!session || !recoveryMode) {
      setError('This password recovery link is invalid or has expired.');
      return;
    }
    if (!password || !confirmPassword) {
      setError('Enter and confirm your new password.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setPending(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError('Unable to update your password. Check the requirements and try again.');
        return;
      }

      clearRecoveryMode();
      setPassword('');
      setConfirmPassword('');
      setSuccess(true);
      await supabase.auth.signOut();
    } catch {
      setError('Unable to update your password right now. Please try again.');
    } finally {
      setPending(false);
    }
  };

  if (loading) {
    return <div className="auth-layout"><p>Validating recovery link...</p></div>;
  }

  return (
    <EtherealBackground>
      <main className="auth-recovery-layout">
        <section className="auth-card auth-page-transition" aria-labelledby="reset-password-title">
          <div className="auth-header">
            <div className="auth-brand__logo auth-recovery-logo">Study<span className="auth-brand__logo-accent">Cord</span></div>
            <h1 className="auth-title" id="reset-password-title">Choose a new password</h1>
            <p className="auth-subtitle">Use a password that meets your existing account requirements.</p>
          </div>

          {success ? (
            <>
              <div className="success-message" role="status">Your password has been updated. Sign in with your new password.</div>
              <Link to="/login" className="btn btn-primary">Return to sign in</Link>
            </>
          ) : !session || !recoveryMode ? (
            <>
              <div className="error-message" role="alert">This password recovery link is invalid or has expired.</div>
              <Link to="/forgot-password" className="btn btn-secondary">Request another link</Link>
            </>
          ) : (
            <form onSubmit={handleSubmit}>
              {error && <div className="error-message" role="alert">{error}</div>}
              <div className="form-group">
                <label className="form-label" htmlFor="new-password">New Password</label>
                <input
                  id="new-password"
                  className="form-input"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={pending}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="confirm-new-password">Confirm New Password</label>
                <input
                  id="confirm-new-password"
                  className="form-input"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  disabled={pending}
                  required
                />
              </div>
              <button className="btn btn-primary" type="submit" disabled={pending}>
                {pending ? 'Updating password...' : 'Update password'}
              </button>
            </form>
          )}
        </section>
      </main>
    </EtherealBackground>
  );
}
