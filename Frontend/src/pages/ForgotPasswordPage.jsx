import { useState } from 'react';
import { Link } from 'react-router-dom';
import EtherealBackground from '../components/EtherealBackground';
import { isValidEmail, requestPasswordReset } from '../lib/authFlow';

const NEUTRAL_SUCCESS = 'If an account exists for this email, password reset instructions have been sent.';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    setError('');

    if (!isValidEmail(email)) {
      setError('Enter a valid email address.');
      return;
    }

    setPending(true);
    try {
      const { error: resetError } = await requestPasswordReset(email);
      if (resetError) {
        setError('Unable to send reset instructions right now. Please try again.');
        return;
      }
      setSent(true);
    } catch {
      setError('Unable to send reset instructions right now. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <EtherealBackground>
      <main className="auth-recovery-layout">
        <section className="auth-card auth-page-transition" aria-labelledby="forgot-password-title">
          <div className="auth-header">
            <div className="auth-brand__logo auth-recovery-logo">Study<span className="auth-brand__logo-accent">Cord</span></div>
            <h1 className="auth-title" id="forgot-password-title">Reset your password</h1>
            <p className="auth-subtitle">Enter the email associated with your StudyCord account.</p>
          </div>

          {error && <div className="error-message" role="alert">{error}</div>}
          {sent ? (
            <div className="success-message" role="status">{NEUTRAL_SUCCESS}</div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="recovery-email">Email Address</label>
                <input
                  id="recovery-email"
                  className="form-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  disabled={pending}
                />
              </div>
              <button className="btn btn-primary" type="submit" disabled={pending}>
                {pending ? 'Sending instructions...' : 'Send reset instructions'}
              </button>
            </form>
          )}

          <div className="auth-footer">
            <Link to="/login" className="auth-link">Back to sign in</Link>
          </div>
        </section>
      </main>
    </EtherealBackground>
  );
}
