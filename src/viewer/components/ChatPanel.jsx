import { useState, useRef, useEffect } from 'react';

// ============================================================================
// SIMPLE MARKDOWN RENDERER
// ============================================================================

function renderInline(text) {
  // Escape HTML first to prevent XSS, then apply markdown formatting
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/`([^`]+)`/g, '<code style="background:var(--bd-muted);padding:1px 4px;border-radius:3px;font-family:JetBrains Mono,monospace;font-size:8px;color:var(--tx-primary)">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--tx-primary)">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em style="color:var(--tx-secondary)">$1</em>');
}

function MarkdownBlock({ text }) {
  const lines = text.split('\n');
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={i} style={{
          background: 'var(--bg-input)', border: '1px solid var(--bd-muted)', borderRadius: 4,
          padding: '6px 8px', margin: '4px 0', overflowX: 'auto',
          fontSize: 8, color: 'var(--tx-secondary)', fontFamily: 'JetBrains Mono,monospace', lineHeight: 1.5,
        }}>
          {codeLines.join('\n')}
        </pre>
      );
      i++;
      continue;
    }

    // H3 / H4 headings
    if (/^#{3,4}\s+/.test(line)) {
      const content = line.replace(/^#{3,4}\s+/, '');
      elements.push(
        <div key={i} style={{ fontSize: 9, color: 'var(--ac-primary)', fontWeight: 600, margin: '8px 0 3px', letterSpacing: '0.04em' }}
          dangerouslySetInnerHTML={{ __html: renderInline(content) }} />
      );
      i++;
      continue;
    }

    // H1 / H2 headings
    if (/^#{1,2}\s+/.test(line)) {
      const content = line.replace(/^#{1,2}\s+/, '');
      elements.push(
        <div key={i} style={{ fontSize: 10, color: 'var(--tx-primary)', fontWeight: 700, margin: '10px 0 4px' }}
          dangerouslySetInnerHTML={{ __html: renderInline(content) }} />
      );
      i++;
      continue;
    }

    // Bullet list
    if (/^[*-]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[*-]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[*-]\s+/, ''));
        i++;
      }
      elements.push(
        <ul key={i} style={{ margin: '3px 0', paddingLeft: 14, listStyle: 'none' }}>
          {items.map((item, j) => (
            <li key={j} style={{ fontSize: 9, color: 'var(--tx-secondary)', lineHeight: 1.6, position: 'relative', paddingLeft: 8 }}>
              <span style={{ position: 'absolute', left: 0, color: 'var(--ac-primary)' }}>·</span>
              <span dangerouslySetInnerHTML={{ __html: renderInline(item) }} />
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const match = lines[i].match(/^(\d+)\.\s+(.*)/);
        if (match) items.push({ num: match[1], text: match[2] });
        i++;
      }
      elements.push(
        <ol key={i} style={{ margin: '3px 0', paddingLeft: 0, listStyle: 'none' }}>
          {items.map((item, j) => (
            <li key={j} style={{ fontSize: 9, color: 'var(--tx-secondary)', lineHeight: 1.6, display: 'flex', gap: 5, margin: '1px 0' }}>
              <span style={{ color: 'var(--ac-primary)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{item.num}.</span>
              <span dangerouslySetInnerHTML={{ __html: renderInline(item.text) }} />
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--bd-muted)', margin: '6px 0' }} />);
      i++;
      continue;
    }

    // Empty line -> spacer
    if (line.trim() === '') {
      elements.push(<div key={i} style={{ height: 4 }} />);
      i++;
      continue;
    }

    // Plain paragraph
    elements.push(
      <div key={i} style={{ fontSize: 9, color: 'var(--tx-secondary)', lineHeight: 1.6 }}
        dangerouslySetInnerHTML={{ __html: renderInline(line) }} />
    );
    i++;
  }

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{elements}</div>;
}

// ============================================================================
// TOOL SPINNER
// ============================================================================

function ToolSpinner() {
  const [frame, setFrame] = useState(0);
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, []);
  return <span style={{ color: 'var(--ac-primary)', fontFamily: 'monospace', fontSize: 10, lineHeight: 1 }}>{frames[frame]}</span>;
}

// ============================================================================
// CHAT PANEL
// ============================================================================

/**
 * ChatPanel -- agentic chatbot panel for the dependency graph viewer.
 *
 * Props:
 *   onHighlight(ids: string[]) -- called when the agent returns node IDs to highlight
 *   onClose()                  -- called when the panel is closed
 */
export function ChatPanel({ onHighlight, onClose }) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        'Hi! Ask me anything about this codebase. For example:\n' +
        '- "What are the most critical functions?"\n' +
        '- "What is the impact of changing the embedding service?"\n' +
        '- "Where would I add a new API endpoint?"',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTools, setActiveTools] = useState([]); // tools currently running
  const [error, setError] = useState(null);
  const [modelInfo, setModelInfo] = useState(null); // { provider, currentModel, models }
  const bottomRef = useRef(null);

  useEffect(() => {
    fetch('/api/chat/models')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) console.warn('[chat/models]', data.error);
        else setModelInfo(data);
      })
      .catch((e) => console.warn('[chat/models] fetch failed:', e.message));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, activeTools]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const history = messages
      .slice(1) // drop initial greeting
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setInput('');
    setLoading(true);
    setActiveTools([]);
    setError(null);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, model: modelInfo?.currentModel }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
      }

      // Parse SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (evt.type === 'tool_start') {
            setActiveTools((prev) => [...prev, evt.name]);
          } else if (evt.type === 'tool_end') {
            setActiveTools((prev) => prev.filter((n) => n !== evt.name));
          } else if (evt.type === 'reply') {
            setMessages((prev) => [...prev, { role: 'assistant', content: evt.reply }]);
            onHighlight(evt.highlightIds ?? []);
          } else if (evt.type === 'error') {
            throw new Error(evt.error);
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setActiveTools([]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const clear = () => {
    setMessages([{ role: 'assistant', content: 'Conversation cleared. What would you like to know?' }]);
    setError(null);
    onHighlight([]);
  };

  return (
    <div
      style={{
        width: 340,
        borderLeft: '1px solid var(--bd-faint)',
        background: 'var(--bg-deep)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: '6px 10px',
          borderBottom: '1px solid var(--bd-faint)',
          flexShrink: 0,
          gap: 5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 9, color: 'var(--ac-primary)', letterSpacing: '0.1em', fontFamily: 'inherit' }}>
            ✦ DIAGRAM CHAT
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={clear}
            title="Clear conversation"
            style={{
              background: 'none', border: '1px solid var(--bd-muted)', borderRadius: 3,
              color: 'var(--tx-ghost)', fontSize: 8, padding: '2px 6px', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            CLEAR
          </button>
          <button
            onClick={onClose}
            title="Close chat"
            style={{
              background: 'none', border: '1px solid var(--bd-muted)', borderRadius: 3,
              color: 'var(--tx-ghost)', fontSize: 10, padding: '2px 6px', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1,
            }}
          >
            x
          </button>
        </div>
        </div>
        {/* Model selector */}
        {modelInfo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 8, color: 'var(--tx-ghost)', letterSpacing: '0.06em', flexShrink: 0 }}>
              {modelInfo.provider.toUpperCase()}
            </span>
            <select
              value={modelInfo.currentModel}
              onChange={(e) => setModelInfo((prev) => ({ ...prev, currentModel: e.target.value }))}
              style={{
                flex: 1, background: 'var(--bg-input)', border: '1px solid var(--bd-muted)', borderRadius: 3,
                color: 'var(--tx-secondary)', fontSize: 8, padding: '2px 4px', fontFamily: 'inherit',
                cursor: 'pointer', outline: 'none',
              }}
            >
              {modelInfo.models.length === 0 && (
                <option value={modelInfo.currentModel}>{modelInfo.currentModel}</option>
              )}
              {modelInfo.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Message list */}
      <div
        style={{
          flex: 1, overflowY: 'auto', padding: '8px 10px',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}
      >
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '96%' }}>
            <div
              style={{
                background: m.role === 'user' ? 'var(--bg-hover)' : 'var(--bg-input)',
                border: `1px solid ${m.role === 'user' ? 'var(--bd-muted)' : 'var(--bd-faint)'}`,
                borderRadius: m.role === 'user' ? '8px 8px 2px 8px' : '8px 8px 8px 2px',
                padding: '6px 10px',
                fontFamily: 'inherit',
              }}
            >
              {m.role === 'user' ? (
                <div style={{ fontSize: 9, color: 'var(--tx-primary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {m.content}
                </div>
              ) : (
                <MarkdownBlock text={m.content} />
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ alignSelf: 'flex-start' }}>
            <div style={{
              fontSize: 9, color: 'var(--ac-primary)', background: 'var(--bg-input)',
              border: '1px solid var(--bd-faint)', borderRadius: '8px 8px 8px 2px',
              padding: '6px 10px', fontFamily: 'inherit',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              {activeTools.length === 0 ? (
                <span>thinking...</span>
              ) : (
                activeTools.map((name, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <ToolSpinner />
                    <span style={{ color: 'var(--tx-secondary)' }}>{name.replace(/_/g, ' ')}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {error && (
          <div style={{
            fontSize: 9, color: '#f87171', background: '#1a0a0a',
            border: '1px solid #3a1a1a', borderRadius: 4,
            padding: '5px 8px', fontFamily: 'inherit',
          }}>
            Error: {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div
        style={{
          borderTop: '1px solid var(--bd-faint)', padding: '8px 10px',
          display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0,
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about the codebase... (Enter to send, Shift+Enter for newline)"
          rows={3}
          style={{
            background: 'var(--bg-input)', border: '1px solid var(--bd-muted)', borderRadius: 4,
            color: 'var(--tx-primary)', fontSize: 9, padding: '6px 8px',
            resize: 'none', outline: 'none', fontFamily: 'inherit', lineHeight: 1.4,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={send}
            disabled={!input.trim() || loading}
            style={{
              background: input.trim() && !loading ? 'var(--bg-select)' : 'transparent',
              border: `1px solid ${input.trim() && !loading ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
              borderRadius: 4,
              color: input.trim() && !loading ? 'var(--tx-primary)' : 'var(--tx-ghost)',
              fontSize: 8, padding: '4px 12px',
              cursor: input.trim() && !loading ? 'pointer' : 'default',
              fontFamily: 'inherit', letterSpacing: '0.06em',
            }}
          >
            SEND
          </button>
        </div>
      </div>
    </div>
  );
}
