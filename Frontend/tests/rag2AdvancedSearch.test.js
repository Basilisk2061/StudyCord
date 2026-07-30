import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  createServerRequestGuard,
  deleteResourceRating,
  formatSemanticScore,
  isBestMatchResult,
  putResourceRating,
  ratingErrorMessage,
  replaceRatingSummary,
  searchErrorMessage,
  searchServerResources,
} from '../src/lib/rag2Api.js';


test('resource search uses the current server endpoint and no scope fields in body', async () => {
  const calls = [];
  const expectedResults = [
    { resource_id: 'resource-b' },
    { resource_id: 'resource-a' },
  ];
  const request = async (path, options) => {
    calls.push([path, options]);
    return { results: expectedResults };
  };

  const response = await searchServerResources(
    request,
    'server-123',
    '  nearest neighbours  ',
  );

  assert.equal(
    calls[0][0],
    '/api/rag2/servers/server-123/resources/search',
  );
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    query: 'nearest neighbours',
    limit: 5,
  });
  assert.equal(calls[0][1].method, 'POST');
  assert.strictEqual(response.results, expectedResults);
  assert.deepEqual(
    response.results.map((result) => result.resource_id),
    ['resource-b', 'resource-a'],
  );
  assert.equal('server_id' in JSON.parse(calls[0][1].body), false);
  assert.equal('channel_id' in JSON.parse(calls[0][1].body), false);
});

test('blank search is prevented before the API request', async () => {
  let called = false;
  await assert.rejects(
    searchServerResources(
      async () => {
        called = true;
      },
      'server-123',
      '   ',
    ),
    /search query/i,
  );
  assert.equal(called, false);
});

test('semantic score uses at most three decimals and never a percentage', () => {
  assert.equal(formatSemanticScore(0.87061), '0.871');
  assert.equal(formatSemanticScore(0.8), '0.8');
  assert.equal(formatSemanticScore(Number.NaN), '—');
  assert.equal(formatSemanticScore(0.87061).includes('%'), false);
});

test('only the first backend-ordered result is marked as Best match', () => {
  const results = [
    { resource_id: 'resource-first', average_rating: 1 },
    { resource_id: 'resource-second', average_rating: 5 },
    { resource_id: 'resource-third', average_rating: null },
  ];
  assert.deepEqual(
    results.map((resource, index) => ({
      resource_id: resource.resource_id,
      bestMatch: isBestMatchResult(index),
    })),
    [
      { resource_id: 'resource-first', bestMatch: true },
      { resource_id: 'resource-second', bestMatch: false },
      { resource_id: 'resource-third', bestMatch: false },
    ],
  );
  assert.deepEqual([].map((_, index) => isBestMatchResult(index)), []);
});

test('rating PUT and DELETE use authenticated backend endpoint wrappers', async () => {
  const calls = [];
  const request = async (path, options) => {
    calls.push([path, options]);
    return { resource_id: 'resource-1' };
  };
  await putResourceRating(request, 'resource-1', 4);
  await deleteResourceRating(request, 'resource-1');

  assert.equal(calls[0][0], '/api/rag2/resources/resource-1/rating');
  assert.equal(calls[0][1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0][1].body), { rating: 4 });
  assert.equal(calls[1][0], '/api/rag2/resources/resource-1/rating');
  assert.equal(calls[1][1].method, 'DELETE');
});

test('rating summary updates only one card and preserves result order', () => {
  const results = [
    { resource_id: 'resource-b', title: 'B', average_rating: 2 },
    { resource_id: 'resource-a', title: 'A', average_rating: 5 },
  ];
  const updated = replaceRatingSummary(results, 'resource-b', {
    average_rating: 4.5,
    rating_count: 2,
    current_user_rating: 4,
  });

  assert.deepEqual(
    updated.map((result) => result.resource_id),
    ['resource-b', 'resource-a'],
  );
  assert.equal(updated[0].average_rating, 4.5);
  assert.strictEqual(updated[1], results[1]);
});

test('failed rating request leaves prior results untouched', async () => {
  const results = [
    { resource_id: 'resource-1', average_rating: 3, rating_count: 1 },
  ];
  await assert.rejects(
    putResourceRating(
      async () => {
        throw Object.assign(new Error('failed'), { status: 500 });
      },
      'resource-1',
      5,
    ),
  );
  assert.deepEqual(results, [
    { resource_id: 'resource-1', average_rating: 3, rating_count: 1 },
  ]);
});

test('server switch and newer requests invalidate stale responses', () => {
  const guard = createServerRequestGuard('server-a');
  const first = guard.begin('server-a');
  assert.equal(guard.isCurrent(first, 'server-a'), true);

  const second = guard.begin('server-a');
  assert.equal(guard.isCurrent(first, 'server-a'), false);
  assert.equal(guard.isCurrent(second, 'server-a'), true);

  guard.switchServer('server-b');
  assert.equal(guard.isCurrent(second, 'server-b'), false);
  const third = guard.begin('server-b');
  assert.equal(guard.isCurrent(third, 'server-b'), true);
});

test('search and rating errors map to safe status-specific messages', () => {
  assert.match(searchErrorMessage({ status: 401 }), /session expired/i);
  assert.match(searchErrorMessage({ status: 403 }), /access/i);
  assert.match(searchErrorMessage({ status: 422 }), /query/i);
  assert.match(searchErrorMessage({ status: 502 }), /temporarily unavailable/i);
  assert.match(searchErrorMessage({ status: 500 }), /try again/i);
  assert.match(ratingErrorMessage({ status: 403 }), /no longer available/i);
  assert.match(ratingErrorMessage({ status: 422 }), /1 to 5/i);
  assert.match(ratingErrorMessage({ status: 500 }), /try again/i);
});

test('workspace is keyed by server and UI contains no direct Supabase rating path', async () => {
  const dashboard = await readFile(
    new URL('../src/pages/DashboardPage.jsx', import.meta.url),
    'utf8',
  );
  const panel = await readFile(
    new URL('../src/components/AdvancedSearchPanel.jsx', import.meta.url),
    'utf8',
  );
  const card = await readFile(
    new URL('../src/components/ResourceSearchCard.jsx', import.meta.url),
    'utf8',
  );

  assert.match(dashboard, /key=\{activeServerId\}/);
  assert.match(dashboard, /workspace === 'advanced-search'/);
  assert.doesNotMatch(panel, /supabase_admin|service[_-]role/i);
  assert.doesNotMatch(panel, /\.rpc\(|resource_ratings/);
  assert.doesNotMatch(card, /storage_path|storage_bucket|uploader_id|embedding/);
  assert.doesNotMatch(card, /file_url|download|open original/i);
});
