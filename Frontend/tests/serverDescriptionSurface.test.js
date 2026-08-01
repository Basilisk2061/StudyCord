import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('existing loaded server description is reused without another request', async () => {
  const dashboard = await readSource('../src/pages/DashboardPage.jsx');

  assert.match(dashboard, /\.from\('servers'\)[\s\S]*?\.select\('\*'\)/);
  assert.match(dashboard, /const activeServerDescription = activeServer\?\.description \|\| null/);
  assert.match(dashboard, /serverDescription=\{activeServerDescription\}/);
});

test('Server Home renders only non-empty descriptions', async () => {
  const home = await readSource('../src/components/SelectedServerHomeState.jsx');

  assert.match(home, /server\.description\.trim\(\)/);
  assert.match(home, /\{description && \(/);
  assert.match(home, /className="server-home__description"/);
  assert.doesNotMatch(home, /No description/);
});

test('sidebar description is conditional and both locations enforce truncation', async () => {
  const sidebar = await readSource('../src/components/ChannelSidebar.jsx');
  const styles = await readSource('../src/index.css');

  assert.match(sidebar, /\{visibleServerDescription && \(/);
  assert.match(sidebar, /className="channel-sidebar__description"/);
  assert.match(styles, /\.channel-sidebar__description\s*\{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/);
  assert.match(styles, /\.server-home__description\s*\{[\s\S]*?-webkit-line-clamp: 2;/);
});
