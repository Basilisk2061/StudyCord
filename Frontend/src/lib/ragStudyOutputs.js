import { initializeRagChatDb } from './ragChatHistory.js';


const STUDY_OUTPUT_STORE = 'study_outputs';
const OUTPUT_SESSION_INDEX = 'by_user_session';
const OUTPUT_TYPES = new Set(['summary', 'flashcards', 'mcq']);
const OUTPUT_VERSION = 1;

function requireIdentity(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requireOutputType(outputType) {
  if (!OUTPUT_TYPES.has(outputType)) {
    throw new Error('Unsupported study output type.');
  }
  return outputType;
}

function validText(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

export function validateStudyOutputContent(outputType, content) {
  requireOutputType(outputType);

  if (outputType === 'summary') {
    if (
      !content
      || typeof content !== 'object'
      || Array.isArray(content)
      || !validText(content.executive_summary)
      || !Array.isArray(content.key_concepts)
      || !Array.isArray(content.key_points)
    ) {
      throw new Error('Summary response is incomplete.');
    }
  } else if (outputType === 'flashcards') {
    if (
      !Array.isArray(content)
      || content.length === 0
      || content.some((card) => (
        !card
        || typeof card !== 'object'
        || !validText(card.question)
        || !validText(card.answer)
      ))
    ) {
      throw new Error('Flashcard response is incomplete.');
    }
  } else if (
    !Array.isArray(content)
    || content.length === 0
    || content.some((question) => (
      !question
      || typeof question !== 'object'
      || !validText(question.question)
      || !Array.isArray(question.options)
      || question.options.length < 2
      || question.options.some((option) => !validText(option))
      || !validText(question.correct_answer)
      || !question.options.includes(question.correct_answer)
    ))
  ) {
    throw new Error('MCQ response is incomplete.');
  }

  return content;
}

function outputId(userId, sessionId, outputType) {
  return `${userId}:${sessionId}:${outputType}`;
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

function requestResult(request, fallbackMessage) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error || new Error(fallbackMessage),
    );
  });
}

export async function putStudyOutput(
  userId,
  sessionId,
  documentId,
  outputType,
  content,
) {
  const safeUserId = requireIdentity(userId, 'user_id');
  const safeSessionId = requireIdentity(sessionId, 'session_id');
  const safeDocumentId = requireIdentity(documentId, 'document_id');
  const safeOutputType = requireOutputType(outputType);
  validateStudyOutputContent(safeOutputType, content);

  const database = await initializeRagChatDb();
  const transaction = database.transaction(STUDY_OUTPUT_STORE, 'readwrite');
  const store = transaction.objectStore(STUDY_OUTPUT_STORE);
  const id = outputId(safeUserId, safeSessionId, safeOutputType);
  const existing = await requestResult(
    store.get(id),
    'Existing study output could not be read.',
  );
  const now = new Date().toISOString();
  const record = {
    id,
    user_id: safeUserId,
    session_id: safeSessionId,
    document_id: safeDocumentId,
    output_type: safeOutputType,
    content,
    created_at: existing?.created_at || now,
    updated_at: now,
    version: OUTPUT_VERSION,
  };

  store.put(record);
  await transactionDone(transaction);
  return record;
}

export async function getSessionStudyOutputs(
  userId,
  sessionId,
  documentId,
) {
  const safeUserId = requireIdentity(userId, 'user_id');
  const safeSessionId = requireIdentity(sessionId, 'session_id');
  const safeDocumentId = requireIdentity(documentId, 'document_id');
  const database = await initializeRagChatDb();
  const transaction = database.transaction(STUDY_OUTPUT_STORE, 'readonly');
  const index = transaction.objectStore(STUDY_OUTPUT_STORE).index(
    OUTPUT_SESSION_INDEX,
  );
  const keyRange = globalThis.IDBKeyRange;
  if (!keyRange) {
    throw new Error('IndexedDB key ranges are unavailable.');
  }
  const records = await requestResult(
    index.getAll(keyRange.only([safeUserId, safeSessionId])),
    'Study outputs could not be read.',
  );

  const outputs = {
    summary: null,
    flashcards: null,
    mcq: null,
  };
  for (const record of records) {
    if (
      record.document_id !== safeDocumentId
      || !OUTPUT_TYPES.has(record.output_type)
    ) continue;
    try {
      validateStudyOutputContent(record.output_type, record.content);
      outputs[record.output_type] = record.content;
    } catch {
      // Corrupt local records behave like missing browser-local output.
    }
  }
  return outputs;
}
