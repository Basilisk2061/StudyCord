import { Link } from 'react-router-dom';
import PublicLayout, { PublicHero, PublicSection } from '../components/PublicLayout';

const SEO = {
  title: 'StudyCord Technology – React, FastAPI and WebRTC',
  description: 'Understand the StudyCord architecture: React and Vite, FastAPI, Supabase, WebRTC, FAISS, pgvector, embeddings, RAG, and production deployment.',
  path: '/technology',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    '@id': 'https://www.studycord.me/technology#article',
    url: 'https://www.studycord.me/technology',
    headline: 'How StudyCord is built',
    description: 'An implementation-level overview of the StudyCord collaboration and AI architecture.',
    about: { '@id': 'https://www.studycord.me/#softwareapplication' },
    author: { '@id': 'https://www.studycord.me/#organization' },
    publisher: { '@id': 'https://www.studycord.me/#organization' },
  },
};

const STACK = [
  ['Frontend', ['React 19', 'Vite', 'React Router', 'Supabase JavaScript client', 'Framer Motion']],
  ['Backend', ['FastAPI', 'Pydantic', 'HTTPX', 'LangChain', 'PDF, DOCX, and TXT extraction']],
  ['Database', ['Supabase PostgreSQL', 'Row Level Security']],
  ['Authentication', ['Supabase Auth', 'Email and password', 'Google OAuth']],
  ['Realtime', ['Supabase Realtime', 'Database-backed presence and signaling']],
  ['Storage', ['Supabase Storage', 'Backend-controlled file validation where required']],
  ['Voice & Video', ['WebRTC', 'Browser media APIs', 'STUN', 'Metered TURN']],
  ['Personal AI', ['FAISS', 'SQLite', 'Google embeddings', 'NVIDIA NIM', 'OpenRouter fallback']],
  ['Semantic Search', ['PostgreSQL', 'pgvector', 'HNSW', 'Cosine similarity']],
  ['Deployment', ['Vercel', 'Render', 'Supabase']],
];

export default function TechnologyPage() {
  return (
    <PublicLayout seo={SEO}>
      <PublicHero
        eyebrow="Technology"
        title="A collaboration platform with clear system boundaries"
        lead="StudyCord separates browser UI, authenticated application services, durable collaboration data, live peer media, personal document study, and server-wide semantic retrieval."
      />

      <PublicSection eyebrow="Architecture" title="How requests and media move">
        <div className="public-architecture" role="img" aria-label="StudyCord architecture: browser frontend communicates with FastAPI and Supabase, while WebRTC carries peer media">
          <div><strong>React frontend</strong><span>Interface, auth session, realtime subscriptions</span></div>
          <span aria-hidden="true">↕</span>
          <div><strong>FastAPI</strong><span>Authorization, AI workflows, trusted server operations</span></div>
          <span aria-hidden="true">↕</span>
          <div><strong>Supabase</strong><span>PostgreSQL, Auth, Storage, Realtime, pgvector</span></div>
          <span aria-hidden="true">＋</span>
          <div><strong>WebRTC</strong><span>Peer audio, video, screen, and optional system audio</span></div>
        </div>
        <p>
          Signaling and media follow different paths. Supabase-backed presence and signaling help
          peers discover one another and exchange offers, answers, and ICE candidates. Once a
          connection is established, WebRTC carries media directly when possible or through TURN
          when network conditions require a relay.
        </p>
      </PublicSection>

      <PublicSection eyebrow="Stack" title="Technologies in the current implementation">
        <div className="public-card-grid public-card-grid--two">
          {STACK.map(([group, technologies]) => (
            <article className="public-card" key={group}>
              <h3>{group}</h3>
              <ul>
                {technologies.map((technology) => <li key={technology}>{technology}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </PublicSection>

      <PublicSection eyebrow="Application" title="Frontend and backend">
        <div className="public-split">
          <article>
            <h3>React frontend</h3>
            <p>
              The Vite application manages the multi-panel StudyCord interface, authenticated
              Supabase session, server and channel navigation, realtime updates, IndexedDB chat
              history, and browser media controls.
            </p>
          </article>
          <article>
            <h3>FastAPI backend</h3>
            <p>
              FastAPI verifies the caller&apos;s JWT, reuses server permissions, coordinates document
              processing and retrieval, manages trusted Storage actions where required, provides
              TURN credentials, and presents provider-neutral AI endpoints.
            </p>
          </article>
        </div>
      </PublicSection>

      <PublicSection eyebrow="Data and security" title="Supabase as the collaboration layer">
        <p>
          Supabase provides PostgreSQL records for servers, memberships, channels, messages,
          attachments, resources, ratings, pins, and voice signaling. Authentication supplies the
          user identity used by frontend requests and backend authorization. Row Level Security,
          restricted grants, permission helpers, and scoped database functions enforce access near
          the data.
        </p>
        <p>
          Supabase Storage holds shared files, avatars, and server icons. Realtime subscriptions
          deliver collaboration updates to connected browsers without turning media traffic into
          database traffic.
        </p>
      </PublicSection>

      <PublicSection eyebrow="AI and search" title="Two independent document systems">
        <div className="public-card-grid public-card-grid--two">
          <article className="public-card">
            <p className="public-card__label">AI Study Assistant · Personal</p>
            <h3>Retrieval-Augmented Generation</h3>
            <p>
              A user uploads a PDF, DOCX, or TXT document to the authenticated backend. StudyCord
              extracts text, chunks it, builds a FAISS index, and stores ownership-scoped metadata
              in local SQLite. Retrieval-Augmented Generation (RAG) grounds document questions,
              summaries, flashcards, and practice quizzes in the selected material.
            </p>
          </article>
          <article className="public-card">
            <p className="public-card__label">Semantic Document Search · Server</p>
            <h3>Shared resource discovery</h3>
            <p>
              Supported server attachments are registered, content-validated, chunked, embedded,
              and stored in PostgreSQL. pgvector HNSW cosine retrieval finds relevant chunks inside
              the current server, then StudyCord returns semantically relevant documents and
              snippets. Semantic Search does not generate answers and remains independent from the
              AI Study Assistant.
            </p>
          </article>
        </div>
        <div className="public-code-flow" aria-label="RAG flow">
          <code>document → validate → extract → chunk → embed → retrieve → study</code>
        </div>
      </PublicSection>

      <PublicSection eyebrow="Embeddings and generation" title="Search and answers use different model tasks">
        <p>
          Document and query embeddings use the configured Google embedding integration with
          768-dimensional normalized vectors. Semantic Search uses cosine distance and HNSW retrieval;
          relevance ordering is kept separate from community ratings.
        </p>
        <p>
          Text generation is provider-neutral at the endpoint layer. The current manager attempts
          NVIDIA NIM first and uses the existing OpenRouter provider only for configured transient
          conditions such as timeouts, rate limits, connection failures, quota exhaustion, and
          eligible upstream server errors.
        </p>
      </PublicSection>

      <PublicSection eyebrow="Realtime media" title="Voice, video, and screen sharing with WebRTC">
        <p>
          Each remote participant receives a dedicated RTCPeerConnection. Microphone, camera,
          display video, and optional display audio tracks are attached or replaced without moving
          media through FastAPI or Supabase. STUN supports direct connectivity; short-lived Metered
          TURN credentials provide relay connectivity when direct paths fail.
        </p>
      </PublicSection>

      <PublicSection eyebrow="Deployment" title="Production services">
        <p>
          The React application is deployed on Vercel at www.studycord.me. FastAPI runs as a separate
          Render service. Supabase hosts the shared database, authentication, storage, realtime, and
          vector data. Environment variables provide deployment-specific URLs and credentials;
          secrets are not embedded in public frontend code or this documentation.
        </p>
      </PublicSection>

      <PublicSection eyebrow="Project leadership" title="Built and maintained by the founding team">
        <p>
          StudyCord was founded and developed by Arya Dahal, Bigyan Budhathoki, and Madan
          Rayamajhi. They continue to maintain and improve the project.
        </p>
        <p><Link to="/team">Meet the StudyCord team</Link>.</p>
      </PublicSection>
    </PublicLayout>
  );
}
