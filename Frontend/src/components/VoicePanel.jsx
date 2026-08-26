/**
 * VoicePanel — shows voice channel participants, join/leave/mute controls.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

function VideoStream({
  stream,
  muted = false,
  mirrored = false,
  screenContent = false,
  playRemoteMedia,
  forgetRemoteMediaElement,
}) {
  const mediaRef = useRef(null);

  useEffect(() => {
    const mediaElement = mediaRef.current;
    if (!mediaElement) return;

    mediaElement.srcObject = stream || null;
    if (stream) {
      if (muted) {
        mediaElement.play().catch((err) => {
          console.error('[WebRTC] Local video preview playback failed:', err);
        });
      } else {
        playRemoteMedia(mediaElement);
      }
    }

    return () => {
      if (!muted) {
        forgetRemoteMediaElement(mediaElement);
      }
      mediaElement.srcObject = null;
    };
  }, [stream, muted, playRemoteMedia, forgetRemoteMediaElement]);

  return (
    <video
      ref={mediaRef}
      className={[
        'voice-video-tile__video',
        mirrored ? 'voice-video-tile__video--mirrored' : '',
        screenContent ? 'voice-video-tile__video--screen' : '',
      ].filter(Boolean).join(' ')}
      autoPlay
      playsInline
      muted={muted}
    />
  );
}

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
  const [screenShareViewMode, setScreenShareViewMode] = useState('focused');
  const [focusedScreenShareUserId, setFocusedScreenShareUserId] = useState(null);
  const [fullscreenShareUserId, setFullscreenShareUserId] = useState(null);
  const [screenShareModalOpen, setScreenShareModalOpen] = useState(false);
  const [shareSystemAudio, setShareSystemAudio] = useState(true);

  const participantsRef = useRef(participants);
  const previousRemoteShareIdsRef = useRef([]);
  const screenShareFocusRef = useRef(null);
  const screenShareTileRefsRef = useRef(new Map());
  const fullscreenReturnToFocusUserIdRef = useRef(null);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Check if current user is joined to this specific channel
  const isJoinedHere = voiceSession.joinedChannelId === channelId;
  const isMuted = voiceSession.isMuted;
  const joining = voiceSession.joining;
  const cameraEnabled = voiceSession.cameraEnabled;

  const activeParticipants = isJoinedHere ? (voiceSession.participants || []) : participants;
  const activeLoading = isJoinedHere ? voiceSession.loading : loading;

  useEffect(() => {
    if (!screenShareModalOpen) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setScreenShareModalOpen(false);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [screenShareModalOpen]);
  const remoteSharingParticipants = activeParticipants.filter((participant) => (
    participant.user_id !== userId
    && voiceSession.remoteScreenShareStates?.[participant.user_id]
  ));
  const remoteShareIdsKey = remoteSharingParticipants
    .map((participant) => participant.user_id)
    .join('|');
  const focusedScreenShareParticipant = remoteSharingParticipants.find(
    (participant) => participant.user_id === focusedScreenShareUserId
  ) || remoteSharingParticipants[0] || null;
  const hasFocusedScreenShare = Boolean(
    focusedScreenShareParticipant && screenShareViewMode === 'focused'
  );

  useEffect(() => {
    const remoteShareIds = remoteShareIdsKey ? remoteShareIdsKey.split('|') : [];
    const previousRemoteShareIds = previousRemoteShareIdsRef.current;
    const newlyStartedShareId = remoteShareIds.find(
      (remoteUserId) => !previousRemoteShareIds.includes(remoteUserId)
    );
    const focusedShareEnded = Boolean(
      focusedScreenShareUserId && !remoteShareIds.includes(focusedScreenShareUserId)
    );
    previousRemoteShareIdsRef.current = remoteShareIds;

    Promise.resolve().then(() => {
      if (
        focusedShareEnded
        && document.fullscreenElement === screenShareFocusRef.current
      ) {
        document.exitFullscreen().catch((err) => {
          console.error('[ScreenShareUI] Failed to exit fullscreen:', err);
        });
      }

      if (remoteShareIds.length === 0) {
        setFocusedScreenShareUserId(null);
        setScreenShareViewMode('focused');
        return;
      }

      if (newlyStartedShareId) {
        setFocusedScreenShareUserId(newlyStartedShareId);
        setScreenShareViewMode('focused');
        return;
      }

      setFocusedScreenShareUserId((currentUserId) => (
        remoteShareIds.includes(currentUserId) ? currentUserId : remoteShareIds[0]
      ));
    });
  }, [focusedScreenShareUserId, remoteShareIdsKey]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (document.fullscreenElement) {
        setFullscreenShareUserId(
          document.fullscreenElement.dataset.screenShareUserId
          || fullscreenReturnToFocusUserIdRef.current
          || null
        );
        return;
      }

      const returnToFocusUserId = fullscreenReturnToFocusUserIdRef.current;
      setFullscreenShareUserId(null);
      fullscreenReturnToFocusUserIdRef.current = null;
      if (returnToFocusUserId) {
        setFocusedScreenShareUserId(returnToFocusUserId);
        setScreenShareViewMode('focused');
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // ---------- fetch participants for this channel ----------
  const fetchParticipants = useCallback(async () => {
    if (!channelId) return;

    // Delete stale rows older than 60 seconds
    const staleTime = new Date(Date.now() - 60000).toISOString();
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
      const cutoff = Date.now() - 45000;
      const rawCount = data ? data.length : 0;
      
      const activeParticipants = (data || []).filter((p) => {
        // 1. Current user is never filtered out
        if (p.user_id === userId) return true;

        // 2. Check last_seen with safe threshold (tolerating future clock drift)
        if (!p.last_seen) return true;
        const lastSeenTime = new Date(p.last_seen).getTime();
        if (lastSeenTime > Date.now()) return true;
        return Date.now() - lastSeenTime < 45000;
      });

      console.log(`[VoicePanelSync] Participants fetched for channel ${channelId}:`, {
        viewingChannelId: channelId,
        currentUserId: userId,
        rawParticipantCount: rawCount,
        filteredParticipantCount: activeParticipants.length,
        participantUserIds: activeParticipants.map(p => p.user_id)
      });

      setParticipants(activeParticipants);
    }
    setLoading(false);
  }, [channelId, userId]);

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
            
            if (deletedParticipant) {
              if (deletedParticipant.user_id !== userId) {
                console.log("Voice participant left");
                new Audio('/sounds/user-leave.mp3').play().catch(e => console.error("Audio play error:", e));
              }

              setParticipants((prev) => prev.filter((p) => p.id !== deletedId));
              fetchParticipants();
            }
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
    setScreenShareModalOpen(false);
    await voiceSession.handleLeave();
    fetchParticipants();
  };

  const openScreenShareModal = () => {
    setShareSystemAudio(true);
    setScreenShareModalOpen(true);
  };

  const handleConfirmScreenShare = async (event) => {
    event.preventDefault();
    setScreenShareModalOpen(false);
    await voiceSession.handleStartScreenShare({ shareSystemAudio });
  };

  const formatJoinTime = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleMinimizeScreenShare = async () => {
    fullscreenReturnToFocusUserIdRef.current = null;
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (err) {
        console.error('[ScreenShareUI] Failed to exit fullscreen:', err);
      }
    }
    setScreenShareViewMode('minimized');
  };

  const handleFocusScreenShare = (remoteUserId) => {
    setFocusedScreenShareUserId(remoteUserId);
    setScreenShareViewMode('focused');
  };

  const handleFullscreenScreenShare = (remoteUserId) => {
    if (!document.fullscreenEnabled) {
      console.error('[ScreenShareUI] Browser fullscreen is not available.');
      return;
    }

    if (document.fullscreenElement) {
      fullscreenReturnToFocusUserIdRef.current = remoteUserId;
      document.exitFullscreen().catch((err) => {
        console.error('[ScreenShareUI] Failed to exit fullscreen:', err);
      });
      return;
    }

    const fullscreenTarget = (
      hasFocusedScreenShare
      && focusedScreenShareParticipant?.user_id === remoteUserId
    )
      ? screenShareFocusRef.current
      : screenShareTileRefsRef.current.get(remoteUserId);
    if (!fullscreenTarget?.requestFullscreen) return;

    fullscreenReturnToFocusUserIdRef.current = remoteUserId;
    fullscreenTarget.requestFullscreen().catch((err) => {
      fullscreenReturnToFocusUserIdRef.current = null;
      console.error('[ScreenShareUI] Failed to enter fullscreen:', err);
    });
  };

  const getParticipantMedia = (participant) => {
    const isMe = participant.user_id === userId;
    const username = participant.profiles?.username || (isMe ? profile?.username : null) || 'Unknown';
    const isSharingScreen = isMe
      ? voiceSession.isScreenSharing
      : Boolean(voiceSession.remoteScreenShareStates?.[participant.user_id]);
    const stream = isMe
      ? (isSharingScreen ? voiceSession.localScreenStream : voiceSession.localVideoStream)
      : voiceSession.remoteStreams?.[participant.user_id];
    const participantCameraState = isMe
      ? cameraEnabled
      : voiceSession.remoteCameraStates?.[participant.user_id];
    const hasLiveVideoTrack = Boolean(
      stream?.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted)
    );

    return {
      isMe,
      username,
      isSharingScreen,
      stream,
      hasLiveVideo: Boolean(
        hasLiveVideoTrack
        && (isSharingScreen || (isMe ? participantCameraState : participantCameraState !== false))
      ),
    };
  };

  const renderScreenShareControls = (remoteUserId, isFocused) => (
    <div className="screen-share-view-controls" aria-label="Screen share view controls">
      {isFocused ? (
        <button
          type="button"
          className="screen-share-view-control"
          onClick={handleMinimizeScreenShare}
          title="Minimize screen share"
          aria-label="Minimize screen share"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          className="screen-share-view-control"
          onClick={() => handleFocusScreenShare(remoteUserId)}
          title="Focus screen share"
          aria-label="Focus screen share"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="screen-share-view-control"
        onClick={() => handleFullscreenScreenShare(remoteUserId)}
        title={fullscreenShareUserId === remoteUserId ? 'Screen share is fullscreen' : 'View screen share fullscreen'}
        aria-label="View screen share fullscreen"
        aria-pressed={fullscreenShareUserId === remoteUserId}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="8 3 3 3 3 8" />
          <polyline points="16 3 21 3 21 8" />
          <polyline points="8 21 3 21 3 16" />
          <polyline points="16 21 21 21 21 16" />
        </svg>
      </button>
    </div>
  );

  const renderParticipantVideoTile = (participant, { compact = false } = {}) => {
    const media = getParticipantMedia(participant);
    const isRemoteScreenShare = media.isSharingScreen && !media.isMe;

    return (
      <div
        ref={(element) => {
          if (!isRemoteScreenShare) return;
          if (element) {
            screenShareTileRefsRef.current.set(participant.user_id, element);
          } else {
            screenShareTileRefsRef.current.delete(participant.user_id);
          }
        }}
        data-screen-share-user-id={isRemoteScreenShare ? participant.user_id : undefined}
        className={[
          'voice-video-tile',
          compact ? 'voice-video-tile--compact' : '',
          media.isSharingScreen ? 'voice-video-tile--screen' : '',
        ].filter(Boolean).join(' ')}
        key={`video-${participant.user_id}`}
      >
        <div className="voice-video-tile__media">
          {media.hasLiveVideo ? (
            <VideoStream
              stream={media.stream}
              muted={media.isMe}
              mirrored={media.isMe && !media.isSharingScreen}
              screenContent={media.isSharingScreen}
              playRemoteMedia={voiceSession.playRemoteMedia}
              forgetRemoteMediaElement={voiceSession.forgetRemoteMediaElement}
            />
          ) : (
            <div className="voice-video-tile__placeholder">
              <span>{media.username[0]?.toUpperCase() || '?'}</span>
              <small>Camera off</small>
            </div>
          )}
          {isRemoteScreenShare && renderScreenShareControls(participant.user_id, false)}
        </div>
        <div className="voice-video-tile__label">
          <span>{media.username}{media.isMe ? ' (You)' : ''}</span>
          <span className="voice-video-tile__status">
            {media.isSharingScreen && <span className="voice-video-tile__sharing">Sharing screen</span>}
            {participant.is_muted && <span className="voice-video-tile__muted">Muted</span>}
          </span>
        </div>
      </div>
    );
  };

  const focusedShareMedia = focusedScreenShareParticipant
    ? getParticipantMedia(focusedScreenShareParticipant)
    : null;
  const filmstripParticipants = focusedScreenShareParticipant
    ? activeParticipants.filter(
      (participant) => participant.user_id !== focusedScreenShareParticipant.user_id
    )
    : activeParticipants;

  return (
    <div
      className={`voice-panel ${hasFocusedScreenShare ? 'voice-panel--share-focused' : ''}`}
      id="voice-panel"
    >
      <style>{`
        @keyframes voiceStatusPulse {
          0% { opacity: 0.5; }
          50% { opacity: 1; }
          100% { opacity: 0.5; }
        }
      `}</style>
      {screenShareModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => setScreenShareModalOpen(false)}
        >
          <form
            className="modal-card screen-share-options-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="screen-share-options-title"
            onSubmit={handleConfirmScreenShare}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="modal-card__title" id="screen-share-options-title">
              Share Screen
            </h3>
            <label className="screen-share-options-modal__option">
              <input
                type="checkbox"
                checked={shareSystemAudio}
                onChange={(event) => setShareSystemAudio(event.target.checked)}
              />
              <span>
                <strong>Share system audio</strong>
                <small>Include audio playing from the shared screen when supported.</small>
              </span>
            </label>
            <div className="modal-card__actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setScreenShareModalOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Start Sharing
              </button>
            </div>
          </form>
        </div>
      )}
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
      {(error || voiceSession.error || voiceSession.cameraError || voiceSession.screenShareError || voiceSession.autoplayWarning) && (
        <div className="voice-panel__error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span>{error || voiceSession.error || voiceSession.cameraError || voiceSession.screenShareError || voiceSession.autoplayWarning}</span>
          <button
            className="voice-panel__error-dismiss"
            onClick={() => {
              setError('');
              voiceSession.setError('');
              voiceSession.setCameraError('');
              voiceSession.setScreenShareError('');
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* TURN Warning */}
      {voiceSession.turnWarning && (
        <div className="voice-panel__warning" style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', border: '1px solid var(--warning, #F59E0B)', color: 'var(--warning, #F59E0B)', padding: '8px 12px', borderRadius: '6px', margin: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>{voiceSession.turnWarning}</span>
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
              className={`voice-panel__btn voice-panel__btn--camera ${cameraEnabled ? 'voice-panel__btn--camera-on' : ''}`}
              onClick={cameraEnabled ? () => voiceSession.handleTurnCameraOff() : voiceSession.handleTurnCameraOn}
              disabled={voiceSession.cameraBusy || voiceSession.screenShareBusy}
              title={cameraEnabled ? 'Turn Camera Off' : 'Turn Camera On'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {cameraEnabled ? (
                  <>
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </>
                ) : (
                  <>
                    <path d="M1 1l22 22" />
                    <path d="M15.5 9.5L23 5v14l-5.2-3.1" />
                    <path d="M13 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" />
                  </>
                )}
              </svg>
              {voiceSession.cameraBusy ? 'Starting Camera...' : (cameraEnabled ? 'Turn Camera Off' : 'Turn Camera On')}
            </button>
            <button
              className={`voice-panel__btn voice-panel__btn--screen ${voiceSession.isScreenSharing ? 'voice-panel__btn--screen-on' : ''}`}
              onClick={voiceSession.isScreenSharing
                ? () => voiceSession.handleStopScreenShare()
                : openScreenShareModal}
              disabled={voiceSession.screenShareBusy || voiceSession.cameraBusy}
              title={voiceSession.isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              {voiceSession.screenShareBusy
                ? 'Starting Share...'
                : (voiceSession.isScreenSharing ? 'Stop Sharing' : 'Share Screen')}
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

      {isJoinedHere && activeParticipants.length > 0 && (
        hasFocusedScreenShare && focusedShareMedia ? (
          <div className="voice-call-workspace" aria-label="Focused screen share">
            <section
              ref={screenShareFocusRef}
              className="screen-share-focus"
              data-screen-share-user-id={focusedScreenShareParticipant.user_id}
              aria-label={`${focusedShareMedia.username} is sharing their screen`}
            >
              <div className="screen-share-focus__media">
                <VideoStream
                  stream={focusedShareMedia.stream}
                  muted={false}
                  mirrored={false}
                  screenContent
                  playRemoteMedia={voiceSession.playRemoteMedia}
                  forgetRemoteMediaElement={voiceSession.forgetRemoteMediaElement}
                />
                <div className="screen-share-focus__identity">
                  <span>{focusedShareMedia.username}</span>
                  <small>Sharing screen</small>
                </div>
                {renderScreenShareControls(focusedScreenShareParticipant.user_id, true)}
              </div>
            </section>
            {filmstripParticipants.length > 0 && (
              <div className="voice-video-filmstrip" aria-label="Call participants">
                {filmstripParticipants.map((participant) => (
                  renderParticipantVideoTile(participant, { compact: true })
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="voice-video-grid" aria-label="Call video">
            {activeParticipants.map((participant) => renderParticipantVideoTile(participant))}
          </div>
        )
      )}

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
              const connStatus = isMe ? 'connected' : (voiceSession.connectionStatuses?.[p.user_id] || 'disconnected');

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
                    <span className="voice-participant__name" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      {username}
                      {isMe && <span className="voice-participant__you-badge">You</span>}
                      {isJoinedHere && (
                        <span 
                          className={`voice-participant__status-badge voice-participant__status-badge--${connStatus}`}
                          style={{
                            fontSize: '9px',
                            padding: '1px 5px',
                            borderRadius: '8px',
                            fontWeight: '600',
                            textTransform: 'uppercase',
                            backgroundColor: connStatus === 'connected' ? 'rgba(16, 185, 129, 0.15)' :
                                             connStatus === 'connecting' ? 'rgba(245, 158, 11, 0.15)' :
                                             connStatus === 'reconnecting' ? 'rgba(245, 158, 11, 0.15)' :
                                             'rgba(107, 114, 128, 0.15)',
                            color: connStatus === 'connected' ? '#10B981' :
                                   connStatus === 'connecting' ? '#F59E0B' :
                                   connStatus === 'reconnecting' ? '#F59E0B' :
                                   '#9CA3AF',
                            animation: connStatus === 'reconnecting' ? 'voiceStatusPulse 1.5s infinite' : 'none'
                          }}
                        >
                          {connStatus}
                        </span>
                      )}
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
