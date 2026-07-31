/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { RECOVERY_STORAGE_KEY } from './authFlow';

const AuthContext = createContext({});

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);

  const clearRecoveryMode = useCallback(() => {
    sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
    setRecoveryMode(false);
  }, []);

  useEffect(() => {
    // 1. Get current session on load
    const initializeAuth = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;
        setSession(session);
        setRecoveryMode(Boolean(session && sessionStorage.getItem(RECOVERY_STORAGE_KEY)));
        if (!session) sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
      } catch {
        setSession(null);
        setRecoveryMode(false);
        sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
      } finally {
        setLoading(false);
      }
    };

    initializeAuth();

    // 2. Listen for auth changes (login, logout, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        sessionStorage.setItem(RECOVERY_STORAGE_KEY, 'active');
        setRecoveryMode(true);
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (event === 'SIGNED_OUT') {
        sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
        setRecoveryMode(false);
      }
      setSession(session);
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ session, loading, recoveryMode, clearRecoveryMode }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  return useContext(AuthContext);
};
