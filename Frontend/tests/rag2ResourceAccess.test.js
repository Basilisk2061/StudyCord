import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  accessResourceFile,
  deleteResourceRating,
  putResourceRating,
  replaceRatingSummary,
  resourceAccessErrorMessage,
} from '../src/lib/rag2Api.js';


test('resource access sends only resource_id to the authenticated backend route', async () => {
  const calls = [];
  const expectedBlob = new Blob(['original']);
  const response = await accessResourceFile(
    async (path, options) => {
      calls.push([path, options]);
      return expectedBlob;
    },
    'resource-123',
  );

  assert.strictEqual(response, expectedBlob);
  assert.equal(calls[0][0], '/api/rag2/resources/resource-123/access');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal('body' in calls[0][1], false);
  assert.doesNotMatch(JSON.stringify(calls), /storage_bucket|storage_path|server_id/);
});

test('resource access errors are safe and membership-aware', () => {
  assert.match(resourceAccessErrorMessage({ status: 401 }), /session expired/i);
  assert.match(resourceAccessErrorMessage({ status: 403 }), /no longer have access/i);
  assert.match(resourceAccessErrorMessage({ status: 404 }), /no longer have access/i);
  assert.match(resourceAccessErrorMessage({ status: 422 }), /invalid/i);
  assert.equal(
    resourceAccessErrorMessage({
      status: 500,
      message: 'storage bucket secret',
    }),
    'Unable to open this resource.',
  );
});

test('search cards expose aggregate rating and Open resource without rating controls', async () => {
  const card = await readFile(
    new URL('../src/components/ResourceSearchCard.jsx', import.meta.url),
    'utf8',
  );
  const panel = await readFile(
    new URL('../src/components/AdvancedSearchPanel.jsx', import.meta.url),
    'utf8',
  );
  assert.match(card, /Open resource/);
  assert.match(card, /average_rating/);
  assert.match(card, /Not rated yet/);
  assert.match(card, /isBestMatch/);
  assert.match(card, />Best match</);
  assert.doesNotMatch(card, /StarRating|onRate|onClearRating/);
  assert.doesNotMatch(card, /Semantic score|formatSemanticScore|relevance_score/);
  assert.doesNotMatch(card, /% relevant|% match|% confidence/i);
  assert.doesNotMatch(card, /storage_bucket|storage_path|file_url|signed/i);
  assert.match(panel, /results\.map\(\(resource, index\)/);
  assert.match(panel, /isBestMatch=\{isBestMatchResult\(index\)\}/);
  assert.match(panel, /Results are ordered by semantic relevance\./);
  assert.doesNotMatch(panel, /Scores are relative ranking values/);
});

test('resource workspace preserves the mounted search state and clears on server switch', async () => {
  const dashboard = await readFile(
    new URL('../src/pages/DashboardPage.jsx', import.meta.url),
    'utf8',
  );
  const panel = await readFile(
    new URL('../src/components/AdvancedSearchPanel.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    dashboard,
    /workspace === 'advanced-search' \|\| workspace === 'resource'/,
  );
  assert.match(dashboard, /key=\{activeServerId\}/);
  assert.match(dashboard, /onBackToSearch=\{\(\) => setWorkspace\('advanced-search'\)\}/);
  assert.match(panel, /const \[query, setQuery\]/);
  assert.match(panel, /const \[results, setResults\]/);
  assert.match(panel, /openedResourceId/);
});

test('post-access rating uses backend endpoints and updates one preserved result', async () => {
  const calls = [];
  const request = async (path, options) => {
    calls.push([path, options]);
    return {
      resource_id: 'resource-a',
      average_rating: 4.5,
      rating_count: 2,
      current_user_rating: options.method === 'DELETE' ? null : 5,
    };
  };
  const initial = [
    { resource_id: 'resource-b', average_rating: 3, rating_count: 1 },
    { resource_id: 'resource-a', average_rating: 4, rating_count: 1 },
  ];

  const summary = await putResourceRating(request, 'resource-a', 5);
  const updated = replaceRatingSummary(initial, 'resource-a', summary);
  await deleteResourceRating(request, 'resource-a');

  assert.deepEqual(
    updated.map((resource) => resource.resource_id),
    ['resource-b', 'resource-a'],
  );
  assert.strictEqual(updated[0], initial[0]);
  assert.equal(updated[1].current_user_rating, 5);
  assert.equal(calls[0][1].method, 'PUT');
  assert.equal(calls[1][1].method, 'DELETE');
});

test('resource access frontend has no direct Storage, indexing, registration, or service role path', async () => {
  const accessPanel = await readFile(
    new URL('../src/components/ResourceAccessPanel.jsx', import.meta.url),
    'utf8',
  );
  const apiHelpers = await readFile(
    new URL('../src/lib/rag2Api.js', import.meta.url),
    'utf8',
  );
  const combined = `${accessPanel}\n${apiHelpers}`;

  assert.doesNotMatch(combined, /supabase\.storage|storage_bucket|storage_path/);
  assert.doesNotMatch(combined, /service[_-]role|signedUrl|createSignedUrl/i);
  assert.doesNotMatch(combined, /register_server_resource|index_authorized_resource|embedding/i);
  assert.match(accessPanel, /StarRating/);
});
