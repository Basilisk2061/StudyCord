/**
 * VoicePanel — shows voice channel participants, join/leave/mute controls.
 * No actual WebRTC audio yet — this is the presence system only.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

export default function VoicePanel({
  channelId, channelName, serverName, activeServerId, userId, profile, onMobileBack,
}) {
  // ---------- state ----------
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [micConnected, setMicConnected] = useState(false);
  const [callStatus, setCallStatus] = useState('');

  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({});
  const participantsRef = useRef(participants);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Derived: is current user in this voice channel?
  const myParticipant = participants.find((p) => p.user_id === userId);
  const isJoined = !!myParticipant;
  const isMuted = myParticipant?.is_muted ?? false;

  // ---------- local audio stream helpers ----------
  const cleanupLocalAudio = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    setMicConnected(false);
  }, []);

  const initLocalAudio = useCallback(async (currentMuteState) => {
    try {
      // Clean up any existing audio stream first
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      setMicConnected(false);
      setError('');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      setMicConnected(true);

      // Apply initial mute state to the audio tracks
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !currentMuteState;
      });
    } catch (err) {
      console.error('Microphone access denied or failed:', err);
      setMicConnected(false);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setError('Microphone permission denied. Please allow microphone access to use voice channels.');
      } else {
        setError('Failed to access microphone. Please check your audio devices.');
      }
      throw err;
    }
  }, []);

  // ---------- WebRTC signaling & peer connection helpers ----------

  const updateCallStatus = useCallback(() => {
    const connections = Object.values(peerConnectionsRef.current);
    if (connections.length === 0) {
      setCallStatus('');
      return;
    }

    const states = connections.map((pc) => pc.iceConnectionState);
    if (states.includes('connected')) {
      setCallStatus('Voice connected');
    } else if (states.some((s) => s === 'checking' || s === 'new')) {
      setCallStatus('Connecting...');
    } else if (states.every((s) => s === 'failed' || s === 'disconnected' || s === 'closed')) {
      setCallStatus('Disconnected');
    }
  }, []);

  const cleanupPeerConnection = useCallback((otherUserId) => {
    console.log(`[WebRTC] Cleaning up connection for user: ${otherUserId}`);
    const pc = peerConnectionsRef.current[otherUserId];
    if (pc) {
      try {
        pc.close();
      } catch (e) {}
      delete peerConnectionsRef.current[otherUserId];
    }

    // Remove remote audio element
    const audioEl = document.getElementById(`remote-audio-${otherUserId}`);
    if (audioEl) {
      try {
        audioEl.srcObject = null;
        audioEl.remove();
      } catch (e) {}
    }
    updateCallStatus();
  }, [updateCallStatus]);

  const cleanupAllCalls = useCallback(() => {
    console.log('[WebRTC] Cleaning up all active peer connections');
    Object.keys(peerConnectionsRef.current).forEach((otherUserId) => {
      cleanupPeerConnection(otherUserId);
    });
    setCallStatus('');
  }, [cleanupPeerConnection]);

  const sendSignal = useCallback(async (receiverId, signalType, signalData) => {
    if (!channelId || !activeServerId || !userId) return;
    console.log(`[WebRTC] Sending signaling data (${signalType}) to user ${receiverId}`);
    const { error: signalErr } = await supabase
      .from('voice_signals')
      .insert({
        server_id: activeServerId,
        channel_id: channelId,
        sender_id: userId,
        receiver_id: receiverId,
        signal_type: signalType,
        signal_data: signalData
      });

    if (signalErr) {
      console.error(`[WebRTC] Failed to send signal ${signalType} to ${receiverId}:`, signalErr);
    }
  }, [channelId, activeServerId, userId]);

  const createPeerConnection = useCallback((otherUserId) => {
    console.log(`[WebRTC] Initializing RTCPeerConnection for user: ${otherUserId}`);

    // Clean up any existing connection with this user
    if (peerConnectionsRef.current[otherUserId]) {
      cleanupPeerConnection(otherUserId);
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    });

    peerConnectionsRef.current[otherUserId] = pc;

    // Add local tracks
    if (localStreamRef.current) {
      console.log(`[WebRTC] Adding local audio tracks to peer connection for ${otherUserId}`);
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    } else {
      console.warn(`[WebRTC] localStreamRef.current is empty when building connection for ${otherUserId}`);
    }

    // ICE Candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[WebRTC] Sending local ICE candidate to user ${otherUserId}`);
        sendSignal(otherUserId, 'ice-candidate', event.candidate);
      }
    };

    // Connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state change for user ${otherUserId}: ${pc.iceConnectionState}`);
      updateCallStatus();
    };

    // Incoming remote track handler
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Remote media track arrived from user ${otherUserId}`);
      const remoteStream = event.streams[0];

      let audioEl = document.getElementById(`remote-audio-${otherUserId}`);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `remote-audio-${otherUserId}`;
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = remoteStream;
      setCallStatus('Voice connected');
    };

    return pc;
  }, [sendSignal, cleanupPeerConnection, updateCallStatus]);

  const handleOffer = useCallback(async (senderId, offerSdp) => {
    console.log(`[WebRTC] Processing incoming offer from user: ${senderId}`);
    let pc = peerConnectionsRef.current[senderId];
    if (!pc) {
      pc = createPeerConnection(senderId);
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(senderId, 'answer', answer);
    } catch (err) {
      console.error(`[WebRTC] Error handling offer from user ${senderId}:`, err);
    }
  }, [createPeerConnection, sendSignal]);

  const handleAnswer = useCallback(async (senderId, answerSdp) => {
    console.log(`[WebRTC] Processing incoming answer from user: ${senderId}`);
    const pc = peerConnectionsRef.current[senderId];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
      } catch (err) {
        console.error(`[WebRTC] Error setting remote answer for user ${senderId}:`, err);
      }
    } else {
      console.warn(`[WebRTC] RTCPeerConnection not found when handling answer from user: ${senderId}`);
    }
  }, []);

  const handleIceCandidate = useCallback(async (senderId, candidateData) => {
    console.log(`[WebRTC] Processing incoming ICE candidate from user: ${senderId}`);
    const pc = peerConnectionsRef.current[senderId];
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidateData));
      } catch (err) {
        console.error(`[WebRTC] Error adding ICE candidate for user ${senderId}:`, err);
      }
    } else {
      console.warn(`[WebRTC] RTCPeerConnection not found when adding ICE candidate from user: ${senderId}`);
    }
  }, []);

  const handleIncomingSignal = useCallback(async (signal) => {
    const { sender_id, signal_type, signal_data } = signal;
    console.log(`[WebRTC] Received incoming signal type ${signal_type} from sender ${sender_id}`);

    if (signal_type === 'offer') {
      await handleOffer(sender_id, signal_data);
    } else if (signal_type === 'answer') {
      await handleAnswer(sender_id, signal_data);
    } else if (signal_type === 'ice-candidate') {
      await handleIceCandidate(sender_id, signal_data);
    }
  }, [handleOffer, handleAnswer, handleIceCandidate]);

  // React to changes in isJoined and isMuted to manage mic state and track activation
  useEffect(() => {
    if (isJoined) {
      if (!localStreamRef.current) {
        initLocalAudio(isMuted).catch((err) => {
          console.error('Auto-initialization of local audio failed:', err);
        });
      } else {
        // Toggle track enablement based on isMuted state
        localStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = !isMuted;
        });
      }
    } else {
      cleanupLocalAudio();
    }
  }, [isJoined, isMuted, initLocalAudio, cleanupLocalAudio]);

  // Clean up all local audio tracks and peer connections on component unmount
  useEffect(() => {
    return () => {
      cleanupLocalAudio();
      cleanupAllCalls();
    };
  }, [cleanupLocalAudio, cleanupAllCalls]);

  // ---------- signaling subscription ----------
  useEffect(() => {
    if (!channelId || !isJoined || !userId) return;

    console.log(`[WebRTC] Subscribing to voice_signals for channel ${channelId}, receiver ${userId}`);

    const channel = supabase
      .channel(`voice_signals:${channelId}:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'voice_signals',
          filter: `receiver_id=eq.${userId}`,
        },
        (payload) => {
          const signal = payload.new;
          if (signal.channel_id === channelId) {
            handleIncomingSignal(signal);
          }
        }
      )
      .subscribe();

    return () => {
      console.log(`[WebRTC] Unsubscribing from voice_signals for channel ${channelId}`);
      supabase.removeChannel(channel);
    };
  }, [channelId, isJoined, userId, handleIncomingSignal]);

  // ---------- call initialization & tracking ----------
  useEffect(() => {
    if (!isJoined || !micConnected) {
      cleanupAllCalls();
      return;
    }

    const startConnections = async () => {
      for (const p of participants) {
        if (p.user_id === userId) continue;

        const otherUserId = p.user_id;

        // If a connection doesn't exist yet, we decide who initiates
        if (!peerConnectionsRef.current[otherUserId]) {
          // Offerer is lexicographically smaller user_id
          if (userId < otherUserId) {
            console.log(`[WebRTC] We are smaller ID. Initiating peer connection and sending offer to ${otherUserId}`);
            const pc = createPeerConnection(otherUserId);
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await sendSignal(otherUserId, 'offer', offer);
            } catch (err) {
              console.error(`[WebRTC] Error creating or sending offer to ${otherUserId}:`, err);
            }
          } else {
            console.log(`[WebRTC] We are larger ID. Waiting for offer from ${otherUserId}`);
          }
        }
      }
    };

    startConnections();

    // Clean up connections for participants who left the channel
    const currentParticipantIds = new Set(participants.map((p) => p.user_id));
    Object.keys(peerConnectionsRef.current).forEach((otherUserId) => {
      if (!currentParticipantIds.has(otherUserId)) {
        console.log(`[WebRTC] User ${otherUserId} is no longer in the participant list. Closing connection.`);
        cleanupPeerConnection(otherUserId);
      }
    });
  }, [participants, isJoined, micConnected, userId, createPeerConnection, sendSignal, cleanupPeerConnection, cleanupAllCalls]);

  // ---------- fetch participants ----------
  const fetchParticipants = useCallback(async () => {
    if (!channelId) return;

    const { data, error: fetchErr } = await supabase
      .from('voice_participants')
      .select(`
        id,
        user_id,
        is_muted,
        joined_at,
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
      setParticipants(data || []);
    }
    setLoading(false);
  }, [channelId]);

  // Load on mount / channel change
  useEffect(() => {
    setLoading(true);
    setError('');
    fetchParticipants();
  }, [fetchParticipants]);

  // ---------- realtime subscription ----------
  useEffect(() => {
    if (!channelId) return;

    const channel = supabase
      .channel(`voice_participants_realtime:${channelId}`)
      .on(
        'postgres_changes',
        {
          event: '*',               // INSERT, UPDATE, DELETE
          schema: 'public',
          table: 'voice_participants',
        },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            if (payload.new.channel_id === channelId) {
              if (payload.eventType === 'INSERT') {
                if (payload.new.user_id !== userId) {
                  console.log("Voice participant joined");
                  new Audio('/sounds/user-join.mp3').play().catch(e => console.error("Audio play error:", e));
                }
              }
              fetchParticipants();
            }
          } else if (payload.eventType === 'DELETE') {
            const deletedId = payload.old.id;
            const deletedParticipant = participantsRef.current.find(p => p.id === deletedId);
            
            if (deletedParticipant && deletedParticipant.user_id !== userId) {
              console.log("Voice participant left");
              new Audio('/sounds/user-leave.mp3').play().catch(e => console.error("Audio play error:", e));
            }

            // Delete payload.old only contains the primary key `id` by default.
            // If the deleted participant is currently in our state, remove it immediately.
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

  // ---------- join voice ----------
  const handleJoin = async () => {
    if (!channelId || !activeServerId || !userId) return;
    setJoining(true);
    setError('');

    try {
      // First request microphone permission
      await initLocalAudio(false);

      // Leave any other voice channel in this server first
      const { error: leaveErr } = await supabase
        .from('voice_participants')
        .delete()
        .eq('server_id', activeServerId)
        .eq('user_id', userId);

      if (leaveErr) console.error('Leave cleanup error:', leaveErr);

      // Join this channel
      const { error: joinErr } = await supabase
        .from('voice_participants')
        .insert({
          server_id: activeServerId,
          channel_id: channelId,
          user_id: userId,
          is_muted: false,
        });

      if (joinErr) {
        // Handle unique constraint (already joined)
        if (joinErr.code === '23505') {
          // Already joined — ignore
        } else {
          throw joinErr;
        }
      }

      await fetchParticipants();
    } catch (err) {
      console.error('Failed to join voice:', err);
      // If error is not a mic permission error (which sets error state in initLocalAudio), set a generic one
      if (err.name !== 'NotAllowedError' && err.name !== 'PermissionDeniedError') {
        setError('Failed to join voice channel.');
      }
      cleanupLocalAudio();
    }

    setJoining(false);
  };

  // ---------- leave voice ----------
  const handleLeave = async () => {
    if (!channelId || !userId) return;
    setError('');

    // Stop local audio tracks and peer connections
    cleanupLocalAudio();
    cleanupAllCalls();

    // Update local state immediately
    setParticipants((prev) => prev.filter((p) => p.user_id !== userId));

    const { error: leaveErr } = await supabase
      .from('voice_participants')
      .delete()
      .eq('channel_id', channelId)
      .eq('user_id', userId);

    if (leaveErr) {
      console.error('Failed to leave voice:', leaveErr);
      setError('Failed to leave voice channel.');
      fetchParticipants();
    } else {
      fetchParticipants();
    }
  };

  // ---------- toggle mute ----------
  const handleToggleMute = async () => {
    if (!myParticipant) return;
    setError('');

    const { error: muteErr } = await supabase
      .from('voice_participants')
      .update({ is_muted: !isMuted })
      .eq('id', myParticipant.id);

    if (muteErr) {
      console.error('Failed to toggle mute:', muteErr);
      setError('Failed to change mute state.');
    }
    // Realtime will update
  };

  // ---------- format join time ----------
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
          {participants.length} {participants.length === 1 ? 'user' : 'users'}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="voice-panel__error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span>{error}</span>
          <button className="voice-panel__error-dismiss" onClick={() => setError('')}>×</button>
        </div>
      )}

      {/* Controls */}
      <div className="voice-panel__controls">
        {!isJoined ? (
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
              onClick={handleToggleMute}
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
          <span>IN VOICE — {participants.length}</span>
        </div>

        {loading ? (
          <div className="voice-panel__loading">
            <svg className="spinner-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span>Loading participants…</span>
          </div>
        ) : participants.length === 0 ? (
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
            {participants.map((p) => {
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
                    {/* Speaking ring placeholder (no audio yet) */}
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
      {isJoined && (
        <div className="voice-panel__status-bar">
          <div className={`voice-panel__status-dot ${isMuted ? 'voice-panel__status-dot--muted' : 'voice-panel__status-dot--connected'}`} />
          <span>
            {isMuted ? 'Muted' : (callStatus || 'Connected')} to {channelName}
            {micConnected && (
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
