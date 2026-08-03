import MessageAttachment from './MessageAttachment';


export function PinIcon({ size = 15 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M5 17h14" />
      <path d="M6 3h12l-2 7 3 3H5l3-3-2-7z" />
    </svg>
  );
}


function formatTimestamp(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString();
}


export default function PinnedMessagesPanel({
  pins,
  loading,
  error,
  canManagePins,
  pendingMessageId,
  resourceMetadataById,
  onClose,
  onJump,
  onUnpin,
  onOpenResource,
}) {
  return (
    <div className="pinned-panel__backdrop" onClick={onClose}>
      <aside
        className="pinned-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pinned-panel-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pinned-panel__header">
          <div>
            <h3 id="pinned-panel-title">
              <PinIcon size={16} />
              Pinned Messages
            </h3>
            <p>Messages pinned in this channel</p>
          </div>
          <button
            type="button"
            className="pinned-panel__close"
            onClick={onClose}
            aria-label="Close pinned messages"
          >
            ×
          </button>
        </header>

        <div className="pinned-panel__body">
          {loading && (
            <div className="pinned-panel__state">Loading pinned messages…</div>
          )}
          {!loading && error && (
            <div className="pinned-panel__error" role="alert">{error}</div>
          )}
          {!loading && !error && pins.length === 0 && (
            <div className="pinned-panel__state">No pinned messages yet.</div>
          )}

          {!loading && pins.map((pin) => {
            const resourceMetadata = pin.attachment?.resource_id
              ? resourceMetadataById[pin.attachment.resource_id] || null
              : null;
            return (
              <article className="pinned-entry" key={pin.message_id}>
                <div className="pinned-entry__author">
                  {pin.author_avatar_url ? (
                    <img src={pin.author_avatar_url} alt="" />
                  ) : (
                    <span>{pin.author_username?.[0]?.toUpperCase() || '?'}</span>
                  )}
                  <div>
                    <strong>{pin.author_username || 'Unknown'}</strong>
                    <time dateTime={pin.message_created_at}>
                      {formatTimestamp(pin.message_created_at)}
                    </time>
                  </div>
                </div>

                {pin.content && (
                  <p className="pinned-entry__content">{pin.content}</p>
                )}
                {pin.attachment && (
                  <MessageAttachment
                    attachment={pin.attachment}
                    resourceMetadata={resourceMetadata}
                    onOpenResource={onOpenResource}
                  />
                )}

                <div className="pinned-entry__metadata">
                  <span>
                    Pinned {formatTimestamp(pin.pinned_at)}
                    {pin.pinned_by_username
                      ? ` by ${pin.pinned_by_username}`
                      : ''}
                  </span>
                </div>

                <div className="pinned-entry__actions">
                  <button
                    type="button"
                    className="settings-link-btn"
                    onClick={() => onJump(pin.message_id)}
                  >
                    Jump to message
                  </button>
                  {canManagePins && (
                    <button
                      type="button"
                      className="settings-link-btn settings-link-btn--danger"
                      disabled={pendingMessageId === pin.message_id}
                      onClick={() => onUnpin(pin.message_id)}
                    >
                      {pendingMessageId === pin.message_id
                        ? 'Unpinning…'
                        : 'Unpin'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
