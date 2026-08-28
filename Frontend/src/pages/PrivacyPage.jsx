import PublicLayout, { GITHUB_URL, PublicHero, PublicSection } from '../components/PublicLayout';

const SEO = {
  title: 'StudyCord Privacy Policy',
  description: 'Read how StudyCord handles account information, messages, uploaded documents, live media, browser storage, AI services, and user choices.',
  path: '/privacy',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': 'https://www.studycord.me/privacy#webpage',
    url: 'https://www.studycord.me/privacy',
    name: 'StudyCord Privacy Policy',
    dateModified: '2026-08-28',
    isPartOf: { '@id': 'https://www.studycord.me/#website' },
  },
};

export default function PrivacyPage() {
  return (
    <PublicLayout seo={SEO}>
      <PublicHero
        eyebrow="Legal"
        title="Privacy Policy"
        lead="This policy explains the information StudyCord processes to provide accounts, collaboration, file sharing, live communication, search, and AI-assisted study features."
      >
        <p className="public-hero__updated">Effective and last updated: August 28, 2026</p>
      </PublicHero>

      <div className="public-legal">
        <PublicSection title="1. Scope">
          <p>
            This Privacy Policy applies to the StudyCord web application at www.studycord.me and
            the services used to operate it. StudyCord is a collaborative educational software
            project, not an educational institution or emergency communication service.
          </p>
        </PublicSection>

        <PublicSection title="2. Account and authentication information">
          <p>
            StudyCord uses Supabase Auth for account creation, email sign-in, password recovery,
            session management, and optional Google OAuth. Supabase processes identifiers needed
            for authentication, such as your user ID and email address. If you use Google sign-in,
            Google and Supabase process the OAuth exchange under their respective policies.
          </p>
          <p>Never share your password or authentication tokens with other people.</p>
        </PublicSection>

        <PublicSection title="3. Profile, server, and collaboration data">
          <p>
            StudyCord stores information you provide or create, including profile details, server
            membership, roles, channel metadata, messages, attachments, pins, bans, resource
            ratings, and related timestamps. This information supports the collaboration features
            you request and the access controls associated with your account and servers.
          </p>
        </PublicSection>

        <PublicSection title="4. Uploaded files and study documents">
          <p>
            Shared channel attachments, avatars, and server icons are stored through Supabase
            Storage. Supported server documents may be downloaded by the authenticated backend for
            validation, text extraction, chunking, and semantic indexing.
          </p>
          <p>
            Documents uploaded to the personal AI Study Assistant are processed by the backend and
            may be retained in backend-controlled storage with local SQLite metadata and FAISS
            artifacts so an authorized user can reopen a study session. Do not upload material you
            are not permitted to use or share.
          </p>
        </PublicSection>

        <PublicSection title="5. AI processing and semantic search">
          <p>
            To provide embeddings, semantic retrieval, and generated study outputs, relevant text,
            prompts, retrieved context, or document content may be processed by configured model
            providers. The current implementation uses Google embedding integrations and a
            provider-managed generation path with NVIDIA NIM and eligible OpenRouter fallback.
            Provider availability and configuration may change.
          </p>
          <p>
            AI output can be incomplete or incorrect. Review generated answers, summaries,
            flashcards, and quizzes against your source material.
          </p>
        </PublicSection>

        <PublicSection title="6. Voice, video, and screen sharing">
          <p>
            StudyCord requests microphone, camera, or display access only when you use the related
            controls and your browser grants permission. WebRTC sends live media to call peers
            directly when possible or through a TURN relay when necessary. Signaling and presence
            records support call setup and participant discovery.
          </p>
          <p>
            StudyCord does not implement voice or video recording. Screen sharing may include
            system audio only when you select that option and the browser supports it.
          </p>
        </PublicSection>

        <PublicSection title="7. Browser storage, cookies, and analytics">
          <p>
            StudyCord uses browser storage for authenticated session handling and local study chat
            history. The application does not currently include a dedicated first-party analytics
            product. Infrastructure providers may process standard technical logs, IP addresses,
            device information, and request metadata for security, reliability, and operation.
          </p>
          <p>
            Third-party authentication or hosting services may use cookies or similar technologies
            according to their own policies. Browser settings can be used to manage stored data,
            although disabling required storage may prevent sign-in or session restoration.
          </p>
        </PublicSection>

        <PublicSection title="8. Service providers">
          <p>StudyCord currently relies on services that may process limited data for specific functions:</p>
          <ul>
            <li><strong>Supabase:</strong> authentication, PostgreSQL, Storage, and Realtime.</li>
            <li><strong>Google:</strong> optional OAuth and configured embedding services.</li>
            <li><strong>NVIDIA and OpenRouter:</strong> configured language-model generation.</li>
            <li><strong>Metered:</strong> TURN connectivity for WebRTC calls when a relay is needed.</li>
            <li><strong>Vercel and Render:</strong> frontend and backend hosting.</li>
          </ul>
        </PublicSection>

        <PublicSection title="9. Access, correction, and deletion">
          <p>
            You can update available profile and server information through StudyCord. Depending on
            your role, you can delete your messages, leave servers, remove study content, or use
            server management controls. Some historical records may remain when required for shared
            resource integrity, moderation, security, backups, or legal obligations.
          </p>
          <p>
            For a privacy request that cannot be completed in the interface, contact the project
            through the <a href={`${GITHUB_URL}/issues`}>StudyCord GitHub issue tracker</a>. Do not
            post passwords, tokens, private documents, or other sensitive information in a public issue.
          </p>
        </PublicSection>

        <PublicSection title="10. Security and changes">
          <p>
            StudyCord uses authenticated requests, server membership checks, role permissions, Row
            Level Security, backend-controlled paths, and scoped service operations. No internet
            service can guarantee absolute security, so use appropriate judgment when sharing data.
          </p>
          <p>
            This policy may be updated as the project, deployment, or providers change. Material
            revisions will be reflected by the date shown on this page.
          </p>
        </PublicSection>
      </div>
    </PublicLayout>
  );
}

