import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import ServerSidebar from '../components/ServerSidebar';
import ChannelSidebar from '../components/ChannelSidebar';
import MainPanel from '../components/MainPanel';
import VoicePanel from '../components/VoicePanel';
import RightPanel from '../components/RightPanel';
import { useVoiceSession } from '../hooks/useVoiceSession';
import ServerSettingsModal from '../components/ServerSettingsModal';
import { apiRequest } from '../lib/api';
import { getCurrentMemberRole } from '../lib/permissions';

export default function DashboardPage() {
  const { session } = useAuth();
  const user = session?.user;

  const voiceSession = useVoiceSession(user?.id);
  const { handleLeave: leaveVoiceSession } = voiceSession;

  // ---------- profile ----------
  const [profile, setProfile] = useState(null);

  // ---------- servers ----------
  const [servers, setServers] = useState([]);
  const [serversLoading, setServersLoading] = useState(true);
  // eslint-disable-next-line no-unused-vars
  const [serversError, setServersError] = useState(null);

  // ---------- channels ----------
  const [channels, setChannels] = useState([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState(null);

  // ---------- members ----------
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [membersError, setMembersError] = useState(null);

  // ---------- selection ----------
  const [activeServerId, setActiveServerId] = useState(null);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [activeChannelName, setActiveChannelName] = useState(null);
  const [activeChannelType, setActiveChannelType] = useState(null);

  // ---------- layout ----------
  const [channelSidebarOpen, setChannelSidebarOpen] = useState(true);
  const [mobilePanelView, setMobilePanelView] = useState('sidebar');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState('');

  // ──────────────────────────────────────────────
  // 1. Ensure profile exists
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const ensureProfile = async () => {
      const { data: existing, error: fetchErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      if (existing) {
        setProfile(existing);
        return;
      }

      // No profile yet — create one
      if (fetchErr && fetchErr.code === 'PGRST116') {
        const username = user.email.split('@')[0];
        const { data: created, error: createErr } = await supabase
          .from('profiles')
          .insert({ id: user.id, email: user.email, username })
          .select()
          .single();

        if (createErr) {
          console.error('Failed to create profile:', createErr);
        } else {
          setProfile(created);
        }
      } else if (fetchErr) {
        console.error('Failed to fetch profile:', fetchErr);
      }
    };

    ensureProfile();
  }, [user]);

  // ──────────────────────────────────────────────
  // 2. Load servers where user is a member
  // ──────────────────────────────────────────────
  const fetchServers = useCallback(async () => {
    if (!user) return;
    Promise.resolve().then(() => {
      setServersLoading(true);
      setServersError(null);
    });

    try {
      // Get server IDs the user belongs to
      const { data: memberships, error: memErr } = await supabase
        .from('server_members')
        .select('server_id')
        .eq('user_id', user.id);

      if (memErr) throw memErr;

      const serverIds = (memberships || []).map((m) => m.server_id);

      if (serverIds.length === 0) {
        setServers([]);
        setServersLoading(false);
        return;
      }

      const { data: serverRows, error: srvErr } = await supabase
        .from('servers')
        .select('*')
        .in('id', serverIds)
        .order('created_at', { ascending: true });

      if (srvErr) throw srvErr;

      setServers(serverRows || []);
    } catch (err) {
      console.error('Failed to load servers:', err);
      setServersError(err.message);
    } finally {
      setServersLoading(false);
    }
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchServers();
  }, [fetchServers]);

  // ──────────────────────────────────────────────
  // 3. Load channels for selected server
  // ──────────────────────────────────────────────
  const fetchChannels = useCallback(async (serverId) => {
    if (!serverId) {
      setChannels([]);
      return;
    }
    Promise.resolve().then(() => {
      setChannelsLoading(true);
      setChannelsError(null);
    });

    try {
      const { data, error } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      setChannels(data || []);
    } catch (err) {
      console.error('Failed to load channels:', err);
      setChannelsError(err.message);
    } finally {
      setChannelsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchChannels(activeServerId);
  }, [activeServerId, fetchChannels]);

  // ──────────────────────────────────────────────
  // 3b. Load members for selected server
  // ──────────────────────────────────────────────
  const fetchMembers = useCallback(async (serverId) => {
    if (!serverId) {
      setMembers([]);
      return;
    }
    Promise.resolve().then(() => {
      setMembersLoading(true);
      setMembersError(null);
    });

    try {
      const { data, error } = await supabase
        .from('server_members')
        .select(`
          role,
          user_id,
          joined_at,
          profiles (
            username,
            full_name,
            avatar_url,
            email
          )
        `)
        .eq('server_id', serverId);

      if (error) throw error;
      setMembers(data || []);
    } catch (err) {
      console.error('Failed to load members:', err);
      setMembersError(err.message);
    } finally {
      setMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMembers(activeServerId);
  }, [activeServerId, fetchMembers]);

  // ──────────────────────────────────────────────
  // 4. Create a new server
  // ──────────────────────────────────────────────
  const handleCreateServer = async (serverName) => {
    if (!user || !serverName.trim()) return;

    try {
      const data = await apiRequest('/api/servers', {
        method: 'POST',
        body: JSON.stringify({ name: serverName }),
      });
      await fetchServers();
      setActiveServerId(data.server.id);
      setActiveChannelId(null);
      setActiveChannelName(null);
      setActiveChannelType(null);

      return { success: true };
    } catch (err) {
      console.error('Server creation failed:', err.message);
      return { success: false, error: err.message };
    }
  };


  // ──────────────────────────────────────────────
  // 5. Create a new channel
  // ──────────────────────────────────────────────
  const handleCreateChannel = async (channelName, channelType = 'text') => {
    if (!activeServerId || !channelName.trim()) return;

    try {
      await apiRequest(`/api/servers/${activeServerId}/channels`, {
        method: 'POST',
        body: JSON.stringify({ name: channelName, type: channelType }),
      });
      await fetchChannels(activeServerId);

      return { success: true };
    } catch (err) {
      console.error('Failed to create channel:', err);
      return { success: false, error: err.message };
    }
  };

  const handleJoinServer = async (inviteCode) => {
    if (!user || !inviteCode.trim()) return;

    try {
      const data = await apiRequest('/api/servers/join', {
        method: 'POST',
        body: JSON.stringify({ invite_code: inviteCode.trim().toUpperCase() }),
      });
      await fetchServers();
      setActiveServerId(data.server.id);
      setActiveChannelId(null);
      setActiveChannelName(null);
      setActiveChannelType(null);

      return { success: true, message: data.message };
    } catch (err) {
      console.error('Failed to join server:', err);
      return { success: false, error: err.message };
    }
  };

  const handleSelectServer = (serverId) => {
    setActiveServerId(serverId);
    setActiveChannelId(null);
    setActiveChannelName(null);
    setActiveChannelType(null);
    setMobilePanelView('sidebar');
  };

  const handleSelectChannel = (channelId, channelName, channelType) => {
    setActiveChannelId(channelId);
    setActiveChannelName(channelName);
    setActiveChannelType(channelType);
    setMobilePanelView('chat');
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const showToast = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  const refreshActiveServerData = useCallback(async () => {
    await Promise.all([
      fetchServers(),
      fetchMembers(activeServerId),
      fetchChannels(activeServerId),
    ]);
  }, [activeServerId, fetchChannels, fetchMembers, fetchServers]);

  const handleServerRemoved = useCallback((serverId) => {
    setServers((prev) => prev.filter((server) => server.id !== serverId));
    if (activeServerId === serverId) {
      setActiveServerId(null);
      setActiveChannelId(null);
      setActiveChannelName(null);
      setActiveChannelType(null);
      leaveVoiceSession?.();
    }
  }, [activeServerId, leaveVoiceSession]);

  useEffect(() => {
    if (!activeServerId || !user?.id) return;

    const channel = supabase
      .channel(`server_membership_watch:${activeServerId}:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'server_members',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          if (payload.old?.server_id === activeServerId) {
            handleServerRemoved(activeServerId);
            showToast('You no longer have access to that server.');
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'server_members',
          filter: `server_id=eq.${activeServerId}`,
        },
        () => fetchMembers(activeServerId)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeServerId, fetchMembers, handleServerRemoved, showToast, user?.id]);

  // ──────────────────────────────────────────────
  // Derived state
  // ──────────────────────────────────────────────
  const activeServer = servers.find((s) => s.id === activeServerId);
  const activeServerName = activeServer?.name || null;
  const activeServerInviteCode = activeServer?.invite_code || null;
  const currentRole = getCurrentMemberRole(members, user?.id);

  const shellClasses = [
    'dashboard-shell',
    !channelSidebarOpen ? 'dashboard-shell--sidebar-collapsed' : '',
    mobilePanelView === 'chat' ? 'dashboard-shell--chat-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClasses} id="dashboard-shell">
      <ServerSidebar
        servers={servers}
        serversLoading={serversLoading}
        activeServerId={activeServerId}
        onSelectServer={handleSelectServer}
        onCreateServer={handleCreateServer}
        onJoinServer={handleJoinServer}
      />
      <ChannelSidebar
        serverId={activeServerId}
        serverName={activeServerName}
        channels={channels}
        channelsLoading={channelsLoading}
        channelsError={channelsError}
        activeChannelId={activeChannelId}
        onSelectChannel={handleSelectChannel}
        onCreateChannel={handleCreateChannel}
        voiceSession={voiceSession}
        currentRole={currentRole}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {activeChannelType === 'voice' ? (
        <VoicePanel
          channelId={activeChannelId}
          channelName={activeChannelName}
          serverName={activeServerName}
          activeServerId={activeServerId}
          userId={user?.id}
          profile={profile}
          onMobileBack={() => setMobilePanelView('sidebar')}
          voiceSession={voiceSession}
        />
      ) : (
        <MainPanel
          serverName={activeServerName}
          channelName={activeChannelName}
          channelType={activeChannelType}
          channelId={activeChannelId}
          userEmail={user?.email}
          profile={profile}
          onLogout={handleLogout}
          channelSidebarOpen={channelSidebarOpen}
          onToggleChannelSidebar={() => setChannelSidebarOpen((p) => !p)}
          onMobileBack={() => setMobilePanelView('sidebar')}
          serversCount={servers.length}
          channelsCount={channels.length}
          activeServerId={activeServerId}
          userId={user?.id}
        />
      )}
      <RightPanel
        activeServerId={activeServerId}
        serverInviteCode={activeServerInviteCode}
        members={members}
        membersLoading={membersLoading}
        profile={profile}
        currentRole={currentRole}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && activeServer && (
        <ServerSettingsModal
          server={activeServer}
          members={members}
          currentUserId={user?.id}
          currentRole={currentRole}
          onClose={() => setSettingsOpen(false)}
          onRefresh={refreshActiveServerData}
          onServerRemoved={handleServerRemoved}
          notify={showToast}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
