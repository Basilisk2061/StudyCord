export async function deleteOwnMessage(apiRequest, messageId) {
  return apiRequest(`/api/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
  });
}

export async function leaveServer(apiRequest, serverId) {
  return apiRequest(`/api/servers/${encodeURIComponent(serverId)}/leave`, {
    method: 'POST',
  });
}

export function removeDeletedMessage(messages, messageId) {
  return messages.filter((message) => message.id !== messageId);
}
