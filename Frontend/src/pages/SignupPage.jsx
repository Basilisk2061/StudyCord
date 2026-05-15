import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';

export default function SignupPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(false);
    const [loadingSignup, setLoadingSignup] = useState(false);

    const navigate = useNavigate();
    const { session, loading } = useAuth();

    // Redirect to dashboard if already logged in
    useEffect(() => {
        if (!loading && session) {
            navigate('/dashboard');
        }
    }, [session, loading, navigate]);

    const handleSignup = async (e) => {
        e.preventDefault();
        setError(null);
        setSuccess(false);

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            return;
        }

        setLoadingSignup(true);

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
        });

        if (error) {
            setError(error.message);
        } else {
            if (data.session) {
                // Auto-login is enabled and worked
                navigate('/dashboard');
            } else {
                // Email confirmation required
                setSuccess(true);
            }
        }

        setLoadingSignup(false);
    };

    if (loading) return null;

    return (
        <div className="auth-layout">
            <div className="auth-card auth-page-transition">
                <div className="auth-header">
                    <h1 className="auth-title">Create Account</h1>
                    <p className="auth-subtitle">Join StudyCord to get started</p>
                </div>

                {error && <div className="error-message">{error}</div>}
                {success && (
                    <div className="success-message">
                        Registration successful! Please check your email to confirm your account.
                    </div>
                )}

                <form onSubmit={handleSignup}>
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
                            placeholder="Create a strong password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label" htmlFor="confirmPassword">Confirm Password</label>
                        <input
                            id="confirmPassword"
                            className="form-input"
                            type="password"
                            placeholder="Confirm your password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            required
                        />
                    </div>
                    <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={loadingSignup}
                    >
                        {loadingSignup ? 'Creating account...' : 'Create Account'}
                    </button>
                </form>

                <div className="auth-footer">
                    Already have an account? <Link to="/login" className="auth-link">Sign in</Link>
                </div>
            </div>
        </div>
    );
}
