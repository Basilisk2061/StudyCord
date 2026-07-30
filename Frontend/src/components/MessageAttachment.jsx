/**
 * MessageAttachment — renders image previews or document download cards
 * inside chat messages. Keeps the current dark theme.
 */
import { useState } from 'react';

const IMAGE_TYPES = ['image/png', 'image/jpg', 'image/jpeg', 'image/gif', 'image/webp'];

/** Human-readable file size */
function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Derive a short label from the MIME type */
function prettyType(mime) {
  if (!mime) return 'FILE';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('word') || mime.includes('docx')) return 'DOCX';
  if (mime.includes('presentation') || mime.includes('pptx')) return 'PPTX';
  if (mime.includes('text/plain')) return 'TXT';
  return mime.split('/').pop()?.toUpperCase() || 'FILE';
}

/** Icon for document types */
function DocTypeIcon({ fileType }) {
  const label = prettyType(fileType);

  // Color by type
  const colors = {
    PDF: '#EF4444',
    DOCX: '#3B82F6',
    PPTX: '#F97316',
    TXT: '#9CA3AF',
  };
  const color = colors[label] || '#6B7280';

  return (
    <div className="attachment-doc__icon" style={{ borderColor: color }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="attachment-doc__badge" style={{ backgroundColor: color }}>{label}</span>
    </div>
  );
}

export default function MessageAttachment({
  attachment,
  resourceMetadata = null,
  onOpenResource,
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  if (!attachment) return null;

  const { file_name, file_url, file_type, file_size } = attachment;
  const isImage = IMAGE_TYPES.includes(file_type);

  /* ---- Image attachment ---- */
  if (isImage) {
    return (
      <>
        <div className="attachment-image" onClick={() => setLightboxOpen(true)}>
          <img
            src={file_url}
            alt={file_name}
            className="attachment-image__img"
            loading="lazy"
          />
          <div className="attachment-image__overlay">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </div>
        </div>

        {/* Lightbox */}
        {lightboxOpen && (
          <div className="attachment-lightbox" onClick={() => setLightboxOpen(false)}>
            <button className="attachment-lightbox__close" onClick={() => setLightboxOpen(false)} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <img src={file_url} alt={file_name} className="attachment-lightbox__img" onClick={(e) => e.stopPropagation()} />
            <div className="attachment-lightbox__info" onClick={(e) => e.stopPropagation()}>
              <span>{file_name}</span>
              <a href={file_url} target="_blank" rel="noopener noreferrer" className="attachment-lightbox__download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download
              </a>
            </div>
          </div>
        )}
      </>
    );
  }

  /* ---- Document attachment ---- */
  return (
    <div className="attachment-doc">
      <DocTypeIcon fileType={file_type} />
      <div className="attachment-doc__info">
        <span className="attachment-doc__name" title={file_name}>{file_name}</span>
        {resourceMetadata && (
          <span className="attachment-doc__rating">
            {resourceMetadata.rating_count > 0
              ? `★ ${Number(resourceMetadata.average_rating).toFixed(1)} (${resourceMetadata.rating_count} ${resourceMetadata.rating_count === 1 ? 'rating' : 'ratings'})`
              : 'Not rated yet'}
          </span>
        )}
        <span className="attachment-doc__meta">{prettyType(file_type)} · {formatFileSize(file_size)}</span>
      </div>
      {resourceMetadata && (
        <button
          type="button"
          className="attachment-doc__open"
          onClick={() => onOpenResource?.(resourceMetadata)}
        >
          Open resource
        </button>
      )}
      <a
        href={file_url}
        target="_blank"
        rel="noopener noreferrer"
        className="attachment-doc__download"
        title="Download file"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </a>
    </div>
  );
}
