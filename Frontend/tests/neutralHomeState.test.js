import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('neutral home shows the approved capabilities without duplicating navigation', async () => {
  const home = await readSource('../src/components/NeutralHomeState.jsx');

  assert.match(home, /Welcome back, \{username\}/);
  assert.match(home, /Chat & Collaborate/);
  assert.match(home, /Share Resources/);
  assert.match(home, /Search Smarter/);
  assert.match(home, /Study with AI/);
  assert.match(home, /Select a server/);
  assert.match(home, /Choose a channel/);
  assert.doesNotMatch(home, /servers\.map|channels\.map|Quick Tips|quick-stats/);
});

test('neutral home reuses the existing sidebar Create and Join modals', async () => {
  const dashboard = await readSource('../src/pages/DashboardPage.jsx');
  const sidebar = await readSource('../src/components/ServerSidebar.jsx');
  const main = await readSource('../src/components/MainPanel.jsx');

  assert.match(main, /\) : activeServerId \? \(/);
  assert.match(main, /<NeutralHomeState[\s\S]*?onCreateServer=\{onCreateServerRequest\}/);
  assert.match(main, /onJoinServer=\{onJoinServerRequest\}/);
  assert.match(dashboard, /onCreateServerRequest=\{\(\) => setServerActionModal\('create'\)\}/);
  assert.match(dashboard, /onJoinServerRequest=\{\(\) => setServerActionModal\('join'\)\}/);
  assert.match(sidebar, /\{showCreateModal && \(/);
  assert.match(sidebar, /\{showJoinModal && \(/);
  assert.match(sidebar, /const result = await onCreateServer\(newServerName\)/);
  assert.match(sidebar, /const result = await onJoinServer\(inviteCode\)/);
});
