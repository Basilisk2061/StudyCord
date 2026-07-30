const DATABASE_NAME = 'studycord-rag1';
const DATABASE_VERSION = 2;
const MESSAGE_STORE = 'messages';
const SESSION_SEQUENCE_INDEX = 'by_user_session_sequence';
const STUDY_OUTPUT_STORE = 'study_outputs';
const OUTPUT_SESSION_INDEX = 'by_user_session';
const OUTPUT_SESSION_TYPE_INDEX = 'by_user_session_type';

let databasePromise = null;

function requireIdentity(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function createMessageId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sessionRange(userId, sessionId) {
  const keyRange = globalThis.IDBKeyRange;
  if (!keyRange) {
    throw new Error('IndexedDB key ranges are unavailable.');
  }
  return keyRange.bound(
    [userId, sessionId, Number.MIN_SAFE_INTEGER],
    [userId, sessionId, Number.MAX_SAFE_INTEGER],
  );
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error || new Error('IndexedDB transaction failed.'),
    );
    transaction.onabort = () => reject(
      transaction.error || new Error('IndexedDB transaction was aborted.'),
    );
  });
}

export function initializeRagChatDb() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('IndexedDB is unavailable.'));
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(MESSAGE_STORE)
        ? request.transaction.objectStore(MESSAGE_STORE)
        : database.createObjectStore(MESSAGE_STORE, { keyPath: 'id' });

      if (!store.indexNames.contains(SESSION_SEQUENCE_INDEX)) {
        store.createIndex(
          SESSION_SEQUENCE_INDEX,
          ['user_id', 'session_id', 'sequence'],
          { unique: true },
        );
      }

      const outputStore = database.objectStoreNames.contains(STUDY_OUTPUT_STORE)
        ? request.transaction.objectStore(STUDY_OUTPUT_STORE)
        : database.createObjectStore(STUDY_OUTPUT_STORE, { keyPath: 'id' });

      if (!outputStore.indexNames.contains(OUTPUT_SESSION_INDEX)) {
        outputStore.createIndex(
          OUTPUT_SESSION_INDEX,
          ['user_id', 'session_id'],
          { unique: false },
        );
      }
      if (!outputStore.indexNames.contains(OUTPUT_SESSION_TYPE_INDEX)) {
        outputStore.createIndex(
          OUTPUT_SESSION_TYPE_INDEX,
          ['user_id', 'session_id', 'output_type'],
          { unique: true },
        );
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('IndexedDB could not be opened.'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('IndexedDB upgrade is blocked.'));
    };
  });

  return databasePromise;
}

export async function getSessionMessages(userId, sessionId) {
  const safeUserId = requireIdentity(userId, 'user_id');
  const safeSessionId = requireIdentity(sessionId, 'session_id');
  const database = await initializeRagChatDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MESSAGE_STORE, 'readonly');
    const index = transaction.objectStore(MESSAGE_STORE).index(
      SESSION_SEQUENCE_INDEX,
    );
    const request = index.getAll(sessionRange(safeUserId, safeSessionId));

    request.onsuccess = () => {
      resolve(
        request.result.sort((left, right) => left.sequence - right.sequence),
      );
    };
    request.onerror = () => reject(
      request.error || new Error('Chat history could not be read.'),
    );
  });
}

export async function addMessage(
  userId,
  sessionId,
  { role, content, id, created_at: createdAt } = {},
) {
  const safeUserId = requireIdentity(userId, 'user_id');
  const safeSessionId = requireIdentity(sessionId, 'session_id');
  if (!['user', 'assistant'].includes(role)) {
    throw new Error('Message role must be user or assistant.');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Message content is required.');
  }

  const database = await initializeRagChatDb();
  const transaction = database.transaction(MESSAGE_STORE, 'readwrite');
  const store = transaction.objectStore(MESSAGE_STORE);
  const index = store.index(SESSION_SEQUENCE_INDEX);
  const range = sessionRange(safeUserId, safeSessionId);

  const sequence = await new Promise((resolve, reject) => {
    const cursorRequest = index.openCursor(range, 'prev');
    cursorRequest.onsuccess = () => {
      resolve((cursorRequest.result?.value.sequence || 0) + 1);
    };
    cursorRequest.onerror = () => reject(
      cursorRequest.error || new Error('Message sequence could not be created.'),
    );
  });

  const message = {
    id: id || createMessageId(),
    user_id: safeUserId,
    session_id: safeSessionId,
    role,
    content,
    created_at: createdAt || new Date().toISOString(),
    sequence,
  };
  store.add(message);
  await transactionDone(transaction);
  return message;
}

export async function clearSessionMessages(userId, sessionId) {
  const safeUserId = requireIdentity(userId, 'user_id');
  const safeSessionId = requireIdentity(sessionId, 'session_id');
  const database = await initializeRagChatDb();
  const transaction = database.transaction(MESSAGE_STORE, 'readwrite');
  const index = transaction.objectStore(MESSAGE_STORE).index(
    SESSION_SEQUENCE_INDEX,
  );
  const request = index.openCursor(sessionRange(safeUserId, safeSessionId));

  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await transactionDone(transaction);
}

export const deleteSessionHistory = clearSessionMessages;

export async function closeRagChatDbForTests() {
  if (!databasePromise) return;
  try {
    const database = await databasePromise;
    database.close();
  } finally {
    databasePromise = null;
  }
}
