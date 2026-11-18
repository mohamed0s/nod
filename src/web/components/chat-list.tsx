import { useState } from 'react';
import type { Task } from '../../shared/contracts';
import { taskLabels } from '../../shared/task-status';
import { api, errorMessage } from '../lib/api';
import { captureAnalytics } from '../lib/analytics';
import { MessageCircle, Plus, X } from './icons';
import { Button, Notice } from './ui';

const groups = [
  { label: 'Working', statuses: ['queued', 'working', 'waiting', 'scheduled'] },
  { label: 'Needs you', statuses: ['needs_you', 'failed'] },
  { label: 'Done', statuses: ['done', 'cancelled'] },
] as const;

export function ChatList({
  tasks,
  chat,
  fresh,
  onChat,
  onNewChat,
  refresh,
}: {
  tasks: Task[];
  chat?: string;
  fresh: boolean;
  onChat(id?: string): void;
  onNewChat(): void;
  refresh(): Promise<void>;
}) {
  const [closing, setClosing] = useState<string>();
  const [error, setError] = useState('');
  const open = tasks.filter((task) => !task.archivedAt);
  async function close(task: Task) {
    setClosing(task.id);
    setError('');
    try {
      await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      });
      captureAnalytics('task_action', { action: 'close_chat' });
      if (chat === task.id) onChat();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setClosing(undefined);
    }
  }
  return (
    <nav className="chat-list" aria-label="Chats">
      <Button
        variant="outline"
        size="sm"
        className="chat-list-new"
        aria-pressed={fresh}
        onClick={onNewChat}
      >
        <Plus size={16} aria-hidden="true" />
        New chat
      </Button>
      <button
        type="button"
        className="chat-list-item"
        aria-current={!chat && !fresh ? 'page' : undefined}
        onClick={() => onChat()}
      >
        <MessageCircle size={16} aria-hidden="true" />
        <span className="chat-list-title">Main</span>
      </button>
      {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
      {groups.map((group) => {
        const items = open.filter((task) =>
          (group.statuses as readonly string[]).includes(task.status),
        );
        if (!items.length) return null;
        return (
          <section key={group.label} className="chat-list-group" aria-label={group.label}>
            <h2>{group.label}</h2>
            <ul role="list">
              {items.map((task) => (
                <li key={task.id} className="chat-list-row">
                  <button
                    type="button"
                    className="chat-list-item"
                    aria-current={chat === task.id ? 'page' : undefined}
                    onClick={() => {
                      captureAnalytics('task_action', { action: 'open_chat' });
                      onChat(task.id);
                    }}
                  >
                    <span className="chat-list-dot" data-status={task.status} aria-hidden="true" />
                    <span className="chat-list-title">{task.title}</span>
                    <span className="sr-only">, {taskLabels[task.status]}</span>
                  </button>
                  {group.label === 'Done' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="chat-list-close"
                      aria-label={`Close ${task.title}`}
                      title="Close chat"
                      disabled={closing === task.id}
                      onClick={() => void close(task)}
                    >
                      <X size={16} aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
