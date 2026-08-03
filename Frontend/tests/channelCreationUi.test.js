import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { hasServerPermission } from '../src/lib/permissions.js';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('authorized users receive one collapsed Add channel action and inline creator', async () => {
  const sidebar = await readSource('../src/components/ChannelSidebar.jsx');

  assert.equal(hasServerPermission('owner', 'manage_channels'), true);
  assert.equal(hasServerPermission('admin', 'manage_channels'), true);
  assert.equal(hasServerPermission('member', 'manage_channels'), false);
  assert.match(sidebar, /!channelsLoading && canManageChannels &&/);
  assert.match(sidebar, /<span>Add channel<\/span>/);
  assert.match(sidebar, /<h3 className="channel-create-form__title">Create channel<\/h3>/);
  assert.match(sidebar, /placeholder="new-channel"/);
});

test('channel type remains a text-default segmented selector with accessible state', async () => {
  const sidebar = await readSource('../src/components/ChannelSidebar.jsx');
  const styles = await readSource('../src/index.css');

  assert.match(sidebar, /useState\('text'\)/);
  assert.match(sidebar, /aria-pressed=\{newChannelType === 'text'\}/);
  assert.match(sidebar, /aria-pressed=\{newChannelType === 'voice'\}/);
  assert.match(styles, /\.channel-type-toggle\s*\{[\s\S]*?grid-template-columns: 1fr 1fr/);
  assert.match(styles, /\.channel-type-toggle__btn--active/);
});

test('explicit Create and Cancel preserve existing submit validation and reset behavior', async () => {
  const sidebar = await readSource('../src/components/ChannelSidebar.jsx');

  assert.match(sidebar, /const r = await onCreateChannel\(name, newChannelType\)/);
  assert.match(sidebar, /disabled=\{creating \|\| !name\.trim\(\)\}/);
  assert.match(sidebar, /\{creating \? 'Creating…' : 'Create channel'\}/);
  assert.match(sidebar, /onClick=\{handleCancelCreate\}/);
  assert.match(sidebar, /event\.key === 'Escape'/);
  assert.doesNotMatch(sidebar, /channel-create-form__btn--confirm|channel-create-form__btn--cancel|'✓'|>✕</);
});

test('existing channel navigation and Advanced Search controls remain present', async () => {
  const sidebar = await readSource('../src/components/ChannelSidebar.jsx');

  assert.match(sidebar, /onSelectChannel\(channel\.id, channel\.name, channel\.type\)/);
  assert.match(sidebar, /onClick=\{onOpenAdvancedSearch\}/);
  assert.match(sidebar, /<strong>Advanced Search<\/strong>/);
});
