import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

export default function ProtectedRoute({ children }) {
  const { session, loading, recoveryMode } = useAuth();

  if (loading) {
    return (
      <div className="auth-layout">
        <p>Loading session...</p>
      </div>
    );
  }

  // If there is no session, redirect to login page
  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (recoveryMode) {
    return <Navigate to="/reset-password" replace />;
  }

  // Otherwise, render the protected component
  return children;
}
