import { useEffect, useState } from 'react';
import { apiBlobRequest } from '../lib/api';
import {
  accessResourceFile,
  formatResourceFileSize,
  resourceAccessErrorMessage,
  safeDownloadFilename,
} from '../lib/rag2Api';
import StarRating from './StarRating';

export default function ResourceAccessPanel({
  resource,
  ratingPending,
  ratingError,
  onRate,
  onClearRating,
  onBack,
  backLabel = 'Back to Advanced Search',
  handoffPending,
  handoffError,
  onUseInRag1,
}) {
  const [accessState, setAccessState] = useState({
    loading: true,
    error: '',
    objectUrl: '',
    text: '',
  });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    let active = true;

    accessResourceFile(
      apiBlobRequest,
      resource.resource_id,
      { signal: controller.signal },
    )
      .then(async (blob) => {
        objectUrl = URL.createObjectURL(blob);
        const text = resource.detected_type === 'txt'
          ? await blob.text()
          : '';
        if (active) {
          setAccessState({
            loading: false,
            error: '',
            objectUrl,
            text,
          });
        }
      })
      .catch((error) => {
        if (error?.name !== 'AbortError' && active) {
          setAccessState({
            loading: false,
            error: resourceAccessErrorMessage(error),
            objectUrl: '',
            text: '',
          });
        }
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resource.resource_id, resource.detected_type]);

  const fileSize = formatResourceFileSize(resource.size_bytes);
  const downloadName = safeDownloadFilename(
    resource.original_filename,
    resource.detected_type,
  );
  const aggregateRating = resource.rating_count > 0
    ? `★ ${Number(resource.average_rating).toFixed(1)} (${resource.rating_count} rating${resource.rating_count === 1 ? '' : 's'})`
    : 'Not rated yet';

  return (
    <div className="resource-access">
      <button type="button" className="resource-access__back" onClick={onBack}>
        <span aria-hidden="true">←</span>
        {backLabel}
      </button>

      <header className="resource-access__header">
        <div>
          <span className="resource-access__type">
            {String(resource.detected_type || 'file').toUpperCase()}
          </span>
          <h1>{resource.title}</h1>
          <p>
            {resource.original_filename}
            {fileSize ? ` · ${fileSize}` : ''}
          </p>
        </div>
        <div className="resource-access__aggregate">{aggregateRating}</div>
      </header>

      <section className="resource-access__viewer" aria-live="polite">
        {accessState.loading && (
          <div className="resource-access__state">
            <div className="advanced-search-spinner" aria-hidden="true" />
            <p>Opening resource…</p>
          </div>
        )}

        {!accessState.loading && accessState.error && (
          <div className="resource-access__state resource-access__state--error" role="alert">
            <p>{accessState.error}</p>
            <button type="button" onClick={onBack}>{backLabel}</button>
          </div>
        )}

        {!accessState.loading && !accessState.error && accessState.objectUrl && (
          <>
            {resource.detected_type === 'pdf' && (
              <iframe
                className="resource-access__pdf"
                src={accessState.objectUrl}
                title={`PDF viewer for ${resource.title}`}
              />
            )}
            {resource.detected_type === 'txt' && (
              <pre className="resource-access__text">{accessState.text}</pre>
            )}
            {resource.detected_type === 'docx' && (
              <div className="resource-access__docx">
                <div className="resource-access__document-icon" aria-hidden="true">DOCX</div>
                <h2>Original Word document</h2>
                <p>Download the authenticated original file to read it in a compatible application.</p>
              </div>
            )}
            <div className="resource-access__actions">
              {resource.detected_type === 'pdf' && (
                <a href={accessState.objectUrl} target="_blank" rel="noopener noreferrer">
                  Open PDF in new tab
                </a>
              )}
              <a href={accessState.objectUrl} download={downloadName}>
                Download original
              </a>
              <button
                type="button"
                onClick={onUseInRag1}
                disabled={handoffPending}
              >
                {handoffPending ? 'Preparing AI study session...' : 'Study with AI'}
              </button>
            </div>
            {handoffError && (
              <p className="resource-access__handoff-error" role="alert">
                {handoffError}
              </p>
            )}
          </>
        )}
      </section>

      {!accessState.loading && !accessState.error && (
        <section className="resource-access__rating">
          <div>
            <h2>Was this resource useful?</h2>
            <p>Rating is optional and does not affect semantic search order.</p>
          </div>
          <div>
            <StarRating
              value={resource.current_user_rating}
              disabled={ratingPending}
              error={ratingError}
              onRate={(rating) => onRate(resource.resource_id, rating)}
              onClear={() => onClearRating(resource.resource_id)}
            />
            {resource.current_user_rating != null && !ratingPending && (
              <div className="resource-access__your-rating">
                Your rating: {resource.current_user_rating}/5
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
