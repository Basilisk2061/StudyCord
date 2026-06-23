/**
 * VoicePanel — shows voice channel participants, join/leave/mute controls.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

export default function VoicePanel({
  channelId,
  channelName,
  serverName,
  activeServerId,
  userId,
  profile,
  onMobileBack,
  voiceSession,
}) {
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const participantsRef = useRef(participants);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Check if current user is joined to this specific channel
  const isJoinedHere = voiceSession.joinedChannelId === channelId;
  const isMuted = voiceSession.isMuted;
  const joining = voiceSession.joining;

  const activeParticipants = isJoinedHere ? (voiceSession.participants || []) : participants;
  const activeLoading = isJoinedHere ? voiceSession.loading : loading;

  // ---------- fetch participants for this channel ----------
  const fetchParticipants = useCallback(async () => {
    if (!channelId) return;

    // Delete stale rows older than 20 seconds
    const staleTime = new Date(Date.now() - 20000).toISOString();
    supabase
      .from('voice_participants')
      .delete()
      .lt('last_seen', staleTime)
      .then(({ error: deleteErr }) => {
        if (deleteErr) {
          console.error('Failed to clean up stale voice participants:', deleteErr);
        }
      });

    const { data, error: fetchErr } = await supabase
      .from('voice_participants')
      .select(`
        id,
        user_id,
        is_muted,
        joined_at,
        last_seen,
        profiles (
          username,
          full_name,
          avatar_url
        )
      `)
      .eq('channel_id', channelId)
      .order('joined_at', { ascending: true });

    if (fetchErr) {
      console.error('Failed to fetch voice participants:', fetchErr);
    } else {
      const cutoff = Date.now() - 15000;
      const activeParticipants = (data || []).filter((p) => {
        if (!p.last_seen) return true;
        return new Date(p.last_seen).getTime() > cutoff;
      });
      setParticipants(activeParticipants);
    }
    setLoading(false);
  }, [channelId]);

  // Load and poll participants
  useEffect(() => {
    setLoading(true);
    setError('');
    fetchParticipants();

    const interval = setInterval(() => {
      fetchParticipants();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchParticipants]);

  // ---------- realtime subscription for participants ----------
  useEffect(() => {
    if (!channelId) return;

    const channel = supabase
      .channel(`voice_participants_panel:${channelId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'voice_participants',
        },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            if (payload.new.channel_id === channelId) {
              fetchParticipants();
            }
          } else if (payload.eventType === 'DELETE') {
            const deletedId = payload.old.id;
            const deletedParticipant = participantsRef.current.find(p => p.id === deletedId);
            
            if (deletedParticipant && deletedParticipant.user_id !== userId) {
              console.log("Voice participant left");
              new Audio('/sounds/user-leave.mp3').play().catch(e => console.error("Audio play error:", e));
            }

            setParticipants((prev) => {
              const exists = prev.some((p) => p.id === deletedId);
              if (exists) {
                return prev.filter((p) => p.id !== deletedId);
              }
              return prev;
            });
            fetchParticipants();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [channelId, fetchParticipants, userId]);

  const handleJoin = async () => {
    try {
      await voiceSession.handleJoin(channelId, channelName, activeServerId);
      fetchParticipants();
    } catch (err) {
      setError(voiceSession.error || 'Failed to join voice channel.');
    }
  };

  const handleLeave = async () => {
    await voiceSession.handleLeave();
    fetchParticipants();
  };

  const formatJoinTime = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="voice-panel" id="voice-panel">
      {/* Header */}
      <div className="voice-panel__header">
        {onMobileBack && (
          <button id="voice-mobile-back-button" className="voice-panel__mobile-back" onClick={onMobileBack} aria-label="Back to channels" title="Back to channels">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        <div className="voice-panel__header-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        </div>
        <div className="voice-panel__header-info">
          <h2 className="voice-panel__channel-name">{channelName}</h2>
          <span className="voice-panel__server-name">{serverName}</span>
        </div>
        <span className="voice-panel__participant-count">
          {activeParticipants.length} {activeParticipants.length === 1 ? 'user' : 'users'}
        </span>
      </div>

      {/* Error */}
      {(error || voiceSession.error) && (
        <div className="voice-panel__error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span>{error || voiceSession.error}</span>
          <button className="voice-panel__error-dismiss" onClick={() => setError('')}>×</button>
        </div>
      )}

      {/* Controls */}
      <div className="voice-panel__controls">
        {!isJoinedHere ? (
          <button
            className="voice-panel__btn voice-panel__btn--join"
            onClick={handleJoin}
            disabled={joining}
          >
            {joining ? (
              <>
                <svg className="spinner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Joining…
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94" />
                  <path d="M1 1l22 22" />
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3" />
                </svg>
                Join Voice
              </>
            )}
          </button>
        ) : (
          <div className="voice-panel__joined-controls">
            <button
              className={`voice-panel__btn voice-panel__btn--mute ${isMuted ? 'voice-panel__btn--muted' : ''}`}
              onClick={voiceSession.handleToggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                  Unmute
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                  Mute
                </>
              )}
            </button>
            <button
              className="voice-panel__btn voice-panel__btn--leave"
              onClick={handleLeave}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                <line x1="23" y1="1" x2="1" y2="23" />
              </svg>
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* Participants list */}
      <div className="voice-panel__participants">
        <div className="voice-panel__participants-header">
          <span>IN VOICE — {activeParticipants.length}</span>
        </div>

        {activeLoading ? (
          <div className="voice-panel__loading">
            <svg className="spinner-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span>Loading participants…</span>
          </div>
        ) : activeParticipants.length === 0 ? (
          <div className="voice-panel__empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            <p>No one is in this voice channel yet.</p>
            <p className="voice-panel__empty-sub">Click "Join Voice" to be the first!</p>
          </div>
        ) : (
          <div className="voice-panel__list">
            {activeParticipants.map((p) => {
              const username = p.profiles?.username || 'Unknown';
              const avatarUrl = p.profiles?.avatar_url;
              const initial = username[0]?.toUpperCase() || '?';
              const isMe = p.user_id === userId;

              return (
                <div
                  className={`voice-participant ${isMe ? 'voice-participant--me' : ''}`}
                  key={p.id}
                >
                  {/* Avatar */}
                  <div className="voice-participant__avatar-wrapper">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt={username}
                        className="voice-participant__avatar"
                      />
                    ) : (
                      <div className="voice-participant__avatar voice-participant__avatar--fallback">
                        {initial}
                      </div>
                    )}
                    {!p.is_muted && (
                      <div className="voice-participant__ring" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="voice-participant__info">
                    <span className="voice-participant__name">
                      {username}
                      {isMe && <span className="voice-participant__you-badge">You</span>}
                    </span>
                    <span className="voice-participant__meta">
                      Joined at {formatJoinTime(p.joined_at)}
                    </span>
                  </div>

                  {/* Muted icon */}
                  {p.is_muted && (
                    <div className="voice-participant__muted-icon" title="Muted">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="1" y1="1" x2="23" y2="23" />
                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" />
                        <line x1="12" y1="19" x2="12" y2="23" />
                        <line x1="8" y1="23" x2="16" y2="23" />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Status bar */}
      {isJoinedHere && (
        <div className="voice-panel__status-bar">
          <div className={`voice-panel__status-dot ${isMuted ? 'voice-panel__status-dot--muted' : 'voice-panel__status-dot--connected'}`} />
          <span>
            {isMuted ? 'Muted' : (voiceSession.callStatus || 'Connected')} to {channelName}
            {voiceSession.micConnected && (
              <span className="voice-panel__status-mic" style={{ color: 'var(--online, #10B981)', marginLeft: '6px', fontWeight: '500' }}>
                • Mic connected
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
