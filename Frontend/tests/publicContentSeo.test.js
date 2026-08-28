import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../src/App.jsx');
const login = read('../src/pages/LoginPage.jsx');
const layout = read('../src/components/PublicLayout.jsx');
const seo = read('../src/components/Seo.jsx');
const sitemap = read('../public/sitemap.xml');
const llms = read('../public/llms.txt');

const publicRoutes = ['/features', '/about', '/technology', '/faq', '/privacy', '/terms'];

test('all requested public routes are registered and internally linked', () => {
  for (const route of publicRoutes) {
    assert.match(app, new RegExp(`path="${route}"`));
    assert.ok(
      login.includes(`to="${route}"`) || layout.includes(`to="${route}"`),
      `${route} must be linked from the public navigation`,
    );
  }
});

test('public pages use one shared canonical metadata implementation', () => {
  assert.match(seo, /document\.title = title/);
  assert.match(seo, /link\[rel="canonical"\]/);
  assert.match(seo, /meta\[property="og:title"\]/);
  assert.match(seo, /meta\[name="twitter:title"\]/);
  assert.match(seo, /studycord-page-schema/);

  const pageFiles = [
    '../src/pages/AboutPage.jsx',
    '../src/pages/FeaturesPage.jsx',
    '../src/pages/TechnologyPage.jsx',
    '../src/pages/FaqPage.jsx',
    '../src/pages/PrivacyPage.jsx',
    '../src/pages/TermsPage.jsx',
  ];
  const titles = pageFiles.map((path) => read(path).match(/title: '([^']+)'/)?.[1]);
  const descriptions = pageFiles.map((path) => read(path).match(/description: '([^']+)'/)?.[1]);
  assert.equal(new Set(titles).size, pageFiles.length);
  assert.equal(new Set(descriptions).size, pageFiles.length);
});

test('sitemap contains canonical public pages and excludes auth or private routes', () => {
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations, [
    'https://www.studycord.me/',
    ...publicRoutes.map((route) => `https://www.studycord.me${route}`),
  ]);
  for (const privatePath of ['/login', '/signup', '/forgot-password', '/reset-password', '/auth/callback', '/dashboard', '/profile']) {
    assert.ok(!sitemap.includes(privatePath));
  }
});

test('homepage copy identifies StudyCord and its implemented capabilities', () => {
  assert.match(login, /AI-powered student collaboration/);
  assert.match(login, /real-time messaging/);
  assert.match(login, /document sharing/);
  assert.match(login, /voice, and video calls/);
  assert.match(login, /semantic document search/);
  assert.match(login, /RAG-powered AI Study Assistant/);
  assert.match(login, /students, study groups, and educators/);
});

test('AI crawler summary identifies sources and keeps personal AI separate from search', () => {
  assert.match(llms, /## Official Website[\s\S]*https:\/\/www\.studycord\.me\//);
  assert.match(llms, /## AI Study Assistant/);
  assert.match(llms, /## Semantic Document Search/);
  assert.match(llms, /Semantic Document Search does not generate answers/);
  assert.match(llms, /StudyCord is under active development/);
  for (const route of publicRoutes) {
    assert.ok(llms.includes(`https://www.studycord.me${route}`));
  }
});
