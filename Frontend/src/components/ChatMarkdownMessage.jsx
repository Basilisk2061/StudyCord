import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './ChatMarkdownMessage.css';

export default function ChatMarkdownMessage({ content }) {
  return (
    <div className="chat-ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ node, ...props }) => {
            void node;
            return (
              <div className="chat-ai-markdown__table-wrap">
                <table {...props} />
              </div>
            );
          },
        }}
      >
        {content || ''}
      </ReactMarkdown>
    </div>
  );
}
