import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const modalSource = await readFile(
  new URL('../src/components/ServerSettingsModal.jsx', import.meta.url),
  'utf8',
);
const stylesheet = await readFile(
  new URL('../src/index.css', import.meta.url),
  'utf8',
);

test('banned users keep avatar, identity, reason, and action in explicit grid areas', () => {
  assert.match(stylesheet, /\.settings-ban\s*\{[^}]*grid-template-areas: "avatar body action";/s);
  assert.match(stylesheet, /\.settings-ban__action\s*\{[^}]*grid-area: action;/s);
  assert.match(stylesheet, /\.settings-ban__reason\s*\{[^}]*overflow-wrap: anywhere;/s);
  assert.match(stylesheet, /\.settings-ban \.settings-member__name\s*\{[^}]*overflow-wrap: anywhere;/s);
  assert.match(modalSource, /className="settings-link-btn settings-ban__action"/);
});

test('ban reason fallback and compact empty state are preserved', () => {
  assert.match(modalSource, /ban\.reason \|\| 'No reason provided'/);
  assert.match(modalSource, /No banned members/);
  assert.match(modalSource, /Everyone currently has access to this server\./);
  assert.match(stylesheet, /\.settings-bans-empty\s*\{[^}]*padding: 8px 0;/s);
});

test('narrow layouts move the existing unban action below the user without overlap', () => {
  assert.match(
    stylesheet,
    /\.settings-ban\s*\{\s*grid-template-columns: 34px minmax\(0, 1fr\);\s*grid-template-areas:\s*"avatar body"\s*"\. action";/s,
  );
  assert.match(modalSource, /onClick=\{\(\) => unban\(ban\)\}/);
  assert.match(modalSource, /disabled=\{busyKey === `unban:\$\{ban\.user_id\}`\}/);
});
