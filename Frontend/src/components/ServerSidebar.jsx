import { useState } from 'react';
import { getServerIconPublicUrl } from '../lib/serverIcons';

function getInitials(name) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function ServerIconContents({ server }) {
  const [imageFailed, setImageFailed] = useState(false);
  const iconUrl = getServerIconPublicUrl(server.icon_path);

  if (iconUrl && !imageFailed) {
    return (
      <img
        className="server-icon__image"
        src={iconUrl}
        alt={`${server.name} icon`}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return <span className="server-icon__label">{getInitials(server.name)}</span>;
}

export default function ServerSidebar({
  servers,
  serversLoading,
  activeServerId,
  onSelectServer,
  onCreateServer,
  onJoinServer,
}) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [showJoinModal, setShowJoinModal] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newServerName.trim()) return;

    setCreating(true);
    setCreateError(null);

    const result = await onCreateServer(newServerName);

    if (result?.success) {
      setNewServerName('');
      setShowCreateModal(false);
    } else {
      setCreateError(result?.error || 'Failed to create server');
    }

    setCreating(false);
  };

  const handleJoin = async (e) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;

    setJoining(true);
    setJoinError(null);

    const result = await onJoinServer(inviteCode);

    if (result?.success) {
      setInviteCode('');
      setShowJoinModal(false);
    } else {
      setJoinError(result?.error || 'Failed to join server');
    }

    setJoining(false);
  };

  return (
    <>
      <aside className="server-sidebar" id="server-sidebar">
        {/* Home button */}
        <div
          className={`server-icon server-icon--home ${activeServerId === null ? 'server-icon--active' : ''}`}
          title="Home"
          onClick={() => onSelectServer(null)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>

        <div className="server-sidebar__divider" />

        {/* Loading state */}
        {serversLoading && (
          <div className="server-icon" style={{ opacity: 0.4, cursor: 'default' }} title="Loading...">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spinner-icon">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </div>
        )}

        {/* Server icons */}
        {!serversLoading &&
          servers.map((server) => (
            <div
              key={server.id}
              className={`server-icon ${activeServerId === server.id ? 'server-icon--active' : ''}`}
              title={server.name}
              onClick={() => onSelectServer(server.id)}
            >
              {activeServerId === server.id && <span className="server-icon__pill" />}
              <ServerIconContents key={server.icon_path || 'initials'} server={server} />
            </div>
          ))}

        <div className="server-sidebar__divider" />

        {/* Create server button */}
        <div
          className="server-icon server-icon--add"
          title="Create Server"
          onClick={() => setShowCreateModal(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>

        {/* Join server button */}
        <div
          className="server-icon server-icon--add"
          title="Join Server"
          aria-label="Join Server"
          onClick={() => setShowJoinModal(true)}
          style={{ marginTop: 4 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
        </div>
      </aside>

      {/* ── Create Server Modal ── */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-card__title">Create a Server</h3>
            <p className="modal-card__desc">
              Give your study group a name. Default channels (general, assignments, resources) will be created automatically.
            </p>

            <form onSubmit={handleCreate}>
              <label className="form-label" htmlFor="server-name-input">
                Server Name
              </label>
              <input
                id="server-name-input"
                className="form-input"
                type="text"
                placeholder="e.g. CS 301 Study Group"
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
                autoFocus
                disabled={creating}
              />

              {createError && (
                <div className="error-message" style={{ marginTop: 12 }}>
                  {createError}
                </div>
              )}

              <div className="modal-card__actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowCreateModal(false)}
                  disabled={creating}
                  style={{ width: 'auto', padding: '8px 18px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={creating || !newServerName.trim()}
                  style={{ width: 'auto', padding: '8px 18px' }}
                >
                  {creating ? 'Creating…' : 'Create Server'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Join Server Modal ── */}
      {showJoinModal && (
        <div className="modal-overlay" onClick={() => setShowJoinModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-card__title">Join a Server</h3>
            <p className="modal-card__desc">
              Enter a 6-character invite code to join an existing study server.
            </p>

            <form onSubmit={handleJoin}>
              <label className="form-label" htmlFor="join-code-input">
                Invite Code
              </label>
              <input
                id="join-code-input"
                className="form-input"
                type="text"
                placeholder="e.g. AB12CD"
                maxLength={10}
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                autoFocus
                disabled={joining}
                style={{ textTransform: 'uppercase' }}
              />

              {joinError && (
                <div className="error-message" style={{ marginTop: 12 }}>
                  {joinError}
                </div>
              )}

              <div className="modal-card__actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowJoinModal(false)}
                  disabled={joining}
                  style={{ width: 'auto', padding: '8px 18px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={joining || !inviteCode.trim()}
                  style={{ width: 'auto', padding: '8px 18px' }}
                >
                  {joining ? 'Joining…' : 'Join Server'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
