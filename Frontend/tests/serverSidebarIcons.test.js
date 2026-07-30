import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';


test('Join Server uses a person-plus icon without changing its flow', async () => {
  const source = await readFile(
    new URL('../src/components/ServerSidebar.jsx', import.meta.url),
    'utf8',
  );
  const joinStart = source.indexOf('title="Join Server"');
  const joinEnd = source.indexOf('</div>', joinStart);
  const joinControl = source.slice(joinStart, joinEnd);

  assert.ok(joinStart >= 0);
  assert.match(joinControl, /aria-label="Join Server"/);
  assert.match(joinControl, /<circle cx="9" cy="7" r="4"/);
  assert.match(joinControl, /x1="19" y1="8" x2="19" y2="14"/);
  assert.match(joinControl, /x1="22" y1="11" x2="16" y2="11"/);
  assert.match(joinControl, /onClick=\{\(\) => setShowJoinModal\(true\)\}/);
  assert.doesNotMatch(joinControl, /M15 3h4|polyline points="10 17 15 12 10 7"/);
});

test('Create Server keeps its standalone plus and logout stays unchanged', async () => {
  const sidebar = await readFile(
    new URL('../src/components/ServerSidebar.jsx', import.meta.url),
    'utf8',
  );
  const mainPanel = await readFile(
    new URL('../src/components/MainPanel.jsx', import.meta.url),
    'utf8',
  );

  assert.match(sidebar, /title="Create Server"[\s\S]*?<line x1="12" y1="5" x2="12" y2="19"/);
  assert.match(mainPanel, /id="logout-button"[\s\S]*?<path d="M9 21H5a2 2 0 0 1-2-2V5/);
  assert.match(mainPanel, />Log out<\/span>/);
});
