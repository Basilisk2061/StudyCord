import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  handoffResourceToRag1,
  rag1HandoffErrorMessage,
} from '../src/lib/rag2Api.js';


test('handoff sends only the canonical resource id to one authenticated endpoint', async () => {
  const calls = [];
  const response = await handoffResourceToRag1(
    async (path, options) => {
      calls.push([path, options]);
      return {
        doc_id: 'doc-1',
        session_id: 'session-1',
        reused: false,
      };
    },
    'resource-1',
  );
  assert.equal(response.doc_id, 'doc-1');
  assert.deepEqual(calls, [[
    '/api/rag1/imports/rag2/resource-1',
    { method: 'POST', signal: undefined },
  ]]);
  assert.doesNotMatch(
    JSON.stringify(calls),
    /server_id|storage|bucket|path|mime|uploader|service.role/i,
  );
});

test('handoff errors are safe and retry-oriented', () => {
  assert.match(rag1HandoffErrorMessage({ status: 401 }), /session expired/i);
  assert.match(rag1HandoffErrorMessage({ status: 403 }), /no longer have access/i);
  assert.match(rag1HandoffErrorMessage({ status: 404 }), /no longer have access/i);
  assert.match(rag1HandoffErrorMessage({ status: 409 }), /already being added/i);
  assert.match(rag1HandoffErrorMessage({ status: 502 }), /processing/i);
  assert.match(rag1HandoffErrorMessage({ status: 503 }), /temporarily unavailable/i);
  assert.doesNotMatch(
    rag1HandoffErrorMessage({
      status: 500,
      message: 'service role storage path secret',
    }),
    /service|storage|secret/i,
  );
});

test('Use in RAG 1 appears only inside the successful shared resource viewer', async () => {
  const panel = await readFile(
    new URL('../src/components/ResourceAccessPanel.jsx', import.meta.url),
    'utf8',
  );
  const workspace = await readFile(
    new URL('../src/components/ResourceAccessWorkspace.jsx', import.meta.url),
    'utf8',
  );
  assert.match(panel, /Use in RAG 1/);
  assert.match(panel, /Adding to RAG 1\.\.\./);
  assert.match(panel, /!accessState\.loading && !accessState\.error && accessState\.objectUrl/);
  assert.match(panel, /disabled=\{handoffPending\}/);
  assert.match(workspace, /handoffResourceToRag1/);
  assert.match(workspace, /onRag1Activated\(activation\)/);
});

test('channel and Advanced Search pass through the same shared handoff callback', async () => {
  const dashboard = await readFile(
    new URL('../src/pages/DashboardPage.jsx', import.meta.url),
    'utf8',
  );
  const advanced = await readFile(
    new URL('../src/components/AdvancedSearchPanel.jsx', import.meta.url),
    'utf8',
  );
  const shared = await readFile(
    new URL('../src/components/ResourceWorkspacePanel.jsx', import.meta.url),
    'utf8',
  );
  assert.match(dashboard, /onRag1Activated=\{handleRag1Activated\}/g);
  assert.match(advanced, /onRag1Activated=\{onRag1Activated\}/);
  assert.match(shared, /<ResourceAccessWorkspace/);
  assert.match(shared, /onRag1Activated=\{onRag1Activated\}/);
  assert.doesNotMatch(
    await readFile(
      new URL('../src/components/MessageAttachment.jsx', import.meta.url),
      'utf8',
    ),
    /Use in RAG 1|handoffResourceToRag1/,
  );
});

test('successful handoff activates existing RightPanel session restoration in Chat', async () => {
  const dashboard = await readFile(
    new URL('../src/pages/DashboardPage.jsx', import.meta.url),
    'utf8',
  );
  const rightPanel = await readFile(
    new URL('../src/components/RightPanel.jsx', import.meta.url),
    'utf8',
  );
  assert.match(dashboard, /rag1ActivationRequest=\{rag1ActivationRequest\}/);
  assert.match(rightPanel, /rag1ActivationRequest\?\.session_id/);
  assert.match(rightPanel, /activateRag1Session\(sessionId\)/);
  assert.match(rightPanel, /openChat: true/);
  assert.match(rightPanel, /expandWorkspace: true/);
  assert.match(rightPanel, /setActiveTab\('chat'\)/);
  assert.match(rightPanel, /apiRequest\(`\/api\/rag\/sessions\/\$\{sessionId\}`\)/);
});

test('handoff does not alter search ranking, ratings, or multi-document behavior', async () => {
  const helper = await readFile(
    new URL('../src/lib/rag2Api.js', import.meta.url),
    'utf8',
  );
  const workspace = await readFile(
    new URL('../src/components/ResourceAccessWorkspace.jsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    workspace,
    /relevance_score|candidate|HNSW|selectedResources|document_ids/,
  );
  assert.match(helper, /replaceRatingSummary/);
  assert.match(helper, /searchServerResources/);
});
