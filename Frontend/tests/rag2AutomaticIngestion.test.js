import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  isRag2CandidateFilename,
  startAutomaticRag2Ingestion,
  triggerAutomaticRag2Ingestion,
} from '../src/lib/rag2AutomaticIngestion.js';


test('PDF DOCX and TXT candidates are extension-based and case-insensitive', () => {
  for (const filename of [
    'lecture.pdf',
    'NOTES.PDF',
    'assignment.docx',
    'REPORT.DOCX',
    'outline.txt',
    'README.TXT',
  ]) {
    assert.equal(isRag2CandidateFilename(filename), true, filename);
  }
});

test('images and unsupported attachments do not trigger RAG classification', () => {
  for (const filename of [
    'diagram.png',
    'photo.jpeg',
    'slides.pptx',
    'archive.zip',
    'fakepdf.pdf.exe',
    '',
  ]) {
    assert.equal(isRag2CandidateFilename(filename), false, filename);
  }
});

test('automatic ingestion request contains attachment_id only', async () => {
  const calls = [];
  await triggerAutomaticRag2Ingestion(
    async (path, options) => {
      calls.push([path, options]);
      return { indexing_scheduled: true };
    },
    'attachment-123',
  );

  assert.equal(
    calls[0][0],
    '/api/rag2/attachments/attachment-123/ingest',
  );
  assert.deepEqual(calls[0][1], { method: 'POST' });
  assert.doesNotMatch(
    JSON.stringify(calls),
    /storage_path|storage_bucket|server_id|user_id|file_size|mime/i,
  );
});

test('registration or indexing request failure is detached from message success', async () => {
  let reported = null;
  const returned = startAutomaticRag2Ingestion(
    async () => {
      throw Object.assign(new Error('semantic failure'), { status: 500 });
    },
    'attachment-123',
    {
      onFailure: (error) => {
        reported = error.status;
      },
    },
  );

  assert.equal(returned, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reported, 500);
});

test('MainPanel triggers only after canonical attachment insertion succeeds', async () => {
  const source = await readFile(
    new URL('../src/components/MainPanel.jsx', import.meta.url),
    'utf8',
  );
  const attachmentInsert = source.indexOf(".from('message_attachments')");
  const selectedId = source.indexOf(".select('id')", attachmentInsert);
  const successCheck = source.indexOf('attachmentData?.id', selectedId);
  const trigger = source.indexOf('startAutomaticRag2Ingestion(', successCheck);

  assert.ok(attachmentInsert >= 0);
  assert.ok(selectedId > attachmentInsert);
  assert.ok(successCheck > selectedId);
  assert.ok(trigger > successCheck);
  assert.match(source, /isRag2CandidateFilename\(pendingFile\.name\)/);
  assert.match(source, /onFailure:/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE|service[_-]role/i);
});
