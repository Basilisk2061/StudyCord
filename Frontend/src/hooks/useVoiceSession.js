import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

export function useVoiceSession(userId) {
  const [joinedChannelId, setJoinedChannelId] = useState(null);
  const [joinedChannelName, setJoinedChannelName] = useState(null);
  const [joinedServerId, setJoinedServerId] = useState(null);

  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [micConnected, setMicConnected] = useState(false);
  const [callStatus, setCallStatus] = useState('');

  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({});
  const participantsRef = useRef([]);
  const pendingCandidatesRef = useRef({});
  const reconnectTimeoutsRef = useRef({});
  const reconnectingRef = useRef({});
  const iceServersRef = useRef([
    { urls: 'stun:stun.l.google.com:19302' }
  ]);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Derived variables
  const myParticipant = participants.find((p) => p.user_id === userId);
  const isJoined = !!myParticipant;
  const isMuted = myParticipant?.is_muted ?? false;

  const currentChannelIdRef = useRef(joinedChannelId);
  const currentUserIdRef = useRef(userId);
  const isJoinedRef = useRef(isJoined);

  useEffect(() => {
    currentChannelIdRef.current = joinedChannelId;
    currentUserIdRef.current = userId;
    isJoinedRef.current = isJoined;
  }, [joinedChannelId, userId, isJoined]);

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
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      setMicConnected(false);
      setError('');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      setMicConnected(true);

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

    // Clear any pending ICE candidates for this user
    delete pendingCandidatesRef.current[otherUserId];

    // Clear any reconnect timeout for this user
    if (reconnectTimeoutsRef.current[otherUserId]) {
      clearTimeout(reconnectTimeoutsRef.current[otherUserId]);
      delete reconnectTimeoutsRef.current[otherUserId];
    }
    delete reconnectingRef.current[otherUserId];

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
    // Clear all reconnect timeouts first
    Object.keys(reconnectTimeoutsRef.current).forEach((uid) => {
      clearTimeout(reconnectTimeoutsRef.current[uid]);
    });
    reconnectTimeoutsRef.current = {};
    reconnectingRef.current = {};

    Object.keys(peerConnectionsRef.current).forEach((otherUserId) => {
      cleanupPeerConnection(otherUserId);
    });
    setCallStatus('');
  }, [cleanupPeerConnection]);

  const sendSignal = useCallback(async (receiverId, signalType, signalData) => {
    if (!joinedChannelId || !joinedServerId || !userId) return;
    console.log(`[WebRTC] Sending signaling data (${signalType}) to user ${receiverId}`);
    const { error: signalErr } = await supabase
      .from('voice_signals')
      .insert({
        server_id: joinedServerId,
        channel_id: joinedChannelId,
        sender_id: userId,
        receiver_id: receiverId,
        signal_type: signalType,
        signal_data: signalData
      });

    if (signalErr) {
      console.error(`[WebRTC] Failed to send signal ${signalType} to ${receiverId}:`, signalErr);
    }
  }, [joinedChannelId, joinedServerId, userId]);

  const createPeerConnection = useCallback((otherUserId) => {
    console.log(`[WebRTC] Creating peer connection for user: ${otherUserId}`);

    if (peerConnectionsRef.current[otherUserId]) {
      cleanupPeerConnection(otherUserId);
    }

    const rtcConfig = {
      iceServers: iceServersRef.current,
      iceCandidatePoolSize: 10,
    };

    console.log('[WebRTC] RTCPeerConnection config:', JSON.stringify(rtcConfig, null, 2));
    const pc = new RTCPeerConnection(rtcConfig);

    peerConnectionsRef.current[otherUserId] = pc;

    if (localStreamRef.current) {
      console.log(`[WebRTC] Adding local audio tracks to peer connection for ${otherUserId}`);
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    } else {
      console.warn(`[WebRTC] localStreamRef.current is empty when building connection for ${otherUserId}`);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[WebRTC] Sending ICE candidate to user ${otherUserId}`);
        sendSignal(otherUserId, 'ice-candidate', event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      const connState = pc.connectionState;
      console.log(`[WebRTC] Connection state for user ${otherUserId}: ${connState}`);

      // connectionState 'failed' triggers immediate reconnect
      if (connState === 'failed') {
        console.log(`[WebRTC] connectionState failed for ${otherUserId}, triggering reconnect`);
        reconnectPeer(otherUserId);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log(`[WebRTC] Signaling state for user ${otherUserId}: ${pc.signalingState}`);
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[WebRTC] ICE connection state for user ${otherUserId}: ${state}`);

      if (state === 'connected' || state === 'completed') {
        // Connection recovered or established — clear any pending reconnect timer
        if (reconnectTimeoutsRef.current[otherUserId]) {
          console.log(`[WebRTC] ICE recovered for ${otherUserId}, clearing reconnect timer`);
          clearTimeout(reconnectTimeoutsRef.current[otherUserId]);
          delete reconnectTimeoutsRef.current[otherUserId];
        }
        delete reconnectingRef.current[otherUserId];

        if (state === 'connected') {
          pc.getStats().then((stats) => {
            let activeCandidatePair = null;
            stats.forEach((report) => {
              if (report.type === 'candidate-pair' && (report.selected || report.nominated)) {
                activeCandidatePair = report;
              }
            });

            if (activeCandidatePair) {
              const localCandidate = stats.get(activeCandidatePair.localCandidateId);
              const remoteCandidate = stats.get(activeCandidatePair.remoteCandidateId);
              console.log(`[WebRTC] Selected ICE Candidate Pair for user ${otherUserId}:`, {
                local: localCandidate ? {
                  candidateType: localCandidate.candidateType,
                  protocol: localCandidate.protocol,
                  ip: localCandidate.ip || localCandidate.address,
                  port: localCandidate.port,
                } : 'unknown',
                remote: remoteCandidate ? {
                  candidateType: remoteCandidate.candidateType,
                  protocol: remoteCandidate.protocol,
                  ip: remoteCandidate.ip || remoteCandidate.address,
                  port: remoteCandidate.port,
                } : 'unknown',
              });
            }
          }).catch((err) => {
            console.error('[WebRTC] Error getting stats for selected candidate:', err);
          });
        }
      } else if (state === 'disconnected') {
        // Treat disconnected as temporary — wait 5 seconds before reconnecting
        if (!reconnectTimeoutsRef.current[otherUserId]) {
          console.log(`[WebRTC] ICE disconnected for ${otherUserId}, waiting 5s before reconnect`);
          reconnectTimeoutsRef.current[otherUserId] = setTimeout(() => {
            delete reconnectTimeoutsRef.current[otherUserId];
            const currentPc = peerConnectionsRef.current[otherUserId];
            if (currentPc && currentPc.iceConnectionState === 'disconnected') {
              console.log(`[WebRTC] ICE still disconnected for ${otherUserId} after 5s, reconnecting`);
              reconnectPeer(otherUserId);
            }
          }, 5000);
        }
      } else if (state === 'failed') {
        // ICE failed — reconnect immediately
        console.log(`[WebRTC] ICE failed for ${otherUserId}, triggering immediate reconnect`);
        reconnectPeer(otherUserId);
      }

      updateCallStatus();
    };

    pc.ontrack = (event) => {
      console.log(`[WebRTC] Remote track received from user ${otherUserId}, kind: ${event.track.kind}, readyState: ${event.track.readyState}`);
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
      updateCallStatus();
    };

    // Note: buffered ICE candidates are flushed after setRemoteDescription
    // in handleOffer / handleAnswer, not here — the remote description is
    // not yet set when the peer connection is first created.

    return pc;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendSignal, cleanupPeerConnection, updateCallStatus]);

  // ---------- reconnect helper ----------
  const reconnectPeer = useCallback(async (otherUserId) => {
    // Prevent duplicate reconnect attempts
    if (reconnectingRef.current[otherUserId]) {
      console.log(`[WebRTC] Reconnect already in progress for ${otherUserId}, skipping`);
      return;
    }
    reconnectingRef.current[otherUserId] = true;

    // Clear any pending reconnect timeout
    if (reconnectTimeoutsRef.current[otherUserId]) {
      clearTimeout(reconnectTimeoutsRef.current[otherUserId]);
      delete reconnectTimeoutsRef.current[otherUserId];
    }

    console.log(`[WebRTC] Reconnecting peer connection for user ${otherUserId}`);
    cleanupPeerConnection(otherUserId);

    // Only the initiator (smaller userId) re-creates and sends a new offer.
    // The other side will receive the offer via signaling and respond.
    const currentUserId = currentUserIdRef.current;
    if (currentUserId && currentUserId < otherUserId) {
      console.log(`[WebRTC] Re-creating connection and sending new offer to ${otherUserId}`);
      const pc = createPeerConnection(otherUserId);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal(otherUserId, 'offer', offer);
      } catch (err) {
        console.error(`[WebRTC] Error creating/sending reconnect offer to ${otherUserId}:`, err);
      }
    } else {
      console.log(`[WebRTC] Waiting for reconnect offer from ${otherUserId} (they are initiator)`);
    }

    // Allow future reconnects after a cooldown
    setTimeout(() => {
      delete reconnectingRef.current[otherUserId];
    }, 3000);
  }, [cleanupPeerConnection, createPeerConnection, sendSignal]);

  const flushPendingIceCandidates = useCallback(async (pc, otherUserId) => {
    const queued = pendingCandidatesRef.current[otherUserId];
    if (queued && queued.length > 0) {
      console.log(`[WebRTC] Processing buffered ICE candidates (${queued.length}) for user ${otherUserId}`);
      for (const candidateData of queued) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidateData));
          console.log(`[WebRTC] Added buffered ICE candidate for user ${otherUserId}`);
        } catch (err) {
          console.error(`[WebRTC] Error adding buffered ICE candidate for ${otherUserId}:`, err);
        }
      }
      delete pendingCandidatesRef.current[otherUserId];
    }
  }, []);

  const handleOffer = useCallback(async (senderId, offerSdp) => {
    console.log(`[WebRTC] Receiving offer from user: ${senderId}`);
    let pc = peerConnectionsRef.current[senderId];
    if (!pc) {
      pc = createPeerConnection(senderId);
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      await flushPendingIceCandidates(pc, senderId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log(`[WebRTC] Sending answer to user: ${senderId}`);
      await sendSignal(senderId, 'answer', answer);
    } catch (err) {
      console.error(`[WebRTC] Error handling offer from user ${senderId}:`, err);
    }
  }, [createPeerConnection, sendSignal, flushPendingIceCandidates]);

  const handleAnswer = useCallback(async (senderId, answerSdp) => {
    console.log(`[WebRTC] Receiving answer from user: ${senderId}`);
    const pc = peerConnectionsRef.current[senderId];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
        await flushPendingIceCandidates(pc, senderId);
      } catch (err) {
        console.error(`[WebRTC] Error setting remote answer for user ${senderId}:`, err);
      }
    } else {
      console.warn(`[WebRTC] RTCPeerConnection not found when handling answer from user: ${senderId}`);
    }
  }, [flushPendingIceCandidates]);

  const handleIceCandidate = useCallback(async (senderId, candidateData) => {
    const pc = peerConnectionsRef.current[senderId];
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      // Remote description is set — safe to add the candidate immediately
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidateData));
        console.log(`[WebRTC] Added ICE candidate from user ${senderId}`);
      } catch (err) {
        console.error(`[WebRTC] Error adding ICE candidate for user ${senderId}:`, err);
      }
    } else {
      // Buffer the candidate — either the peer connection doesn't exist yet,
      // or setRemoteDescription() hasn't completed
      console.log(`[WebRTC] Buffering ICE candidate from user ${senderId}`);
      if (!pendingCandidatesRef.current[senderId]) {
        pendingCandidatesRef.current[senderId] = [];
      }
      pendingCandidatesRef.current[senderId].push(candidateData);
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

  // ---------- fetch participants ----------
  const fetchParticipants = useCallback(async () => {
    if (!joinedChannelId) return;

    // Delete stale rows older than 20 seconds when loading participants.
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
      .eq('channel_id', joinedChannelId)
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
  }, [joinedChannelId]);

  // ---------- join voice ----------
  const handleJoin = async (channelId, channelName, serverId) => {
    if (!channelId || !serverId || !userId) return;
    setJoining(true);
    setError('');

    try {
      await initLocalAudio(false);

      // Fetch TURN credentials from FastAPI backend
      try {
        console.log('[WebRTC] Fetching TURN credentials from backend...');
        const response = await fetch('http://127.0.0.1:8000/api/turn-credentials');
        if (!response.ok) {
          throw new Error(`Failed to fetch TURN credentials: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        console.log('[WebRTC] TURN credentials fetched successfully:', data);
        iceServersRef.current = data;
      } catch (err) {
        console.warn('[WebRTC] Failed to fetch TURN credentials, falling back to STUN-only:', err);
        iceServersRef.current = [
          { urls: 'stun:stun.l.google.com:19302' }
        ];
      }

      const { error: leaveErr } = await supabase
        .from('voice_participants')
        .delete()
        .eq('server_id', serverId)
        .eq('user_id', userId);

      if (leaveErr) console.error('Leave cleanup error:', leaveErr);

      const { error: joinErr } = await supabase
        .from('voice_participants')
        .insert({
          server_id: serverId,
          channel_id: channelId,
          user_id: userId,
          is_muted: false,
          last_seen: new Date().toISOString(),
        });

      if (joinErr && joinErr.code !== '23505') {
        throw joinErr;
      }

      setJoinedChannelId(channelId);
      setJoinedChannelName(channelName);
      setJoinedServerId(serverId);
    } catch (err) {
      console.error('Failed to join voice:', err);
      if (err.name !== 'NotAllowedError' && err.name !== 'PermissionDeniedError') {
        setError('Failed to join voice channel.');
      }
      cleanupLocalAudio();
    }
    setJoining(false);
  };

  // ---------- leave voice ----------
  const handleLeave = async () => {
    if (!joinedChannelId || !userId) return;
    setError('');

    cleanupLocalAudio();
    cleanupAllCalls();

    setParticipants([]);
    const leavingChannelId = joinedChannelId;

    setJoinedChannelId(null);
    setJoinedChannelName(null);
    setJoinedServerId(null);

    const { error: leaveErr } = await supabase
      .from('voice_participants')
      .delete()
      .eq('channel_id', leavingChannelId)
      .eq('user_id', userId);

    if (leaveErr) {
      console.error('Failed to leave voice:', leaveErr);
      setError('Failed to leave voice channel.');
    }
  };

  // ---------- toggle mute ----------
  const handleToggleMute = async () => {
    if (!myParticipant) return;
    setError('');

    const newMuteState = !isMuted;

    const { error: muteErr } = await supabase
      .from('voice_participants')
      .update({ is_muted: newMuteState })
      .eq('id', myParticipant.id);

    if (muteErr) {
      console.error('Failed to toggle mute:', muteErr);
      setError('Failed to change mute state.');
    }
  };

  // ---------- clean up voice session on unmount or unload ----------
  const cleanupVoiceSession = useCallback(() => {
    if (!isJoinedRef.current || !currentChannelIdRef.current || !currentUserIdRef.current) return;

    isJoinedRef.current = false;
    console.log('[VoicePanel] Cleaning up voice session');

    cleanupLocalAudio();
    cleanupAllCalls();

    supabase
      .from('voice_participants')
      .delete()
      .eq('channel_id', currentChannelIdRef.current)
      .eq('user_id', currentUserIdRef.current)
      .then(({ error }) => {
        if (error) {
          console.error('[VoicePanel] Failed to delete participant on cleanup:', error);
        }
      });
  }, [cleanupLocalAudio, cleanupAllCalls]);

  // React to changes in isJoined and isMuted to manage mic state and track activation
  useEffect(() => {
    if (isJoined) {
      if (!localStreamRef.current) {
        initLocalAudio(isMuted).catch((err) => {
          console.error('Auto-initialization of local audio failed:', err);
        });
      } else {
        localStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = !isMuted;
        });
      }
    } else {
      cleanupLocalAudio();
    }
  }, [isJoined, isMuted, initLocalAudio, cleanupLocalAudio]);

  // Clean up all local audio tracks, peer connections, and database row on component unmount or tab close
  useEffect(() => {
    const handleBeforeUnload = () => {
      cleanupVoiceSession();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cleanupVoiceSession();
    };
  }, [cleanupVoiceSession]);

  // Load and poll participants
  useEffect(() => {
    if (!joinedChannelId) return;
    setLoading(true);
    setError('');
    fetchParticipants();

    const interval = setInterval(() => {
      fetchParticipants();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchParticipants, joinedChannelId]);

  // Heartbeat to update last_seen every 5 seconds when joined
  useEffect(() => {
    if (!isJoined || !joinedChannelId || !userId) return;

    const interval = setInterval(async () => {
      const { error } = await supabase
        .from('voice_participants')
        .update({ last_seen: new Date().toISOString() })
        .eq('channel_id', joinedChannelId)
        .eq('user_id', userId);

      if (error) {
        console.error('[VoicePanel] Heartbeat failed:', error);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isJoined, joinedChannelId, userId]);

  // ---------- WebRTC signaling subscription ----------
  useEffect(() => {
    if (!joinedChannelId || !isJoined || !userId) return;

    console.log(`[WebRTC] Subscribing to voice_signals for channel ${joinedChannelId}, receiver ${userId}`);

    const channel = supabase
      .channel(`voice_signals:${joinedChannelId}:${userId}`)
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
          if (signal.channel_id === joinedChannelId) {
            handleIncomingSignal(signal);
          }
        }
      )
      .subscribe();

    return () => {
      console.log(`[WebRTC] Unsubscribing from voice_signals for channel ${joinedChannelId}`);
      supabase.removeChannel(channel);
    };
  }, [joinedChannelId, isJoined, userId, handleIncomingSignal]);

  // ---------- WebRTC Call initialization & tracking ----------
  useEffect(() => {
    if (!isJoined || !micConnected) {
      cleanupAllCalls();
      return;
    }

    const startConnections = async () => {
      const remoteParticipants = participants.filter((p) => p.user_id !== userId);
      console.log(`[WebRTC] Evaluating connections for ${remoteParticipants.length} remote participant(s)`);

      for (const p of remoteParticipants) {
        const otherUserId = p.user_id;

        // Skip if connection already exists and is in a non-terminal state.
        // 'disconnected' is handled by the reconnect timer inside oniceconnectionstatechange,
        // so we do NOT tear it down here.
        const existingPc = peerConnectionsRef.current[otherUserId];
        if (existingPc) {
          const connState = existingPc.connectionState;
          const iceState = existingPc.iceConnectionState;

          // Only re-establish if connection is truly dead
          const isTerminal = connState === 'failed' || connState === 'closed';
          if (!isTerminal) {
            // Connection is alive, connecting, or temporarily disconnected — leave it alone
            continue;
          }

          console.log(`[WebRTC] Existing connection to ${otherUserId} is terminal (conn=${connState}, ice=${iceState}), re-establishing`);
          cleanupPeerConnection(otherUserId);
        }

        // Deterministic offer rule: smaller userId sends offer
        if (userId < otherUserId) {
          console.log(`[WebRTC] Sending offer to ${otherUserId} (we are initiator)`);
          const pc = createPeerConnection(otherUserId);
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await sendSignal(otherUserId, 'offer', offer);
          } catch (err) {
            console.error(`[WebRTC] Error creating/sending offer to ${otherUserId}:`, err);
          }
        } else {
          console.log(`[WebRTC] Waiting for offer from ${otherUserId} (they are initiator)`);
        }
      }
    };

    startConnections();

    const currentParticipantIds = new Set(participants.map((p) => p.user_id));
    Object.keys(peerConnectionsRef.current).forEach((otherUserId) => {
      if (!currentParticipantIds.has(otherUserId)) {
        console.log(`[WebRTC] User ${otherUserId} is no longer in the participant list. Closing connection.`);
        cleanupPeerConnection(otherUserId);
      }
    });
  }, [participants, isJoined, micConnected, userId, createPeerConnection, sendSignal, cleanupPeerConnection, cleanupAllCalls]);

  // ---------- voice participants realtime subscription ----------
  useEffect(() => {
    if (!joinedChannelId) return;

    const channel = supabase
      .channel(`voice_participants_realtime:${joinedChannelId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'voice_participants',
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            if (payload.new.channel_id === joinedChannelId) {
              // Play join sound for other users
              if (payload.new.user_id !== userId) {
                console.log('Voice participant joined');
                new Audio('/sounds/user-join.mp3').play().catch(e => console.error('Audio play error:', e));
              }
              fetchParticipants();
            }
          } else if (payload.eventType === 'UPDATE') {
            if (payload.new.channel_id === joinedChannelId) {
              fetchParticipants();
            }
          } else if (payload.eventType === 'DELETE') {
            const deletedId = payload.old.id;
            const deletedParticipant = participantsRef.current.find(p => p.id === deletedId);
            
            if (deletedParticipant && deletedParticipant.user_id !== userId) {
              console.log('Voice participant left');
              new Audio('/sounds/user-leave.mp3').play().catch(e => console.error('Audio play error:', e));
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
  }, [joinedChannelId, fetchParticipants, userId]);

  return {
    joinedChannelId,
    joinedChannelName,
    joinedServerId,
    participants,
    loading,
    joining,
    error,
    setError,
    micConnected,
    callStatus,
    isJoined,
    isMuted,
    handleJoin,
    handleLeave,
    handleToggleMute,
  };
}
