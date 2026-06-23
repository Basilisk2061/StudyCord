import { useState, useRef, useEffect } from 'react';

const SUGGESTED_PROMPTS = [
  'Explain binary search trees',
  'Quiz me on Chapter 7',
  'Summarize sorting algorithms',
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

export default function RightPanel({
  activeServerId,
  serverInviteCode,
  members = [],
  membersLoading = false,
  profile,
  userId,
}) {
  const [copied, setCopied] = useState(false);

  // AI Assistant States
  const [activeTab, setActiveTab] = useState('summary');
  const [uploadedDoc, setUploadedDoc] = useState(null); // { docId, filename }
  const [uploadError, setUploadError] = useState('');
  
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

  const handleCopy = () => {
    if (!serverInviteCode) return;
    navigator.clipboard.writeText(serverInviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const showServerInfo = activeServerId !== null;

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
      const response = await fetch('http://127.0.0.1:8000/api/rag/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Failed to upload document.');
      }

      const data = await response.json();
      setUploadedDoc({
        docId: data.doc_id,
        filename: file.name,
      });

      // Clear old data when a new doc is uploaded
      setSummaryData(null);
      setFlashcards([]);
      setMcqs([]);
      setChatMessages([
        {
          id: 'welcome',
          sender: 'ai',
          content: `Loaded **${file.name}**. I can now summarize it, quiz you, or answer questions!`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
      ]);
      setActiveTab('summary');
      fetchSummary(data.doc_id); // Auto-summarize on upload
    } catch (err) {
      console.error(err);
      setUploadError(err.message || 'Error uploading file.');
    } finally {
      setUploading(false);
    }
  };

  const fetchSummary = async (docId = uploadedDoc?.docId) => {
    if (!docId) return;
    setLoadingSummary(true);
    try {
      const response = await fetch('http://127.0.0.1:8000/api/rag/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: docId }),
      });
      if (!response.ok) throw new Error('Failed to generate summary.');
      const data = await response.json();
      setSummaryData(data);
    } catch (err) {
      console.error(err);
      setUploadError('Failed to generate summary.');
    } finally {
      setLoadingSummary(false);
    }
  };

  const fetchFlashcards = async () => {
    if (!uploadedDoc?.docId) return;
    if (flashcards.length > 0) return;
    setLoadingFlashcards(true);
    try {
      const response = await fetch('http://127.0.0.1:8000/api/rag/flashcards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: uploadedDoc.docId }),
      });
      if (!response.ok) throw new Error('Failed to generate flashcards.');
      const data = await response.json();
      setFlashcards(data.flashcards || []);
      setCurrentFlashcardIndex(0);
      setFlashcardFlipped(false);
    } catch (err) {
      console.error(err);
      setUploadError('Failed to generate flashcards.');
    } finally {
      setLoadingFlashcards(false);
    }
  };

  const fetchMcqs = async () => {
    if (!uploadedDoc?.docId) return;
    if (mcqs.length > 0) return;
    setLoadingMcqs(true);
    try {
      const response = await fetch('http://127.0.0.1:8000/api/rag/mcq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: uploadedDoc.docId }),
      });
      if (!response.ok) throw new Error('Failed to generate MCQs.');
      const data = await response.json();
      setMcqs(data.mcqs || []);
      setMcqAnswers({});
      setMcqChecked({});
    } catch (err) {
      console.error(err);
      setUploadError('Failed to generate MCQs.');
    } finally {
      setLoadingMcqs(false);
    }
  };

  const handleSendChat = async (e) => {
    e.preventDefault();
    if (!chatInput.trim() || !uploadedDoc?.docId || sendingChat) return;

    const userMessage = {
      id: Date.now().toString(),
      sender: 'user',
      content: chatInput,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setSendingChat(true);

    try {
      const response = await fetch('http://127.0.0.1:8000/api/rag/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userMessage.content,
          mode: 'chat',
          doc_id: uploadedDoc.docId,
        }),
      });

      if (!response.ok) throw new Error('Failed to get answer.');
      const data = await response.json();

      setChatMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          content: data.answer,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
      ]);
    } catch (err) {
      console.error(err);
      setChatMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          content: 'Error processing question. Please try again.',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isError: true,
        }
      ]);
    } finally {
      setSendingChat(false);
    }
  };

  const resetDocument = () => {
    setUploadedDoc(null);
    setSummaryData(null);
    setFlashcards([]);
    setMcqs([]);
    setChatMessages([]);
    setUploadError('');
  };

  const selectTab = (tab) => {
    setActiveTab(tab);
    if (tab === 'flashcards') fetchFlashcards();
    if (tab === 'mcq') fetchMcqs();
  };

  const handleSelectMcqOption = (mcqIndex, optionIndex) => {
    if (mcqChecked[mcqIndex]) return;
    setMcqAnswers(prev => ({ ...prev, [mcqIndex]: optionIndex }));
  };

  const handleCheckMcq = (mcqIndex) => {
    if (mcqAnswers[mcqIndex] === undefined) return;
    setMcqChecked(prev => ({ ...prev, [mcqIndex]: true }));
  };

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
        .ai-helper__desc {
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.5;
          margin: 0 0 12px 0;
        }
        .ai-sidebar-upload {
          border: 1px dashed var(--border);
          border-radius: var(--radius-sm);
          padding: 18px 12px;
          text-align: center;
          background-color: var(--bg-surface);
          cursor: pointer;
          transition: all var(--transition);
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .ai-sidebar-upload:hover {
          border-color: var(--text-muted);
          background-color: var(--bg-hover);
        }
        .ai-sidebar-upload__icon {
          width: 24px;
          height: 24px;
          color: var(--text-muted);
          margin-bottom: 6px;
        }
        .ai-sidebar-upload__text {
          font-size: 11px;
          font-weight: 500;
        }
        .ai-sidebar-doc {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px;
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          margin-bottom: 12px;
          gap: 8px;
        }
        .ai-sidebar-doc__name {
          font-size: 11px;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }
        .ai-sidebar-tabs {
          display: flex;
          background-color: var(--bg-darkest);
          padding: 2px;
          border-radius: var(--radius-xs);
          margin-bottom: 12px;
          gap: 2px;
        }
        .ai-sidebar-tab {
          flex: 1;
          background: transparent;
          border: none;
          color: var(--text-muted);
          padding: 4px 2px;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          border-radius: 2px;
          text-align: center;
          transition: all var(--transition);
        }
        .ai-sidebar-tab:hover {
          color: var(--text-primary);
        }
        .ai-sidebar-tab--active {
          background-color: var(--bg-elevated);
          color: var(--text-primary);
          border: 1px solid var(--border);
        }
        .ai-sidebar-content {
          max-height: 280px;
          overflow-y: auto;
          font-size: 12px;
          padding-right: 2px;
        }
        .ai-sidebar-content::-webkit-scrollbar { width: 3px; }
        .ai-sidebar-content::-webkit-scrollbar-thumb { background-color: var(--border); }
        
        .ai-sidebar-summary__sec {
          margin-bottom: 12px;
        }
        .ai-sidebar-summary__sec-title {
          font-weight: 600;
          color: #FFFFFF;
          margin-bottom: 4px;
        }
        .ai-sidebar-concept-row {
          padding: 6px;
          border-bottom: 1px solid var(--border);
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
          max-height: 200px;
          overflow-y: auto;
        }
        .ai-sidebar-chat-list::-webkit-scrollbar { width: 2px; }
        .ai-sidebar-bubble {
          padding: 6px 10px;
          border-radius: var(--radius-sm);
          line-height: 1.4;
          word-break: break-word;
          max-width: 90%;
        }
        .ai-sidebar-bubble--ai {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          align-self: flex-start;
        }
        .ai-sidebar-bubble--user {
          background-color: #FFFFFF;
          color: #000000;
          align-self: flex-end;
        }
        .ai-sidebar-chat-form {
          display: flex;
          gap: 4px;
        }
        .ai-sidebar-chat-input {
          flex: 1;
          padding: 6px 10px;
          font-size: 11px;
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
          padding: 0 8px;
          border-radius: var(--radius-xs);
          cursor: pointer;
        }

        /* Sidebar Flashcard */
        .ai-sidebar-card {
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          background-color: var(--bg-surface);
          height: 130px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          cursor: pointer;
          user-select: none;
          transition: all 0.3s ease;
        }
        .ai-sidebar-card--flipped {
          background-color: var(--bg-elevated);
          border-color: var(--border-subtle);
        }
        .ai-sidebar-card__content {
          font-size: 12px;
          font-weight: 500;
          line-height: 1.4;
        }

        /* Sidebar MCQ */
        .ai-sidebar-mcq-item {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 10px;
          margin-bottom: 10px;
        }
        .ai-sidebar-mcq-opt {
          padding: 6px 8px;
          border: 1px solid var(--border);
          border-radius: var(--radius-xs);
          background-color: var(--bg-darkest);
          margin-top: 4px;
          cursor: pointer;
          font-size: 11px;
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
      `}} />

      {/* ── AI STUDY ASSISTANT (Top Section) ── */}
      <div className="right-panel__section ai-assistant-wrapper">
        <h3 className="right-panel__section-title">
          {uploadedDoc ? 'AI Study Assistant' : 'AI Study Helper'}
        </h3>

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

        {!uploadedDoc ? (
          <>
            <p className="ai-helper__desc">
              Upload a study document to start using AI tools.
            </p>
            <div 
              className="ai-sidebar-upload"
              onClick={() => fileInputRef.current?.click()}
            >
              <input 
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                onChange={handleFileChange}
                accept=".pdf,.txt,.docx"
              />
              {uploading ? (
                <>
                  <svg className="ai-sidebar-upload__icon ai-spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span className="ai-sidebar-upload__text">Uploading...</span>
                </>
              ) : (
                <>
                  <svg className="ai-sidebar-upload__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span className="ai-sidebar-upload__text">Upload PDF/TXT/DOCX</span>
                </>
              )}
            </div>
            
            {/* Suggested prompts list (Only shown if no doc is uploaded) */}
            <div className="ai-helper__prompts" style={{ marginTop: '16px' }}>
              {SUGGESTED_PROMPTS.map((prompt) => (
                <span key={prompt} className="ai-helper__prompt">
                  {prompt}
                </span>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="ai-sidebar-doc">
              <span className="ai-sidebar-doc__name" title={uploadedDoc.filename}>
                {uploadedDoc.filename}
              </span>
              <button 
                className="btn btn-secondary" 
                style={{ width: 'auto', padding: '3px 8px', fontSize: '9px' }}
                onClick={resetDocument}
              >
                Change
              </button>
            </div>

            {/* Tab Navigation */}
            <div className="ai-sidebar-tabs">
              <button 
                className={`ai-sidebar-tab ${activeTab === 'summary' ? 'ai-sidebar-tab--active' : ''}`}
                onClick={() => selectTab('summary')}
              >
                Summary
              </button>
              <button 
                className={`ai-sidebar-tab ${activeTab === 'chat' ? 'ai-sidebar-tab--active' : ''}`}
                onClick={() => selectTab('chat')}
              >
                Chat
              </button>
              <button 
                className={`ai-sidebar-tab ${activeTab === 'flashcards' ? 'ai-sidebar-tab--active' : ''}`}
                onClick={() => selectTab('flashcards')}
              >
                Cards
              </button>
              <button 
                className={`ai-sidebar-tab ${activeTab === 'mcq' ? 'ai-sidebar-tab--active' : ''}`}
                onClick={() => selectTab('mcq')}
              >
                MCQs
              </button>
            </div>

            {/* Tabbed Content Area */}
            <div className="ai-sidebar-content">
              {activeTab === 'summary' && (
                <div>
                  {loadingSummary ? (
                    <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-muted)' }}>
                      Generating summary...
                    </div>
                  ) : summaryData ? (
                    <div>
                      <div className="ai-sidebar-summary__sec">
                        <div className="ai-sidebar-summary__sec-title">Executive Summary</div>
                        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
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
                          <ul style={{ paddingLeft: '14px', margin: 0, color: 'var(--text-secondary)' }}>
                            {summaryData.key_points.map((p, i) => (
                              <li key={i} style={{ marginBottom: '4px' }}>{p}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => fetchSummary()}>
                      Generate Summary
                    </button>
                  )}
                </div>
              )}

              {activeTab === 'chat' && (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div className="ai-sidebar-chat-list">
                    {chatMessages.map(msg => (
                      <div 
                        key={msg.id} 
                        className={`ai-sidebar-bubble ai-sidebar-bubble--${msg.sender}`}
                      >
                        {msg.content}
                      </div>
                    ))}
                    {sendingChat && (
                      <div className="ai-sidebar-bubble ai-sidebar-bubble--ai" style={{ opacity: 0.6 }}>
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
                    <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-muted)' }}>
                      Generating cards...
                    </div>
                  ) : flashcards.length > 0 ? (
                    <div>
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
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px' }}>
                        <button 
                          className="btn btn-secondary" 
                          style={{ width: 'auto', padding: '3px 8px', fontSize: '10px' }}
                          disabled={currentFlashcardIndex === 0}
                          onClick={() => {
                            setCurrentFlashcardIndex(prev => prev - 1);
                            setFlashcardFlipped(false);
                          }}
                        >
                          Prev
                        </button>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          {currentFlashcardIndex + 1} of {flashcards.length}
                        </span>
                        <button 
                          className="btn btn-secondary" 
                          style={{ width: 'auto', padding: '3px 8px', fontSize: '10px' }}
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
                    <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={fetchFlashcards}>
                      Generate Cards
                    </button>
                  )}
                </div>
              )}

              {activeTab === 'mcq' && (
                <div>
                  {loadingMcqs ? (
                    <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-muted)' }}>
                      Generating quiz...
                    </div>
                  ) : mcqs.length > 0 ? (
                    <div>
                      {mcqs.map((q, qIdx) => {
                        const isChecked = mcqChecked[qIdx];
                        const selectedOptIdx = mcqAnswers[qIdx];
                        const correctOptIdx = q.options.indexOf(q.correct_answer);

                        return (
                          <div key={qIdx} className="ai-sidebar-mcq-item">
                            <div style={{ fontWeight: 600, marginBottom: '6px' }}>Q{qIdx + 1}. {q.question}</div>
                            
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
                                style={{ width: 'auto', padding: '3px 8px', fontSize: '9px', marginTop: '8px' }}
                                disabled={selectedOptIdx === undefined}
                                onClick={() => handleCheckMcq(qIdx)}
                              >
                                Check
                              </button>
                            ) : (
                              <div style={{ fontSize: '10px', marginTop: '6px', fontWeight: '500' }}>
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
                    <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={fetchMcqs}>
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
            <h3 className="right-panel__section-title">Invite Code</h3>
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
                      {m.role === 'owner' ? 'Owner' : 'Member'}
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
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
            Select a study server and channel to view shared resources.
          </p>
        </div>
      )}
    </aside>
  );
}
