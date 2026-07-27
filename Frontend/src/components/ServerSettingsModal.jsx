import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';
import {
  getServerIconPublicUrl,
  validateServerIcon,
} from '../lib/serverIcons';
import { canManageTargetMember, hasServerPermission } from '../lib/permissions';

function displayProfile(profile) {
  return profile?.full_name || profile?.username || profile?.email || 'Unknown user';
}

function initials(name) {
  return (name || '?').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function MemberAvatar({ profile }) {
  const name = displayProfile(profile);
  if (profile?.avatar_url) {
    return <img className="settings-avatar" src={profile.avatar_url} alt={name} />;
  }
  return <div className="settings-avatar settings-avatar--fallback">{initials(name)}</div>;
}

function ServerIconPreview({ serverName, iconPath }) {
  const [imageFailed, setImageFailed] = useState(false);
  const iconUrl = getServerIconPublicUrl(iconPath);

  if (iconUrl && !imageFailed) {
    return (
      <img
        className="settings-server-icon-preview"
        src={iconUrl}
        alt={`${serverName} icon`}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <div className="settings-server-icon-preview settings-server-icon-preview--fallback">
      {initials(serverName)}
    </div>
  );
}

export default function ServerSettingsModal({
  server,
  members,
  currentUserId,
  currentRole,
  onClose,
  onRefresh,
  onServerRemoved,
  notify,
}) {
  const [activeTab, setActiveTab] = useState('overview');
  const [name, setName] = useState(server?.name || '');
  const [description, setDescription] = useState(server?.description || '');
  const [bans, setBans] = useState([]);
  const [bansLoading, setBansLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [reasonByUser, setReasonByUser] = useState({});
  const [transferTarget, setTransferTarget] = useState('');
  const [transferPhrase, setTransferPhrase] = useState('');
  const [deletePhrase, setDeletePhrase] = useState('');
  const iconInputRef = useRef(null);

  const canManageServer = hasServerPermission(currentRole, 'manage_server');
  const isOwner = currentRole === 'owner';

  const ownerCandidates = useMemo(
    () => members.filter((member) => member.user_id !== currentUserId && member.role !== 'owner'),
    [currentUserId, members]
  );

  useEffect(() => {
    if (activeTab !== 'bans' || !isOwner) return;
    let ignore = false;
    async function loadBans() {
      setBansLoading(true);
      setError('');
      try {
        const data = await apiRequest(`/api/servers/${server.id}/bans`);
        if (!ignore) setBans(data.bans || []);
      } catch (err) {
        if (!ignore) setError(err.message);
      } finally {
        if (!ignore) setBansLoading(false);
      }
    }
    loadBans();
    return () => {
      ignore = true;
    };
  }, [activeTab, isOwner, server.id]);

  async function runAction(key, successMessage, action, refresh = true) {
    setBusyKey(key);
    setError('');
    try {
      await action();
      notify(successMessage);
      if (refresh) await onRefresh();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusyKey('');
    }
  }

  async function saveOverview(e) {
    e.preventDefault();
    await runAction('overview', 'Server settings updated', async () => {
      await apiRequest(`/api/servers/${server.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, description }),
      });
    });
  }

  async function uploadServerIcon(file) {
    if (!file || busyKey) return;
    setBusyKey('icon-upload');
    setError('');

    try {
      await validateServerIcon(file);
      const formData = new FormData();
      formData.append('file', file);
      await apiRequest(`/api/servers/${server.id}/icon`, {
        method: 'PUT',
        body: formData,
      });
      await onRefresh();
      notify(server.icon_path ? 'Server icon changed' : 'Server icon added');
    } catch (uploadError) {
      setError(uploadError.message || 'Failed to update the server icon.');
    } finally {
      setBusyKey('');
    }
  }

  async function removeServerIcon() {
    const oldIconPath = server.icon_path;
    if (!oldIconPath || busyKey) return;

    setBusyKey('icon-remove');
    setError('');
    try {
      await apiRequest(`/api/servers/${server.id}/icon`, { method: 'DELETE' });
      await onRefresh();
      notify('Server icon removed');
    } catch (removeError) {
      setError(removeError.message || 'Failed to remove the server icon.');
    } finally {
      setBusyKey('');
    }
  }

  async function regenerateInvite() {
    await runAction('invite', 'Invite code regenerated', async () => {
      await apiRequest(`/api/servers/${server.id}/regenerate-invite`, { method: 'POST', body: '{}' });
    });
  }

  async function changeRole(member, role) {
    await runAction(`role:${member.user_id}`, role === 'admin' ? 'Member promoted to admin' : 'Member demoted to member', async () => {
      await apiRequest(`/api/servers/${server.id}/members/${member.user_id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    });
  }

  async function kick(member) {
    await runAction(`kick:${member.user_id}`, 'Member kicked', async () => {
      await apiRequest(`/api/servers/${server.id}/members/${member.user_id}/kick`, {
        method: 'POST',
        body: JSON.stringify({ reason: reasonByUser[member.user_id] || null }),
      });
    });
  }

  async function ban(member) {
    await runAction(`ban:${member.user_id}`, 'Member banned', async () => {
      await apiRequest(`/api/servers/${server.id}/members/${member.user_id}/ban`, {
        method: 'POST',
        body: JSON.stringify({ reason: reasonByUser[member.user_id] || null }),
      });
    });
  }

  async function unban(banRow) {
    const ok = await runAction(`unban:${banRow.user_id}`, 'User unbanned', async () => {
      await apiRequest(`/api/servers/${server.id}/bans/${banRow.user_id}`, { method: 'DELETE' });
    }, false);
    if (ok) setBans((prev) => prev.filter((banItem) => banItem.user_id !== banRow.user_id));
  }

  async function transferOwnership(e) {
    e.preventDefault();
    if (transferPhrase !== 'TRANSFER' || !transferTarget) return;
    const ok = await runAction('transfer', 'Ownership transferred', async () => {
      await apiRequest(`/api/servers/${server.id}/transfer-ownership`, {
        method: 'POST',
        body: JSON.stringify({ new_owner_id: transferTarget }),
      });
    });
    if (ok) {
      setTransferPhrase('');
      setTransferTarget('');
    }
  }

  async function deleteServer(e) {
    e.preventDefault();
    if (deletePhrase !== server.name) return;
    const ok = await runAction('delete', 'Server deleted', async () => {
      await apiRequest(`/api/servers/${server.id}`, { method: 'DELETE' });
    }, false);
    if (ok) {
      onServerRemoved(server.id);
      onClose();
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <h2 className="settings-title">Server Settings</h2>
          {['overview', 'members', 'bans', 'danger'].map((tab) => (
            <button
              key={tab}
              className={`settings-tab ${activeTab === tab ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab(tab)}
              disabled={tab === 'bans' && !isOwner}
            >
              {tab === 'danger' ? 'Danger Zone' : tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </aside>

        <section className="settings-content">
          <header className="settings-content__header">
            <h3>{activeTab === 'danger' ? 'Danger Zone' : activeTab[0].toUpperCase() + activeTab.slice(1)}</h3>
            <button className="settings-icon-btn" onClick={onClose} title="Close" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </header>

          {error && <div className="settings-error">{error}</div>}

          {activeTab === 'overview' && (
            canManageServer ? (
              <form className="settings-stack" onSubmit={saveOverview}>
                <div className="settings-server-icon-section">
                  <label className="form-label">Server Icon</label>
                  <div className="settings-server-icon-row">
                    <ServerIconPreview
                      key={server.icon_path || 'initials'}
                      serverName={server.name}
                      iconPath={server.icon_path}
                    />
                    <div className="settings-server-icon-controls">
                      <span className="settings-server-icon-name">{server.name}</span>
                      <span className="settings-muted">JPEG, PNG, or WebP. Maximum 2 MB.</span>
                      <div className="settings-server-icon-actions">
                        <input
                          ref={iconInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          hidden
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) uploadServerIcon(file);
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary settings-btn settings-icon-action"
                          onClick={() => iconInputRef.current?.click()}
                          disabled={Boolean(busyKey)}
                        >
                          {busyKey === 'icon-upload'
                            ? 'Uploading...'
                            : server.icon_path
                              ? 'Change Icon'
                              : 'Upload Icon'}
                        </button>
                        {server.icon_path && (
                          <button
                            type="button"
                            className="settings-link-btn settings-link-btn--danger"
                            onClick={removeServerIcon}
                            disabled={Boolean(busyKey)}
                          >
                            {busyKey === 'icon-remove' ? 'Removing...' : 'Remove Icon'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <label className="form-label">Server Name</label>
                <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} disabled={busyKey === 'overview'} />
                <label className="form-label">Description</label>
                <textarea className="form-input settings-textarea" value={description} onChange={(e) => setDescription(e.target.value)} disabled={busyKey === 'overview'} />
                <div className="settings-row">
                  <button className="btn btn-primary settings-btn" disabled={busyKey === 'overview' || !name.trim()}>
                    {busyKey === 'overview' ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button type="button" className="btn btn-secondary settings-btn" onClick={regenerateInvite} disabled={busyKey === 'invite'}>
                    {busyKey === 'invite' ? 'Regenerating...' : 'Regenerate Invite'}
                  </button>
                </div>
              </form>
            ) : (
              <p className="settings-muted">You do not have permission to manage this server.</p>
            )
          )}

          {activeTab === 'members' && (
            <div className="settings-stack">
              {members.length === 0 && <p className="settings-muted">No members found.</p>}
              {members.map((member) => {
                const profile = member.profiles || {};
                const canRole = canManageTargetMember(currentRole, member.role, currentUserId, member.user_id, 'role');
                const canKick = canManageTargetMember(currentRole, member.role, currentUserId, member.user_id, 'kick');
                const canBan = canManageTargetMember(currentRole, member.role, currentUserId, member.user_id, 'ban');
                return (
                  <div className="settings-member" key={member.user_id}>
                    <MemberAvatar profile={profile} />
                    <div className="settings-member__body">
                      <span className="settings-member__name">{displayProfile(profile)}</span>
                      <span className="settings-muted">{profile.username || profile.email || member.user_id}</span>
                    </div>
                    <span className="settings-role">{member.role}</span>
                    {(canRole || canKick || canBan) && (
                      <div className="settings-actions">
                        {canRole && member.role === 'member' && <button className="settings-link-btn" disabled={busyKey === `role:${member.user_id}`} onClick={() => changeRole(member, 'admin')}>Promote</button>}
                        {canRole && member.role === 'admin' && <button className="settings-link-btn" disabled={busyKey === `role:${member.user_id}`} onClick={() => changeRole(member, 'member')}>Demote</button>}
                        {canKick && <button className="settings-link-btn" disabled={busyKey === `kick:${member.user_id}`} onClick={() => kick(member)}>Kick</button>}
                        {canBan && <button className="settings-link-btn settings-link-btn--danger" disabled={busyKey === `ban:${member.user_id}`} onClick={() => ban(member)}>Ban</button>}
                      </div>
                    )}
                    {(canKick || canBan) && (
                      <input
                        className="form-input settings-reason"
                        placeholder="Optional reason"
                        value={reasonByUser[member.user_id] || ''}
                        onChange={(e) => setReasonByUser((prev) => ({ ...prev, [member.user_id]: e.target.value }))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'bans' && (
            isOwner ? (
              <div className="settings-stack">
                {bansLoading && <p className="settings-muted">Loading bans...</p>}
                {!bansLoading && bans.length === 0 && <p className="settings-muted">No banned users.</p>}
                {bans.map((ban) => (
                  <div className="settings-ban" key={ban.id}>
                    <MemberAvatar profile={ban.profile} />
                    <div className="settings-member__body">
                      <span className="settings-member__name">{displayProfile(ban.profile)}</span>
                      <span className="settings-muted">{ban.reason || 'No reason provided'}</span>
                    </div>
                    <button className="settings-link-btn" disabled={busyKey === `unban:${ban.user_id}`} onClick={() => unban(ban)}>Unban</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="settings-muted">Only the server owner can view bans.</p>
            )
          )}

          {activeTab === 'danger' && (
            isOwner ? (
              <div className="settings-stack">
                <form className="settings-danger-box" onSubmit={transferOwnership}>
                  <h4>Transfer Ownership</h4>
                  <select className="form-input" value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)}>
                    <option value="">Select new owner</option>
                    {ownerCandidates.map((member) => <option key={member.user_id} value={member.user_id}>{displayProfile(member.profiles)}</option>)}
                  </select>
                  <input className="form-input" placeholder="Type TRANSFER" value={transferPhrase} onChange={(e) => setTransferPhrase(e.target.value)} />
                  <button className="btn btn-secondary settings-btn" disabled={busyKey === 'transfer' || transferPhrase !== 'TRANSFER' || !transferTarget}>Transfer Ownership</button>
                </form>
                <form className="settings-danger-box" onSubmit={deleteServer}>
                  <h4>Delete Server</h4>
                  <input className="form-input" placeholder={server.name} value={deletePhrase} onChange={(e) => setDeletePhrase(e.target.value)} />
                  <button className="btn btn-secondary settings-btn settings-btn--danger" disabled={busyKey === 'delete' || deletePhrase !== server.name}>Delete Server</button>
                </form>
              </div>
            ) : (
              <p className="settings-muted">Only the server owner can use these actions.</p>
            )
          )}
        </section>
      </div>
    </div>
  );
}
