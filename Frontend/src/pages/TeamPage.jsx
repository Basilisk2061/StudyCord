import { Link } from 'react-router-dom';
import PublicLayout, {
  GITHUB_URL,
  PublicHero,
  PublicSection,
} from '../components/PublicLayout';

const FOUNDERS = [
  { name: 'Arya Dahal', id: 'arya-dahal' },
  { name: 'Bigyan Budhathoki', id: 'bigyan-budhathoki' },
  { name: 'Madan Rayamajhi', id: 'madan-rayamajhi' },
];

const SEO = {
  title: 'Meet the StudyCord Team',
  description: 'Meet the founding developers who created and continue to maintain StudyCord, an AI-powered student collaboration platform.',
  path: '/team',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    '@id': 'https://www.studycord.me/team#teampage',
    url: 'https://www.studycord.me/team',
    name: 'Meet the StudyCord Team',
    description: 'The founding developers behind StudyCord and the history of the project.',
    isPartOf: { '@id': 'https://www.studycord.me/#website' },
    about: { '@id': 'https://www.studycord.me/#organization' },
    mainEntity: {
      '@type': 'ItemList',
      name: 'StudyCord Founding Developers',
      itemListElement: FOUNDERS.map((founder, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'Person',
          '@id': `https://www.studycord.me/#${founder.id}`,
          name: founder.name,
          jobTitle: 'Founding Developer of StudyCord',
        },
      })),
    },
  },
};

export default function TeamPage() {
  return (
    <PublicLayout seo={SEO}>
      <PublicHero
        eyebrow="StudyCord team"
        title="Meet the StudyCord Team"
        lead="StudyCord was founded and developed by three founding developers who continue to maintain and improve the project."
      />

      <PublicSection eyebrow="Founding developers" title="The people behind StudyCord">
        <p>
          Arya Dahal, Bigyan Budhathoki, and Madan Rayamajhi designed and built StudyCord as an
          AI-powered student collaboration platform.
        </p>
        <div className="public-card-grid public-card-grid--three public-team-grid">
          {FOUNDERS.map((founder) => (
            <article className="public-card" key={founder.name}>
              <div className="public-team-grid__initial" aria-hidden="true">
                {founder.name.charAt(0)}
              </div>
              <h3>{founder.name}</h3>
              <p>Founding Developer of StudyCord</p>
            </article>
          ))}
        </div>
      </PublicSection>

      <PublicSection eyebrow="Project history" title="From capstone project to active platform">
        <p>
          StudyCord began as a university capstone project focused on bringing student
          communication, shared study resources, semantic document search, and document-grounded
          AI study tools into one workspace.
        </p>
        <p>
          The project remains under active development. Its founding developers continue to
          maintain and improve the application and its public documentation.
        </p>
      </PublicSection>

      <PublicSection eyebrow="Project links" title="Learn more about StudyCord">
        <p>
          Read the <Link to="/about">StudyCord story and mission</Link>, or review the current
          implementation in the <a href={GITHUB_URL}>StudyCord GitHub repository</a>.
        </p>
      </PublicSection>
    </PublicLayout>
  );
}
