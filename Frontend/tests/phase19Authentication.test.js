import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const app = source('../src/App.jsx');
const authContext = source('../src/lib/AuthContext.jsx');
const authFlow = source('../src/lib/authFlow.js');
const login = source('../src/pages/LoginPage.jsx');
const signup = source('../src/pages/SignupPage.jsx');
const forgot = source('../src/pages/ForgotPasswordPage.jsx');
const reset = source('../src/pages/ResetPasswordPage.jsx');
const callback = source('../src/pages/AuthCallbackPage.jsx');
const dashboard = source('../src/pages/DashboardPage.jsx');
const profile = source('../src/pages/ProfilePage.jsx');
const api = source('../src/lib/api.js');

test('existing email auth, logout, session restoration, and JWT forwarding remain', () => {
  assert.match(login, /signInWithPassword/);
  assert.match(signup, /supabase\.auth\.signUp/);
  assert.match(dashboard, /supabase\.auth\.signOut/);
  assert.match(authContext, /supabase\.auth\.getSession/);
  assert.match(authContext, /supabase\.auth\.onAuthStateChange/);
  assert.match(api, /Authorization: `Bearer \$\{session\.access_token\}`/);
});

test('forgot password is login-only and uses neutral enumeration-safe recovery', () => {
  assert.match(login, /to="\/forgot-password"[^>]*>Forgot password\?/);
  assert.doesNotMatch(signup, /Forgot password\?/);
  assert.match(authFlow, /resetPasswordForEmail/);
  assert.match(authFlow, /redirectTo: getAuthRedirectUrl\('\/reset-password'\)/);
  assert.match(forgot, /If an account exists for this email/);
  assert.match(forgot, /isValidEmail\(email\)/);
  assert.match(forgot, /if \(pending\) return/);
  assert.doesNotMatch(forgot, /Account not found/i);
});

test('password recovery requires the Supabase recovery session and exits on success', () => {
  assert.match(authContext, /event === 'PASSWORD_RECOVERY'/);
  assert.match(authContext, /sessionStorage\.setItem\(RECOVERY_STORAGE_KEY/);
  assert.match(reset, /!session \|\| !recoveryMode/);
  assert.match(reset, /password !== confirmPassword/);
  assert.match(reset, /supabase\.auth\.updateUser\(\{ password \}\)/);
  assert.match(reset, /clearRecoveryMode\(\)/);
  assert.match(reset, /supabase\.auth\.signOut\(\)/);
  assert.match(app, /path="\/reset-password"/);
});

test('Google OAuth uses Supabase with a fixed safe callback route', () => {
  assert.match(authFlow, /signInWithOAuth/);
  assert.match(authFlow, /provider: 'google'/);
  assert.match(authFlow, /redirectTo: getAuthRedirectUrl\('\/auth\/callback'\)/);
  assert.match(authFlow, /VITE_AUTH_REDIRECT_ORIGIN/);
  assert.match(authFlow, /window\.location\.origin/);
  assert.match(authFlow, /Authentication redirects require HTTPS or local development/);
  assert.match(login, /beginGoogleOAuth\(\)/);
  assert.match(signup, /beginGoogleOAuth\(\)/);
  assert.match(app, /path="\/auth\/callback"/);
  assert.match(callback, /navigate\('\/dashboard', \{ replace: true \}\)/);
});

test('OAuth profile compatibility keeps auth user id authoritative and ignores provider metadata', () => {
  assert.match(dashboard, /\.insert\(\{ id: user\.id, email: user\.email, username \}\)/);
  assert.match(dashboard, /user-\$\{user\.id\.slice\(0, 8\)\}/);
  assert.match(profile, /user-\$\{user\.id\.slice\(0, 8\)\}/);
  assert.doesNotMatch(dashboard, /user_metadata|identities|provider_token/);
  assert.doesNotMatch(callback, /user_metadata|avatar_url|provider_token/);
});

test('auth pages do not render or log recovery and OAuth tokens', () => {
  const authSources = [authContext, authFlow, login, signup, forgot, reset, callback].join('\n');
  assert.doesNotMatch(authSources, /console\.(?:log|debug|error)/);
  assert.doesNotMatch(authSources, /provider_token|refresh_token/);
  assert.doesNotMatch(callback, /error_description/);
  assert.match(authContext, /history\.replaceState/);
  assert.match(callback, /history\.replaceState/);
});
