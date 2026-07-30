import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  applyChannelRatingSummary,
  fetchChannelResourceMetadata,
  indexChannelResourceMetadata,
} from '../src/lib/channelResourceApi.js';


test('channel resource metadata is fetched once per bounded visible batch', async () => {
  const calls = [];
  const rows = await fetchChannelResourceMetadata(
    async (path, options) => {
      calls.push([path, options]);
      return [{ resource_id: 'resource-a' }];
    },
    'server-1',
    ['resource-a', 'resource-b', 'resource-a'],
  );
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0],
    '/api/rag2/servers/server-1/resources/channel-metadata',
  );
  assert.deepEqual(
    JSON.parse(calls[0][1].body),
    { resource_ids: ['resource-a', 'resource-b'] },
  );
  assert.doesNotMatch(JSON.stringify(calls), /storage_path|storage_bucket/);
});

test('null and historical resource lists make no metadata request', async () => {
  let calls = 0;
  const rows = await fetchChannelResourceMetadata(
    async () => {
      calls += 1;
      return [];
    },
    'server-1',
    [],
  );
  assert.deepEqual(rows, []);
  assert.equal(calls, 0);
});

test('authoritative rating summary updates only its channel resource', () => {
  const original = indexChannelResourceMetadata([
    {
      resource_id: 'resource-a',
      average_rating: 4,
      rating_count: 1,
      current_user_rating: 4,
    },
    {
      resource_id: 'resource-b',
      average_rating: 5,
      rating_count: 2,
      current_user_rating: null,
    },
  ]);
  const updated = applyChannelRatingSummary(original, {
    resource_id: 'resource-a',
    average_rating: 4.5,
    rating_count: 2,
    current_user_rating: 5,
  });
  assert.equal(updated['resource-a'].average_rating, 4.5);
  assert.strictEqual(updated['resource-b'], original['resource-b']);
  assert.equal(original['resource-a'].average_rating, 4);
});

test('channel cards gate resource controls on ready metadata and preserve download', async () => {
  const source = await readFile(
    new URL('../src/components/MessageAttachment.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /resourceMetadata &&/);
  assert.match(source, /Open resource/);
  assert.match(source, /average_rating/);
  assert.match(source, /Not rated yet/);
  assert.match(source, /href=\{file_url\}/);
  assert.doesNotMatch(source, /StarRating|onRate|onClearRating/);
  assert.doesNotMatch(source, /register|ingest|storage_path|storage_bucket/);
});

test('channel and Advanced Search use one shared resource workspace', async () => {
  const dashboard = await readFile(
    new URL('../src/pages/DashboardPage.jsx', import.meta.url),
    'utf8',
  );
  const advanced = await readFile(
    new URL('../src/components/AdvancedSearchPanel.jsx', import.meta.url),
    'utf8',
  );
  const workspace = await readFile(
    new URL('../src/components/ResourceWorkspacePanel.jsx', import.meta.url),
    'utf8',
  );
  assert.match(dashboard, /<ResourceWorkspacePanel/);
  assert.match(advanced, /<ResourceWorkspacePanel/);
  assert.match(workspace, /<ResourceAccessWorkspace/);
  assert.match(dashboard, /Back to #\$\{activeChannelName/);
  assert.match(dashboard, /dashboard-preserved-channel--hidden/);
  assert.match(dashboard, /handleBackToChannel/);
});

test('rating failures do not publish channel aggregate updates', async () => {
  const workspace = await readFile(
    new URL('../src/components/ResourceAccessWorkspace.jsx', import.meta.url),
    'utf8',
  );
  const success = workspace.indexOf('onRatingSummary(summary)');
  const failure = workspace.indexOf('catch (error)');
  assert.ok(success >= 0);
  assert.ok(failure > success);
  const catchBlock = workspace.slice(failure);
  assert.doesNotMatch(catchBlock, /onRatingSummary/);
});

test('channel integration does not affect ranking or RAG 1', async () => {
  const helper = await readFile(
    new URL('../src/lib/channelResourceApi.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(helper, /sort\(|relevance|ranking|rag1/i);
});
