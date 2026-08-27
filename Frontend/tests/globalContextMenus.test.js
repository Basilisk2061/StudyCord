import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const hookSource = await readFile(
  new URL('../src/hooks/useDismissableMenu.js', import.meta.url),
  'utf8',
);
const channelSidebarSource = await readFile(
  new URL('../src/components/ChannelSidebar.jsx', import.meta.url),
  'utf8',
);
const mainPanelSource = await readFile(
  new URL('../src/components/MainPanel.jsx', import.meta.url),
  'utf8',
);
const dashboardSource = await readFile(
  new URL('../src/pages/DashboardPage.jsx', import.meta.url),
  'utf8',
);

test('shared menu hook handles outside clicks, Escape, and competing menus', () => {
  assert.match(hookSource, /document\.addEventListener\('pointerdown', handlePointerDown, true\)/);
  assert.match(hookSource, /rootRef\.current\?\.contains\(event\.target\)/);
  assert.match(hookSource, /event\.key === 'Escape'/);
  assert.match(hookSource, /MENU_OPEN_EVENT/);
  assert.match(hookSource, /event\.detail\?\.menuId !== menuId/);
  assert.doesNotMatch(hookSource, /addEventListener\('click'/);
  assert.doesNotMatch(hookSource, /closest\('\[role="menuitem"\]'\)/);
});

test('server and message menus use the shared dismissable primitive', () => {
  assert.match(channelSidebarSource, /<DismissableMenu\s+className="server-header-menu"/);
  assert.match(channelSidebarSource, /onDismiss=\{\(\) => setServerMenuOpen\(false\)\}/);
  assert.match(mainPanelSource, /<DismissableMenu\s+className="message-actions"/);
  assert.match(mainPanelSource, /onDismiss=\{\(\) => setOpenMessageMenuId\(null\)\}/);
});

test('dashboard context changes dismiss every open menu', () => {
  assert.match(dashboardSource, /dismissAllMenus\(\)/);
  assert.match(
    dashboardSource,
    /\[activeServerId, activeChannelId, workspace, settingsOpen, location\.pathname\]/,
  );
});

test('existing menu actions still close their owning menu', () => {
  assert.match(channelSidebarSource, /setServerMenuOpen\(false\)/);
  assert.match(mainPanelSource, /setOpenMessageMenuId\(null\)/);
  assert.match(mainPanelSource, /role="menuitem"/);
});
