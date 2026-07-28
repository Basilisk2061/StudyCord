import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  IDBKeyRange,
  indexedDB as fakeIndexedDB,
} from 'fake-indexeddb';

import {
  addMessage,
  clearSessionMessages,
  closeRagChatDbForTests,
  getSessionMessages,
  initializeRagChatDb,
} from '../src/lib/ragChatHistory.js';
import {
  matchesChatSession,
  persistChatTurn,
  RAG_CHAT_HISTORY_LIMIT,
  selectRecentChatHistory,
} from '../src/lib/ragChatFlow.js';
import {
  getSessionStudyOutputs,
  putStudyOutput,
} from '../src/lib/ragStudyOutputs.js';
import {
  generateAndPersistStudyOutput,
} from '../src/lib/ragStudyOutputFlow.js';


function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDB.deleteDatabase('studycord-rag1');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Test database deletion blocked.'));
  });
}

const SUMMARY = {
  executive_summary: 'A structured summary.',
  key_concepts: [{ concept: 'Index', description: 'Search structure.' }],
  key_points: ['Persistent output'],
};
const FLASHCARDS = [
  { question: 'What is FAISS?', answer: 'A vector search library.' },
];
const MCQS = [
  {
    question: 'Which library performs vector search?',
    options: ['FAISS', 'SQLite'],
    correct_answer: 'FAISS',
  },
];

beforeEach(async () => {
  globalThis.indexedDB = fakeIndexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  await closeRagChatDbForTests();
  await deleteDatabase();
});

afterEach(async () => {
  await closeRagChatDbForTests();
  await deleteDatabase();
});

test('initializes the versioned messages store and compound index', async () => {
  const database = await initializeRagChatDb();
  assert.equal(database.name, 'studycord-rag1');
  assert.equal(database.version, 2);
  assert.equal(database.objectStoreNames.contains('messages'), true);
  assert.equal(database.objectStoreNames.contains('study_outputs'), true);

  const transaction = database.transaction(
    ['messages', 'study_outputs'],
    'readonly',
  );
  const store = transaction.objectStore('messages');
  assert.equal(
    store.indexNames.contains('by_user_session_sequence'),
    true,
  );
  const outputStore = transaction.objectStore('study_outputs');
  assert.equal(outputStore.indexNames.contains('by_user_session'), true);
  assert.equal(
    outputStore.indexNames.contains('by_user_session_type'),
    true,
  );
});

test('database version two upgrade preserves legacy version one chat messages', async () => {
  await closeRagChatDbForTests();
  const legacyDatabase = await new Promise((resolve, reject) => {
    const request = fakeIndexedDB.open('studycord-rag1', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(
        'messages',
        { keyPath: 'id' },
      );
      store.createIndex(
        'by_user_session_sequence',
        ['user_id', 'session_id', 'sequence'],
        { unique: true },
      );
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = legacyDatabase.transaction('messages', 'readwrite');
  transaction.objectStore('messages').add({
    id: 'legacy-message',
    user_id: 'user-a',
    session_id: 'session-a',
    role: 'user',
    content: 'Preserve this chat.',
    created_at: '2026-07-28T00:00:00.000Z',
    sequence: 1,
  });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  legacyDatabase.close();

  const upgraded = await initializeRagChatDb();
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.objectStoreNames.contains('study_outputs'), true);
  assert.equal(
    (await getSessionMessages('user-a', 'session-a'))[0].content,
    'Preserve this chat.',
  );
});

test('persists and restores structured summary, flashcards, and MCQ output', async () => {
  await putStudyOutput(
    'user-a',
    'session-a',
    'document-a',
    'summary',
    SUMMARY,
  );
  await putStudyOutput(
    'user-a',
    'session-a',
    'document-a',
    'flashcards',
    FLASHCARDS,
  );
  await putStudyOutput(
    'user-a',
    'session-a',
    'document-a',
    'mcq',
    MCQS,
  );
  await closeRagChatDbForTests();

  const restored = await getSessionStudyOutputs(
    'user-a',
    'session-a',
    'document-a',
  );
  assert.deepEqual(restored.summary, SUMMARY);
  assert.deepEqual(restored.flashcards, FLASHCARDS);
  assert.deepEqual(restored.mcq, MCQS);
});

test('study outputs are isolated by user, session, and matching document', async () => {
  await putStudyOutput(
    'user-a',
    'session-a',
    'document-a',
    'summary',
    SUMMARY,
  );
  await putStudyOutput(
    'user-a',
    'session-b',
    'document-b',
    'flashcards',
    FLASHCARDS,
  );
  await putStudyOutput(
    'user-b',
    'session-a',
    'document-c',
    'mcq',
    MCQS,
  );

  assert.deepEqual(
    await getSessionStudyOutputs('user-a', 'session-a', 'document-a'),
    { summary: SUMMARY, flashcards: null, mcq: null },
  );
  assert.deepEqual(
    await getSessionStudyOutputs('user-a', 'session-a', 'wrong-document'),
    { summary: null, flashcards: null, mcq: null },
  );
  assert.deepEqual(
    await getSessionStudyOutputs('user-a', 'session-b', 'document-b'),
    { summary: null, flashcards: FLASHCARDS, mcq: null },
  );
  assert.deepEqual(
    await getSessionStudyOutputs('user-b', 'session-a', 'document-c'),
    { summary: null, flashcards: null, mcq: MCQS },
  );
});

test('successful regeneration replaces output while failed regeneration preserves it', async () => {
  await putStudyOutput(
    'user-a',
    'session-a',
    'document-a',
    'summary',
    SUMMARY,
  );
  const replacement = {
    ...SUMMARY,
    executive_summary: 'Replacement summary.',
  };
  const failed = await generateAndPersistStudyOutput({
    userId: 'user-a',
    sessionId: 'session-a',
    documentId: 'document-a',
    outputType: 'summary',
    requestOutput: async () => {
      throw new Error('generation failed');
    },
  });
  assert.equal(failed.error.message, 'generation failed');
  assert.deepEqual(
    (
      await getSessionStudyOutputs('user-a', 'session-a', 'document-a')
    ).summary,
    SUMMARY,
  );
  const invalid = await generateAndPersistStudyOutput({
    userId: 'user-a',
    sessionId: 'session-a',
    documentId: 'document-a',
    outputType: 'summary',
    requestOutput: async () => ({ executive_summary: '' }),
  });
  assert.match(invalid.error.message, /incomplete/);
  assert.deepEqual(
    (
      await getSessionStudyOutputs('user-a', 'session-a', 'document-a')
    ).summary,
    SUMMARY,
  );

  const succeeded = await generateAndPersistStudyOutput({
    userId: 'user-a',
    sessionId: 'session-a',
    documentId: 'document-a',
    outputType: 'summary',
    requestOutput: async () => replacement,
  });
  assert.equal(succeeded.error, null);
  assert.deepEqual(
    (
      await getSessionStudyOutputs('user-a', 'session-a', 'document-a')
    ).summary,
    replacement,
  );
});

test('IndexedDB output write failure still displays successful generation', async () => {
  let displayed = null;
  let persistenceWarning = null;
  const result = await generateAndPersistStudyOutput({
    userId: 'user-a',
    sessionId: 'session-a',
    documentId: 'document-a',
    outputType: 'flashcards',
    requestOutput: async () => FLASHCARDS,
    putStudyOutputFn: async () => {
      throw new Error('IndexedDB unavailable');
    },
    onDisplay: (content) => {
      displayed = content;
    },
    onPersistenceError: (error) => {
      persistenceWarning = error;
    },
  });

  assert.equal(result.persisted, false);
  assert.deepEqual(displayed, FLASHCARDS);
  assert.equal(persistenceWarning.message, 'IndexedDB unavailable');
});

test('late generated outputs persist to their origin but never display in another session', async () => {
  for (const [outputType, content] of [
    ['summary', SUMMARY],
    ['flashcards', FLASHCARDS],
    ['mcq', MCQS],
  ]) {
    let displayed = false;
    let persistedIdentity = null;
    await generateAndPersistStudyOutput({
      userId: 'user-a',
      sessionId: 'session-a',
      documentId: 'document-a',
      outputType,
      requestOutput: async () => content,
      putStudyOutputFn: async (...identity) => {
        persistedIdentity = identity.slice(0, 4);
      },
      isActive: () => false,
      onDisplay: () => {
        displayed = true;
      },
    });
    assert.deepEqual(
      persistedIdentity,
      ['user-a', 'session-a', 'document-a', outputType],
    );
    assert.equal(displayed, false);
  }
});

test('writes and restores messages in deterministic sequence order', async () => {
  const userId = 'user-a';
  const sessionId = 'session-a';
  const first = await addMessage(userId, sessionId, {
    role: 'user',
    content: 'First question',
  });
  const second = await addMessage(userId, sessionId, {
    role: 'assistant',
    content: 'First answer',
  });
  const third = await addMessage(userId, sessionId, {
    role: 'user',
    content: 'Second question',
  });

  assert.deepEqual(
    [first.sequence, second.sequence, third.sequence],
    [1, 2, 3],
  );
  assert.deepEqual(
    (await getSessionMessages(userId, sessionId)).map(
      (message) => [message.sequence, message.role, message.content],
    ),
    [
      [1, 'user', 'First question'],
      [2, 'assistant', 'First answer'],
      [3, 'user', 'Second question'],
    ],
  );
});

test('isolates messages by both authenticated user and session', async () => {
  await addMessage('user-a', 'session-a', {
    role: 'user',
    content: 'A in session A',
  });
  await addMessage('user-a', 'session-b', {
    role: 'user',
    content: 'A in session B',
  });
  await addMessage('user-b', 'session-a', {
    role: 'user',
    content: 'B in session A',
  });

  assert.deepEqual(
    (await getSessionMessages('user-a', 'session-a')).map(
      (message) => message.content,
    ),
    ['A in session A'],
  );
  assert.deepEqual(
    (await getSessionMessages('user-a', 'session-b')).map(
      (message) => message.content,
    ),
    ['A in session B'],
  );
  assert.deepEqual(
    (await getSessionMessages('user-b', 'session-a')).map(
      (message) => message.content,
    ),
    ['B in session A'],
  );
});

test('clearing one session does not delete another session history', async () => {
  await addMessage('user-a', 'session-a', {
    role: 'user',
    content: 'Keep only in A until cleared',
  });
  await addMessage('user-a', 'session-b', {
    role: 'user',
    content: 'Keep B',
  });

  await clearSessionMessages('user-a', 'session-a');

  assert.deepEqual(await getSessionMessages('user-a', 'session-a'), []);
  assert.equal(
    (await getSessionMessages('user-a', 'session-b'))[0].content,
    'Keep B',
  );
});

test('history survives a database close while no session auto-open state exists', async () => {
  await addMessage('user-a', 'session-a', {
    role: 'user',
    content: 'Persist across refresh simulation',
  });
  await closeRagChatDbForTests();

  assert.equal(
    (await getSessionMessages('user-a', 'session-a'))[0].content,
    'Persist across refresh simulation',
  );
  assert.deepEqual(await getSessionMessages('user-a', 'session-new'), []);
});

test('successful chat turn persists user and assistant messages', async () => {
  const displayed = [];
  const result = await persistChatTurn({
    userId: 'user-a',
    sessionId: 'session-a',
    documentId: 'document-a',
    question: 'What is the objective?',
    sendQuestion: async () => 'The objective is persistent learning.',
    onUserMessage: (message) => displayed.push(message.role),
    onAssistantMessage: (message) => displayed.push(message.role),
  });

  assert.equal(result.error, null);
  assert.deepEqual(displayed, ['user', 'assistant']);
  assert.deepEqual(
    (await getSessionMessages('user-a', 'session-a')).map(
      (message) => message.role,
    ),
    ['user', 'assistant'],
  );
});

test('sends only the last six previous messages without duplicating current question', async () => {
  const userId = 'user-a';
  const sessionId = 'session-a';
  for (let index = 1; index <= 8; index += 1) {
    await addMessage(userId, sessionId, {
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `Previous ${index}`,
    });
  }

  let requestPayload = null;
  await persistChatTurn({
    userId,
    sessionId,
    documentId: 'document-a',
    question: 'Current follow-up',
    sendQuestion: async (payload) => {
      requestPayload = payload;
      return 'Current answer';
    },
  });

  assert.equal(RAG_CHAT_HISTORY_LIMIT, 6);
  assert.deepEqual(
    requestPayload.history.map((message) => message.content),
    [
      'Previous 3',
      'Previous 4',
      'Previous 5',
      'Previous 6',
      'Previous 7',
      'Previous 8',
    ],
  );
  assert.equal(
    requestPayload.history.some(
      (message) => message.content === 'Current follow-up',
    ),
    false,
  );
});

test('restored IndexedDB history is used only for its user and session', async () => {
  await addMessage('user-a', 'session-a', {
    role: 'user',
    content: 'What is HNSW?',
  });
  await addMessage('user-a', 'session-a', {
    role: 'assistant',
    content: 'HNSW is a graph-based search method.',
  });
  await addMessage('user-a', 'session-b', {
    role: 'user',
    content: 'Session B content',
  });
  await addMessage('user-b', 'session-a', {
    role: 'user',
    content: 'User B content',
  });
  await closeRagChatDbForTests();

  let sentHistory = null;
  await persistChatTurn({
    userId: 'user-a',
    sessionId: 'session-a',
    documentId: 'document-a',
    question: 'Why is it faster?',
    sendQuestion: async ({ history }) => {
      sentHistory = history;
      return 'Because of its layered graph traversal.';
    },
  });

  assert.deepEqual(
    sentHistory.map((message) => message.content),
    [
      'What is HNSW?',
      'HNSW is a graph-based search method.',
    ],
  );
});

test('history selector excludes transient, error, and unsupported content', () => {
  const selected = selectRecentChatHistory([
    { id: 'welcome', sender: 'ai', content: 'Loaded notes.pdf.' },
    { role: 'system', content: 'Untrusted system text' },
    { role: 'assistant', content: 'Temporary failure', isError: true },
    { role: 'summary', content: 'Generated summary' },
    { role: 'user', content: '  Valid question  ' },
    { role: 'assistant', content: ' Valid answer ' },
  ]);

  assert.deepEqual(selected, [
    { role: 'user', content: 'Valid question' },
    { role: 'assistant', content: 'Valid answer' },
  ]);
});

test('failed backend request keeps user message without fake assistant history', async () => {
  let requestError = null;
  const result = await persistChatTurn({
    userId: 'user-a',
    sessionId: 'session-a',
    documentId: 'document-a',
    question: 'A real submitted question',
    sendQuestion: async () => {
      throw new Error('simulated API failure');
    },
    onRequestError: (error) => {
      requestError = error;
    },
  });

  assert.equal(result.assistantMessage, null);
  assert.equal(requestError.message, 'simulated API failure');
  assert.deepEqual(
    (await getSessionMessages('user-a', 'session-a')).map(
      (message) => message.role,
    ),
    ['user'],
  );
});

test('IndexedDB write failure does not prevent active chat', async () => {
  const displayed = [];
  const persistenceFailures = [];
  const result = await persistChatTurn({
    userId: 'user-a',
    sessionId: 'session-a',
    documentId: 'document-a',
    question: 'Continue without storage',
    addMessageFn: async () => {
      throw new Error('IndexedDB unavailable');
    },
    sendQuestion: async () => 'Chat still responds.',
    onUserMessage: (message) => displayed.push(message.role),
    onAssistantMessage: (message) => displayed.push(message.role),
    onPersistenceError: (_error, role) => persistenceFailures.push(role),
  });

  assert.equal(result.error, null);
  assert.deepEqual(displayed, ['user', 'assistant']);
  assert.deepEqual(persistenceFailures, ['user', 'assistant']);
});

test('session identity guard rejects a late response from another session', () => {
  const active = {
    userId: 'user-a',
    sessionId: 'session-b',
    documentId: 'document-b',
  };
  assert.equal(
    matchesChatSession(active, 'user-a', 'session-a', 'document-a'),
    false,
  );
  assert.equal(
    matchesChatSession(active, 'user-a', 'session-b', 'document-b'),
    true,
  );
  assert.equal(
    matchesChatSession(active, 'user-b', 'session-b', 'document-b'),
    false,
  );
});

test('non-chat generated content cannot be stored as chat messages', async () => {
  for (const role of ['summary', 'flashcards', 'mcq']) {
    await assert.rejects(
      addMessage('user-a', 'session-a', {
        role,
        content: 'Not chat history',
      }),
      /role must be user or assistant/,
    );
  }
  assert.deepEqual(await getSessionMessages('user-a', 'session-a'), []);
});
