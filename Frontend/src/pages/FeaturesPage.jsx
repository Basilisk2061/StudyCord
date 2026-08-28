import { Link } from 'react-router-dom';
import PublicLayout, { PublicHero, PublicSection } from '../components/PublicLayout';

const FEATURES = [
  {
    title: 'AI Study Assistant',
    summary: 'Turn an uploaded PDF, DOCX, or TXT document into an active study session.',
    detail: 'Ask grounded questions, create a summary, generate flashcards, or build a revision quiz from the selected material. Personal sessions and generated study outputs can be restored later.',
  },
  {
    title: 'Semantic Document Search',
    summary: 'Find shared material by meaning instead of relying only on filenames or exact keywords.',
    detail: 'StudyCord indexes supported server resources with PostgreSQL pgvector and HNSW, then returns semantically relevant documents and snippets. It does not generate answers, remains independent from the AI Study Assistant, and keeps community ratings separate from relevance ranking.',
  },
  {
    title: 'Real-time Messaging',
    summary: 'Discuss coursework in dedicated text channels with updates delivered as they happen.',
    detail: 'Messages support shared attachments, ownership-aware deletion, server moderation, and channel-scoped pinning so important context remains easy to revisit.',
  },
  {
    title: 'Voice Channels',
    summary: 'Join a study room without creating a separate meeting.',
    detail: 'Presence, microphone controls, peer discovery, and WebRTC signaling are connected to StudyCord voice channels. Heartbeats help the interface identify active participants.',
  },
  {
    title: 'Video Calls',
    summary: 'Add camera video when a face-to-face discussion helps.',
    detail: 'Video tracks use the same peer connections as voice, keeping the call attached to the selected server channel rather than a separate conferencing product.',
  },
  {
    title: 'Screen and System Audio Sharing',
    summary: 'Present notes, slides, demonstrations, or video material to the group.',
    detail: 'Screen sharing can include optional system audio when the browser supports it. Users remain in control of whether display audio is shared.',
  },
  {
    title: 'Document Sharing',
    summary: 'Keep useful files next to the conversation that gives them context.',
    detail: 'Channel attachments support previews and downloads. Supported study documents can be registered and indexed for server-wide discovery without changing the original message workflow.',
  },
  {
    title: 'Servers and Channels',
    summary: 'Give each study community an organized home.',
    detail: 'Servers contain ordered text and voice channels, member roles, descriptions, icons, invitations, moderation controls, and owner or administrator permissions.',
  },
  {
    title: 'Authentication and Account Recovery',
    summary: 'Use email credentials or Google sign-in with protected application routes.',
    detail: 'Supabase Auth manages sessions while the application supports email sign-up, sign-in, password recovery, and OAuth callback handling.',
  },
  {
    title: 'Responsive Collaboration',
    summary: 'Move between servers, channels, resources, and study tools across practical screen sizes.',
    detail: 'The interface adapts its panels and controls for narrower displays while retaining the desktop-focused workspace used for active study sessions.',
  },
];

const SEO = {
  title: 'StudyCord Features – AI Study, Search and Collaboration',
  description: 'Explore StudyCord features including messaging, voice and video channels, document sharing, semantic search, and a RAG-powered AI Study Assistant.',
  path: '/features',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': 'https://www.studycord.me/features#features',
    url: 'https://www.studycord.me/features',
    name: 'StudyCord Features',
    description: 'Communication, resource discovery, and AI-supported learning features in StudyCord.',
    isPartOf: { '@id': 'https://www.studycord.me/#website' },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: FEATURES.map((feature, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: feature.title,
        description: feature.summary,
      })),
    },
  },
};

export default function FeaturesPage() {
  return (
    <PublicLayout seo={SEO}>
      <PublicHero
        eyebrow="StudyCord features"
        title="One workspace for group communication and focused study"
        lead="StudyCord combines the everyday tools a study group needs with resource-aware search and AI assistance grounded in the material students choose."
      >
        <div className="public-hero__actions">
          <Link className="public-button public-button--primary" to="/signup">Get started</Link>
          <Link className="public-button" to="/technology">See how it works</Link>
        </div>
      </PublicHero>

      <PublicSection eyebrow="Capabilities" title="Built around the study workflow">
        <div className="public-feature-list">
          {FEATURES.map((feature, index) => (
            <article className="public-feature" key={feature.title}>
              <span className="public-feature__number">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3>{feature.title}</h3>
                <p className="public-feature__summary">{feature.summary}</p>
                <p>{feature.detail}</p>
              </div>
            </article>
          ))}
        </div>
      </PublicSection>

      <section className="public-cta">
        <div><p>Ready to create a study space?</p><h2>Bring your group and materials together.</h2></div>
        <Link className="public-button public-button--primary" to="/signup">Create an account</Link>
      </section>
    </PublicLayout>
  );
}
