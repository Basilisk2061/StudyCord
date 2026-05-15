import { useState } from 'react';

function HashIcon() {
  return <span style={{ fontSize: '14px', fontWeight: 700, opacity: 0.45, lineHeight: 1 }}>#</span>;
}

function VoiceIcon() {
  return (
    <svg className="channel-item__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

export default function ChannelSidebar({
  serverId, serverName, channels, channelsLoading, channelsError,
  activeChannelId, onSelectChannel, onCreateChannel,
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setErr(null);
    const r = await onCreateChannel(name);
    if (r?.success) { setName(''); setShowForm(false); }
    else { setErr(r?.error || 'Failed'); }
    setCreating(false);
  };

  if (!serverId) {
    return (
      <aside className="channel-sidebar" id="channel-sidebar">
        <div className="channel-sidebar__header">
          <span className="channel-sidebar__title">StudyCord</span>
        </div>
        <div className="channel-sidebar__empty"><p>Select a server to view channels</p></div>
      </aside>
    );
  }

  const textCh = channels.filter((c) => c.type === 'text');
  const voiceCh = channels.filter((c) => c.type === 'voice');

  return (
    <aside className="channel-sidebar" id="channel-sidebar">
      <div className="channel-sidebar__header">
        <span className="channel-sidebar__title">{serverName || 'Server'}</span>
      </div>
      <nav className="channel-sidebar__list">
        {channelsLoading && <div className="channel-sidebar__empty"><p>Loading channels…</p></div>}
        {channelsError && !channelsLoading && <div className="channel-sidebar__empty"><p style={{ color: 'var(--error-color)' }}>Error: {channelsError}</p></div>}
        {!channelsLoading && !channelsError && channels.length === 0 && <div className="channel-sidebar__empty"><p>No channels yet</p></div>}

        {!channelsLoading && textCh.length > 0 && (
          <div className="channel-category">
            <div className="channel-category__header">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
              <span>Text Channels</span>
            </div>
            {textCh.map((ch) => (
              <button key={ch.id} className={`channel-item ${activeChannelId === ch.id ? 'channel-item--active' : ''}`} onClick={() => onSelectChannel(ch.id, ch.name, ch.type)}>
                <HashIcon /><span className="channel-item__name">{ch.name}</span>
              </button>
            ))}
          </div>
        )}

        {!channelsLoading && voiceCh.length > 0 && (
          <div className="channel-category">
            <div className="channel-category__header">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
              <span>Voice Channels</span>
            </div>
            {voiceCh.map((ch) => (
              <button key={ch.id} className={`channel-item ${activeChannelId === ch.id ? 'channel-item--active' : ''}`} onClick={() => onSelectChannel(ch.id, ch.name, ch.type)}>
                <VoiceIcon /><span className="channel-item__name">{ch.name}</span>
              </button>
            ))}
          </div>
        )}

        {!channelsLoading && (
          <div className="channel-sidebar__create">
            {!showForm ? (
              <button className="channel-create-btn" onClick={() => setShowForm(true)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Add Channel</span>
              </button>
            ) : (
              <form className="channel-create-form" onSubmit={handleCreate}>
                <input className="channel-create-form__input" type="text" placeholder="channel-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus disabled={creating} />
                <div className="channel-create-form__actions">
                  <button type="submit" className="channel-create-form__btn channel-create-form__btn--confirm" disabled={creating || !name.trim()} title="Create">{creating ? '…' : '✓'}</button>
                  <button type="button" className="channel-create-form__btn channel-create-form__btn--cancel" onClick={() => { setShowForm(false); setName(''); setErr(null); }} title="Cancel">✕</button>
                </div>
                {err && <div className="channel-create-form__error">{err}</div>}
              </form>
            )}
          </div>
        )}
      </nav>
    </aside>
  );
}
