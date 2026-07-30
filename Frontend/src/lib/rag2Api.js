export const RESOURCE_SEARCH_LIMIT = 5;

function requireIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return encodeURIComponent(normalized);
}

export async function searchServerResources(
  request,
  serverId,
  query,
  { limit = RESOURCE_SEARCH_LIMIT, signal } = {},
) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) throw new Error('Enter a search query.');
  const safeServerId = requireIdentifier(serverId, 'Server');
  return request(`/api/rag2/servers/${safeServerId}/resources/search`, {
    method: 'POST',
    body: JSON.stringify({ query: normalizedQuery, limit }),
    signal,
  });
}

export async function putResourceRating(
  request,
  resourceId,
  rating,
  { signal } = {},
) {
  const safeResourceId = requireIdentifier(resourceId, 'Resource');
  return request(`/api/rag2/resources/${safeResourceId}/rating`, {
    method: 'PUT',
    body: JSON.stringify({ rating }),
    signal,
  });
}

export async function deleteResourceRating(
  request,
  resourceId,
  { signal } = {},
) {
  const safeResourceId = requireIdentifier(resourceId, 'Resource');
  return request(`/api/rag2/resources/${safeResourceId}/rating`, {
    method: 'DELETE',
    signal,
  });
}

export async function accessResourceFile(
  requestBlob,
  resourceId,
  { signal } = {},
) {
  const safeResourceId = requireIdentifier(resourceId, 'Resource');
  return requestBlob(`/api/rag2/resources/${safeResourceId}/access`, {
    method: 'GET',
    signal,
  });
}

export function formatSemanticScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return numeric.toFixed(3).replace(/\.?0+$/, '');
}

export function isBestMatchResult(index) {
  return index === 0;
}

export function formatResourceFileSize(bytes) {
  const numeric = Number(bytes);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric < 1024) return `${numeric} B`;
  if (numeric < 1024 * 1024) return `${(numeric / 1024).toFixed(1)} KB`;
  return `${(numeric / (1024 * 1024)).toFixed(1)} MB`;
}

export function replaceRatingSummary(results, resourceId, summary) {
  return results.map((result) => (
    result.resource_id === resourceId
      ? {
          ...result,
          average_rating: summary.average_rating,
          rating_count: summary.rating_count,
          current_user_rating: summary.current_user_rating,
        }
      : result
  ));
}

export function searchErrorMessage(error) {
  if (error?.status === 401) return 'Your session expired. Sign in again to continue.';
  if (error?.status === 403) return 'You no longer have access to search this server.';
  if (error?.status === 422) return 'Check the search query and try again.';
  if (error?.status === 502) return 'Semantic search is temporarily unavailable. Please retry.';
  return 'Advanced Search could not be completed. Please try again.';
}

export function ratingErrorMessage(error) {
  if (error?.status === 401) return 'Your session expired.';
  if (error?.status === 403 || error?.status === 404) {
    return 'This resource is no longer available to rate.';
  }
  if (error?.status === 422) return 'Choose a rating from 1 to 5 stars.';
  return 'The rating could not be saved. Please try again.';
}

export function resourceAccessErrorMessage(error) {
  if (error?.status === 401) return 'Your session expired. Sign in again to continue.';
  if (error?.status === 403 || error?.status === 404) {
    return 'You no longer have access to this resource.';
  }
  if (error?.status === 422) return 'This resource request is invalid.';
  return 'Unable to open this resource.';
}

export function safeDownloadFilename(filename, detectedType = 'file') {
  const normalized = Array.from(
    String(filename || '')
    .replaceAll('\\', '_')
    .replaceAll('/', '_'),
  )
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('')
    .trim();
  return normalized || `resource.${detectedType}`;
}

export function createServerRequestGuard(initialServerId = null) {
  let serverId = initialServerId;
  let generation = 0;

  return {
    switchServer(nextServerId) {
      serverId = nextServerId;
      generation += 1;
    },
    begin(requestServerId) {
      generation += 1;
      return { serverId: requestServerId, generation };
    },
    capture() {
      return { serverId, generation };
    },
    isCurrent(token, currentServerId) {
      return (
        token.serverId === serverId
        && token.serverId === currentServerId
        && token.generation === generation
      );
    },
    invalidate() {
      generation += 1;
    },
  };
}
