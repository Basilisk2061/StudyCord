import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import VoiceSessionBar from './VoiceSessionBar';

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
  voiceSession,
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [newChannelType, setNewChannelType] = useState('text');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);

  // ---------- voice participant counts per channel ----------
  const [voiceCounts, setVoiceCounts] = useState({});

  const fetchVoiceCounts = useCallback(async () => {
    if (!serverId) {
      setVoiceCounts({});
      return;
    }

    const { data, error } = await supabase
      .from('voice_participants')
      .select('channel_id')
      .eq('server_id', serverId);

    if (error) {
      console.error('Failed to fetch voice counts:', error);
      return;
    }

    // Count per channel
    const counts = {};
    (data || []).forEach((row) => {
      counts[row.channel_id] = (counts[row.channel_id] || 0) + 1;
    });
    setVoiceCounts(counts);
  }, [serverId]);

  // Fetch on mount & server change
  useEffect(() => {
    fetchVoiceCounts();
  }, [fetchVoiceCounts]);

  // Realtime: re-fetch counts when voice_participants change in this server
  useEffect(() => {
    if (!serverId) return;

    const channel = supabase
      .channel(`voice_counts_realtime:${serverId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'voice_participants',
        },
        () => {
          fetchVoiceCounts();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [serverId, fetchVoiceCounts]);

  // ---------- create channel ----------
  const handleCreate = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setErr(null);
    const r = await onCreateChannel(name, newChannelType);
    if (r?.success) { setName(''); setShowForm(false); setNewChannelType('text'); }
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
            {voiceCh.map((ch) => {
              const count = voiceCounts[ch.id] || 0;
              return (
                <button
                  key={ch.id}
                  className={`channel-item channel-item--voice ${activeChannelId === ch.id ? 'channel-item--active' : ''}`}
                  onClick={() => onSelectChannel(ch.id, ch.name, ch.type)}
                >
                  <VoiceIcon />
                  <span className="channel-item__name">{ch.name}</span>
                  {count > 0 && (
                    <span className="channel-item__voice-count" title={`${count} connected`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
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

                {/* Type toggle */}
                <div className="channel-type-toggle">
                  <button
                    type="button"
                    className={`channel-type-toggle__btn ${newChannelType === 'text' ? 'channel-type-toggle__btn--active' : ''}`}
                    onClick={() => setNewChannelType('text')}
                    disabled={creating}
                  >
                    <span style={{ fontSize: '11px', fontWeight: 700, opacity: 0.6 }}>#</span>
                    Text
                  </button>
                  <button
                    type="button"
                    className={`channel-type-toggle__btn ${newChannelType === 'voice' ? 'channel-type-toggle__btn--active' : ''}`}
                    onClick={() => setNewChannelType('voice')}
                    disabled={creating}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                    Voice
                  </button>
                </div>

                <div className="channel-create-form__actions">
                  <button type="submit" className="channel-create-form__btn channel-create-form__btn--confirm" disabled={creating || !name.trim()} title="Create">{creating ? '…' : '✓'}</button>
                  <button type="button" className="channel-create-form__btn channel-create-form__btn--cancel" onClick={() => { setShowForm(false); setName(''); setErr(null); setNewChannelType('text'); }} title="Cancel">✕</button>
                </div>
                {err && <div className="channel-create-form__error">{err}</div>}
              </form>
            )}
          </div>
        )}
      </nav>
      {voiceSession && voiceSession.joinedChannelId && (
        <VoiceSessionBar
          channelName={voiceSession.joinedChannelName}
          micConnected={voiceSession.micConnected}
          callStatus={voiceSession.callStatus}
          isMuted={voiceSession.isMuted}
          onToggleMute={voiceSession.handleToggleMute}
          onLeave={voiceSession.handleLeave}
        />
      )}
    </aside>
  );
}
