import { supabase } from './supabase';

export const RECOVERY_STORAGE_KEY = 'studycord.password-recovery';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

export function getAuthRedirectUrl(pathname) {
  const configuredOrigin = import.meta.env.VITE_AUTH_REDIRECT_ORIGIN?.trim();
  const origin = new URL(configuredOrigin || window.location.origin).origin;
  const parsedOrigin = new URL(origin);
  const isLocalHttp = parsedOrigin.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname);

  if (parsedOrigin.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Authentication redirects require HTTPS or local development.');
  }

  return new URL(pathname, `${origin}/`).toString();
}

export async function requestPasswordReset(email) {
  return supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
    redirectTo: getAuthRedirectUrl('/reset-password'),
  });
}

export async function beginGoogleOAuth() {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: getAuthRedirectUrl('/auth/callback'),
    },
  });
}
