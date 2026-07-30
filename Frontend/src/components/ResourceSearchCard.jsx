import { formatResourceFileSize } from '../lib/rag2Api';

function typeLabel(value) {
  return String(value || 'file').toUpperCase();
}

export default function ResourceSearchCard({
  resource,
  isBestMatch,
  onOpen,
}) {
  const fileSize = formatResourceFileSize(resource.size_bytes);
  const showOriginalFilename = (
    resource.original_filename
    && resource.original_filename !== resource.title
  );

  return (
    <article className="resource-search-card">
      <div className="resource-search-card__header">
        <div className="resource-search-card__identity">
          <span className={`resource-search-card__type resource-search-card__type--${resource.detected_type}`}>
            {typeLabel(resource.detected_type)}
          </span>
          <div className="resource-search-card__titles">
            <h3>{resource.title}</h3>
            {showOriginalFilename && (
              <div className="resource-search-card__filename" title={resource.original_filename}>
                {resource.original_filename}
              </div>
            )}
          </div>
        </div>
        {isBestMatch && (
          <span className="resource-search-card__best-match">Best match</span>
        )}
      </div>

      <div className="resource-search-card__meta">
        {fileSize && <span>{fileSize}</span>}
        <span>
          {resource.rating_count > 0
            ? `★ ${Number(resource.average_rating).toFixed(1)} (${resource.rating_count} rating${resource.rating_count === 1 ? '' : 's'})`
            : 'Not rated yet'}
        </span>
      </div>

      <blockquote className="resource-search-card__snippet">
        {resource.best_match?.snippet}
      </blockquote>

      <button
        type="button"
        className="resource-search-card__open"
        onClick={() => onOpen(resource.resource_id)}
      >
        Open resource
      </button>
    </article>
  );
}
