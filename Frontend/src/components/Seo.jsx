import { useEffect } from 'react';

const SITE_ORIGIN = 'https://www.studycord.me';
const SOCIAL_IMAGE = `${SITE_ORIGIN}/new-logo.png`;

function setMeta(selector, attribute, value) {
  const element = document.head.querySelector(selector);
  if (element) element.setAttribute(attribute, value);
}

export default function Seo({ title, description, path = '/', structuredData = null }) {
  useEffect(() => {
    const canonicalUrl = new URL(path, `${SITE_ORIGIN}/`).toString();
    document.title = title;
    setMeta('meta[name="description"]', 'content', description);
    setMeta('meta[name="robots"]', 'content', 'index, follow');
    setMeta('link[rel="canonical"]', 'href', canonicalUrl);
    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', description);
    setMeta('meta[property="og:url"]', 'content', canonicalUrl);
    setMeta('meta[property="og:image"]', 'content', SOCIAL_IMAGE);
    setMeta('meta[property="og:image:secure_url"]', 'content', SOCIAL_IMAGE);
    setMeta('meta[name="twitter:title"]', 'content', title);
    setMeta('meta[name="twitter:description"]', 'content', description);
    setMeta('meta[name="twitter:image"]', 'content', SOCIAL_IMAGE);

    const previousSchema = document.getElementById('studycord-page-schema');
    previousSchema?.remove();
    if (!structuredData) return undefined;

    const schema = document.createElement('script');
    schema.id = 'studycord-page-schema';
    schema.type = 'application/ld+json';
    schema.textContent = JSON.stringify(structuredData);
    document.head.appendChild(schema);
    return () => schema.remove();
  }, [description, path, structuredData, title]);

  return null;
}

