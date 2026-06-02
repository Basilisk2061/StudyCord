import { useState } from 'react';

const SUGGESTED_PROMPTS = [
  'Explain binary search trees',
  'Quiz me on Chapter 7',
  'Summarize sorting algorithms',
];

const AVATAR_COLORS = ['#4d7a6e', '#5a6872', '#64748b', '#3d5f55', '#455a64', '#5c6bc0'];

function getInitials(name) {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getAvatarBg(username) {
  if (!username) return '#64748b';
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

export default function RightPanel({
  activeServerId,
  serverInviteCode,
  members = [],
  membersLoading = false,
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!serverInviteCode) return;
    navigator.clipboard.writeText(serverInviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const showServerInfo = activeServerId !== null;

  return (
    <aside className="right-panel" id="right-panel">
      {/* ── AI STUDY HELPER ── */}
      <div className="right-panel__section">
        <h3 className="right-panel__section-title">AI Study Helper</h3>
        <p className="ai-helper__desc">
          Ask questions about your coursework, get explanations, or generate practice problems.
        </p>
        <input
          className="ai-helper__input"
          type="text"
          placeholder="Ask about this topic..."
          readOnly
        />
        <div className="ai-helper__prompts">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <span key={prompt} className="ai-helper__prompt">
              {prompt}
            </span>
          ))}
        </div>
      </div>

      {/* ── SERVER SPECIFIC VIEWS ── */}
      {showServerInfo ? (
        <>
          {/* Server Invite Code */}
          <div className="right-panel__section">
            <h3 className="right-panel__section-title">Invite Code</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
              <div
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  backgroundColor: '#1A1A1A',
                  border: '1px solid #475569',
                  borderRadius: 'var(--radius-sm)',
                  fontFamily: 'monospace',
                  fontSize: '13px',
                  fontWeight: '600',
                  color: '#F3F4F6',
                  letterSpacing: '0.05em',
                  textAlign: 'center',
                  userSelect: 'all',
                }}
              >
                {serverInviteCode || 'No invite code'}
              </div>
              <button
                onClick={handleCopy}
                className="btn btn-secondary"
                disabled={!serverInviteCode}
                style={{
                  width: 'auto',
                  padding: '6px 12px',
                  fontSize: '11px',
                  backgroundColor: copied ? 'var(--accent-subtle)' : 'transparent',
                  borderColor: copied ? 'var(--accent)' : 'var(--border)',
                  color: copied ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'all 0.15s ease',
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Members List */}
          <div className="right-panel__section">
            <h3 className="right-panel__section-title">
              Members ({membersLoading ? '...' : members.length})
            </h3>

            {membersLoading && (
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                Loading members...
              </p>
            )}

            {!membersLoading && members.length === 0 && (
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                No members found.
              </p>
            )}

            {!membersLoading &&
              members.map((m) => {
                const profileObj = m.profiles || {};
                const displayName = profileObj.full_name || profileObj.username || 'Anonymous';
                const username = profileObj.username || 'user';

                return (
                  <div key={m.user_id || username} className="member-item" style={{ margin: '6px 0' }}>
                    {profileObj.avatar_url ? (
                      <img
                        src={profileObj.avatar_url}
                        alt={displayName}
                        className="member-item__avatar"
                        style={{ objectFit: 'cover' }}
                      />
                    ) : (
                      <div
                        className="member-item__avatar"
                        style={{ backgroundColor: getAvatarBg(username) }}
                      >
                        {getInitials(displayName)}
                      </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, marginLeft: '2px' }}>
                      <span
                        className="member-item__name"
                        style={{
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          fontWeight: '500',
                          color: 'var(--text-primary)',
                          lineHeight: '1.2',
                        }}
                      >
                        {username}
                      </span>
                      {profileObj.full_name && (
                        <span
                          style={{
                            fontSize: '9px',
                            color: 'var(--text-muted)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            marginTop: '1px',
                          }}
                        >
                          {profileObj.full_name}
                        </span>
                      )}
                    </div>

                    <span className="member-item__role">
                      {m.role === 'owner' ? 'Owner' : 'Member'}
                    </span>
                  </div>
                );
              })}
          </div>
        </>
      ) : (
        /* ── GENERIC SHARED RESOURCES (Home View Only) ── */
        <div className="right-panel__section">
          <h3 className="right-panel__section-title">Shared Resources</h3>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
            Select a study server and channel to view shared resources.
          </p>
        </div>
      )}
    </aside>
  );
}
