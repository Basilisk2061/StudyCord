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
const index = read('../index.html');
const robots = read('../public/robots.txt');

const publicRoutes = ['/features', '/about', '/technology', '/team', '/faq', '/privacy', '/terms'];

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
    '../src/pages/TeamPage.jsx',
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

test('homepage metadata and structured data use the canonical production identity', () => {
  const canonicalDomain = 'https://www.studycord.me';
  const schemas = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));

  assert.equal((index.match(/<title>/g) || []).length, 1);
  assert.equal((index.match(/<meta\s+name="description"/g) || []).length, 1);
  assert.equal((index.match(/<link rel="canonical"/g) || []).length, 1);
  assert.match(index, /StudyCord – AI-Powered Student Collaboration Platform/);
  assert.match(index, /AI-powered student collaboration platform/);
  assert.doesNotMatch(index, /https:\/\/studycord\.me/);
  assert.doesNotMatch(robots, /https:\/\/studycord\.me/);
  assert.doesNotMatch(sitemap, /https:\/\/studycord\.me/);
  assert.doesNotMatch(index, /SearchAction|dashboard\?search/);
  assert.equal(schemas.length, 3);
  assert.deepEqual(schemas.map((schema) => schema['@type']), [
    'SoftwareApplication',
    'Organization',
    'WebSite',
  ]);
  assert.ok(schemas.every((schema) => JSON.stringify(schema).includes(canonicalDomain)));
  const application = schemas.find((schema) => schema['@type'] === 'SoftwareApplication');
  assert.deepEqual(application.creator.map((creator) => creator['@id']), [
    'https://www.studycord.me/#arya-dahal',
    'https://www.studycord.me/#bigyan-budhathoki',
    'https://www.studycord.me/#madan-rayamajhi',
  ]);
});

test('founder attribution is consistent across public sources', () => {
  const team = read('../src/pages/TeamPage.jsx');
  const about = read('../src/pages/AboutPage.jsx');
  const technology = read('../src/pages/TechnologyPage.jsx');
  const readme = read('../../README.md');
  const founders = ['Arya Dahal', 'Bigyan Budhathoki', 'Madan Rayamajhi'];

  for (const source of [team, about, technology, readme, llms]) {
    const normalizedSource = source.replace(/\s+/g, ' ');
    let previousIndex = -1;
    for (const founder of founders) {
      const founderIndex = normalizedSource.indexOf(founder);
      assert.ok(founderIndex > previousIndex, `${founder} must appear in the approved order`);
      previousIndex = founderIndex;
    }
  }
  assert.match(team, /<PublicHero[\s\S]*title="Meet the StudyCord Team"/);
  assert.match(team, /to="\/about"/);
  assert.match(about, /to="\/team"/);
  assert.match(technology, /to="\/team"/);
});
