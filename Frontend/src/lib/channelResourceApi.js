const CHANNEL_RESOURCE_BATCH_LIMIT = 200;


export async function fetchChannelResourceMetadata(
  request,
  serverId,
  resourceIds,
  { signal } = {},
) {
  const safeServerId = encodeURIComponent(String(serverId || '').trim());
  if (!safeServerId) throw new Error('Server is required.');
  const uniqueIds = [...new Set(
    (resourceIds || []).map((value) => String(value || '').trim()).filter(Boolean),
  )];
  if (!uniqueIds.length) return [];
  if (uniqueIds.length > CHANNEL_RESOURCE_BATCH_LIMIT) {
    throw new Error('Too many channel resources.');
  }
  return request(
    `/api/rag2/servers/${safeServerId}/resources/channel-metadata`,
    {
      method: 'POST',
      body: JSON.stringify({ resource_ids: uniqueIds }),
      signal,
    },
  );
}


export function indexChannelResourceMetadata(rows) {
  return Object.fromEntries(
    (rows || []).map((row) => [row.resource_id, row]),
  );
}


export function applyChannelRatingSummary(metadataById, summary) {
  const current = metadataById[summary.resource_id];
  if (!current) return metadataById;
  return {
    ...metadataById,
    [summary.resource_id]: {
      ...current,
      average_rating: summary.average_rating,
      rating_count: summary.rating_count,
      current_user_rating: summary.current_user_rating,
    },
  };
}
