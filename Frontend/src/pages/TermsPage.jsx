import PublicLayout, { GITHUB_URL, PublicHero, PublicSection } from '../components/PublicLayout';

const SEO = {
  title: 'StudyCord Terms of Service',
  description: 'Review the terms governing accounts, acceptable use, shared content, AI-generated material, collaboration, and availability of StudyCord.',
  path: '/terms',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': 'https://www.studycord.me/terms#webpage',
    url: 'https://www.studycord.me/terms',
    name: 'StudyCord Terms of Service',
    dateModified: '2026-08-28',
    isPartOf: { '@id': 'https://www.studycord.me/#website' },
  },
};

export default function TermsPage() {
  return (
    <PublicLayout seo={SEO}>
      <PublicHero
        eyebrow="Legal"
        title="Terms of Service"
        lead="These terms set expectations for using StudyCord responsibly as a communication, collaboration, resource-sharing, and AI-assisted study platform."
      >
        <p className="public-hero__updated">Effective and last updated: August 28, 2026</p>
      </PublicHero>

      <div className="public-legal">
        <PublicSection title="1. Acceptance and eligibility">
          <p>
            By accessing or using StudyCord, you agree to these Terms of Service and the Privacy
            Policy. If you do not agree, do not use the service. You must be legally permitted to
            create an account and use online services in your location. If an institution provides
            access, its additional rules may also apply.
          </p>
        </PublicSection>

        <PublicSection title="2. Accounts">
          <p>
            You are responsible for the accuracy of your account information, the security of your
            credentials, and activity performed through your account. Notify the project maintainers
            if you believe an account or server has been compromised. Do not impersonate another
            person or attempt to obtain another user&apos;s session or credentials.
          </p>
        </PublicSection>

        <PublicSection title="3. Acceptable use">
          <p>You may not use StudyCord to:</p>
          <ul>
            <li>break applicable law or violate another person&apos;s rights;</li>
            <li>harass, threaten, exploit, or deliberately mislead other users;</li>
            <li>upload malware, harmful code, or content designed to disrupt the service;</li>
            <li>probe, bypass, or interfere with authentication, permissions, RLS, moderation, or rate limits;</li>
            <li>share material you do not have permission to distribute;</li>
            <li>use automated traffic that harms availability for other users.</li>
          </ul>
        </PublicSection>

        <PublicSection title="4. Your content and shared resources">
          <p>
            You retain responsibility for messages, files, server descriptions, and other content
            you submit. You grant StudyCord the limited permission needed to store, process,
            display, transmit, index, and retrieve that content to provide the features you request.
          </p>
          <p>
            Server-visible content may be accessible to current members of that server. Deleting an
            originating message does not necessarily delete a canonical resource that remains part
            of the server&apos;s shared study library. Use server and deletion controls carefully.
          </p>
        </PublicSection>

        <PublicSection title="5. AI-generated content">
          <p>
            StudyCord provides document-grounded answers, summaries, flashcards, quizzes, and other
            generated study material. These outputs may contain errors, omit context, or reflect
            limitations in source documents and model providers. They are study aids, not guaranteed
            facts, professional advice, or substitutes for course requirements and primary sources.
          </p>
          <p>You are responsible for reviewing generated material before relying on or sharing it.</p>
        </PublicSection>

        <PublicSection title="6. Moderation and server administration">
          <p>
            Server owners and administrators can manage channels, members, roles, bans, messages,
            pins, and server settings according to their permissions. StudyCord may restrict or
            remove access when necessary to protect users, comply with law, investigate abuse, or
            maintain the service.
          </p>
        </PublicSection>

        <PublicSection title="7. Third-party services">
          <p>
            StudyCord depends on third-party authentication, hosting, storage, realtime, TURN,
            embedding, and language-model services. Their terms and availability may affect parts of
            StudyCord. The project does not control every action or interruption of those providers.
          </p>
        </PublicSection>

        <PublicSection title="8. Availability and changes">
          <p>
            StudyCord is an evolving software project. Features may be corrected, changed, limited,
            or discontinued, and uninterrupted availability is not guaranteed. Reasonable efforts
            are made to preserve existing behavior and data integrity, but users should retain
            copies of important academic material.
          </p>
        </PublicSection>

        <PublicSection title="9. Disclaimer and limitation">
          <p>
            StudyCord is provided on an “as is” and “as available” basis to the extent permitted by
            law. No warranty is made that generated content, search results, calls, files, or other
            features will always be complete, accurate, secure, or available. To the extent permitted
            by law, the project contributors are not liable for indirect or consequential loss
            arising from use of the service.
          </p>
        </PublicSection>

        <PublicSection title="10. Contact and updates">
          <p>
            Questions about these terms can be raised through the
            {' '}<a href={`${GITHUB_URL}/issues`}>StudyCord GitHub issue tracker</a>. Do not disclose
            private account information or secrets in a public issue. Updated terms will show a new
            revision date on this page; continued use after an update indicates acceptance where
            permitted by law.
          </p>
        </PublicSection>
      </div>
    </PublicLayout>
  );
}

