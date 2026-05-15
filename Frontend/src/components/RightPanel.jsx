const FAKE_MEMBERS = [
  { name: 'Sarah Kim', initials: 'SK', color: '#5b7bd5', status: 'online', role: null },
  { name: 'Alex Chen', initials: 'AC', color: '#c9953a', status: 'online', role: null },
  { name: 'James Liu', initials: 'JL', color: '#3faa7d', status: 'online', role: null },
  { name: 'Maya Patel', initials: 'MP', color: '#d45b7b', status: 'idle', role: null },
  { name: 'Prof. Williams', initials: 'PW', color: '#5b7bd5', status: 'offline', role: 'Instructor' },
  { name: 'TA - Rachel', initials: 'TR', color: '#3faa7d', status: 'offline', role: 'TA' },
];

const FAKE_RESOURCES = [
  { name: 'Chapter 7 Notes.pdf', meta: '2.4 MB · PDF', icon: '📄' },
  { name: 'Midterm Study Guide', meta: 'Google Docs', icon: '📝' },
  { name: 'Algorithm Cheat Sheet', meta: '1.1 MB · PDF', icon: '📄' },
  { name: 'Lecture Recording W8', meta: 'External link', icon: '🔗' },
];

const SUGGESTED_PROMPTS = [
  'Explain binary search trees',
  'Quiz me on Chapter 7',
  'Summarize sorting algorithms',
];

export default function RightPanel() {
  const onlineMembers = FAKE_MEMBERS.filter((m) => m.status === 'online');
  const otherMembers = FAKE_MEMBERS.filter((m) => m.status !== 'online');

  return (
    <aside className="right-panel" id="right-panel">
      {/* AI Study Helper */}
      <div className="right-panel__section">
        <h3 className="right-panel__section-title">AI Study Helper</h3>
        <p className="ai-helper__desc">
          Ask questions about your coursework, get explanations, or generate practice problems.
        </p>
        <input
          className="ai-helper__input"
          type="text"
          placeholder="Ask about this topic..."
          readOnly
        />
        <div className="ai-helper__prompts">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <span key={prompt} className="ai-helper__prompt">{prompt}</span>
          ))}
        </div>
      </div>

      {/* Shared Resources */}
      <div className="right-panel__section">
        <h3 className="right-panel__section-title">Shared Resources</h3>
        {FAKE_RESOURCES.map((res) => (
          <div key={res.name} className="resource-item">
            <div className="resource-item__icon">{res.icon}</div>
            <div className="resource-item__info">
              <div className="resource-item__name">{res.name}</div>
              <div className="resource-item__meta">{res.meta}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Online Members */}
      <div className="right-panel__section">
        <h3 className="right-panel__section-title">
          Members — {onlineMembers.length} online
        </h3>
        {onlineMembers.map((m) => (
          <div key={m.name} className="member-item">
            <div className="member-item__avatar" style={{ backgroundColor: m.color }}>
              {m.initials}
              <span className={`member-item__status member-item__status--${m.status}`} />
            </div>
            <span className="member-item__name">{m.name}</span>
            {m.role && <span className="member-item__role">{m.role}</span>}
          </div>
        ))}
        {otherMembers.map((m) => (
          <div key={m.name} className="member-item">
            <div className="member-item__avatar" style={{ backgroundColor: m.color, opacity: 0.5 }}>
              {m.initials}
              <span className={`member-item__status member-item__status--${m.status}`} />
            </div>
            <span className="member-item__name" style={{ opacity: 0.5 }}>{m.name}</span>
            {m.role && <span className="member-item__role" style={{ opacity: 0.5 }}>{m.role}</span>}
          </div>
        ))}
      </div>
    </aside>
  );
}
