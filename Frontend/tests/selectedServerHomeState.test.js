import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { hasServerPermission } from '../src/lib/permissions.js';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('selected server home uses server identity and contains no old statistics or navigation copies', async () => {
  const home = await readSource('../src/components/SelectedServerHomeState.jsx');

  assert.match(home, /<ServerIconContents/);
  assert.match(home, /\{server\.name\}/);
  assert.match(home, /Conversations/);
  assert.match(home, /Voice & Video/);
  assert.match(home, /Shared Resources/);
  assert.match(home, /Advanced Search/);
  assert.match(home, /Choose a channel from the sidebar to begin/);
  assert.doesNotMatch(home, /servers\.map|channels\.map|members\.map|invite code/i);
});

test('MainPanel keeps global, selected-server, text-channel, and voice routing distinct', async () => {
  const main = await readSource('../src/components/MainPanel.jsx');
  const dashboard = await readSource('../src/pages/DashboardPage.jsx');

  assert.match(main, /\{hasChannel \? \(/);
  assert.match(main, /\) : activeServerId \? \([\s\S]*?<SelectedServerHomeState/);
  assert.match(main, /\) : \([\s\S]*?<NeutralHomeState/);
  assert.match(dashboard, /activeChannelType === 'voice'/);
  assert.match(dashboard, /server=\{activeServer\}/);
  assert.doesNotMatch(main, /Welcome back!|quick-stats|Quick Tips|serversCount|channelsCount/);
});

test('Create channel reuses the controlled sidebar form and existing permissions', async () => {
  const home = await readSource('../src/components/SelectedServerHomeState.jsx');
  const sidebar = await readSource('../src/components/ChannelSidebar.jsx');
  const dashboard = await readSource('../src/pages/DashboardPage.jsx');

  assert.equal(hasServerPermission('owner', 'manage_channels'), true);
  assert.equal(hasServerPermission('admin', 'manage_channels'), true);
  assert.equal(hasServerPermission('member', 'manage_channels'), false);
  assert.match(home, /canCreateChannel && onCreateChannel &&/);
  assert.match(sidebar, /const r = await onCreateChannel\(name, newChannelType\)/);
  assert.match(sidebar, /const showForm = createFormOpen \?\? localCreateFormOpen/);
  assert.match(dashboard, /onCreateChannelRequest=\{\(\) => setChannelCreateFormOpen\(true\)\}/);
  assert.match(dashboard, /onCreateFormOpenChange=\{setChannelCreateFormOpen\}/);
});
