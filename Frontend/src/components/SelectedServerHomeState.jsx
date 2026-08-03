import { hasServerPermission } from '../lib/permissions';
import ServerIconContents from './ServerIconContents';

const SERVER_CAPABILITIES = [
  {
    icon: 'conversation',
    title: 'Conversations',
    description: 'Chat with your study group in dedicated text channels.',
  },
  {
    icon: 'voice',
    title: 'Voice & Video',
    description: 'Join voice channels for calls, video, and screen sharing.',
  },
  {
    icon: 'resources',
    title: 'Shared Resources',
    description: 'Share study documents with members of this server.',
  },
  {
    icon: 'search',
    title: 'Advanced Search',
    description: 'Find relevant server resources using semantic search.',
  },
];

export default function SelectedServerHomeState({
  server,
  currentRole,
  onCreateChannel,
}) {
  const canCreateChannel = hasServerPermission(currentRole, 'manage_channels');

  if (!server) return null;
  const description = typeof server.description === 'string'
    ? server.description.trim()
    : '';

  return (
    <div className="server-home">
      <div className="server-home__content">
        <section className="server-home__welcome" aria-labelledby="server-home-title">
          <p className="server-home__eyebrow">Server home</p>
          <div className="server-home__identity">
            <div className="server-home__icon" aria-hidden="true">
              <ServerIconContents
                key={`${server.id}:${server.icon_path || 'fallback'}`}
                server={server}
              />
            </div>
            <div>
              <h1 id="server-home-title">{server.name}</h1>
              {description && (
                <p className="server-home__description" title={description}>
                  {description}
                </p>
              )}
              <p className="server-home__status">Your study space is ready.</p>
            </div>
          </div>

          <div className="server-home__guidance">
            <span className="server-home__guidance-arrow" aria-hidden="true">←</span>
            <div>
              <strong>Choose a channel from the sidebar to begin.</strong>
              <p>Start a conversation or join a voice channel when you are ready.</p>
            </div>
          </div>

          {canCreateChannel && onCreateChannel && (
            <button type="button" className="server-home__create" onClick={onCreateChannel}>
              <PlusIcon />
              Create channel
            </button>
          )}
        </section>

        <section className="server-home__capabilities" aria-labelledby="server-home-capabilities">
          <h2 id="server-home-capabilities">In this server</h2>
          <div className="server-home__capability-grid">
            {SERVER_CAPABILITIES.map((capability) => (
              <article className="server-home__capability" key={capability.title}>
                <div className="server-home__capability-icon" aria-hidden="true">
                  <CapabilityIcon name={capability.icon} />
                </div>
                <div>
                  <h3>{capability.title}</h3>
                  <p>{capability.description}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="server-home__workflow" aria-label="Server study workflow">
          <span>Choose a channel</span>
          <span aria-hidden="true">→</span>
          <span>Start studying</span>
        </div>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CapabilityIcon({ name }) {
  if (name === 'conversation') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3v-7a4 4 0 0 1-1-2.7V7a4 4 0 0 1 4-4h11a4 4 0 0 1 4 4Z" />
        <path d="M7 9h10M7 13h6" />
      </svg>
    );
  }
  if (name === 'voice') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 5 6 9H2v6h4l5 4Z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
      </svg>
    );
  }
  if (name === 'resources') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z" />
        <path d="M3 10h18" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  );
}
