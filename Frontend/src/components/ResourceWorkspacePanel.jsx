import { useNavigate } from 'react-router-dom';
import ResourceAccessWorkspace from './ResourceAccessWorkspace';


export default function ResourceWorkspacePanel({
  resource,
  serverName,
  profile,
  userEmail,
  onLogout,
  channelSidebarOpen,
  onToggleChannelSidebar,
  onMobileBack,
  onBack,
  backLabel,
  onRatingSummary,
}) {
  const navigate = useNavigate();

  return (
    <main className="main-panel advanced-search-panel">
      <header className="main-panel__topbar">
        <div className="main-panel__topbar-left">
          <button className="main-panel__mobile-back" onClick={onMobileBack} aria-label="Back to channels" title="Back to channels">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button className="main-panel__sidebar-toggle" onClick={onToggleChannelSidebar} aria-label={channelSidebarOpen ? 'Hide channels' : 'Show channels'} title={channelSidebarOpen ? 'Hide channels' : 'Show channels'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <svg className="main-panel__channel-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <h2 className="main-panel__channel-name">Resource</h2>
          <span className="main-panel__server-badge">{serverName}</span>
        </div>
        <div className="main-panel__topbar-right">
          <button className="main-panel__profile-btn" onClick={() => navigate('/profile')} title="Profile Settings">
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="Avatar" className="main-panel__avatar" />
            ) : (
              <div className="main-panel__avatar-placeholder">
                {profile?.username?.[0]?.toUpperCase() || '?'}
              </div>
            )}
            <span className="main-panel__username">{profile?.username || userEmail}</span>
          </button>
          <button className="btn btn-secondary main-panel__logout" onClick={onLogout}>
            <span className="main-panel__logout-label">Log out</span>
          </button>
        </div>
      </header>
      <div className="advanced-search-panel__body">
        <ResourceAccessWorkspace
          resource={resource}
          onBack={onBack}
          backLabel={backLabel}
          onRatingSummary={onRatingSummary}
        />
      </div>
    </main>
  );
}
