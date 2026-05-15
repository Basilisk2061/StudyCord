import { useNavigate } from 'react-router-dom';

export default function MainPanel({
  serverName, channelName, channelType, channelId, userEmail, profile,
  onLogout, channelSidebarOpen, onToggleChannelSidebar, onMobileBack,
  serversCount, channelsCount,
}) {
  const navigate = useNavigate();
  const hasChannel = channelName && serverName;

  return (
    <section className="main-panel" id="main-panel">
      {/* Topbar */}
      <header className="main-panel__topbar">
        <div className="main-panel__topbar-left">
          <button id="mobile-back-button" className="main-panel__mobile-back" onClick={onMobileBack} aria-label="Back to channels" title="Back to channels">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          <button id="sidebar-toggle-button" className="main-panel__sidebar-toggle" onClick={onToggleChannelSidebar} aria-label={channelSidebarOpen ? 'Hide channels' : 'Show channels'} title={channelSidebarOpen ? 'Hide channels' : 'Show channels'}>
            {channelSidebarOpen ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <polyline points="6 9 3 12 6 15" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <polyline points="12 9 15 12 12 15" />
              </svg>
            )}
          </button>

          {hasChannel ? (
            <>
              {channelType === 'voice' ? (
                <svg className="main-panel__channel-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              ) : (
                <span className="main-panel__hash">#</span>
              )}
              <h2 className="main-panel__channel-name">{channelName}</h2>
              <span className="main-panel__server-badge">{serverName}</span>
            </>
          ) : (
            <h2 className="main-panel__channel-name">StudyCord</h2>
          )}
        </div>

        <div className="main-panel__topbar-right">
          <button 
            className="main-panel__profile-btn" 
            onClick={() => navigate('/profile')}
            title="Profile Settings"
          >
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="Avatar" className="main-panel__avatar" />
            ) : (
              <div className="main-panel__avatar-placeholder">
                {profile?.username?.[0]?.toUpperCase() || '?'}
              </div>
            )}
            <span className="main-panel__username">{profile?.username || userEmail}</span>
          </button>
          
          <button id="logout-button" className="btn btn-secondary main-panel__logout" onClick={onLogout}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span className="main-panel__logout-label">Log out</span>
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="main-panel__body">
        {hasChannel ? (
          <>
            {/* Selected channel info — chat will be built later */}
            <div className="main-panel__placeholder">
              <div className="main-panel__placeholder-icon">
                {channelType === 'voice' ? (
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                ) : (
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                )}
              </div>
              <h3 className="main-panel__placeholder-title">
                {channelType === 'voice' ? `Voice: ${channelName}` : `# ${channelName}`}
              </h3>
              <p className="main-panel__placeholder-text">
                {channelType === 'voice'
                  ? 'Voice channels will be available once real-time features are connected.'
                  : 'Chat will be connected in the next phase. This channel is ready!'}
              </p>
            </div>

            {/* Compose bar (read-only for now) */}
            <div className="main-panel__compose">
              <div className="compose-bar">
                <button className="compose-bar__add" title="Attach file">+</button>
                <input className="compose-bar__input" type="text" placeholder={`Message #${channelName}`} readOnly />
              </div>
            </div>
          </>
        ) : (
          <div className="main-panel__welcome" style={{ overflow: 'auto', flex: 1 }}>
            <div className="main-panel__welcome-card">
              <h2 className="main-panel__welcome-title">Welcome back!</h2>
              <p className="main-panel__welcome-subtitle">
                Select a server from the sidebar, then pick a channel to get started.
              </p>
              <div className="main-panel__quick-stats">
                <div className="main-panel__stat">
                  <span className="main-panel__stat-value">{serversCount ?? 0}</span>
                  <span className="main-panel__stat-label">Servers</span>
                </div>
                <div className="main-panel__stat">
                  <span className="main-panel__stat-value">{channelsCount ?? 0}</span>
                  <span className="main-panel__stat-label">Channels</span>
                </div>
              </div>
            </div>
            <div className="main-panel__tips">
              <h3 className="main-panel__tips-title">Quick Tips</h3>
              <ul className="main-panel__tips-list">
                <li>Click a server icon on the left to switch servers</li>
                <li>Browse channels in the sidebar to jump into a conversation</li>
                <li>Use the + button to create a new server or channel</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
