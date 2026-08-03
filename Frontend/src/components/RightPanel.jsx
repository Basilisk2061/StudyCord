import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import ChatMarkdownMessage from './ChatMarkdownMessage';
import { apiRequest } from '../lib/api';
import { getSessionMessages } from '../lib/ragChatHistory';
import { matchesChatSession, persistChatTurn } from '../lib/ragChatFlow';
import { getSessionStudyOutputs } from '../lib/ragStudyOutputs';
import { generateAndPersistStudyOutput } from '../lib/ragStudyOutputFlow';

const AI_FEATURES = [
  'Ask questions',
  'Summarize documents',
  'Create flashcards',
  'Generate quizzes',
];

const AVATAR_COLORS = ['#262626', '#2F2F2F', '#404040', '#525252', '#737373', '#A3A3A3'];

function getInitials(name) {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getAvatarBg(username) {
  if (!username) return '#64748b';
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function formatSessionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function toUiChatMessage(message) {
  const createdAt = new Date(message.created_at);
  return {
    id: message.id,
    sender: message.role === 'assistant' ? 'ai' : 'user',
    content: message.content,
    time: Number.isNaN(createdAt.getTime())
      ? ''
      : createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

function createWelcomeMessage(filename) {
  return {
    id: 'welcome',
    sender: 'ai',
    content: `Loaded **${filename}**. You can ask questions or generate study materials.`,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

function SkeletonLoader({ lines = 5, label = 'Generating...' }) {
  const lineWidths = ['100%', '85%', '92%', '68%', '88%', '60%'];
  return (
    <div className="ai-loading-box">
      <div className="ai-loading-header">
        <svg className="ai-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span>{label}</span>
      </div>
      <div style={{ marginTop: '4px' }}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="skeleton-line"
            style={{ width: lineWidths[i % lineWidths.length] }}
          />
        ))}
      </div>
    </div>
  );
}

export default function RightPanel({
  activeServerId,
  serverInviteCode,
  userId,
  members = [],
  membersLoading = false,
  profile,
  currentRole,
  onOpenSettings,
  rag1ActivationRequest,
}) {
  const [copied, setCopied] = useState(false);

  // AI Assistant States
  const [activeTab, setActiveTab] = useState('summary');
  const [assistantMode, setAssistantMode] = useState('new');
  const [uploadedDoc, setUploadedDoc] = useState(null); // { sessionId, docId, filename }
  const [uploadError, setUploadError] = useState('');
  const [historySessions, setHistorySessions] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [localPersistenceWarning, setLocalPersistenceWarning] = useState('');
  
  // Loading states
  const [uploading, setUploading] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingFlashcards, setLoadingFlashcards] = useState(false);
  const [loadingMcqs, setLoadingMcqs] = useState(false);
  const [sendingChat, setSendingChat] = useState(false);

  // Data states
  const [summaryData, setSummaryData] = useState(null);
  const [flashcards, setFlashcards] = useState([]);
  const [mcqs, setMcqs] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

  // UI state for interactive components
  const [currentFlashcardIndex, setCurrentFlashcardIndex] = useState(0);
  const [flashcardFlipped, setFlashcardFlipped] = useState(false);
  const [mcqAnswers, setMcqAnswers] = useState({}); // { mcqIndex: selectedOptionIndex }
  const [mcqChecked, setMcqChecked] = useState({}); // { mcqIndex: true }

  const fileInputRef = useRef(null);
  const chatEndRef = useRef(null);
  const activeDocumentRef = useRef(null);
  const activeSessionRef = useRef(null);
  const historyOpenRequestRef = useRef(0);
  const rag1ActivationHandledRef = useRef(null);

  const [isExpanded, setIsExpanded] = useState(false);

  // Escape key close listener
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setIsExpanded(false);
      }
    };
    if (isExpanded) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isExpanded]);

  const handleCopy = () => {
    if (!serverInviteCode) return;
    navigator.clipboard.writeText(serverInviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const showServerInfo = activeServerId !== null;
  const canOpenSettings = currentRole === 'owner' || currentRole === 'admin';

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleFileChange = (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  const processFile = async (file) => {
    setUploadError('');
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['pdf', 'txt', 'docx'].includes(ext)) {
      setUploadError('Unsupported file type. Use PDF, TXT, or DOCX.');
      return;
    }

    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const data = await apiRequest('/api/rag/upload', {
        method: 'POST',
        body: formData,
      });
      activeDocumentRef.current = data.doc_id;
      activeSessionRef.current = {
        userId,
        sessionId: data.session_id,
        documentId: data.doc_id,
      };
      setUploadedDoc({
        sessionId: data.session_id,
        docId: data.doc_id,
        filename: data.filename,
      });
      setAssistantMode('session');

      // Clear old data when a new doc is uploaded
      setSummaryData(null);
      setFlashcards([]);
      setMcqs([]);
      setLocalPersistenceWarning('');
      setChatMessages([createWelcomeMessage(data.filename)]);
      setActiveTab('summary');
      fetchSummary({
        userId,
        sessionId: data.session_id,
        documentId: data.doc_id,
      }); // Preserve the existing upload-time summary behavior.
    } catch (err) {
      console.error(err);
      setUploadError(err.message || 'Error uploading file.');
    } finally {
      setUploading(false);
    }
  };

  const fetchSummary = async (
    identity = activeSessionRef.current,
  ) => {
    if (!identity?.documentId || loadingSummary) return;
    const targetIdentity = { ...identity };
    const isTargetActive = () => matchesChatSession(
      activeSessionRef.current,
      targetIdentity.userId,
      targetIdentity.sessionId,
      targetIdentity.documentId,
    );
    setLoadingSummary(true);
    try {
      await generateAndPersistStudyOutput({
        ...targetIdentity,
        outputType: 'summary',
        requestOutput: () => apiRequest('/api/rag/summary', {
          method: 'POST',
          body: JSON.stringify({ doc_id: targetIdentity.documentId }),
        }),
        isActive: isTargetActive,
        onDisplay: setSummaryData,
        onPersistenceError: (error) => {
          console.warn('RAG summary persistence failed.', error);
          setLocalPersistenceWarning(
            'Study materials are available now, but this browser could not save them locally.',
          );
        },
        onRequestError: (error) => {
          console.error(error);
          setUploadError('Failed to generate summary.');
        },
      });
    } finally {
      if (isTargetActive()) {
        setLoadingSummary(false);
      }
    }
  };

  const fetchFlashcards = async (
    identity = activeSessionRef.current,
  ) => {
    if (!identity?.documentId || loadingFlashcards) return;
    const targetIdentity = { ...identity };
    const isTargetActive = () => matchesChatSession(
      activeSessionRef.current,
      targetIdentity.userId,
      targetIdentity.sessionId,
      targetIdentity.documentId,
    );
    setLoadingFlashcards(true);
    try {
      await generateAndPersistStudyOutput({
        ...targetIdentity,
        outputType: 'flashcards',
        requestOutput: async () => {
          const data = await apiRequest('/api/rag/flashcards', {
            method: 'POST',
            body: JSON.stringify({ doc_id: targetIdentity.documentId }),
          });
          return data.flashcards;
        },
        isActive: isTargetActive,
        onDisplay: (content) => {
          setFlashcards(content);
          setCurrentFlashcardIndex(0);
          setFlashcardFlipped(false);
        },
        onPersistenceError: (error) => {
          console.warn('RAG flashcard persistence failed.', error);
          setLocalPersistenceWarning(
            'Study materials are available now, but this browser could not save them locally.',
          );
        },
        onRequestError: (error) => {
          console.error(error);
          setUploadError('Failed to generate flashcards.');
        },
      });
    } finally {
      if (isTargetActive()) {
        setLoadingFlashcards(false);
      }
    }
  };

  const fetchMcqs = async (
    identity = activeSessionRef.current,
  ) => {
    if (!identity?.documentId || loadingMcqs) return;
    const targetIdentity = { ...identity };
    const isTargetActive = () => matchesChatSession(
      activeSessionRef.current,
      targetIdentity.userId,
      targetIdentity.sessionId,
      targetIdentity.documentId,
    );
    setLoadingMcqs(true);
    try {
      await generateAndPersistStudyOutput({
        ...targetIdentity,
        outputType: 'mcq',
        requestOutput: async () => {
          const data = await apiRequest('/api/rag/mcq', {
            method: 'POST',
            body: JSON.stringify({ doc_id: targetIdentity.documentId }),
          });
          return data.mcqs;
        },
        isActive: isTargetActive,
        onDisplay: (content) => {
          setMcqs(content);
          setMcqAnswers({});
          setMcqChecked({});
        },
        onPersistenceError: (error) => {
          console.warn('RAG MCQ persistence failed.', error);
          setLocalPersistenceWarning(
            'Study materials are available now, but this browser could not save them locally.',
          );
        },
        onRequestError: (error) => {
          console.error(error);
          setUploadError('Failed to generate MCQs.');
        },
      });
    } finally {
      if (isTargetActive()) {
        setLoadingMcqs(false);
      }
    }
  };

  const handleSendChat = async (e) => {
    e.preventDefault();
    if (
      !chatInput.trim()
      || !uploadedDoc?.docId
      || !uploadedDoc?.sessionId
      || sendingChat
    ) return;
    const targetUserId = userId;
    const targetSessionId = uploadedDoc.sessionId;
    const targetDocumentId = uploadedDoc.docId;
    const targetQuestion = chatInput.trim();
    const isTargetActive = () => matchesChatSession(
      activeSessionRef.current,
      targetUserId,
      targetSessionId,
      targetDocumentId,
    );

    setChatInput('');
    setSendingChat(true);

    try {
      await persistChatTurn({
        userId: targetUserId,
        sessionId: targetSessionId,
        documentId: targetDocumentId,
        question: targetQuestion,
        sendQuestion: async ({ question, documentId, history }) => {
          const data = await apiRequest('/api/rag/chat', {
            method: 'POST',
            body: JSON.stringify({
              question,
              mode: 'chat',
              document_id: documentId,
              history,
            }),
          });
          return data.answer;
        },
        onUserMessage: (message) => {
          if (!isTargetActive()) return;
          setChatMessages(prev => [...prev, toUiChatMessage(message)]);
        },
        onAssistantMessage: (message) => {
          if (!isTargetActive()) return;
          setChatMessages(prev => [...prev, toUiChatMessage(message)]);
        },
        onPersistenceError: (error) => {
          console.warn('RAG chat history persistence failed.', error);
          if (isTargetActive()) {
            setLocalPersistenceWarning(
              'Chat is working, but this browser could not save its local history.',
            );
          }
        },
        onRequestError: (error) => {
          console.error(error);
          if (!isTargetActive()) return;
          setChatMessages(prev => [
            ...prev,
            {
              id: `${Date.now()}-error`,
              sender: 'ai',
              content: 'Error processing question. Please try again.',
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              isError: true,
            },
          ]);
        },
      });
    } finally {
      if (isTargetActive()) {
        setSendingChat(false);
      }
    }
  };

  const clearSessionUi = () => {
    activeDocumentRef.current = null;
    activeSessionRef.current = null;
    setUploadedDoc(null);
    setSummaryData(null);
    setFlashcards([]);
    setMcqs([]);
    setChatMessages([]);
    setChatInput('');
    setActiveTab('summary');
    setCurrentFlashcardIndex(0);
    setFlashcardFlipped(false);
    setMcqAnswers({});
    setMcqChecked({});
    setLoadingSummary(false);
    setLoadingFlashcards(false);
    setLoadingMcqs(false);
    setSendingChat(false);
    setLocalPersistenceWarning('');
    setUploadError('');
  };

  const startNewStudy = () => {
    historyOpenRequestRef.current += 1;
    clearSessionUi();
    setHistoryError('');
    setAssistantMode('new');
  };

  const openHistory = async () => {
    const requestId = historyOpenRequestRef.current + 1;
    historyOpenRequestRef.current = requestId;
    clearSessionUi();
    setAssistantMode('history');
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const sessions = await apiRequest('/api/rag/sessions');
      if (historyOpenRequestRef.current !== requestId) return;
      setHistorySessions(Array.isArray(sessions) ? sessions : []);
    } catch (err) {
      console.error(err);
      if (historyOpenRequestRef.current !== requestId) return;
      setHistoryError(err.message || 'Study history could not be loaded.');
    } finally {
      if (historyOpenRequestRef.current === requestId) {
        setHistoryLoading(false);
      }
    }
  };

  const openHistorySession = async (
    sessionId,
    {
      openChat = false,
      expandWorkspace = false,
    } = {},
  ) => {
    const requestId = historyOpenRequestRef.current + 1;
    historyOpenRequestRef.current = requestId;
    const targetUserId = userId;
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const session = await apiRequest(`/api/rag/sessions/${sessionId}`);
      if (historyOpenRequestRef.current !== requestId) return;
      clearSessionUi();
      activeDocumentRef.current = session.document_id;
      activeSessionRef.current = {
        userId: targetUserId,
        sessionId: session.id,
        documentId: session.document_id,
      };
      setUploadedDoc({
        sessionId: session.id,
        docId: session.document_id,
        filename: session.original_filename,
      });
      setAssistantMode('session');
      if (openChat) setActiveTab('chat');
      if (expandWorkspace) setIsExpanded(true);
      const [messagesResult, outputsResult] = await Promise.allSettled([
        getSessionMessages(targetUserId, session.id),
        getSessionStudyOutputs(
          targetUserId,
          session.id,
          session.document_id,
        ),
      ]);
      if (
        historyOpenRequestRef.current !== requestId
        || !matchesChatSession(
          activeSessionRef.current,
          targetUserId,
          session.id,
          session.document_id,
        )
      ) return;

      if (messagesResult.status === 'fulfilled') {
        const messages = messagesResult.value;
        setChatMessages(
          messages.length > 0
            ? messages.map(toUiChatMessage)
            : [createWelcomeMessage(session.original_filename)],
        );
      } else {
        console.warn(
          'RAG chat history could not be loaded.',
          messagesResult.reason,
        );
        setChatMessages([createWelcomeMessage(session.original_filename)]);
        setLocalPersistenceWarning(
          'This session opened, but some browser-local study data is unavailable.',
        );
      }

      if (outputsResult.status === 'fulfilled') {
        const outputs = outputsResult.value;
        setSummaryData(outputs.summary);
        setFlashcards(outputs.flashcards || []);
        setMcqs(outputs.mcq || []);
        setCurrentFlashcardIndex(0);
        setFlashcardFlipped(false);
        setMcqAnswers({});
        setMcqChecked({});
      } else {
        console.warn(
          'RAG study outputs could not be loaded.',
          outputsResult.reason,
        );
        setLocalPersistenceWarning(
          'This session opened, but some browser-local study data is unavailable.',
        );
      }
    } catch (err) {
      console.error(err);
      if (historyOpenRequestRef.current !== requestId) return;
      setHistoryError(err.message || 'Study session could not be opened.');
    } finally {
      if (historyOpenRequestRef.current === requestId) {
        setHistoryLoading(false);
      }
    }
  };
  const activateRag1Session = useEffectEvent((sessionId) => {
    void openHistorySession(sessionId, {
      openChat: true,
      expandWorkspace: true,
    });
  });

  useEffect(() => {
    const requestId = rag1ActivationRequest?.requestId;
    const sessionId = rag1ActivationRequest?.session_id;
    if (
      !requestId
      || !sessionId
      || rag1ActivationHandledRef.current === requestId
    ) return;
    rag1ActivationHandledRef.current = requestId;
    activateRag1Session(sessionId);
  }, [rag1ActivationRequest]);

  const selectTab = (tab) => {
    setActiveTab(tab);
  };

  const handleSelectMcqOption = (mcqIndex, optionIndex) => {
    if (mcqChecked[mcqIndex]) return;
    setMcqAnswers(prev => ({ ...prev, [mcqIndex]: optionIndex }));
  };

  const handleCheckMcq = (mcqIndex) => {
    if (mcqAnswers[mcqIndex] === undefined) return;
    setMcqChecked(prev => ({ ...prev, [mcqIndex]: true }));
  };

  const renderHistory = (expanded = false) => (
    <div className={`ai-history ${expanded ? 'ai-history--expanded' : ''}`}>
      <div className="ai-history__header">
        <div>
          <div className="ai-history__title">Study History</div>
          <div className="ai-history__subtitle">Choose a previous study session.</div>
        </div>
        <button
          type="button"
          className="btn btn-secondary ai-history__back"
          onClick={startNewStudy}
        >
          New Study
        </button>
      </div>

      {historyError && <div className="error-message ai-history__error">{historyError}</div>}

      {historyLoading ? (
        <SkeletonLoader lines={4} label="Loading history..." />
      ) : historySessions.length === 0 ? (
        <div className="ai-history__empty">
          No previous study sessions yet.
        </div>
      ) : (
        <div className="ai-history__list">
          {historySessions.map((session) => (
            <button
              type="button"
              className="ai-history__item"
              key={session.id}
              onClick={() => openHistorySession(session.id)}
            >
              <span className="ai-history__item-main">
                <span className="ai-history__item-title">{session.title}</span>
                <span className="ai-history__item-type">{session.detected_type.toUpperCase()}</span>
              </span>
              <span className="ai-history__item-date">
                {formatSessionDate(session.updated_at)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <aside className="right-panel" id="right-panel">
      {/* CSS overrides to support compact Sidebar layout */}
      <style dangerouslySetInnerHTML={{ __html: `
        .right-panel {
          width: var(--right-w);
          min-width: var(--right-w);
          height: 100vh;
          background-color: var(--bg-panel1);
          border-left: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 16px 0;
          gap: 16px;
        }
        .right-panel__section {
          padding: 0 16px;
          display: flex;
          flex-direction: column;
        }
        .right-panel__section-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
          margin: 0 0 10px 0;
        }
        .ai-assistant-wrapper {
          border-bottom: 1px solid var(--border);
          padding-bottom: 16px;
          margin-bottom: 8px;
        }
        .ai-study-empty {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .ai-study-history-link {
          flex-shrink: 0;
        }
        .ai-quick-study {
          margin-bottom: 12px;
        }
        .ai-quick-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          margin-top: 8px;
        }
        .ai-quick-action {
          min-width: 0;
          padding: 7px 6px;
          color: var(--text-secondary);
          background-color: var(--bg-darkest);
          border: 1px solid var(--border);
          border-radius: var(--radius-xs);
          font-size: 10.5px;
          font-weight: 500;
          text-align: center;
          cursor: pointer;
          transition: background-color var(--transition), color var(--transition), border-color var(--transition);
        }
        .ai-quick-action:hover,
        .ai-quick-action--active {
          color: var(--text-primary);
          background-color: var(--bg-elevated);
          border-color: var(--border-subtle);
        }
        .shared-resources-empty {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.45;
        }
        .shared-resources-empty__icon {
          width: 14px;
          height: 14px;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .ai-study-tagline {
          margin: 0 0 12px;
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.45;
        }
        .ai-study-upload-card,
        .ai-study-document-card {
          width: 100%;
          min-height: 150px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 10px;
          padding: 20px 14px;
          color: var(--text-primary);
          background-color: var(--bg-surface);
          border: 1px dashed var(--border);
          border-radius: var(--radius-sm);
          text-align: center;
        }
        .ai-study-upload-card {
          cursor: pointer;
          transition: background-color var(--transition), border-color var(--transition);
        }
        .ai-study-upload-card:hover:not(:disabled) {
          background-color: var(--bg-hover);
          border-color: var(--text-muted);
        }
        .ai-study-upload-card:disabled {
          cursor: wait;
          opacity: 0.7;
        }
        .ai-study-upload-card__icon {
          width: 28px;
          height: 28px;
          color: var(--text-muted);
        }
        .ai-study-upload-card__title {
          font-size: 12px;
          font-weight: 600;
        }
        .ai-study-upload-card__formats {
          color: var(--text-muted);
          font-size: 10.5px;
          letter-spacing: 0.03em;
        }
        .ai-features,
        .ai-recent-sessions {
          padding-top: 14px;
          border-top: 1px solid var(--border);
        }
        .ai-features__title,
        .ai-quick-study__title,
        .ai-recent-sessions__title {
          margin: 0;
          color: var(--text-primary);
          font-size: 11px;
          font-weight: 600;
        }
        .ai-features__list {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 7px 10px;
          margin: 9px 0 0;
          padding: 0;
          list-style: none;
        }
        .ai-features__item {
          position: relative;
          padding-left: 10px;
          color: var(--text-muted);
          font-size: 10.5px;
          line-height: 1.35;
        }
        .ai-features__item::before {
          content: '';
          position: absolute;
          top: 0.55em;
          left: 0;
          width: 3px;
          height: 3px;
          border-radius: 50%;
          background-color: currentColor;
        }
        .ai-recent-sessions .ai-study-history-link {
          display: inline-flex;
          width: auto;
          margin-top: 7px;
          padding: 5px 9px;
          font-size: 10px;
        }
        .ai-study-document-card {
          position: relative;
          border-style: solid;
        }
        .ai-study-document-card__name {
          width: 100%;
          overflow: hidden;
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 600;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ai-study-document-card__status {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--text-secondary);
          font-size: 11px;
        }
        .ai-study-document-card__status-icon {
          width: 14px;
          height: 14px;
          color: var(--text-muted);
        }
        .ai-study-document-card__new {
          position: absolute;
          top: 10px;
          right: 10px;
          width: auto;
          padding: 3px 7px;
          font-size: 9px;
        }
        .ai-history {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-height: 100px;
        }
        .ai-history--expanded {
          width: min(720px, 90%);
          max-height: 70vh;
          padding: 24px;
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
        }
        .ai-history__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .ai-history__title {
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .ai-history__subtitle {
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.4;
          margin-top: 3px;
        }
        .ai-history__back {
          width: auto;
          flex-shrink: 0;
          padding: 5px 9px;
          font-size: 10px;
        }
        .ai-history__error {
          padding: 7px 9px;
          font-size: 11px;
        }
        .ai-history__list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          overflow-y: auto;
        }
        .ai-history__item {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 10px 11px;
          color: var(--text-primary);
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          text-align: left;
          cursor: pointer;
          transition: background-color var(--transition), border-color var(--transition);
        }
        .ai-history--expanded .ai-history__item {
          background-color: var(--bg-darkest);
          padding: 13px 14px;
        }
        .ai-history__item:hover {
          background-color: var(--bg-hover);
          border-color: var(--border-subtle);
        }
        .ai-history__item-main {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .ai-history__item-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 500;
        }
        .ai-history__item-type {
          flex-shrink: 0;
          color: var(--text-muted);
          font-size: 9px;
          letter-spacing: 0.05em;
        }
        .ai-history__item-date,
        .ai-history__empty {
          color: var(--text-muted);
          font-size: 10.5px;
        }
        .ai-history__empty {
          padding: 18px 12px;
          border: 1px dashed var(--border);
          border-radius: var(--radius-sm);
          text-align: center;
        }
        .ai-sidebar-content {
          max-height: 340px;
          overflow-y: auto;
          font-size: 12.5px;
          padding-right: 4px;
        }
        .ai-sidebar-content::-webkit-scrollbar { width: 4px; }
        .ai-sidebar-content::-webkit-scrollbar-thumb { background-color: var(--border); border-radius: 2px; }

        /* Smooth Content Fade In */
        .ai-fade-in {
          animation: aiFadeIn 250ms ease-out forwards;
        }
        @keyframes aiFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        /* Loading Spinner */
        @keyframes aiSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .ai-spinner {
          animation: aiSpin 0.75s linear infinite;
        }
        .ai-loading-box {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 12px 8px;
        }
        .ai-loading-header {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          font-weight: 500;
          color: var(--text-secondary);
        }

        /* Skeleton Lines & Shimmer */
        @keyframes aiShimmer {
          0% { background-position: -250px 0; }
          100% { background-position: 250px 0; }
        }
        .skeleton-line {
          height: 11px;
          border-radius: 4px;
          background: linear-gradient(90deg, #1e1e1e 0%, #2e2e2e 50%, #1e1e1e 100%);
          background-size: 500px 100%;
          animation: aiShimmer 1.4s infinite ease-in-out;
          margin-bottom: 8px;
        }
        
        .ai-sidebar-summary__sec {
          margin-bottom: 14px;
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 10px 12px;
        }
        .ai-sidebar-summary__sec-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
          margin-bottom: 6px;
        }
        .ai-sidebar-concept-row {
          padding: 6px 0;
          border-bottom: 1px solid var(--border);
          line-height: 1.45;
        }
        .ai-sidebar-concept-row:last-child {
          border-bottom: none;
        }
        
        /* Sidebar Chat */
        .ai-sidebar-chat-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-bottom: 10px;
          max-height: 240px;
          overflow-y: auto;
        }
        .ai-sidebar-chat-list::-webkit-scrollbar { width: 3px; }
        .ai-sidebar-bubble {
          padding: 8px 12px;
          border-radius: var(--radius-sm);
          line-height: 1.45;
          word-break: break-word;
          max-width: 92%;
          font-size: 12px;
        }
        .ai-sidebar-bubble--ai {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          align-self: flex-start;
          color: var(--text-secondary);
        }
        .ai-sidebar-bubble--user {
          background-color: #FFFFFF;
          color: #000000;
          align-self: flex-end;
          font-weight: 450;
        }
        .ai-sidebar-chat-form {
          display: flex;
          gap: 6px;
        }
        .ai-sidebar-chat-input {
          flex: 1;
          padding: 8px 12px;
          font-size: 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-xs);
          background-color: var(--bg-darkest);
          color: var(--text-primary);
          outline: none;
        }
        .ai-sidebar-chat-btn {
          background-color: #FFFFFF;
          color: #000000;
          border: none;
          padding: 0 12px;
          border-radius: var(--radius-xs);
          cursor: pointer;
          font-weight: 600;
        }

        /* Sidebar Flashcard */
        .ai-sidebar-card {
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          background-color: var(--bg-surface);
          min-height: 140px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          cursor: pointer;
          user-select: none;
          transition: all 0.25s ease;
        }
        .ai-sidebar-card--flipped {
          background-color: var(--bg-elevated);
          border-color: var(--border-subtle);
        }
        .ai-sidebar-card__content {
          font-size: 12.5px;
          font-weight: 500;
          line-height: 1.5;
          margin-top: 6px;
          margin-bottom: 6px;
        }

        /* Sidebar MCQ */
        .ai-sidebar-mcq-item {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 12px;
          margin-bottom: 10px;
        }
        .ai-sidebar-mcq-opt {
          padding: 8px 10px;
          border: 1px solid var(--border);
          border-radius: var(--radius-xs);
          background-color: var(--bg-darkest);
          margin-top: 6px;
          cursor: pointer;
          font-size: 11.5px;
          line-height: 1.4;
          transition: all var(--transition);
        }
        .ai-sidebar-mcq-opt--selected {
          border-color: #FFFFFF;
        }
        .ai-sidebar-mcq-opt--correct {
          border-color: rgba(34, 197, 94, 0.4);
          background-color: rgba(34, 197, 94, 0.1);
          color: #4ade80;
        }
        .ai-sidebar-mcq-opt--incorrect {
          border-color: rgba(239, 68, 68, 0.4);
          background-color: rgba(239, 68, 68, 0.1);
          color: #f87171;
        }

        /* Workspace Modal */
        .ai-workspace-modal {
          position: fixed;
          inset: 0;
          z-index: 1000;
          background-color: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          animation: fadeIn 0.2s ease-out forwards;
        }
        .ai-workspace-card {
          width: 90vw;
          height: 90vh;
          background-color: var(--bg-dark);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 24px 60px rgba(0,0,0,0.6);
          animation: scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes scaleIn {
          from { opacity: 0; transform: scale(0.97) translateY(12px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .ai-workspace-header {
          height: 56px;
          padding: 0 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid var(--border);
          background-color: var(--bg-panel1);
        }
        .ai-workspace-header__left {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .ai-workspace-title {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #FFF;
          margin: 0;
        }
        .ai-workspace-docname {
          font-size: 11px;
          color: var(--text-muted);
          background-color: var(--bg-elevated);
          padding: 2px 8px;
          border-radius: var(--radius-xs);
          border: 1px solid var(--border);
        }
        .ai-workspace-close {
          background: transparent;
          border: none;
          color: var(--text-muted);
          font-size: 28px;
          cursor: pointer;
          transition: color var(--transition);
          padding: 0;
          display: flex;
          align-items: center;
          line-height: 1;
        }
        .ai-workspace-close:hover {
          color: #FFF;
        }
        .ai-workspace-body {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .ai-workspace-split {
          display: flex;
          height: 100%;
          width: 100%;
        }
        .ai-workspace-tabs {
          width: 200px;
          background-color: var(--bg-panel1);
          border-right: 1px solid var(--border);
          padding: 20px 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .ai-workspace-tab-btn {
          width: 100%;
          text-align: left;
          padding: 10px 14px;
          font-size: 12px;
          font-weight: 500;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          border-radius: var(--radius-sm);
          transition: all var(--transition);
        }
        .ai-workspace-tab-btn:hover {
          background-color: var(--bg-hover);
          color: var(--text-primary);
        }
        .ai-workspace-tab-btn--active {
          background-color: var(--bg-hover);
          border-color: var(--border);
          color: #FFF;
          font-weight: 600;
        }
        .ai-workspace-content {
          flex: 1;
          background-color: var(--bg-dark);
          padding: 24px;
          overflow: hidden;
          height: 100%;
          position: relative;
        }
        .ai-workspace-content > div {
          height: 100%;
          animation: tabFadeIn 0.25s ease-out forwards;
        }
        @keyframes tabFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .ai-workspace-summary, .ai-workspace-chat, .ai-workspace-flashcards, .ai-workspace-mcqs {
          height: 100%;
          display: flex;
          flex-direction: column;
        }
        .ai-workspace-loading {
          text-align: center;
          font-size: 13px;
          color: var(--text-muted);
          margin-top: 48px;
        }
        
        /* Chat tab fullscreen */
        .ai-workspace-chat {
          height: 100%;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          background-color: var(--bg-dark);
          border-radius: var(--radius-md);
        }
        .ai-chat-messages {
          flex: 1;
          overflow-y: auto;
          padding-right: 12px;
          margin-bottom: 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .ai-chat-messages::-webkit-scrollbar {
          width: 4px;
        }
        .ai-chat-messages::-webkit-scrollbar-thumb {
          background-color: var(--border);
          border-radius: 2px;
        }
        .ai-message {
          display: flex;
          gap: 12px;
          max-width: 80%;
          animation: messageSlide 0.2s ease-out forwards;
        }
        @keyframes messageSlide {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .ai-message--ai {
          align-self: flex-start;
        }
        .ai-message--user {
          align-self: flex-end;
          flex-direction: row-reverse;
        }
        .ai-message__avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background-color: var(--bg-elevated);
          border: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 11px;
          flex-shrink: 0;
          color: var(--text-secondary);
        }
        .ai-message__bubble {
          padding: 12px 16px;
          border-radius: var(--radius-md);
          line-height: 1.5;
          font-size: 13.5px;
          word-break: break-word;
        }
        .ai-message--ai .ai-message__bubble {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          color: var(--text-secondary);
          border-top-left-radius: 2px;
        }
        .ai-message--user .ai-message__bubble {
          background-color: #FFFFFF;
          color: #000000;
          border-top-right-radius: 2px;
          font-weight: 450;
        }
        .ai-message__time {
          font-size: 10px;
          color: var(--text-dark);
          margin-top: 4px;
          display: block;
        }
        .ai-message--user .ai-message__time {
          text-align: right;
        }
        /* Typing Indicator */
        .ai-typing-indicator {
          display: flex;
          gap: 4px;
          align-items: center;
          padding: 12px 16px;
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          border-top-left-radius: 2px;
          width: fit-content;
          align-self: flex-start;
          margin-left: 44px;
        }
        .ai-typing-dot {
          width: 6px;
          height: 6px;
          background-color: var(--text-muted);
          border-radius: 50%;
          animation: bounce 1.4s infinite ease-in-out both;
        }
        .ai-typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .ai-typing-dot:nth-child(2) { animation-delay: -0.16s; }
        @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1.0); } }
        
        .ai-chat-compose {
          display: flex;
          gap: 10px;
          background-color: var(--bg-surface);
          padding: 6px;
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
        }
        .ai-chat-input {
          flex: 1;
          background: transparent;
          border: none;
          color: var(--text-primary);
          font-size: 13.5px;
          padding: 10px 14px;
          outline: none;
        }
        .ai-chat-submit {
          padding: 10px 20px;
          font-size: 12.5px;
          font-weight: 600;
          border: none;
          border-radius: var(--radius-sm);
          background-color: #FFFFFF;
          color: #000000;
          cursor: pointer;
          transition: background-color var(--transition);
        }
        .ai-chat-submit:hover:not(:disabled) {
          background-color: var(--accent-hover);
        }
        .ai-chat-submit:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        /* Flashcards tab fullscreen */
        .ai-workspace-flashcards {
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
        }
        .ai-flashcard-container {
          perspective: 1200px;
          margin-bottom: 24px;
        }
        .ai-flashcard {
          width: 100%;
          height: 100%;
          position: relative;
          transform-style: preserve-3d;
          transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
          cursor: pointer;
        }
        .ai-flashcard:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
        }
        .ai-flashcard--flipped {
          transform: rotateY(180deg) translateY(-4px);
        }
        .ai-flashcard__side {
          position: absolute;
          width: 100%;
          height: 100%;
          backface-visibility: hidden;
          border-radius: var(--radius-lg);
          border: 1px solid var(--border);
          padding: 32px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
          transition: border-color var(--transition);
        }
        .ai-flashcard__front {
          background-color: var(--bg-surface);
          color: #FFFFFF;
        }
        .ai-flashcard__back {
          background-color: var(--bg-elevated);
          color: var(--text-secondary);
          transform: rotateY(180deg);
          border-color: var(--border-subtle);
        }
        .ai-flashcard__label {
          font-size: 9.5px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--text-muted);
          margin-bottom: 16px;
        }
        .ai-flashcard__content {
          font-size: 17px;
          font-weight: 500;
          line-height: 1.6;
          margin: 0;
          max-width: 90%;
        }
        .ai-flashcard-controls {
          display: flex;
          align-items: center;
          gap: 20px;
        }

        /* MCQ tab fullscreen */
        .ai-workspace-mcq-progress {
          margin-bottom: 24px;
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          padding: 16px 20px;
        }
        .ai-workspace-mcq-progress__bar-bg {
          height: 6px;
          width: 100%;
          background-color: var(--bg-darkest);
          border-radius: 3px;
          margin-top: 8px;
          overflow: hidden;
        }
        .ai-workspace-mcq-progress__bar-fill {
          height: 100%;
          background-color: #FFFFFF;
          border-radius: 3px;
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .ai-workspace-mcq-item-card {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          padding: 24px;
          margin-bottom: 24px;
          transition: border-color var(--transition);
        }
        .ai-workspace-mcq-item-card:hover {
          border-color: var(--border-subtle);
        }
        .ai-workspace-mcq-question {
          font-size: 15px;
          font-weight: 600;
          margin: 0 0 18px 0;
          line-height: 1.5;
          color: #FFFFFF;
        }
        .ai-workspace-mcq-options {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 12px;
          margin-bottom: 20px;
        }
        .ai-workspace-mcq-option-btn {
          display: flex;
          align-items: center;
          padding: 14px 18px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--border);
          background-color: var(--bg-darkest);
          cursor: pointer;
          font-size: 13px;
          transition: all var(--transition);
          color: var(--text-secondary);
        }
        .ai-workspace-mcq-option-btn:hover:not(.ai-workspace-mcq-option-btn--disabled) {
          border-color: var(--text-muted);
          background-color: var(--bg-hover);
          color: #FFFFFF;
        }
        .ai-workspace-mcq-option-btn--selected {
          border-color: #FFFFFF;
          background-color: var(--bg-hover);
          color: #FFFFFF;
          font-weight: 500;
        }
        .ai-workspace-mcq-option-btn--correct {
          border-color: rgba(34, 197, 94, 0.5);
          background-color: rgba(34, 197, 94, 0.1);
          color: #4ade80 !important;
          font-weight: 500;
        }
        .ai-workspace-mcq-option-btn--incorrect {
          border-color: rgba(239, 68, 68, 0.5);
          background-color: rgba(239, 68, 68, 0.1);
          color: #f87171 !important;
        }
        .ai-workspace-mcq-option-btn--disabled {
          cursor: default;
        }
      `}} />

      {/* ── AI STUDY ASSISTANT (Top Section) ── */}
      <div className="right-panel__section ai-assistant-wrapper">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <h3 className="right-panel__section-title" style={{ margin: 0 }}>
            {assistantMode === 'history'
              ? 'Study History'
              : uploadedDoc
                ? 'AI Study Assistant'
                : 'AI Study Helper'}
          </h3>
          <button 
            className="ai-expand-btn"
            title="Expand Workspace"
            onClick={() => setIsExpanded(true)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: '2px',
              transition: 'color var(--transition)'
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>

        {uploadError && (
          <div className="error-message" style={{ padding: '6px 10px', fontSize: '11px', marginBottom: '10px' }}>
            {uploadError}
            <button 
              onClick={() => setUploadError('')} 
              style={{ background: 'transparent', border: 'none', color: 'inherit', float: 'right', cursor: 'pointer' }}
            >
              ×
            </button>
          </div>
        )}
        {localPersistenceWarning && (
          <div className="error-message" style={{ padding: '6px 10px', fontSize: '11px', marginBottom: '10px' }}>
            {localPersistenceWarning}
            <button
              onClick={() => setLocalPersistenceWarning('')}
              style={{ background: 'transparent', border: 'none', color: 'inherit', float: 'right', cursor: 'pointer' }}
            >
              Ã—
            </button>
          </div>
        )}

        {assistantMode === 'history' ? (
          renderHistory()
        ) : !uploadedDoc ? (
          <div className="ai-study-empty">
            <p className="ai-study-tagline">Study smarter with AI.</p>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={handleFileChange}
              accept=".pdf,.txt,.docx"
            />
            <button
              type="button"
              className="ai-study-upload-card"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <svg className={`ai-study-upload-card__icon ${uploading ? 'ai-spinner' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                {uploading ? (
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                ) : (
                  <>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </>
                )}
              </svg>
              <span className="ai-study-upload-card__title">
                {uploading ? 'Uploading...' : 'Upload Study Material'}
              </span>
              <span className="ai-study-upload-card__formats">PDF &bull; DOCX &bull; TXT</span>
            </button>
            <section className="ai-features" aria-labelledby="ai-features-title">
              <h4 className="ai-features__title" id="ai-features-title">AI Features</h4>
              <ul className="ai-features__list">
                {AI_FEATURES.map((feature) => (
                  <li key={feature} className="ai-features__item">{feature}</li>
                ))}
              </ul>
            </section>
            <section className="ai-recent-sessions" aria-labelledby="ai-recent-sessions-title">
              <h4 className="ai-recent-sessions__title" id="ai-recent-sessions-title">Recent Sessions</h4>
              <button type="button" className="btn btn-secondary ai-study-history-link" onClick={openHistory}>
                View History &rarr;
              </button>
            </section>
          </div>
        ) : (
          <>
            <p className="ai-study-tagline">Study smarter with AI.</p>
            <div className="ai-study-document-card">
              <button
                type="button"
                className="btn btn-secondary ai-study-document-card__new"
                onClick={startNewStudy}
              >
                New
              </button>
              <span className="ai-study-document-card__name" title={uploadedDoc.filename}>
                {uploadedDoc.filename}
              </span>
              <span className="ai-study-document-card__status">
                <svg className="ai-study-document-card__status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Ready for AI
              </span>
            </div>

            <div className="ai-quick-study">
              <h4 className="ai-quick-study__title">Quick Study Actions</h4>
              <div className="ai-quick-actions">
                <button type="button" className={`ai-quick-action ${activeTab === 'summary' ? 'ai-quick-action--active' : ''}`} onClick={() => selectTab('summary')}>Summary</button>
                <button type="button" className={`ai-quick-action ${activeTab === 'flashcards' ? 'ai-quick-action--active' : ''}`} onClick={() => selectTab('flashcards')}>Flashcards</button>
                <button type="button" className={`ai-quick-action ${activeTab === 'mcq' ? 'ai-quick-action--active' : ''}`} onClick={() => selectTab('mcq')}>Practice Quiz</button>
                <button type="button" className={`ai-quick-action ${activeTab === 'chat' ? 'ai-quick-action--active' : ''}`} onClick={() => selectTab('chat')}>Ask Questions</button>
              </div>
            </div>

            <section className="ai-recent-sessions" aria-labelledby="ai-session-history-title">
              <h4 className="ai-recent-sessions__title" id="ai-session-history-title">Recent Sessions</h4>
              <button type="button" className="btn btn-secondary ai-study-history-link" onClick={openHistory}>
                View History &rarr;
              </button>
            </section>

            {/* Tabbed Content Area */}
            <div className="ai-sidebar-content">
              {activeTab === 'summary' && (
                <div>
                  {loadingSummary ? (
                    <SkeletonLoader lines={5} label="Generating summary..." />
                  ) : summaryData ? (
                    <div className="ai-fade-in">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ width: 'auto', padding: '4px 9px', fontSize: '10px', marginBottom: '10px' }}
                        onClick={() => fetchSummary()}
                      >
                        Regenerate
                      </button>
                      <div className="ai-sidebar-summary__sec">
                        <div className="ai-sidebar-summary__sec-title">Executive Summary</div>
                        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.5, fontSize: '12.5px' }}>
                          {summaryData.executive_summary}
                        </p>
                      </div>

                      {summaryData.key_concepts && summaryData.key_concepts.length > 0 && (
                        <div className="ai-sidebar-summary__sec">
                          <div className="ai-sidebar-summary__sec-title">Key Concepts</div>
                          {summaryData.key_concepts.map((c, i) => (
                            <div key={i} className="ai-sidebar-concept-row">
                              <span style={{ fontWeight: 600, color: '#FFF' }}>{c.concept}: </span>
                              <span style={{ color: 'var(--text-muted)' }}>{c.description}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {summaryData.key_points && summaryData.key_points.length > 0 && (
                        <div className="ai-sidebar-summary__sec">
                          <div className="ai-sidebar-summary__sec-title">Key Takeaways</div>
                          <ul style={{ paddingLeft: '16px', margin: 0, color: 'var(--text-secondary)' }}>
                            {summaryData.key_points.map((p, i) => (
                              <li key={i} style={{ marginBottom: '6px', lineHeight: 1.45 }}>{p}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      className="btn btn-primary"
                      style={{ padding: '8px 16px', fontSize: '12px' }}
                      onClick={() => fetchSummary()}
                      disabled={loadingSummary}
                    >
                      Generate Summary
                    </button>
                  )}
                </div>
              )}

              {activeTab === 'chat' && (
                <div style={{ display: 'flex', flexDirection: 'column' }} className="ai-fade-in">
                  <div className="ai-sidebar-chat-list">
                    {chatMessages.map(msg => (
                      <div 
                        key={msg.id} 
                        className={`ai-sidebar-bubble ai-sidebar-bubble--${msg.sender}`}
                      >
                        {msg.sender === 'ai'
                          ? <ChatMarkdownMessage content={msg.content} />
                          : msg.content}
                      </div>
                    ))}
                    {sendingChat && (
                      <div className="ai-sidebar-bubble ai-sidebar-bubble--ai" style={{ opacity: 0.85, display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <svg className="ai-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                        Thinking...
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  <form className="ai-sidebar-chat-form" onSubmit={handleSendChat}>
                    <input 
                      type="text" 
                      className="ai-sidebar-chat-input"
                      placeholder="Ask document..."
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      disabled={sendingChat}
                    />
                    <button type="submit" className="ai-sidebar-chat-btn" disabled={!chatInput.trim() || sendingChat}>
                      →
                    </button>
                  </form>
                </div>
              )}

              {activeTab === 'flashcards' && (
                <div>
                  {loadingFlashcards ? (
                    <SkeletonLoader lines={4} label="Generating flashcards..." />
                  ) : flashcards.length > 0 ? (
                    <div className="ai-fade-in">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ width: 'auto', padding: '4px 9px', fontSize: '10px', marginBottom: '10px' }}
                        onClick={() => fetchFlashcards()}
                      >
                        Regenerate
                      </button>
                      <div 
                        className={`ai-sidebar-card ${flashcardFlipped ? 'ai-sidebar-card--flipped' : ''}`}
                        onClick={() => setFlashcardFlipped(!flashcardFlipped)}
                      >
                        <div className="ai-flashcard__label">
                          {flashcardFlipped ? 'Answer' : 'Question'}
                        </div>
                        <div className="ai-sidebar-card__content">
                          {flashcardFlipped 
                            ? flashcards[currentFlashcardIndex].answer 
                            : flashcards[currentFlashcardIndex].question}
                        </div>
                        <span style={{ fontSize: '9px', color: 'var(--text-muted)', opacity: 0.6, marginTop: 'auto' }}>
                          Click to flip
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                        <button 
                          className="btn btn-secondary" 
                          style={{ width: 'auto', padding: '4px 10px', fontSize: '11px' }}
                          disabled={currentFlashcardIndex === 0}
                          onClick={() => {
                            setCurrentFlashcardIndex(prev => prev - 1);
                            setFlashcardFlipped(false);
                          }}
                        >
                          Prev
                        </button>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {currentFlashcardIndex + 1} of {flashcards.length}
                        </span>
                        <button 
                          className="btn btn-secondary" 
                          style={{ width: 'auto', padding: '4px 10px', fontSize: '11px' }}
                          disabled={currentFlashcardIndex === flashcards.length - 1}
                          onClick={() => {
                            setCurrentFlashcardIndex(prev => prev + 1);
                            setFlashcardFlipped(false);
                          }}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="btn btn-primary"
                      style={{ padding: '8px 16px', fontSize: '12px' }}
                      onClick={() => fetchFlashcards()}
                      disabled={loadingFlashcards}
                    >
                      Generate Cards
                    </button>
                  )}
                </div>
              )}

              {activeTab === 'mcq' && (
                <div>
                  {loadingMcqs ? (
                    <SkeletonLoader lines={6} label="Generating quiz..." />
                  ) : mcqs.length > 0 ? (
                    <div className="ai-fade-in">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ width: 'auto', padding: '4px 9px', fontSize: '10px', marginBottom: '10px' }}
                        onClick={() => fetchMcqs()}
                      >
                        Regenerate
                      </button>
                      {mcqs.map((q, qIdx) => {
                        const isChecked = mcqChecked[qIdx];
                        const selectedOptIdx = mcqAnswers[qIdx];
                        const correctOptIdx = q.options.indexOf(q.correct_answer);

                        return (
                          <div key={qIdx} className="ai-sidebar-mcq-item">
                            <div style={{ fontWeight: 600, marginBottom: '6px', lineHeight: 1.4 }}>Q{qIdx + 1}. {q.question}</div>
                            
                            {q.options.map((opt, oIdx) => {
                              let optClass = 'ai-sidebar-mcq-opt';
                              if (selectedOptIdx === oIdx) optClass += ' ai-sidebar-mcq-opt--selected';
                              if (isChecked) {
                                optClass += ' ai-sidebar-mcq-opt--disabled';
                                if (oIdx === correctOptIdx) optClass += ' ai-sidebar-mcq-opt--correct';
                                else if (selectedOptIdx === oIdx) optClass += ' ai-sidebar-mcq-opt--incorrect';
                              }

                              return (
                                <div 
                                  key={oIdx} 
                                  className={optClass}
                                  onClick={() => handleSelectMcqOption(qIdx, oIdx)}
                                >
                                  {opt}
                                </div>
                              );
                            })}

                            {!isChecked ? (
                              <button 
                                className="btn btn-secondary" 
                                style={{ width: 'auto', padding: '4px 10px', fontSize: '10px', marginTop: '8px' }}
                                disabled={selectedOptIdx === undefined}
                                onClick={() => handleCheckMcq(qIdx)}
                              >
                                Check Answer
                              </button>
                            ) : (
                              <div style={{ fontSize: '10.5px', marginTop: '6px', fontWeight: '500' }}>
                                {selectedOptIdx === correctOptIdx 
                                  ? <span style={{ color: '#4ade80' }}>✓ Correct</span> 
                                  : <span style={{ color: '#f87171' }}>✗ Incorrect (Ans: {q.correct_answer})</span>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <button
                      className="btn btn-primary"
                      style={{ padding: '8px 16px', fontSize: '12px' }}
                      onClick={() => fetchMcqs()}
                      disabled={loadingMcqs}
                    >
                      Generate Quiz
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── SERVER SPECIFIC VIEWS (Invite Code, Members List) ── */}
      {showServerInfo ? (
        <>
          {/* Server Invite Code */}
          <div className="right-panel__section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <h3 className="right-panel__section-title" style={{ margin: 0 }}>Invite Code</h3>
              {canOpenSettings && (
                <button className="settings-mini-btn" onClick={onOpenSettings} title="Server settings" aria-label="Server settings">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              <div
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  fontFamily: 'monospace',
                  fontSize: '13px',
                  fontWeight: '500',
                  color: 'var(--text-primary)',
                  letterSpacing: '0.05em',
                  textAlign: 'center',
                  userSelect: 'all',
                }}
              >
                {serverInviteCode || 'No invite code'}
              </div>
              <button
                onClick={handleCopy}
                className="btn btn-secondary"
                disabled={!serverInviteCode}
                style={{
                  width: 'auto',
                  padding: '6px 12px',
                  fontSize: '11px',
                  backgroundColor: copied ? '#FFFFFF' : 'transparent',
                  borderColor: copied ? '#FFFFFF' : 'var(--border)',
                  color: copied ? '#000000' : 'var(--text-primary)',
                  transition: 'all 0.15s ease',
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Members List */}
          <div className="right-panel__section">
            <h3 className="right-panel__section-title">
              Members ({membersLoading ? '...' : members.length})
            </h3>

            {membersLoading && (
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                Loading members...
              </p>
            )}

            {!membersLoading && members.length === 0 && (
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                No members found.
              </p>
            )}

            {!membersLoading &&
              members.map((m) => {
                const profileObj = m.profiles || {};
                const displayName = profileObj.full_name || profileObj.username || 'Anonymous';
                const username = profileObj.username || 'user';

                return (
                  <div key={m.user_id || username} className="member-item" style={{ margin: '6px 0' }}>
                    {profileObj.avatar_url ? (
                      <img
                        src={profileObj.avatar_url}
                        alt={displayName}
                        className="member-item__avatar"
                        style={{ objectFit: 'cover' }}
                      />
                    ) : (
                      <div
                        className="member-item__avatar"
                        style={{ backgroundColor: getAvatarBg(username) }}
                      >
                        {getInitials(displayName)}
                      </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, marginLeft: '2px' }}>
                      <span
                        className="member-item__name"
                        style={{
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          fontWeight: '500',
                          color: 'var(--text-primary)',
                          lineHeight: '1.2',
                        }}
                      >
                        {username}
                      </span>
                      {profileObj.full_name && (
                        <span
                          style={{
                            fontSize: '9px',
                            color: 'var(--text-muted)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            marginTop: '1px',
                          }}
                        >
                          {profileObj.full_name}
                        </span>
                      )}
                    </div>

                    <span className="member-item__role">
                      {m.role === 'owner' ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Member'}
                    </span>
                  </div>
                );
              })}
          </div>
        </>
      ) : (
        /* ── GENERIC SHARED RESOURCES (Home View Only) ── */
        <div className="right-panel__section">
          <h3 className="right-panel__section-title">Shared Resources</h3>
          <div className="shared-resources-empty">
            <svg className="shared-resources-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
            </svg>
            <span>Choose a server and channel to browse shared study materials.</span>
          </div>
        </div>
      )}

      {/* ── AI STUDY ASSISTANT FULL WORKSPACE MODAL ── */}
      {isExpanded && (
        <div className="ai-workspace-modal" onClick={() => setIsExpanded(false)}>
          <div className="ai-workspace-card" onClick={(e) => e.stopPropagation()}>
            <header className="ai-workspace-header">
              <div className="ai-workspace-header__left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <h2 className="ai-workspace-title">AI Study Assistant Workspace</h2>
                {uploadedDoc && <span className="ai-workspace-docname">{uploadedDoc.filename}</span>}
              </div>
              <div className="ai-workspace-header__right" style={{ display: 'flex', alignItems: 'center' }}>
                {uploadedDoc && (
                  <>
                    <button className="btn btn-secondary" style={{ width: 'auto', padding: '5px 12px', marginRight: '8px', fontSize: '11px' }} onClick={openHistory}>
                      History
                    </button>
                    <button className="btn btn-secondary" style={{ width: 'auto', padding: '5px 12px', marginRight: '16px', fontSize: '11px' }} onClick={startNewStudy}>
                      New Study
                    </button>
                  </>
                )}
                <button className="ai-workspace-close" onClick={() => setIsExpanded(false)}>×</button>
              </div>
            </header>
            <div className="ai-workspace-body">
              {assistantMode === 'history' ? (
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', background: 'var(--bg-dark)' }}>
                  {renderHistory(true)}
                </div>
              ) : !uploadedDoc ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: 'var(--bg-dark)' }}>
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '48px',
                    borderRadius: 'var(--radius-lg)',
                    border: '1px dashed var(--border)',
                    backgroundColor: 'var(--bg-surface)',
                    maxWidth: '480px',
                    width: '100%',
                    textAlign: 'center',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                  }}>
                    <svg className="ai-sidebar-upload__icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)', marginBottom: '16px' }}>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <h3 style={{ fontSize: '16px', fontWeight: '600', color: '#FFF', marginBottom: '8px' }}>Start your learning session</h3>
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '24px', lineHeight: 1.5 }}>
                      Upload your study document to automatically generate summarized notes, Q&A chat assistants, interactive flashcards, or revision quizzes.
                    </p>
                    <button 
                      className="btn btn-primary"
                      onClick={() => fileInputRef.current?.click()}
                      style={{ padding: '10px 24px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}
                      disabled={uploading}
                    >
                      {uploading ? (
                        <>
                          <svg className="ai-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                          </svg>
                          Uploading document...
                        </>
                      ) : (
                        'Select PDF, TXT or DOCX'
                      )}
                    </button>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '16px' }}>
                      Supported formats: .pdf, .txt, .docx
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={openHistory}
                      style={{ width: 'auto', marginTop: '12px', padding: '7px 18px', fontSize: '12px' }}
                    >
                      History
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ai-workspace-split">
                  {/* Left Column: Navigation Tabs */}
                  <div className="ai-workspace-tabs">
                    <button 
                      className={`ai-workspace-tab-btn ${activeTab === 'summary' ? 'ai-workspace-tab-btn--active' : ''}`}
                      onClick={() => selectTab('summary')}
                    >
                      Document Summary
                    </button>
                    <button 
                      className={`ai-workspace-tab-btn ${activeTab === 'chat' ? 'ai-workspace-tab-btn--active' : ''}`}
                      onClick={() => selectTab('chat')}
                    >
                      Chat Q&A
                    </button>
                    <button 
                      className={`ai-workspace-tab-btn ${activeTab === 'flashcards' ? 'ai-workspace-tab-btn--active' : ''}`}
                      onClick={() => selectTab('flashcards')}
                    >
                      Interactive Flashcards
                    </button>
                    <button 
                      className={`ai-workspace-tab-btn ${activeTab === 'mcq' ? 'ai-workspace-tab-btn--active' : ''}`}
                      onClick={() => selectTab('mcq')}
                    >
                      Revision MCQs Quiz
                    </button>
                  </div>
                  
                  {/* Right Column: Content */}
                  <div className="ai-workspace-content">
                    {activeTab === 'summary' && (
                      <div className="ai-workspace-summary" style={{ overflowY: 'auto', paddingRight: '10px' }}>
                        {loadingSummary ? (
                          <div style={{ padding: '24px' }}>
                            <SkeletonLoader lines={8} label="Analyzing document & generating summary..." />
                          </div>
                        ) : summaryData ? (
                          <div className="ai-fade-in">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ width: 'auto', padding: '7px 16px', fontSize: '12px', marginBottom: '14px' }}
                              onClick={() => fetchSummary()}
                            >
                              Regenerate Summary
                            </button>
                            <div className="ai-summary-card" style={{ padding: '24px', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                              <h4 className="ai-summary-card__title" style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '12px' }}>Executive Summary</h4>
                              <p className="ai-summary-card__text" style={{ fontSize: '14px', lineHeight: 1.6, color: 'var(--text-secondary)' }}>{summaryData.executive_summary}</p>
                            </div>
                            
                            <h4 className="ai-summary-card__title" style={{ marginTop: '28px', fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Key Concepts</h4>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px', marginBottom: '24px', marginTop: '12px' }}>
                              {summaryData.key_concepts?.map((c, i) => (
                                <div key={i} className="ai-concept-card" style={{ padding: '18px', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                  <h5 className="ai-concept-card__name" style={{ fontSize: '13.5px', marginBottom: '6px', color: '#FFF', fontWeight: '600' }}>{c.concept}</h5>
                                  <p className="ai-concept-card__desc" style={{ fontSize: '12.5px', lineHeight: 1.5, color: 'var(--text-secondary)' }}>{c.description}</p>
                                </div>
                              ))}
                            </div>
 
                            <h4 className="ai-summary-card__title" style={{ marginTop: '28px', fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Key Takeaways</h4>
                            <ul className="ai-points-list" style={{ marginTop: '12px', color: 'var(--text-secondary)', paddingLeft: '20px' }}>
                              {summaryData.key_points?.map((p, i) => (
                                <li key={i} style={{ fontSize: '13.5px', marginBottom: '8px', lineHeight: 1.55 }}>{p}</li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                            <button className="btn btn-primary" style={{ width: 'auto', padding: '10px 20px' }} onClick={() => fetchSummary()} disabled={loadingSummary}>
                              Generate Summary
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {activeTab === 'chat' && (
                      <div className="ai-workspace-chat" style={{ height: '100%', justifyContent: 'space-between' }}>
                        <div className="ai-chat-messages" style={{ flex: 1, overflowY: 'auto', paddingRight: '10px', marginBottom: '16px' }}>
                          {chatMessages.map(msg => (
                            <div key={msg.id} className={`ai-message ai-message--${msg.sender}`} style={{ maxWidth: '80%' }}>
                              <div className="ai-message__avatar">
                                {msg.sender === 'ai' ? 'AI' : (profile?.username?.[0]?.toUpperCase() || 'U')}
                              </div>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div className="ai-message__bubble">
                                  {msg.sender === 'ai'
                                    ? <ChatMarkdownMessage content={msg.content} />
                                    : msg.content}
                                </div>
                                <span className="ai-message__time">{msg.time}</span>
                              </div>
                            </div>
                          ))}
                          {sendingChat && (
                            <div className="ai-message ai-message--ai" style={{ maxWidth: '80%' }}>
                              <div className="ai-message__avatar">AI</div>
                              <div className="ai-typing-indicator">
                                <span className="ai-typing-dot"></span>
                                <span className="ai-typing-dot"></span>
                                <span className="ai-typing-dot"></span>
                              </div>
                            </div>
                          )}
                          <div ref={chatEndRef} />
                        </div>
                        
                        <form className="ai-chat-compose" onSubmit={handleSendChat}>
                          <input 
                            type="text" 
                            className="ai-chat-input"
                            style={{ padding: '12px 16px', fontSize: '13.5px' }}
                            placeholder="Ask anything about the document..."
                            value={chatInput}
                            onChange={e => setChatInput(e.target.value)}
                            disabled={sendingChat}
                          />
                          <button type="submit" className="ai-chat-submit" style={{ height: '42px', padding: '0 24px' }} disabled={!chatInput.trim() || sendingChat}>
                            Send
                          </button>
                        </form>
                      </div>
                    )}
                    
                    {activeTab === 'flashcards' && (
                      <div className="ai-workspace-flashcards" style={{ justifyContent: 'center', height: '100%' }}>
                        {loadingFlashcards ? (
                          <div style={{ width: '400px' }}>
                            <SkeletonLoader lines={5} label="Generating interactive study cards..." />
                          </div>
                        ) : flashcards.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }} className="ai-fade-in">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ width: 'auto', padding: '7px 16px', fontSize: '12px', marginBottom: '14px' }}
                              onClick={() => fetchFlashcards()}
                            >
                              Regenerate Flashcards
                            </button>
                            <div className="ai-flashcard-container" style={{ height: '320px', width: '540px' }}>
                              <div 
                                className={`ai-flashcard ${flashcardFlipped ? 'ai-flashcard--flipped' : ''}`}
                                onClick={() => setFlashcardFlipped(!flashcardFlipped)}
                              >
                                <div className="ai-flashcard__side ai-flashcard__front" style={{ padding: '36px' }}>
                                  <span className="ai-flashcard__label">Question</span>
                                  <p className="ai-flashcard__content" style={{ fontSize: '18px' }}>{flashcards[currentFlashcardIndex].question}</p>
                                  <span className="ai-flashcard__label" style={{ marginTop: 'auto', marginBottom: 0, opacity: 0.5 }}>Click to reveal answer</span>
                                </div>
                                <div className="ai-flashcard__side ai-flashcard__back" style={{ padding: '36px' }}>
                                  <span className="ai-flashcard__label">Answer</span>
                                  <p className="ai-flashcard__content" style={{ fontSize: '16px' }}>{flashcards[currentFlashcardIndex].answer}</p>
                                  <span className="ai-flashcard__label" style={{ marginTop: 'auto', marginBottom: 0, opacity: 0.5 }}>Click to flip back</span>
                                </div>
                              </div>
                            </div>
                            
                            <div className="ai-flashcard-controls" style={{ marginTop: '24px' }}>
                              <button 
                                className="btn btn-secondary" 
                                style={{ width: 'auto', padding: '8px 20px', fontSize: '13px' }}
                                disabled={currentFlashcardIndex === 0}
                                onClick={() => {
                                  setCurrentFlashcardIndex(prev => prev - 1);
                                  setFlashcardFlipped(false);
                                }}
                              >
                                Previous
                              </button>
                              <span style={{ fontSize: '14px', color: 'var(--text-muted)', minWidth: '70px', textAlign: 'center' }}>
                                {currentFlashcardIndex + 1} of {flashcards.length}
                              </span>
                              <button 
                                className="btn btn-secondary" 
                                style={{ width: 'auto', padding: '8px 20px', fontSize: '13px' }}
                                disabled={currentFlashcardIndex === flashcards.length - 1}
                                onClick={() => {
                                  setCurrentFlashcardIndex(prev => prev + 1);
                                  setFlashcardFlipped(false);
                                }}
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                            <button className="btn btn-primary" style={{ width: 'auto', padding: '10px 20px' }} onClick={() => fetchFlashcards()} disabled={loadingFlashcards}>
                              Generate Flashcards
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {activeTab === 'mcq' && (
                      <div className="ai-workspace-mcqs" style={{ overflowY: 'auto', height: '100%', paddingRight: '12px' }}>
                        {loadingMcqs ? (
                          <div style={{ padding: '24px' }}>
                            <SkeletonLoader lines={8} label="Generating quiz questions..." />
                          </div>
                        ) : mcqs.length > 0 ? (
                          <div className="ai-fade-in">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ width: 'auto', padding: '7px 16px', fontSize: '12px', marginBottom: '14px' }}
                              onClick={() => fetchMcqs()}
                            >
                              Regenerate MCQ Quiz
                            </button>
                            {/* Quiz Progress Indicator */}
                            <div className="ai-workspace-mcq-progress">
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', fontWeight: '500' }}>
                                <span>Quiz Progress</span>
                                <span style={{ color: 'var(--text-muted)' }}>
                                  {Object.keys(mcqChecked).length} of {mcqs.length} answered
                                </span>
                              </div>
                              <div className="ai-workspace-mcq-progress__bar-bg">
                                <div 
                                  className="ai-workspace-mcq-progress__bar-fill" 
                                  style={{ width: `${(Object.keys(mcqChecked).length / mcqs.length) * 100}%` }}
                                />
                              </div>
                            </div>

                            {mcqs.map((q, qIdx) => {
                              const isChecked = mcqChecked[qIdx];
                              const selectedOptIdx = mcqAnswers[qIdx];
                              const correctOptIdx = q.options.indexOf(q.correct_answer);

                              return (
                                <div key={qIdx} className="ai-workspace-mcq-item-card">
                                  <h4 className="ai-workspace-mcq-question">Q{qIdx + 1}. {q.question}</h4>
                                  
                                  <div className="ai-workspace-mcq-options">
                                    {q.options.map((opt, oIdx) => {
                                      let optClass = 'ai-workspace-mcq-option-btn';
                                      if (selectedOptIdx === oIdx) optClass += ' ai-workspace-mcq-option-btn--selected';
                                      if (isChecked) {
                                        optClass += ' ai-workspace-mcq-option-btn--disabled';
                                        if (oIdx === correctOptIdx) optClass += ' ai-workspace-mcq-option-btn--correct';
                                        else if (selectedOptIdx === oIdx) optClass += ' ai-workspace-mcq-option-btn--incorrect';
                                      }

                                      return (
                                        <button 
                                          key={oIdx} 
                                          className={optClass}
                                          disabled={isChecked}
                                          onClick={() => handleSelectMcqOption(qIdx, oIdx)}
                                        >
                                          {opt}
                                        </button>
                                      );
                                    })}
                                  </div>

                                  {!isChecked ? (
                                    <button 
                                      className="btn btn-secondary" 
                                      style={{ width: 'auto', padding: '6px 16px', fontSize: '12px' }}
                                      disabled={selectedOptIdx === undefined}
                                      onClick={() => handleCheckMcq(qIdx)}
                                    >
                                      Submit Answer
                                    </button>
                                  ) : (
                                    <div style={{ fontSize: '13px', marginTop: '10px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      {selectedOptIdx === correctOptIdx 
                                        ? <span style={{ color: '#4ade80' }}>✓ Correct! Well done.</span> 
                                        : <span style={{ color: '#f87171' }}>✗ Incorrect. Correct answer: {q.correct_answer}</span>}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                            <button className="btn btn-primary" style={{ width: 'auto', padding: '10px 20px' }} onClick={() => fetchMcqs()} disabled={loadingMcqs}>
                              Generate MCQ Quiz
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
