import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import EtherealBackground from '../components/EtherealBackground';
import { useAuth } from '../lib/AuthContext';

export default function AuthCallbackPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const failed = !loading && !session;

  useEffect(() => {
    if (loading) return;

    window.history.replaceState({}, document.title, '/auth/callback');

    if (session) {
      navigate('/dashboard', { replace: true });
    }
  }, [loading, navigate, session]);

  return (
    <EtherealBackground>
      <main className="auth-recovery-layout">
        <section className="auth-card auth-page-transition" aria-labelledby="auth-callback-title">
          <div className="auth-header">
            <div className="auth-brand__logo auth-recovery-logo">Study<span className="auth-brand__logo-accent">Cord</span></div>
            <h1 className="auth-title" id="auth-callback-title">
              {failed ? 'Unable to complete sign in' : 'Completing sign in'}
            </h1>
            <p className="auth-subtitle">
              {failed
                ? 'The Google sign-in request was cancelled, expired, or could not be completed.'
                : 'Securely restoring your StudyCord session...'}
            </p>
          </div>
          {failed && <Link to="/login" className="btn btn-primary">Return to sign in</Link>}
        </section>
      </main>
    </EtherealBackground>
  );
}
