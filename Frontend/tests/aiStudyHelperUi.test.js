import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rightPanelSource = await readFile(
  new URL('../src/components/RightPanel.jsx', import.meta.url),
  'utf8',
);

test('AI Study Helper keeps upload as the hero and removes prompt suggestions', () => {
  assert.match(rightPanelSource, /Study smarter with AI\./);
  assert.match(rightPanelSource, /className="ai-study-upload-card"/);
  assert.match(rightPanelSource, /min-height: 150px/);
  assert.match(rightPanelSource, /Upload Study Material/);
  assert.match(rightPanelSource, /PDF &bull; DOCX &bull; TXT/);

  assert.doesNotMatch(rightPanelSource, /Upload Document/);
  assert.doesNotMatch(rightPanelSource, /Turn your study materials into:/);
  assert.doesNotMatch(rightPanelSource, /Explain binary search trees/);
  assert.doesNotMatch(rightPanelSource, /Quiz me on Chapter 7/);
  assert.doesNotMatch(rightPanelSource, /Summarize sorting algorithms/);
});

test('AI Features stays compact, informational, and limited to four items', () => {
  assert.match(rightPanelSource, /AI Features/);

  for (const feature of [
    'Ask questions',
    'Summarize documents',
    'Create flashcards',
    'Generate quizzes',
  ]) {
    assert.match(rightPanelSource, new RegExp(feature));
  }

  assert.match(rightPanelSource, /AI_FEATURES\.map/);
  assert.doesNotMatch(rightPanelSource, /ai-study-capability__check/);
});

test('hero presentation preserves the existing document input flow', () => {
  assert.match(rightPanelSource, /onChange=\{handleFileChange\}/);
  assert.match(rightPanelSource, /accept="\.pdf,\.txt,\.docx"/);
  assert.match(rightPanelSource, /onClick=\{\(\) => fileInputRef\.current\?\.click\(\)\}/);
});

test('uploaded document replaces the hero with an equal-height ready card', () => {
  assert.match(rightPanelSource, /className="ai-study-document-card"/);
  assert.match(rightPanelSource, /Ready for AI/);
  assert.match(rightPanelSource, /\.ai-study-upload-card,\s*\.ai-study-document-card/);
  assert.match(rightPanelSource, /\{uploadedDoc\.filename\}/);
});

test('quick actions reuse four existing AI modes and keep history secondary', () => {
  const quickActionsStart = rightPanelSource.indexOf('Quick Study Actions');
  const historyLink = rightPanelSource.indexOf('Recent Sessions', quickActionsStart);

  assert.ok(quickActionsStart >= 0);
  assert.ok(historyLink > quickActionsStart);
  assert.match(rightPanelSource, /selectTab\('summary'\)[^>]*>Summary/);
  assert.match(rightPanelSource, /selectTab\('flashcards'\)[^>]*>Flashcards/);
  assert.match(rightPanelSource, /selectTab\('mcq'\)[^>]*>Practice Quiz/);
  assert.match(rightPanelSource, /selectTab\('chat'\)[^>]*>Ask Questions/);
  assert.doesNotMatch(rightPanelSource, />Explain Concepts<\/button>/);
  assert.match(rightPanelSource, /View History &rarr;/);
  assert.match(
    rightPanelSource,
    /className="btn btn-secondary ai-study-history-link" onClick=\{openHistory\}/,
  );
});

test('shared resources empty state uses the refined guidance', () => {
  assert.match(
    rightPanelSource,
    /Choose a server and channel to browse shared study materials\./,
  );
  assert.doesNotMatch(
    rightPanelSource,
    /Select a study server and channel to view shared resources\./,
  );
});
