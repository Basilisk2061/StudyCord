import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  deleteOwnMessage,
  leaveServer,
  removeDeletedMessage,
} from '../src/lib/lifecycleApi.js';
import { hasServerPermission } from '../src/lib/permissions.js';


test('lifecycle API uses authenticated backend endpoints only', async () => {
  const calls = [];
  const request = async (path, options) => {
    calls.push([path, options]);
    return { success: true };
  };

  await deleteOwnMessage(request, 'message/id');
  await leaveServer(request, 'server/id');

  assert.deepEqual(calls, [
    ['/api/messages/message%2Fid', { method: 'DELETE' }],
    ['/api/servers/server%2Fid/leave', { method: 'POST' }],
  ]);
});

test('message removal preserves backend-provided order', () => {
  const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(removeDeletedMessage(messages, 'b'), [
    { id: 'a' },
    { id: 'c' },
  ]);
  assert.deepEqual(messages, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
});

test('message UI exposes deletion to authors and server managers only', async () => {
  const source = await readFile(
    new URL('../src/components/MainPanel.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /const isOwnMessage = msg\.user_id === userId/);
  assert.match(source, /const canManagePins = hasServerPermission\(currentRole, 'manage_server'\)/);
  assert.match(source, /const canModerateMessages = canManagePins/);
  assert.match(source, /const canDeleteMessage = isOwnMessage \|\| canModerateMessages/);
  assert.match(source, /\{canDeleteMessage && \(/);
  assert.match(source, /\{isOwnMessage \? 'Delete' : 'Delete Message'\}/);
  assert.match(source, /Delete message\?/);
  assert.match(source, /linked server resource, chunks, and ratings/);
  assert.match(source, /Existing personal AI study imports remain/);
  assert.match(source, /event: 'DELETE'/);
  assert.match(source, /removeDeletedMessage\(current, deletedMessageId\)/);
  assert.doesNotMatch(source, /\.from\('messages'\)\s*\.delete/);
  assert.doesNotMatch(source, /\.from\('message_attachments'\)\s*\.delete/);
});

test('member, admin, and owner deletion visibility follows existing permissions', () => {
  const canDelete = (role, isOwnMessage) => (
    isOwnMessage || hasServerPermission(role, 'manage_server')
  );

  assert.equal(canDelete('member', true), true);
  assert.equal(canDelete('member', false), false);
  assert.equal(canDelete('admin', true), true);
  assert.equal(canDelete('admin', false), true);
  assert.equal(canDelete('owner', true), true);
  assert.equal(canDelete('owner', false), true);
});

test('failed message deletion keeps the message visible', async () => {
  const source = await readFile(
    new URL('../src/components/MainPanel.jsx', import.meta.url),
    'utf8',
  );
  const requestStart = source.indexOf('await deleteOwnMessage(apiRequest, messageId)');
  const localRemoval = source.indexOf(
    'setMessages((current) => removeDeletedMessage(current, messageId))',
    requestStart,
  );
  const failure = source.indexOf('catch (error)', requestStart);
  assert.ok(requestStart >= 0);
  assert.ok(localRemoval > requestStart);
  assert.ok(failure > localRemoval);
  assert.doesNotMatch(source.slice(failure, source.indexOf('finally', failure)), /setMessages/);
});

test('leave UI blocks owners and preserves historical-content warning', async () => {
  const sidebar = await readFile(
    new URL('../src/components/ChannelSidebar.jsx', import.meta.url),
    'utf8',
  );
  const dashboard = await readFile(
    new URL('../src/pages/DashboardPage.jsx', import.meta.url),
    'utf8',
  );
  assert.match(sidebar, /disabled=\{currentRole === 'owner'\}/);
  assert.match(sidebar, /Transfer ownership or delete the server before leaving/);
  assert.match(sidebar, /historical messages,\s*resources, and ratings will remain/);
  assert.match(dashboard, /await leaveVoiceSession\?\.\(\)/);
  assert.match(dashboard, /await leaveServer\(apiRequest, activeServerId\)/);
  assert.match(dashboard, /handleServerRemoved\(activeServerId\)/);
  assert.doesNotMatch(sidebar, /\.from\('server_members'\)\s*\.delete/);
});

test('leave and delete confirmations are explicit and cancellable', async () => {
  const mainPanel = await readFile(
    new URL('../src/components/MainPanel.jsx', import.meta.url),
    'utf8',
  );
  const sidebar = await readFile(
    new URL('../src/components/ChannelSidebar.jsx', import.meta.url),
    'utf8',
  );
  assert.match(mainPanel, /aria-labelledby="delete-message-title"/);
  assert.match(sidebar, /aria-labelledby="leave-server-title"/);
  assert.match(mainPanel, />\s*Cancel\s*</);
  assert.match(sidebar, />\s*Cancel\s*</);
});
