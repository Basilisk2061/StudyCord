import {
  addMessage,
  getSessionMessages,
} from './ragChatHistory.js';

export const RAG_CHAT_HISTORY_LIMIT = 6;

function transientMessage(role, content) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    role,
    content,
    created_at: new Date().toISOString(),
    sequence: null,
  };
}

export function matchesChatSession(
  identity,
  userId,
  sessionId,
  documentId,
) {
  return (
    identity?.userId === userId
    && identity?.sessionId === sessionId
    && identity?.documentId === documentId
  );
}

export function selectRecentChatHistory(
  messages,
  limit = RAG_CHAT_HISTORY_LIMIT,
) {
  if (!Array.isArray(messages) || limit <= 0) return [];

  return messages
    .filter((message) => (
      ['user', 'assistant'].includes(message?.role)
      && typeof message.content === 'string'
      && message.content.trim()
      && !message.isError
    ))
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }));
}

export async function persistChatTurn({
  userId,
  sessionId,
  documentId,
  question,
  sendQuestion,
  addMessageFn = addMessage,
  getSessionMessagesFn = getSessionMessages,
  onUserMessage = () => {},
  onAssistantMessage = () => {},
  onRequestError = () => {},
  onPersistenceError = () => {},
}) {
  let history = [];
  try {
    history = selectRecentChatHistory(
      await getSessionMessagesFn(userId, sessionId),
    );
  } catch (error) {
    onPersistenceError(error, 'history');
  }

  let userMessage;
  try {
    userMessage = await addMessageFn(userId, sessionId, {
      role: 'user',
      content: question,
    });
  } catch (error) {
    onPersistenceError(error, 'user');
    userMessage = transientMessage('user', question);
  }
  onUserMessage(userMessage);

  try {
    const answer = await sendQuestion({
      question,
      documentId,
      history,
    });
    let assistantMessage;
    try {
      assistantMessage = await addMessageFn(userId, sessionId, {
        role: 'assistant',
        content: answer,
      });
    } catch (error) {
      onPersistenceError(error, 'assistant');
      assistantMessage = transientMessage('assistant', answer);
    }
    onAssistantMessage(assistantMessage);
    return { userMessage, assistantMessage, error: null };
  } catch (error) {
    onRequestError(error);
    return { userMessage, assistantMessage: null, error };
  }
}
