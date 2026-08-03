export async function fetchChannelPins(apiRequest, channelId, options = {}) {
  return apiRequest(`/api/channels/${encodeURIComponent(channelId)}/pins`, {
    method: 'GET',
    ...options,
  });
}

export async function pinMessage(apiRequest, messageId) {
  return apiRequest(`/api/messages/${encodeURIComponent(messageId)}/pin`, {
    method: 'POST',
  });
}

export async function unpinMessage(apiRequest, messageId) {
  return apiRequest(`/api/messages/${encodeURIComponent(messageId)}/pin`, {
    method: 'DELETE',
  });
}

export function indexPinsByMessage(pins) {
  return Object.fromEntries(
    (pins || []).map((pin) => [pin.message_id, pin]),
  );
}
