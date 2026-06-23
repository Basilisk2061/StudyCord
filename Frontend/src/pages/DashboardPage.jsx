import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import ServerSidebar from '../components/ServerSidebar';
import ChannelSidebar from '../components/ChannelSidebar';
import MainPanel from '../components/MainPanel';
import VoicePanel from '../components/VoicePanel';
import RightPanel from '../components/RightPanel';

function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export default function DashboardPage() {
  const { session } = useAuth();
  const user = session?.user;

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
          profiles (
            username,
            full_name,
            avatar_url
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

    // Log the user ID as requested for verification
    console.log('Creating server for user ID:', user.id);

    try {
      // Step 1: Ensure profile exists (upsert — idempotent)
      const username = user.email.split('@')[0];
      const { error: profileErr } = await supabase
        .from('profiles')
        .upsert(
          { id: user.id, email: user.email, username },
          { onConflict: 'id' }
        );

      if (profileErr) throw new Error(`profile error: ${profileErr.message}`);

      // Generate a unique 6-character invite code
      const inviteCode = generateInviteCode();

      // Step 2: Insert server with owner_id and invite_code
      const { data: newServer, error: srvErr } = await supabase
        .from('servers')
        .insert({
          name: serverName.trim(),
          owner_id: user.id,
          invite_code: inviteCode
        })
        .select()
        .single();

      if (srvErr) throw new Error(`server error: ${srvErr.message}`);

      // Step 3: Insert owner membership
      const { error: memErr } = await supabase
        .from('server_members')
        .insert({ server_id: newServer.id, user_id: user.id, role: 'owner' });

      if (memErr) throw new Error(`member error: ${memErr.message}`);

      // Step 4: Create default channels
      const defaultChannels = ['general', 'assignments', 'resources'];
      const channelRows = defaultChannels.map((name) => ({
        server_id: newServer.id,
        name,
        type: 'text',
      }));

      const { error: chErr } = await supabase
        .from('channels')
        .insert(channelRows);

      if (chErr) throw new Error(`channel error: ${chErr.message}`);

      // Step 5: Refresh servers list and auto-select new server
      await fetchServers();
      setActiveServerId(newServer.id);
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
      const { error } = await supabase
        .from('channels')
        .insert({
          server_id: activeServerId,
          name: channelName.trim().toLowerCase().replace(/\s+/g, '-'),
          type: channelType,
        });

      if (error) throw error;

      // Refresh channels
      await fetchChannels(activeServerId);

      return { success: true };
    } catch (err) {
      console.error('Failed to create channel:', err);
      return { success: false, error: err.message };
    }
  };

  // ──────────────────────────────────────────────
  // 5b. Join a server via invite code
  // ──────────────────────────────────────────────
  const handleJoinServer = async (inviteCode) => {
    if (!user || !inviteCode.trim()) return;

    const cleanCode = inviteCode.trim().toUpperCase();

    try {
      // Step 1: Find server by invite code
      const { data: server, error: serverErr } = await supabase
        .from('servers')
        .select('*')
        .eq('invite_code', cleanCode)
        .maybeSingle();

      if (serverErr) throw serverErr;
      if (!server) {
        return { success: false, error: 'Invalid invite code. Server not found.' };
      }

      // Step 2: Check if already a member
      const { data: existingMember, error: memberCheckErr } = await supabase
        .from('server_members')
        .select('*')
        .eq('server_id', server.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (memberCheckErr) throw memberCheckErr;

      if (existingMember) {
        // Already joined — select it and return success
        setActiveServerId(server.id);
        setActiveChannelId(null);
        setActiveChannelName(null);
        setActiveChannelType(null);
        return { success: true, message: 'You are already a member of this server!' };
      }

      // Step 3: Insert membership
      const { error: joinErr } = await supabase
        .from('server_members')
        .insert({
          server_id: server.id,
          user_id: user.id,
          role: 'member'
        });

      if (joinErr) throw joinErr;

      // Step 4: Refresh servers and auto-select
      await fetchServers();
      setActiveServerId(server.id);
      setActiveChannelId(null);
      setActiveChannelName(null);
      setActiveChannelType(null);

      return { success: true };
    } catch (err) {
      console.error('Failed to join server:', err);
      return { success: false, error: err.message };
    }
  };

  // ──────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────
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

  // ──────────────────────────────────────────────
  // Derived state
  // ──────────────────────────────────────────────
  const activeServer = servers.find((s) => s.id === activeServerId);
  const activeServerName = activeServer?.name || null;
  const activeServerInviteCode = activeServer?.invite_code || null;

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
      />
    </div>
  );
}
