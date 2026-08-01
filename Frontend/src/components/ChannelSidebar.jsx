import { useState, useEffect, useCallback } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { supabase } from '../lib/supabase';
import VoiceSessionBar from './VoiceSessionBar';
import { hasServerPermission } from '../lib/permissions';

function HashIcon() {
  return <span className="channel-item__hash">#</span>;
}

function VoiceIcon() {
  return (
    <svg className="channel-item__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function ChannelItemContents({ channel, voiceCount = 0 }) {
  return (
    <>
      {channel.type === 'voice' ? <VoiceIcon /> : <HashIcon />}
      <span className="channel-item__name">{channel.name}</span>
      {channel.type === 'voice' && voiceCount > 0 && (
        <span className="channel-item__voice-count" title={`${voiceCount} connected`}>
          {voiceCount}
        </span>
      )}
    </>
  );
}

function StaticChannelItem({ channel, activeChannelId, onSelectChannel, voiceCount }) {
  return (
    <button
      className={`channel-item ${channel.type === 'voice' ? 'channel-item--voice' : ''} ${activeChannelId === channel.id ? 'channel-item--active' : ''}`}
      onClick={() => onSelectChannel(channel.id, channel.name, channel.type)}
    >
      <ChannelItemContents channel={channel} voiceCount={voiceCount} />
    </button>
  );
}

function SortableChannelItem({
  channel,
  activeChannelId,
  onSelectChannel,
  voiceCount,
  disabled,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: channel.id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 2 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`channel-item channel-item--sortable ${channel.type === 'voice' ? 'channel-item--voice' : ''} ${activeChannelId === channel.id ? 'channel-item--active' : ''}`}
    >
      <button
        className="channel-item__select"
        onClick={() => onSelectChannel(channel.id, channel.name, channel.type)}
      >
        <ChannelItemContents channel={channel} voiceCount={voiceCount} />
      </button>
      <button
        type="button"
        className="channel-item__drag-handle"
        aria-label={`Reorder ${channel.name}`}
        title="Drag to reorder"
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="5" r="1.5" />
          <circle cx="16" cy="5" r="1.5" />
          <circle cx="8" cy="12" r="1.5" />
          <circle cx="16" cy="12" r="1.5" />
          <circle cx="8" cy="19" r="1.5" />
          <circle cx="16" cy="19" r="1.5" />
        </svg>
      </button>
    </div>
  );
}

function SortableChannelList({
  channels,
  activeChannelId,
  onSelectChannel,
  voiceCounts,
  onReorderChannel,
  reorderBusy,
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async ({ active, over }) => {
    if (!over || active.id === over.id || reorderBusy) return;

    const oldIndex = channels.findIndex((channel) => channel.id === active.id);
    const newIndex = channels.findIndex((channel) => channel.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(channels, oldIndex, newIndex);
    const movedIndex = reordered.findIndex((channel) => channel.id === active.id);
    const beforeChannelId = reordered[movedIndex - 1]?.id || null;
    const afterChannelId = reordered[movedIndex + 1]?.id || null;

    await onReorderChannel(active.id, beforeChannelId, afterChannelId);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={channels.map((channel) => channel.id)}
        strategy={verticalListSortingStrategy}
      >
        {channels.map((channel) => (
          <SortableChannelItem
            key={channel.id}
            channel={channel}
            activeChannelId={activeChannelId}
            onSelectChannel={onSelectChannel}
            voiceCount={voiceCounts[channel.id] || 0}
            disabled={reorderBusy}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

export default function ChannelSidebar({
  serverId, serverName, serverDescription, channels, channelsLoading, channelsError,
  activeChannelId, onSelectChannel, onCreateChannel, onReorderChannel,
  voiceSession,
  currentRole,
  onOpenSettings,
  onLeaveServer,
  workspace,
  onOpenAdvancedSearch,
  createFormOpen,
  onCreateFormOpenChange,
}) {
  const [localCreateFormOpen, setLocalCreateFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [newChannelType, setNewChannelType] = useState('text');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [reorderError, setReorderError] = useState('');
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState('');

  const showForm = createFormOpen ?? localCreateFormOpen;
  const setShowForm = onCreateFormOpenChange ?? setLocalCreateFormOpen;

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
    Promise.resolve().then(() => {
      fetchVoiceCounts();
    });
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

  const handleCancelCreate = () => {
    setShowForm(false);
    setName('');
    setErr(null);
    setNewChannelType('text');
  };

  const handleReorder = async (channelId, beforeChannelId, afterChannelId) => {
    if (!onReorderChannel || reorderBusy) return;
    setReorderBusy(true);
    setReorderError('');
    const result = await onReorderChannel(channelId, beforeChannelId, afterChannelId);
    if (!result?.success) {
      setReorderError(result?.error || 'Channel order changed. Please try again.');
    }
    setReorderBusy(false);
  };

  const handleLeaveServer = async () => {
    if (!onLeaveServer || leaving || currentRole === 'owner') return;
    setLeaving(true);
    setLeaveError('');
    const result = await onLeaveServer();
    if (result?.success) {
      setLeaveConfirmOpen(false);
      setServerMenuOpen(false);
    } else {
      setLeaveError(result?.error || 'Could not leave the server. Please try again.');
    }
    setLeaving(false);
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
  const canManageChannels = hasServerPermission(currentRole, 'manage_channels');
  const canManageServer = hasServerPermission(currentRole, 'manage_server');
  const visibleServerDescription = typeof serverDescription === 'string'
    ? serverDescription.trim()
    : '';

  return (
    <aside className="channel-sidebar" id="channel-sidebar">
      <div className="channel-sidebar__header">
        <div className="channel-sidebar__identity">
          <span className="channel-sidebar__title">{serverName || 'Server'}</span>
          {visibleServerDescription && (
            <span className="channel-sidebar__description" title={visibleServerDescription}>
              {visibleServerDescription}
            </span>
          )}
        </div>
        {canManageServer && (
          <button className="channel-settings-btn" onClick={onOpenSettings} title="Server settings" aria-label="Server settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}
        <div className="server-header-menu">
          <button
            type="button"
            className="channel-settings-btn"
            onClick={() => setServerMenuOpen((open) => !open)}
            title="Server menu"
            aria-label="Server menu"
            aria-expanded={serverMenuOpen}
          >
            <span aria-hidden="true">•••</span>
          </button>
          {serverMenuOpen && (
            <div className="server-header-menu__popover" role="menu">
              <button
                type="button"
                className="server-header-menu__leave"
                role="menuitem"
                disabled={currentRole === 'owner'}
                onClick={() => {
                  setLeaveError('');
                  setLeaveConfirmOpen(true);
                  setServerMenuOpen(false);
                }}
              >
                Leave server
              </button>
              {currentRole === 'owner' && (
                <p className="server-header-menu__note">
                  Transfer ownership or delete the server before leaving.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <nav className="channel-sidebar__list">
        <button
          type="button"
          className={`advanced-search-nav ${workspace === 'advanced-search' ? 'advanced-search-nav--active' : ''}`}
          onClick={onOpenAdvancedSearch}
          aria-current={workspace === 'advanced-search' ? 'page' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <span>
            <strong>Advanced Search</strong>
            <small>Search this server</small>
          </span>
        </button>

        {channelsLoading && <div className="channel-sidebar__empty"><p>Loading channels…</p></div>}
        {channelsError && !channelsLoading && <div className="channel-sidebar__empty"><p style={{ color: 'var(--error-color)' }}>Error: {channelsError}</p></div>}
        {!channelsLoading && !channelsError && channels.length === 0 && <div className="channel-sidebar__empty"><p>No channels yet</p></div>}

        {!channelsLoading && textCh.length > 0 && (
          <div className="channel-category">
            <div className="channel-category__header">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
              <span>Text Channels</span>
            </div>
            {canManageChannels ? (
              <SortableChannelList
                channels={textCh}
                activeChannelId={activeChannelId}
                onSelectChannel={onSelectChannel}
                voiceCounts={voiceCounts}
                onReorderChannel={handleReorder}
                reorderBusy={reorderBusy}
              />
            ) : (
              textCh.map((channel) => (
                <StaticChannelItem
                  key={channel.id}
                  channel={channel}
                  activeChannelId={activeChannelId}
                  onSelectChannel={onSelectChannel}
                  voiceCount={0}
                />
              ))
            )}
          </div>
        )}

        {!channelsLoading && voiceCh.length > 0 && (
          <div className="channel-category">
            <div className="channel-category__header">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
              <span>Voice Channels</span>
            </div>
            {canManageChannels ? (
              <SortableChannelList
                channels={voiceCh}
                activeChannelId={activeChannelId}
                onSelectChannel={onSelectChannel}
                voiceCounts={voiceCounts}
                onReorderChannel={handleReorder}
                reorderBusy={reorderBusy}
              />
            ) : (
              voiceCh.map((channel) => (
                <StaticChannelItem
                  key={channel.id}
                  channel={channel}
                  activeChannelId={activeChannelId}
                  onSelectChannel={onSelectChannel}
                  voiceCount={voiceCounts[channel.id] || 0}
                />
              ))
            )}
          </div>
        )}

        {reorderError && (
          <div className="channel-reorder-error" role="status">
            {reorderError}
          </div>
        )}

        {!channelsLoading && canManageChannels && (
          <div className="channel-sidebar__create">
            {!showForm ? (
              <button className="channel-create-btn" onClick={() => setShowForm(true)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Add channel</span>
              </button>
            ) : (
              <form
                className="channel-create-form"
                onSubmit={handleCreate}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !creating) {
                    event.preventDefault();
                    handleCancelCreate();
                  }
                }}
              >
                <h3 className="channel-create-form__title">Create channel</h3>
                <label className="channel-create-form__label" htmlFor="new-channel-name">
                  Channel name
                </label>
                <input
                  id="new-channel-name"
                  className="channel-create-form__input"
                  type="text"
                  placeholder="new-channel"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  disabled={creating}
                />

                <fieldset className="channel-create-form__type-fieldset">
                  <legend className="channel-create-form__label">Channel type</legend>
                  <div className="channel-type-toggle">
                    <button
                      type="button"
                      className={`channel-type-toggle__btn ${newChannelType === 'text' ? 'channel-type-toggle__btn--active' : ''}`}
                      onClick={() => setNewChannelType('text')}
                      disabled={creating}
                      aria-pressed={newChannelType === 'text'}
                    >
                      <span className="channel-type-toggle__hash" aria-hidden="true">#</span>
                      Text
                    </button>
                    <button
                      type="button"
                      className={`channel-type-toggle__btn ${newChannelType === 'voice' ? 'channel-type-toggle__btn--active' : ''}`}
                      onClick={() => setNewChannelType('voice')}
                      disabled={creating}
                      aria-pressed={newChannelType === 'voice'}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                      Voice
                    </button>
                  </div>
                </fieldset>

                {err && <div className="channel-create-form__error" role="alert">{err}</div>}

                <div className="channel-create-form__actions">
                  <button
                    type="submit"
                    className="channel-create-form__submit"
                    disabled={creating || !name.trim()}
                  >
                    {creating ? 'Creating…' : 'Create channel'}
                  </button>
                  <button
                    type="button"
                    className="channel-create-form__cancel"
                    onClick={handleCancelCreate}
                    disabled={creating}
                  >
                    Cancel
                  </button>
                </div>
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
      {leaveConfirmOpen && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!leaving) setLeaveConfirmOpen(false);
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-server-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="leave-server-title" className="modal-card__title">
              Leave {serverName || 'server'}?
            </h3>
            <p className="modal-card__desc">
              You will lose access to this server. Your historical messages,
              resources, and ratings will remain.
            </p>
            {leaveError && (
              <div className="settings-error" role="alert">{leaveError}</div>
            )}
            <div className="modal-card__actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={leaving}
                onClick={() => setLeaveConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary server-leave-confirm"
                disabled={leaving}
                onClick={handleLeaveServer}
              >
                {leaving ? 'Leaving…' : 'Leave server'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
