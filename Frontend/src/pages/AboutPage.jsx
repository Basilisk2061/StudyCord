import { Link } from 'react-router-dom';
import PublicLayout, { PublicHero, PublicSection } from '../components/PublicLayout';

const SEO = {
  title: 'About StudyCord – Built for Collaborative Learning',
  description: 'Learn why StudyCord was built, the problems it solves for students and educators, and the founding team behind the platform.',
  path: '/about',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    '@id': 'https://www.studycord.me/about#aboutpage',
    url: 'https://www.studycord.me/about',
    name: 'About StudyCord',
    description: 'The story, mission, values, and founding team behind StudyCord.',
    about: { '@id': 'https://www.studycord.me/#softwareapplication' },
    isPartOf: { '@id': 'https://www.studycord.me/#website' },
  },
};

const TEAM = ['Arya Dahal', 'Bigyan Budhathoki', 'Madan Rayamajhi'];

export default function AboutPage() {
  return (
    <PublicLayout seo={SEO}>
      <PublicHero
        eyebrow="About StudyCord"
        title="A shared place to communicate, find knowledge, and study"
        lead="StudyCord is an AI-powered student collaboration platform that brings group communication, shared materials, semantic search, and focused AI study tools into one workspace."
      >
        <div className="public-hero__actions">
          <Link className="public-button public-button--primary" to="/signup">Create an account</Link>
          <Link className="public-button" to="/features">Explore features</Link>
        </div>
      </PublicHero>

      <PublicSection eyebrow="Why it exists" title="Study tools should work together">
        <p>
          Study groups often split their work across chat applications, meeting tools, file drives,
          search tabs, and separate AI products. Useful context gets scattered, and students spend
          time locating material instead of working with it.
        </p>
        <p>
          StudyCord was built to reduce that fragmentation. A server gives a group a stable home
          for text and voice channels, shared documents, live calls, semantic resource discovery,
          and personal study sessions grounded in uploaded material.
        </p>
      </PublicSection>

      <PublicSection eyebrow="Who it serves" title="For people who learn with others">
        <div className="public-card-grid public-card-grid--three">
          <article className="public-card">
            <h3>Students</h3>
            <p>Keep conversations, resources, revision tools, and group calls connected to the same study space.</p>
          </article>
          <article className="public-card">
            <h3>Study groups</h3>
            <p>Organize work by server and channel while making useful documents easier for every current member to find.</p>
          </article>
          <article className="public-card">
            <h3>Educators and mentors</h3>
            <p>Share learning materials, host discussions, and support collaborative revision without changing tools for every task.</p>
          </article>
        </div>
      </PublicSection>

      <PublicSection eyebrow="Direction" title="Mission and vision">
        <div className="public-split">
          <article>
            <h3>Mission</h3>
            <p>Help students communicate clearly, find the material they need, and learn actively from trustworthy study resources.</p>
          </article>
          <article>
            <h3>Vision</h3>
            <p>A study workspace where collaboration and AI support strengthen each other without replacing student judgment or discussion.</p>
          </article>
        </div>
      </PublicSection>

      <PublicSection eyebrow="Principles" title="Core values">
        <ul className="public-value-list">
          <li><strong>Useful over flashy.</strong> Features should solve a real study problem.</li>
          <li><strong>Shared context matters.</strong> Communication and resources are more useful when they stay connected.</li>
          <li><strong>Access should be explicit.</strong> Server membership and roles determine what people can view and manage.</li>
          <li><strong>AI should remain grounded.</strong> Study assistance is tied to material the learner chooses.</li>
          <li><strong>Simple systems last.</strong> Maintainability and clear boundaries are part of product quality.</li>
        </ul>
      </PublicSection>

      <PublicSection eyebrow="Founding team" title="Meet the team">
        <p>StudyCord was created by three founding developers:</p>
        <div className="public-card-grid public-card-grid--three public-team-grid">
          {TEAM.map((name) => (
            <article className="public-card" key={name}>
              <div className="public-team-grid__initial" aria-hidden="true">{name.charAt(0)}</div>
              <h3>{name}</h3>
              <p>Founding Developer of StudyCord</p>
            </article>
          ))}
        </div>
      </PublicSection>

      <PublicSection eyebrow="Development" title="StudyCord timeline">
        <ol className="public-timeline">
          <li>
            <span>Foundation</span>
            <div><h3>Collaborative workspace</h3><p>StudyCord began with authentication, profiles, servers, channels, messaging, shared files, and realtime updates.</p></div>
          </li>
          <li>
            <span>Communication</span>
            <div><h3>Live study rooms</h3><p>Voice channels expanded with peer-to-peer audio, video, screen sharing, presence, and TURN-assisted connectivity.</p></div>
          </li>
          <li>
            <span>Study intelligence</span>
            <div><h3>RAG-based learning</h3><p>Persistent personal document study added grounded Q&amp;A, summaries, flashcards, quizzes, and session history.</p></div>
          </li>
          <li>
            <span>Resource discovery</span>
            <div><h3>Server-wide semantic search</h3><p>Shared PDF, DOCX, and TXT resources gained automatic indexing, vector retrieval, ratings, and secure handoff into personal study sessions.</p></div>
          </li>
          <li>
            <span>Production</span>
            <div><h3>A stable public deployment</h3><p>StudyCord moved to its production home at www.studycord.me with deployment, security, accessibility, and discoverability work.</p></div>
          </li>
        </ol>
      </PublicSection>

      <PublicSection eyebrow="Project status" title="Under active development">
        <p>
          StudyCord is under active development, and its features and documentation evolve over
          time. For current information, prefer the official website and GitHub repository over
          third-party descriptions.
        </p>
      </PublicSection>
    </PublicLayout>
  );
}
