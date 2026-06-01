import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import EtherealBackground from '../components/EtherealBackground';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loadingLogin, setLoadingLogin] = useState(false);
  
  const navigate = useNavigate();
  const { session, loading } = useAuth();

  // Redirect to dashboard if already logged in
  useEffect(() => {
    if (!loading && session) {
      navigate('/dashboard');
    }
  }, [session, loading, navigate]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null);
    setLoadingLogin(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
    } else {
      navigate('/dashboard');
    }
    
    setLoadingLogin(false);
  };

  if (loading) return null; // Avoid flicker

  return (
    <EtherealBackground>
      <div className="auth-split">
        {/* Branding Panel */}
        <div className="auth-brand auth-page-transition">
          <div className="auth-brand__logo">Study<span className="auth-brand__logo-accent">Cord</span></div>
          <p className="auth-brand__tagline">Where study groups stay connected, organized, and focused.</p>
          
          <ul className="auth-brand__features">
            <li className="auth-brand__feature">
              <div className="auth-brand__feature-icon">✦</div>
              <div className="auth-brand__feature-text">
                <h4>Dedicated Channels</h4>
                <p>Organize your courses and study materials cleanly.</p>
              </div>
            </li>
            <li className="auth-brand__feature">
              <div className="auth-brand__feature-icon">⚡</div>
              <div className="auth-brand__feature-text">
                <h4>Real-time Collaboration</h4>
                <p>Stay in sync with your study partners instantly.</p>
              </div>
            </li>
            <li className="auth-brand__feature">
              <div className="auth-brand__feature-icon">🎯</div>
              <div className="auth-brand__feature-text">
                <h4>Focus Driven</h4>
                <p>A distraction-free environment for deep work.</p>
              </div>
            </li>
          </ul>
        </div>

        {/* Form Panel */}
        <div className="auth-form-panel">
          <div className="auth-card auth-page-transition">
            <div className="auth-header">
              <h1 className="auth-title">Welcome back</h1>
              <p className="auth-subtitle">Sign in to your StudyCord account</p>
            </div>

            {error && <div className="error-message">{error}</div>}

            <form onSubmit={handleLogin}>
              <div className="form-group">
                <label className="form-label" htmlFor="email">Email Address</label>
                <input
                  id="email"
                  className="form-input"
                  type="email"
                  placeholder="you@university.edu"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="password">Password</label>
                <input
                  id="password"
                  className="form-input"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <button 
                type="submit" 
                className="btn btn-primary" 
                disabled={loadingLogin}
              >
                {loadingLogin ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            <div className="auth-footer">
              Don't have an account? <Link to="/signup" className="auth-link">Create one</Link>
            </div>
          </div>
        </div>
      </div>
    </EtherealBackground>
  );
}
