import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const apiSource = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
const voiceSource = readFileSync(
  new URL('../src/hooks/useVoiceSession.js', import.meta.url),
  'utf8',
);
const viteSource = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
const backendSource = readFileSync(
  new URL('../../Backend/main.py', import.meta.url),
  'utf8',
);

test('FastAPI calls default to the same-origin Vite proxy', () => {
  assert.match(apiSource, /VITE_API_BASE_URL \|\| ''/);
  assert.doesNotMatch(apiSource, /127\.0\.0\.1:8000/);
  assert.match(viteSource, /['"]\/api['"]/);
  assert.match(viteSource, /http:\/\/127\.0\.0\.1:8000/);
});

test('TURN uses the authenticated shared API client without logging credentials', () => {
  assert.match(voiceSource, /apiRequest\('\/api\/turn-credentials'\)/);
  assert.doesNotMatch(voiceSource, /fetch\(['"]http:\/\/127\.0\.0\.1:8000/);
  assert.doesNotMatch(
    voiceSource,
    /TURN credentials fetched successfully:',\s*data/,
  );
  assert.match(
    backendSource,
    /get_turn_credentials\(\s*_current_user: dict = Depends\(get_current_user\)/,
  );
});

test('Vite supports optional certificate files and a configurable backend target', () => {
  assert.match(viteSource, /STUDYCORD_HTTPS_CERT_FILE/);
  assert.match(viteSource, /STUDYCORD_HTTPS_KEY_FILE/);
  assert.match(viteSource, /STUDYCORD_BACKEND_PROXY_TARGET/);
  assert.match(viteSource, /readFileSync/);
});

test('CORS remains limited to localhost and HTTPS private-LAN presentation origins', () => {
  assert.doesNotMatch(backendSource, /allow_origins=\s*\[\s*["']\*["']/);
  assert.match(backendSource, /allow_origin_regex/);
  assert.match(backendSource, /192\\\.168/);
  assert.match(backendSource, /172\\\./);
});
