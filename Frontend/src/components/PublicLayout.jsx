import { Link, NavLink } from 'react-router-dom';
import Seo from './Seo';

const NAV_ITEMS = [
  ['/features', 'Features'],
  ['/about', 'About'],
  ['/technology', 'Technology'],
  ['/faq', 'FAQ'],
];

export const GITHUB_URL = 'https://github.com/Basilisk2061/StudyCord';

export default function PublicLayout({ seo, children }) {
  return (
    <div className="public-site">
      <Seo {...seo} />
      <a className="public-site__skip-link" href="#public-content">Skip to content</a>
      <header className="public-site__header">
        <div className="public-site__header-inner">
          <Link className="public-site__brand" to="/" aria-label="StudyCord home">
            Study<span>Cord</span>
          </Link>
          <nav className="public-site__nav" aria-label="Public navigation">
            {NAV_ITEMS.map(([path, label]) => (
              <NavLink key={path} to={path}>{label}</NavLink>
            ))}
            <a href={GITHUB_URL}>GitHub</a>
          </nav>
          <Link className="public-site__sign-in" to="/login">Sign in</Link>
        </div>
      </header>

      <main id="public-content" className="public-site__main">
        {children}
      </main>

      <footer className="public-site__footer">
        <div className="public-site__footer-inner">
          <div>
            <Link className="public-site__brand" to="/">Study<span>Cord</span></Link>
            <p>An AI-powered student collaboration platform for learning together.</p>
          </div>
          <nav aria-label="Product links">
            <Link to="/features">Features</Link>
            <Link to="/about">About</Link>
            <Link to="/technology">Technology</Link>
            <Link to="/faq">FAQ</Link>
          </nav>
          <nav aria-label="Legal and project links">
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <a href={GITHUB_URL}>GitHub</a>
          </nav>
        </div>
        <p className="public-site__copyright">© 2026 StudyCord. Built for students who learn together.</p>
      </footer>
    </div>
  );
}

export function PublicHero({ eyebrow, title, lead, children }) {
  return (
    <section className="public-hero">
      <p className="public-hero__eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="public-hero__lead">{lead}</p>
      {children}
    </section>
  );
}

export function PublicSection({ id, eyebrow, title, children }) {
  return (
    <section className="public-section" id={id}>
      {eyebrow && <p className="public-section__eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      <div className="public-section__body">{children}</div>
    </section>
  );
}

