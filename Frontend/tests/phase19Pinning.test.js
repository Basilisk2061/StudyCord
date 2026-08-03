import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  fetchChannelPins,
  indexPinsByMessage,
  pinMessage,
  unpinMessage,
} from '../src/lib/pinningApi.js';


test('pinning API uses authenticated backend endpoints and preserves result order', async () => {
  const calls = [];
  const pins = [{ message_id: 'b' }, { message_id: 'a' }];
  const request = async (path, options) => {
    calls.push([path, options]);
    return path.includes('/channels/') ? pins : { success: true };
  };

  assert.equal(await fetchChannelPins(request, 'channel/id'), pins);
  await pinMessage(request, 'message/id');
  await unpinMessage(request, 'message/id');

  assert.deepEqual(calls, [
    ['/api/channels/channel%2Fid/pins', { method: 'GET' }],
    ['/api/messages/message%2Fid/pin', { method: 'POST' }],
    ['/api/messages/message%2Fid/pin', { method: 'DELETE' }],
  ]);
  assert.deepEqual(indexPinsByMessage(pins), {
    b: pins[0],
    a: pins[1],
  });
  assert.deepEqual(pins, [{ message_id: 'b' }, { message_id: 'a' }]);
});

test('message menu, indicators, and realtime follow role and channel scope', async () => {
  const source = await readFile(
    new URL('../src/components/MainPanel.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /hasServerPermission\(currentRole, 'manage_server'\)/);
  assert.match(source, /const hasMessageActions = canDeleteMessage \|\| canManagePins/);
  assert.match(source, /\{hasMessageActions && \(/);
  assert.match(source, /\{canManagePins && \(/);
  assert.match(source, /\{canDeleteMessage && \(/);
  assert.match(source, /isPinned \? 'Unpin message' : 'Pin message'/);
  assert.match(source, />\s*Pinned\s*</);
  assert.match(source, /table: 'pinned_messages'/);
  assert.match(source, /filter: `channel_id=eq\.\$\{channelId\}`/);
  assert.match(source, /event: '\*'/);
  assert.match(source, /setPinnedMessages\(\(current\) =>\s*current\.filter/);
});

test('pinned panel retains attachments, jump, manager unpin, and empty state', async () => {
  const source = await readFile(
    new URL('../src/components/PinnedMessagesPanel.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /Pinned Messages/);
  assert.match(source, /No pinned messages yet\./);
  assert.match(source, /<MessageAttachment/);
  assert.match(source, /onOpenResource=\{onOpenResource\}/);
  assert.match(source, /Jump to message/);
  assert.match(source, /\{canManagePins && \(/);
  assert.match(source, /Pinned \{formatTimestamp\(pin\.pinned_at\)\}/);
});

test('header exposes a text-labelled pinned messages action without changing storage or RAG', async () => {
  const main = await readFile(
    new URL('../src/components/MainPanel.jsx', import.meta.url),
    'utf8',
  );
  const api = await readFile(
    new URL('../src/lib/pinningApi.js', import.meta.url),
    'utf8',
  );
  assert.match(main, /aria-label="Pinned Messages"/);
  assert.match(main, /title="Pinned Messages"/);
  assert.match(main, /<PinnedMessagesPanel/);
  assert.doesNotMatch(api, /supabase|storage|rag1|rag2|resource_chunks/i);
});
