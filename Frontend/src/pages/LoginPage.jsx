import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import EtherealBackground from '../components/EtherealBackground';
import AuthCharacters from '../components/AuthCharacters';
import GoogleAuthButton from '../components/GoogleAuthButton';
import { beginGoogleOAuth, normalizeEmail } from '../lib/authFlow';
import Seo from '../components/Seo';

const HOME_SEO = {
  title: 'StudyCord – AI-Powered Student Collaboration Platform',
  description: 'StudyCord brings messaging, voice and video, document sharing, semantic search, and a RAG-powered AI Study Assistant into one student workspace.',
  path: '/',
};

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [loadingLogin, setLoadingLogin] = useState(false);
  const [loadingGoogle, setLoadingGoogle] = useState(false);
  const [focusedField, setFocusedField] = useState(null);

  const navigate = useNavigate();
  const { session, loading, recoveryMode } = useAuth();

  // Redirect to dashboard if already logged in
  useEffect(() => {
    if (!loading && session) {
      navigate(recoveryMode ? '/reset-password' : '/dashboard');
    }
  }, [session, loading, navigate, recoveryMode]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (loadingLogin || loadingGoogle) return;
    setError(null);
    setLoadingLogin(true);

    try {
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: normalizeEmail(email),
        password,
      });

      if (loginError) {
        setError('Unable to sign in. Check your credentials and try again.');
      } else {
        navigate('/dashboard');
      }
    } catch {
      setError('Unable to reach the authentication service. Please try again.');
    } finally {
      setLoadingLogin(false);
    }
  };

  const handleGoogleLogin = async () => {
    if (loadingLogin || loadingGoogle) return;
    setError(null);
    setLoadingGoogle(true);
    try {
      const { error: oauthError } = await beginGoogleOAuth();
      if (oauthError) {
        setError('Unable to start Google sign in. Please try again.');
        setLoadingGoogle(false);
      }
    } catch {
      setError('Unable to start Google sign in. Please try again.');
      setLoadingGoogle(false);
    }
  };

  // Compute character state from which field is focused
  const charState = !focusedField
    ? 'idle'
    : focusedField === 'email'
    ? 'email'
    : showPassword
    ? 'password-visible'
    : 'password-hidden';

  if (loading) return null; // Avoid flicker

  return (
    <EtherealBackground>
      <Seo {...HOME_SEO} />
      <div className="auth-split auth-split--login">
        {/* Branding Panel */}
        <div className="auth-brand auth-page-transition">
          <h1 className="auth-brand__logo">
            Study<span className="auth-brand__logo-accent">Cord</span>
          </h1>
          <p className="auth-brand__tagline">
            AI-powered student collaboration for connected, organized study groups.
          </p>

          <AuthCharacters charState={charState} />
          <p className="auth-brand__mascot-note">Built for students, study groups, and educators.</p>

          <ul className="auth-brand__features">
            <li className="auth-brand__feature">
              <div className="auth-brand__feature-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="auth-brand__feature-text">
                <h2>Study Together</h2>
                <p>Use real-time messaging, document sharing, voice, and video calls.</p>
              </div>
            </li>
            <li className="auth-brand__feature">
              <div className="auth-brand__feature-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
              </div>
              <div className="auth-brand__feature-text">
                <h2>Search Smarter</h2>
                <p>Find relevant study materials with semantic document search.</p>
              </div>
            </li>
            <li className="auth-brand__feature">
              <div className="auth-brand__feature-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1 0-3.12 3 3 0 0 1 0-4.88 2.5 2.5 0 0 1 0-3.12A2.5 2.5 0 0 1 9.5 2z" />
                  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 0-3.12 3 3 0 0 0 0-4.88 2.5 2.5 0 0 0 0-3.12A2.5 2.5 0 0 0 14.5 2z" />
                </svg>
              </div>
              <div className="auth-brand__feature-text">
                <h2>Learn with AI</h2>
                <p>Use the RAG-powered AI Study Assistant for answers, summaries, flashcards, and quizzes.</p>
              </div>
            </li>
          </ul>

          <nav className="auth-public-nav" aria-label="Learn about StudyCord">
            <Link to="/features">Features</Link>
            <Link to="/about">About</Link>
            <Link to="/technology">Technology</Link>
            <Link to="/faq">FAQ</Link>
          </nav>
        </div>

        {/* Form Panel */}
        <div className="auth-form-panel">
          <div className="auth-card auth-page-transition">
            <div className="auth-header">
              <h2 className="auth-title">Welcome to StudyCord</h2>
              <p className="auth-subtitle">Sign in to your StudyCord account</p>
            </div>

            {error && <div className="error-message" role="alert">{error}</div>}

            <form onSubmit={handleLogin}>
              <div className="form-group">
                <label className="form-label" htmlFor="login-email">Email Address</label>
                <input
                  id="login-email"
                  className="form-input"
                  type="email"
                  placeholder="you@university.edu"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={() => setFocusedField('email')}
                  onBlur={() => setFocusedField(null)}
                  required
                  autoComplete="email"
                  disabled={loadingLogin || loadingGoogle}
                />
              </div>

              <div className="form-group">
                <div className="form-label-row">
                  <label className="form-label" htmlFor="login-password">Password</label>
                  <Link to="/forgot-password" className="auth-forgot-link">Forgot password?</Link>
                </div>
                <div className="password-field">
                  <input
                    id="login-password"
                    className="form-input"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocusedField('password')}
                    onBlur={() => setFocusedField(null)}
                    required
                    autoComplete="current-password"
                    disabled={loadingLogin || loadingGoogle}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loadingLogin || loadingGoogle}
              >
                {loadingLogin ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            <div className="auth-separator"><span>or</span></div>
            <GoogleAuthButton
              disabled={loadingLogin || loadingGoogle}
              pending={loadingGoogle}
              onClick={handleGoogleLogin}
            />

            <div className="auth-footer">
              Don&apos;t have an account?{' '}
              <Link to="/signup" className="auth-link">Create one</Link>
            </div>
            <nav className="auth-public-legal" aria-label="StudyCord legal links">
              <Link to="/privacy">Privacy</Link>
              <Link to="/terms">Terms</Link>
              <a href="https://github.com/Basilisk2061/StudyCord">GitHub</a>
            </nav>
          </div>
        </div>
      </div>
    </EtherealBackground>
  );
}

/* ── Inline SVG eye icons (avoids extra dependency) ── */

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
