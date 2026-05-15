import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import ServerSidebar from '../components/ServerSidebar';
import ChannelSidebar from '../components/ChannelSidebar';
import MainPanel from '../components/MainPanel';
import RightPanel from '../components/RightPanel';

export default function DashboardPage() {
  const { session } = useAuth();
  const user = session?.user;

  // ---------- profile ----------
  const [profile, setProfile] = useState(null);

  // ---------- servers ----------
  const [servers, setServers] = useState([]);
  const [serversLoading, setServersLoading] = useState(true);
  const [serversError, setServersError] = useState(null);

  // ---------- channels ----------
  const [channels, setChannels] = useState([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState(null);

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
    setServersLoading(true);
    setServersError(null);

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
    setChannelsLoading(true);
    setChannelsError(null);

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
    fetchChannels(activeServerId);
  }, [activeServerId, fetchChannels]);

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

      // Step 2: Insert server with owner_id
      const { data: newServer, error: srvErr } = await supabase
        .from('servers')
        .insert({ name: serverName.trim(), owner_id: user.id })
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
  const handleCreateChannel = async (channelName) => {
    if (!activeServerId || !channelName.trim()) return;

    try {
      const { error } = await supabase
        .from('channels')
        .insert({
          server_id: activeServerId,
          name: channelName.trim().toLowerCase().replace(/\s+/g, '-'),
          type: 'text',
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
      />
      <RightPanel />
    </div>
  );
}
