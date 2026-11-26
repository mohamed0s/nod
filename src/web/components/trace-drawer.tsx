import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { readUiPreference, writeUiPreference } from '../lib/ui-preferences';
import { Tabs } from './tabs';
import { Button, Loading, SearchField } from './ui';
import { Check, Copy, Maximize2, Minimize2, RefreshCw, X } from './icons';

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  mimeType?: string;
};
type TraceMessage = {
  role: string;
  content?: string | Block[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  [key: string]: unknown;
};
type TraceTool = { name: string; description: string; parameters: unknown };
export type TraceCall = {
  id: string;
  source: string;
  task?: string;
  turnId: string;
  runId?: string;
  parentRunId?: string;
  provider: string;
  model: string;
  startedAt: string;
  endedAt: string;
  systemPrompt: string;
  tools: TraceTool[];
  messages: TraceMessage[];
  output: { content: Block[]; stopReason: string };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number | null;
  };
  stopReason: string;
  requestKind?: string;
  error?: string;
};
type TraceStep = {
  id: string;
  type: string;
  summary: string;
  detail: string | null;
  runId: string | null;
  createdAt: string;
};
type TurnTrace = {
  turn: {
    id: string;
    source: string;
    status: string;
    prompt: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
  calls: TraceCall[];
  steps: TraceStep[];
};
type TraceTurn = {
  id: string;
  source: string;
  status: string;
  prompt: string;
  startedAt: string;
};
type View = 'timeline' | 'prompt' | 'tools' | 'messages' | 'raw';

const views: { value: View; label: string }[] = [
  { value: 'timeline', label: 'Timeline' },
  { value: 'prompt', label: 'System prompt' },
  { value: 'tools', label: 'Tools' },
  { value: 'messages', label: 'Messages' },
  { value: 'raw', label: 'Raw' },
];
const minimumWidth = 360;

const time = (value: string) => new Date(value).getTime();
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
const tokens = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : String(value);
const json = (value: unknown) => JSON.stringify(value, null, 2);

function blocks(content: TraceMessage['content']): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function callLabel(call: TraceCall) {
  if (call.source === 'curator') return call.task ? `curator · ${call.task}` : 'curator';
  return call.parentRunId ? 'subagent' : 'agent';
}

function toolCalls(call: TraceCall) {
  return (call.output?.content ?? []).filter((block) => block.type === 'toolCall');
}

function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </Button>
  );
}

function parsed(text: string): { value: unknown } | undefined {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed) || trimmed.length < 2) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' ? { value } : undefined;
  } catch {
    return undefined;
  }
}

function JsonValue({ value }: { value: unknown }): ReactNode {
  if (typeof value === 'string') {
    const inner = parsed(value);
    if (inner) return <JsonValue value={inner.value} />;
    return <span className="trace-json-string">{value}</span>;
  }
  if (value === null || typeof value !== 'object')
    return <span className="trace-json-scalar">{String(value)}</span>;
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  if (!entries.length)
    return <span className="trace-json-scalar">{Array.isArray(value) ? '[]' : '{}'}</span>;
  return (
    <div className="trace-json">
      {entries.map(([key, item]) =>
        item && typeof item === 'object' && Object.keys(item).length ? (
          <details key={key} open>
            <summary>
              <span className="trace-json-key">{key}</span>
              <span className="trace-json-count">
                {Array.isArray(item) ? `${item.length} items` : `${Object.keys(item).length} keys`}
              </span>
            </summary>
            <JsonValue value={item} />
          </details>
        ) : (
          <div key={key} className="trace-json-row">
            <span className="trace-json-key">{key}</span>
            <JsonValue value={item} />
          </div>
        ),
      )}
    </div>
  );
}

function TextView({ text }: { text: string }) {
  const whole = parsed(text);
  if (whole) return <JsonValue value={whole.value} />;
  const parts: ReactNode[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.join('').trim())
      parts.push(
        <p key={parts.length} className="trace-text">
          {prose.join('\n').trim()}
        </p>,
      );
    prose = [];
  };
  for (const line of text.split('\n')) {
    const data = parsed(line);
    if (!data) {
      prose.push(line);
      continue;
    }
    flush();
    parts.push(<JsonValue key={parts.length} value={data.value} />);
  }
  flush();
  return <>{parts}</>;
}

function BlockView({ block }: { block: Block }) {
  if (block.type === 'text') return <TextView text={block.text ?? ''} />;
  if (block.type === 'thinking')
    return (
      <div className="trace-block">
        <span className="trace-label">thinking</span>
        <p className="trace-text is-muted">{block.thinking}</p>
      </div>
    );
  if (block.type === 'toolCall')
    return (
      <div className="trace-block">
        <span className="trace-label">
          tool call · <code>{block.name}</code>
        </span>
        <JsonValue value={block.arguments} />
      </div>
    );
  return <JsonValue value={block} />;
}

function messageSize(message: TraceMessage) {
  return JSON.stringify(message.content ?? '').length;
}

function MessageView({
  message,
  index,
  open,
}: {
  message: TraceMessage;
  index: number;
  open: boolean;
}) {
  const role =
    message.role === 'toolResult'
      ? `tool result · ${message.toolName ?? ''}${message.isError ? ' · error' : ''}`
      : message.role;
  const extra =
    message.role === 'system'
      ? Object.fromEntries(
          Object.entries(message).filter(
            ([key]) => !['role', 'content', 'timestamp'].includes(key),
          ),
        )
      : {};
  return (
    <details className={`trace-message is-${message.role}`} open={open}>
      <summary>
        <span className="trace-label">{index + 1}</span>
        <span className="trace-message-role">{role}</span>
        <span className="trace-label">{tokens(Math.round(messageSize(message) / 4))} tokens</span>
      </summary>
      {blocks(message.content).map((block, position) => (
        <BlockView key={position} block={block} />
      ))}
      {Object.keys(extra).length > 0 && <JsonValue value={extra} />}
    </details>
  );
}

function Timeline({
  trace,
  selected,
  onSelect,
}: {
  trace: TurnTrace;
  selected?: TraceCall;
  onSelect(call: TraceCall): void;
}) {
  const start = Math.min(
    ...trace.calls.map((call) => time(call.startedAt)),
    time(trace.turn.startedAt ?? trace.turn.createdAt),
  );
  const end = Math.max(
    ...trace.calls.map((call) => time(call.endedAt)),
    trace.turn.finishedAt ? time(trace.turn.finishedAt) : start,
  );
  const span = Math.max(end - start, 1);
  if (!trace.calls.length)
    return <p className="trace-empty">No model calls recorded for this turn yet.</p>;
  return (
    <ol className="trace-timeline">
      {trace.calls.map((call, index) => {
        const left = ((time(call.startedAt) - start) / span) * 100;
        const width = Math.max(((time(call.endedAt) - time(call.startedAt)) / span) * 100, 0.5);
        const used = toolCalls(call);
        return (
          <li
            key={call.id}
            className={`trace-call${call.parentRunId || call.source === 'curator' ? ' is-nested' : ''}`}
          >
            <button
              type="button"
              aria-pressed={selected?.id === call.id}
              onClick={() => onSelect(call)}
            >
              <span className="trace-call-name">
                <span className="trace-label">{index + 1}</span>
                {callLabel(call)} · {call.model}
              </span>
              <span className="trace-call-meta">
                {seconds(time(call.endedAt) - time(call.startedAt))} ·{' '}
                {tokens(call.usage.inputTokens)} in · {tokens(call.usage.outputTokens)} out
                {call.usage.costUsd !== null && ` · $${call.usage.costUsd.toFixed(4)}`}
                {call.error && ` · ${call.error}`}
              </span>
              <span className="trace-track" aria-hidden="true">
                <span
                  className={`trace-bar${call.error ? ' is-error' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
            </button>
            {used.length > 0 && (
              <ul className="trace-tools-used">
                {used.map((block) => (
                  <li key={block.id}>
                    <code>{block.name}</code>
                    <span>{JSON.stringify(block.arguments)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ToolList({ tools }: { tools: TraceTool[] }) {
  const [query, setQuery] = useState('');
  const shown = tools.filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="trace-toolbar">
        <span>
          {tools.length} tools · {tokens(Math.round(JSON.stringify(tools).length / 4))} tokens
        </span>
        <SearchField
          aria-label="Filter tools"
          placeholder="Filter tools"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery('')}
        />
      </div>
      {shown.map((tool) => (
        <details key={tool.name} className="trace-tool" open>
          <summary>
            <code>{tool.name}</code>
            <span>{tokens(Math.round(JSON.stringify(tool).length / 4))} tokens</span>
          </summary>
          <pre>{tool.description}</pre>
          <span className="trace-label">input schema</span>
          <pre>{json(tool.parameters)}</pre>
        </details>
      ))}
    </>
  );
}

function storedWidth() {
  const value = Number(readUiPreference('nod.trace-width'));
  return Number.isFinite(value) && value >= minimumWidth ? value : 520;
}

export function TraceDrawer({ changed, onClose }: { changed: unknown; onClose(): void }) {
  const id = useId();
  const [recent, setRecent] = useState<TraceTurn[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      api<{ turns: TraceTurn[] }>('/api/traces', { signal: controller.signal })
        .then((found) => setRecent(found.turns))
        .catch(() => {});
    void refresh();
    window.addEventListener('nod:trace', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('nod:trace', refresh);
    };
  }, [changed]);
  const [follow, setFollow] = useState(true);
  const [turnId, setTurnId] = useState(recent[0]?.id);
  const current = follow ? recent[0]?.id : turnId;
  const [trace, setTrace] = useState<TurnTrace>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>('timeline');
  const [selectedId, setSelectedId] = useState<string>();
  const [width, setWidth] = useState(storedWidth);
  const [expanded, setExpanded] = useState(false);
  const [pageWidth, setPageWidth] = useState(0);
  const widest = (page: number) => Math.max(minimumWidth, page - minimumWidth);
  useEffect(() => {
    const page = root.current?.parentElement;
    if (!page) return;
    const measure = () => setPageWidth(page.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);
  const [messagesOpen, setMessagesOpen] = useState(true);
  useEffect(() => {
    if (!expanded) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setExpanded(false);
    };
    window.addEventListener('keydown', leave);
    return () => window.removeEventListener('keydown', leave);
  }, [expanded]);
  const root = useRef<HTMLElement>(null);
  const load = useCallback(async (turn: string, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const found = await api<TurnTrace>(`/api/turns/${turn}/trace`, { signal });
      if (!signal?.aborted) {
        setTrace(found);
        setError('');
      }
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!current) return;
    const controller = new AbortController();
    setSelectedId(undefined);
    setError('');
    void load(current, controller.signal);
    const updated = (event: Event) => {
      if ((event as CustomEvent<{ turnId: string }>).detail?.turnId === current)
        void load(current, controller.signal);
    };
    window.addEventListener('nod:trace', updated);
    return () => {
      controller.abort();
      window.removeEventListener('nod:trace', updated);
    };
  }, [current, load]);
  useEffect(() => {
    const open = (event: Event) => {
      const turn = (event as CustomEvent<{ turnId: string }>).detail?.turnId;
      if (!turn) return;
      setFollow(turn === recent[0]?.id);
      setTurnId(turn);
    };
    window.addEventListener('nod:open-trace', open);
    return () => window.removeEventListener('nod:open-trace', open);
  }, [recent]);
  const shown = trace && trace.turn.id === current ? trace : undefined;
  const selected =
    shown?.calls.find((call) => call.id === selectedId) ??
    shown?.calls.find((call) => call.source === 'agent' && !call.parentRunId) ??
    shown?.calls[0];
  const totals = shown?.calls.reduce(
    (sum, call) => ({
      input: sum.input + call.usage.inputTokens,
      cached: sum.cached + call.usage.cacheReadTokens,
      output: sum.output + call.usage.outputTokens,
      cost: sum.cost + (call.usage.costUsd ?? 0),
      tools: sum.tools + toolCalls(call).length,
    }),
    { input: 0, cached: 0, output: 0, cost: 0, tools: 0 },
  );
  const duration =
    shown?.turn.startedAt &&
    (shown.turn.finishedAt ? time(shown.turn.finishedAt) : Date.now()) - time(shown.turn.startedAt);
  let body: ReactNode = null;
  if (!current) body = <p className="trace-empty">No turns in this chat yet.</p>;
  else if (!shown)
    body = error ? (
      <p role="alert">{error}</p>
    ) : loading ? (
      <Loading label="Loading trace…" />
    ) : null;
  else if (view === 'timeline')
    body = (
      <>
        <Timeline
          trace={shown}
          selected={selected}
          onSelect={(call) => {
            setSelectedId(call.id);
            setView('messages');
          }}
        />
        {shown.steps.length > 0 && (
          <>
            <span className="trace-label">turn events</span>
            <ol className="trace-steps">
              {shown.steps.map((step) => (
                <li key={step.id}>
                  <time>
                    +
                    {seconds(
                      time(step.createdAt) - time(shown.turn.startedAt ?? shown.turn.createdAt),
                    )}
                  </time>
                  <code>{step.type}</code>
                  <span>{step.summary}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </>
    );
  else if (!selected)
    body = <p className="trace-empty">No model calls recorded for this turn yet.</p>;
  else if (view === 'prompt')
    body = (
      <>
        <div className="trace-toolbar">
          <span>
            Call {shown.calls.indexOf(selected) + 1} · {callLabel(selected)} ·{' '}
            {selected.systemPrompt.length.toLocaleString()} characters
          </span>
          <Copyable text={selected.systemPrompt} label="Copy system prompt" />
        </div>
        <pre>{selected.systemPrompt}</pre>
      </>
    );
  else if (view === 'tools') body = <ToolList key={selected.id} tools={selected.tools} />;
  else if (view === 'messages')
    body = (
      <>
        <div className="trace-toolbar">
          <span>
            Call {shown.calls.indexOf(selected) + 1} · {callLabel(selected)} · {selected.provider} ·{' '}
            {selected.model} · {selected.messages.length} messages sent
          </span>
          <Button variant="ghost" size="sm" onClick={() => setMessagesOpen(!messagesOpen)}>
            {messagesOpen ? 'Collapse all' : 'Expand all'}
          </Button>
        </div>
        {selected.messages.map((message, index) => (
          <MessageView
            key={`${selected.id}.${index}.${messagesOpen}`}
            message={message}
            index={index}
            open={messagesOpen}
          />
        ))}
        <details className="trace-message is-output" open>
          <summary>
            <span className="trace-message-role">response</span>
            <span className="trace-label">{selected.stopReason}</span>
          </summary>
          {(selected.output?.content ?? []).map((block, index) => (
            <BlockView key={index} block={block} />
          ))}
          {selected.error && <pre role="alert">{selected.error}</pre>}
        </details>
      </>
    );
  else
    body = (
      <>
        <div className="trace-toolbar">
          <span>Everything stored for this turn</span>
          <Copyable text={json(shown)} label="Copy raw trace" />
        </div>
        <pre>{json(shown)}</pre>
      </>
    );
  return (
    <aside
      ref={root}
      className={`artifact-drawer trace-drawer${expanded ? ' is-expanded' : ''}`}
      style={expanded ? undefined : { width, ['--artifact-width' as string]: `${width}px` }}
      aria-label="Turn trace"
    >
      <div
        className="artifact-drawer-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize trace"
        aria-valuemin={minimumWidth}
        aria-valuemax={widest(pageWidth)}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          const page = root.current?.parentElement;
          if (!page) return;
          event.preventDefault();
          const next = Math.min(
            Math.max(width + (event.key === 'ArrowLeft' ? 24 : -24), minimumWidth),
            widest(page.clientWidth),
          );
          setWidth(next);
          writeUiPreference('nod.trace-width', String(next));
        }}
        onPointerDown={(event) => {
          const page = root.current?.parentElement;
          if (!page || event.button !== 0) return;
          event.preventDefault();
          const handle = event.currentTarget;
          handle.setPointerCapture(event.pointerId);
          const right = page.getBoundingClientRect().right;
          let latest = width;
          page.classList.add('is-resizing-artifact');
          const follow = (move: PointerEvent) => {
            latest = Math.round(
              Math.min(Math.max(right - move.clientX, minimumWidth), widest(page.clientWidth)),
            );
            setWidth(latest);
          };
          const stop = () => {
            page.classList.remove('is-resizing-artifact');
            handle.removeEventListener('pointermove', follow);
            handle.removeEventListener('pointerup', stop);
            handle.removeEventListener('pointercancel', stop);
            writeUiPreference('nod.trace-width', String(latest));
          };
          handle.addEventListener('pointermove', follow);
          handle.addEventListener('pointerup', stop);
          handle.addEventListener('pointercancel', stop);
        }}
      />
      <div className="artifact-drawer-panel">
        <header className="artifact-drawer-header">
          <div className="artifact-drawer-title">
            <h2>Trace</h2>
            <select
              className="trace-turn-picker"
              aria-label="Turn"
              value={follow ? '' : current}
              onChange={(event) => {
                setFollow(event.target.value === '');
                setTurnId(event.target.value || recent[0]?.id);
              }}
            >
              <option value="">Latest turn{recent[0] ? ` · ${recent[0].status}` : ''}</option>
              {recent.map((turn) => (
                <option key={turn.id} value={turn.id}>
                  {new Date(turn.startedAt).toLocaleTimeString()} · {turn.source} · {turn.status} ·{' '}
                  {turn.prompt.replace(/\s+/g, ' ').slice(0, 48)}
                </option>
              ))}
            </select>
          </div>
          <div className="artifact-drawer-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label={expanded ? 'Exit full screen' : 'Full screen'}
              title={expanded ? 'Exit full screen' : 'Full screen'}
              aria-pressed={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reload trace"
              title="Reload"
              disabled={!current || loading}
              onClick={() => current && void load(current)}
            >
              <RefreshCw size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close trace"
              title="Close"
              onClick={onClose}
            >
              <X size={16} />
            </Button>
          </div>
        </header>
        {shown && totals && (
          <dl className="trace-stats">
            <div>
              <dt>duration</dt>
              <dd>{duration ? seconds(duration) : '–'}</dd>
            </div>
            <div>
              <dt>model calls</dt>
              <dd>{shown.calls.length}</dd>
            </div>
            <div>
              <dt>tool calls</dt>
              <dd>{totals.tools}</dd>
            </div>
            <div>
              <dt>tokens in</dt>
              <dd>
                {tokens(totals.input)}
                {totals.cached > 0 && <small> · {tokens(totals.cached)} cached</small>}
              </dd>
            </div>
            <div>
              <dt>tokens out</dt>
              <dd>{tokens(totals.output)}</dd>
            </div>
            <div>
              <dt>cost</dt>
              <dd>${totals.cost.toFixed(3)}</dd>
            </div>
          </dl>
        )}
        <Tabs
          id={id}
          panelId={`${id}-panel`}
          label="Trace view"
          items={views}
          value={view}
          onValueChange={setView}
          variant="underline"
          size="compact"
          className="trace-tabs"
        />
        <div id={`${id}-panel`} role="tabpanel" className="artifact-drawer-body trace-body">
          {body}
        </div>
      </div>
    </aside>
  );
}
