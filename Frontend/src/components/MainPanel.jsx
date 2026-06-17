import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function MainPanel({
  serverName, channelName, channelType, channelId, userEmail, profile,
  onLogout, channelSidebarOpen, onToggleChannelSidebar, onMobileBack,
  serversCount, channelsCount, activeServerId, userId,
}) {
  const navigate = useNavigate();
  const hasChannel = channelName && serverName;

  // ---------- messages state ----------
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);

  // ---------- fetch messages when channel changes ----------
  useEffect(() => {
    if (!channelId) {
      setMessages([]);
      return;
    }

    const loadMessages = async () => {
      setMessagesLoading(true);

      const { data, error } = await supabase
        .from('messages')
        .select(`
          id,
          content,
          created_at,
          user_id,
          profiles (
            username,
            avatar_url
          )
        `)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Failed to load messages:', error);
      } else {
        setMessages(data || []);
      }

      setMessagesLoading(false);
    };

    loadMessages();
  }, [channelId]);

  // ---------- Supabase Realtime subscription ----------
  useEffect(() => {
    if (!channelId) return;

    const channel = supabase
      .channel(`messages:channel_id=eq.${channelId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        async (payload) => {
          const newMsg = payload.new;

          // Fetch sender profile
          const { data: profileData } = await supabase
            .from('profiles')
            .select('username, avatar_url')
            .eq('id', newMsg.user_id)
            .single();

          const enrichedMsg = {
            ...newMsg,
            profiles: profileData || { username: 'Unknown', avatar_url: null },
          };

          setMessages((prev) => {
            // Avoid duplicates (e.g. own message already added by send handler)
            if (prev.some((m) => m.id === enrichedMsg.id)) return prev;

            // Insert in correct order by created_at
            const updated = [...prev, enrichedMsg].sort(
              (a, b) => new Date(a.created_at) - new Date(b.created_at)
            );
            return updated;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [channelId]);

  // ---------- scroll to bottom when messages change ----------
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ---------- send a message ----------
  const handleSendMessage = async (e) => {
    e.preventDefault();

    const trimmed = messageText.trim();
    if (!trimmed || !channelId || !activeServerId || !userId) return;

    setSending(true);

    const { error } = await supabase
      .from('messages')
      .insert({
        server_id: activeServerId,
        channel_id: channelId,
        user_id: userId,
        content: trimmed,
      });

    if (error) {
      console.error('Failed to send message:', error);
      setSending(false);
      return;
    }

    // Clear input — realtime subscription will append the new message
    setMessageText('');
    setSending(false);
  };

  // ---------- format timestamp ----------
  const formatTime = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isToday) return `Today at ${time}`;

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;

    return `${date.toLocaleDateString()} ${time}`;
  };

  // ---------- get date label for separator ----------
  const getDateLabel = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) return 'Today';

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  };

  // ---------- build messages with date separators ----------
  const renderMessages = () => {
    if (messagesLoading) {
      return (
        <div className="main-panel__placeholder">
          <div className="main-panel__placeholder-icon">
            <svg className="spinner-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </div>
          <p className="main-panel__placeholder-text">Loading messages…</p>
        </div>
      );
    }

    if (messages.length === 0) {
      return (
        <div className="main-panel__placeholder">
          <div className="main-panel__placeholder-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3 className="main-panel__placeholder-title"># {channelName}</h3>
          <p className="main-panel__placeholder-text">
            This is the start of the channel. Send a message to get the conversation going!
          </p>
        </div>
      );
    }

    const items = [];
    let lastDateLabel = null;

    messages.forEach((msg) => {
      const dateLabel = getDateLabel(msg.created_at);

      // Insert a date separator when the day changes
      if (dateLabel !== lastDateLabel) {
        items.push(
          <div className="message-date-sep" key={`sep-${msg.id}`}>
            <div className="message-date-sep__line" />
            <span className="message-date-sep__label">{dateLabel}</span>
            <div className="message-date-sep__line" />
          </div>
        );
        lastDateLabel = dateLabel;
      }

      const username = msg.profiles?.username || 'Unknown';
      const avatarUrl = msg.profiles?.avatar_url;
      const initial = username[0]?.toUpperCase() || '?';

      items.push(
        <div className="message-row" key={msg.id} id={`message-${msg.id}`}>
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={username}
              className="message-avatar"
              style={{ objectFit: 'cover' }}
            />
          ) : (
            <div
              className="message-avatar"
              style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              {initial}
            </div>
          )}
          <div className="message-body">
            <div className="message-header">
              <span className="message-author">{username}</span>
              <span className="message-time">{formatTime(msg.created_at)}</span>
            </div>
            <div className="message-text">{msg.content}</div>
          </div>
        </div>
      );
    });

    return items;
  };

  return (
    <section className="main-panel" id="main-panel">
      {/* Topbar */}
      <header className="main-panel__topbar">
        <div className="main-panel__topbar-left">
          <button id="mobile-back-button" className="main-panel__mobile-back" onClick={onMobileBack} aria-label="Back to channels" title="Back to channels">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          <button id="sidebar-toggle-button" className="main-panel__sidebar-toggle" onClick={onToggleChannelSidebar} aria-label={channelSidebarOpen ? 'Hide channels' : 'Show channels'} title={channelSidebarOpen ? 'Hide channels' : 'Show channels'}>
            {channelSidebarOpen ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <polyline points="6 9 3 12 6 15" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <polyline points="12 9 15 12 12 15" />
              </svg>
            )}
          </button>

          {hasChannel ? (
            <>
              {channelType === 'voice' ? (
                <svg className="main-panel__channel-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              ) : (
                <span className="main-panel__hash">#</span>
              )}
              <h2 className="main-panel__channel-name">{channelName}</h2>
              <span className="main-panel__server-badge">{serverName}</span>
            </>
          ) : (
            <h2 className="main-panel__channel-name">StudyCord</h2>
          )}
        </div>

        <div className="main-panel__topbar-right">
          <button 
            className="main-panel__profile-btn" 
            onClick={() => navigate('/profile')}
            title="Profile Settings"
          >
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="Avatar" className="main-panel__avatar" />
            ) : (
              <div className="main-panel__avatar-placeholder">
                {profile?.username?.[0]?.toUpperCase() || '?'}
              </div>
            )}
            <span className="main-panel__username">{profile?.username || userEmail}</span>
          </button>
          
          <button id="logout-button" className="btn btn-secondary main-panel__logout" onClick={onLogout}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span className="main-panel__logout-label">Log out</span>
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="main-panel__body">
        {hasChannel ? (
          <>
            {/* Messages area */}
            <div className="main-panel__messages">
              {renderMessages()}
              <div ref={messagesEndRef} />
            </div>

            {/* Compose bar */}
            <div className="main-panel__compose">
              <form className="compose-bar" onSubmit={handleSendMessage}>
                <button type="button" className="compose-bar__add" title="Attach file">+</button>
                <input
                  id="message-input"
                  className="compose-bar__input"
                  type="text"
                  placeholder={`Message #${channelName}`}
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  disabled={sending}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  className="compose-bar__send"
                  disabled={!messageText.trim() || sending}
                  title="Send message"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: messageText.trim() ? 'var(--text-primary)' : 'var(--text-muted)',
                    cursor: messageText.trim() ? 'pointer' : 'default',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    transition: 'color 0.15s ease',
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="main-panel__welcome" style={{ overflow: 'auto', flex: 1 }}>
            <div className="main-panel__welcome-card">
              <h2 className="main-panel__welcome-title">Welcome back!</h2>
              <p className="main-panel__welcome-subtitle">
                Select a server from the sidebar, then pick a channel to get started.
              </p>
              <div className="main-panel__quick-stats">
                <div className="main-panel__stat">
                  <span className="main-panel__stat-value">{serversCount ?? 0}</span>
                  <span className="main-panel__stat-label">Servers</span>
                </div>
                <div className="main-panel__stat">
                  <span className="main-panel__stat-value">{channelsCount ?? 0}</span>
                  <span className="main-panel__stat-label">Channels</span>
                </div>
              </div>
            </div>
            <div className="main-panel__tips">
              <h3 className="main-panel__tips-title">Quick Tips</h3>
              <ul className="main-panel__tips-list">
                <li>Click a server icon on the left to switch servers</li>
                <li>Browse channels in the sidebar to jump into a conversation</li>
                <li>Use the + button to create a new server or channel</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
