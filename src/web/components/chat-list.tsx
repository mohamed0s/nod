import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../shared/contracts';
import type { Agent } from '../../shared/agents';
import type { Room } from '../../shared/rooms';
import { taskLabels } from '../../shared/task-status';
import { api, errorMessage } from '../lib/api';
import { captureAnalytics } from '../lib/analytics';
import { ActionMenu, ActionMenuItem } from './action-menu';
import { Bot, Ellipsis, MessageCircle, Plus } from './icons';
import { Button, Dialog, Input, Notice } from './ui';
import { NewRoomDialog } from './chat-room';

const groups = [
  { label: 'Working', statuses: ['queued', 'working', 'waiting', 'scheduled'] },
  { label: 'Needs you', statuses: ['needs_you', 'failed'] },
  { label: 'Done', statuses: ['done', 'cancelled'] },
] as const;

export function ChatList({
  tasks,
  agents,
  rooms = [],
  chat,
  fresh,
  freshAgent,
  unread,
  onChat,
  onNewChat,
  refresh,
}: {
  tasks: Task[];
  agents: Agent[];
  rooms?: Room[];
  chat?: string;
  fresh: boolean;
  freshAgent?: string;
  unread: Record<string, number>;
  onChat(id?: string): void;
  onNewChat(agent?: string): void;
  refresh(): Promise<void>;
}) {
  const [closing, setClosing] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const saving = useRef(new Set<string>());
  const editing = useRef<string | undefined>(undefined);
  const renameNext = useRef<Task | undefined>(undefined);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const renamed = useRef<string | undefined>(undefined);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const agentChats = new Set([
    ...agents.map((agent) => agent.chatId),
    ...rooms.map(({ id }) => id),
  ]);
  const open = tasks.filter((task) => !task.archivedAt && !agentChats.has(task.id));
  useEffect(() => {
    if (renaming || !renamed.current) return;
    items.current.get(renamed.current)?.focus({ preventScroll: true });
    renamed.current = undefined;
  }, [renaming]);
  function startRename(task: Task) {
    setError('');
    setDraft(task.title);
    editing.current = task.id;
    setRenaming(task.id);
  }
  function stopRename(task: Task, refocus: boolean) {
    if (editing.current !== task.id) return;
    editing.current = undefined;
    if (refocus) renamed.current = task.id;
    setRenaming(undefined);
  }
  async function rename(task: Task, refocus: boolean) {
    if (saving.current.has(task.id) || editing.current !== task.id) return;
    const title = draft.trim();
    if (!title || title === task.title) return stopRename(task, refocus);
    saving.current.add(task.id);
    setError('');
    try {
      await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      });
      captureAnalytics('task_action', { action: 'rename_chat' });
      await refresh();
      stopRename(task, refocus);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      saving.current.delete(task.id);
    }
  }
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
        aria-current={fresh ? 'page' : undefined}
        onClick={() => onNewChat()}
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
      {agents.length > 0 && (
        <section className="chat-list-group" aria-label="Agents">
          <h2>Agents</h2>
          <ul role="list">
            {agents.map((agent) => {
              const task = tasks.find((item) => item.id === agent.chatId);
              return (
                <li key={agent.id} className="chat-list-row">
                  <button
                    type="button"
                    className="chat-list-item"
                    aria-current={
                      (agent.chatId ? chat === agent.chatId : freshAgent === agent.id)
                        ? 'page'
                        : undefined
                    }
                    title={agent.description || undefined}
                    onClick={() => (agent.chatId ? onChat(agent.chatId) : onNewChat(agent.id))}
                  >
                    {task ? (
                      <span
                        className="chat-list-dot"
                        data-status={task.status}
                        aria-hidden="true"
                      />
                    ) : (
                      <Bot size={16} aria-hidden="true" />
                    )}
                    <span className="chat-list-title">{agent.name}</span>
                    {task && <span className="sr-only">, {taskLabels[task.status]}</span>}
                    {task && Boolean(unread[task.id]) && chat !== task.id && (
                      <span className="chat-list-unread">
                        {unread[task.id]! > 99 ? '99+' : unread[task.id]}
                        <span className="sr-only"> unread</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {(agents.length > 0 || rooms.length > 0) && (
        <section className="chat-list-group" aria-label="Rooms">
          <h2>Rooms</h2>
          <ul role="list">
            {rooms.map((room) => {
              const task = tasks.find((item) => item.id === room.id);
              return (
                <li key={room.id} className="chat-list-row">
                  <button
                    type="button"
                    className="chat-list-item"
                    aria-current={chat === room.id ? 'page' : undefined}
                    title={room.members.map(({ name }) => name).join(', ') || undefined}
                    onClick={() => onChat(room.id)}
                  >
                    <span className="chat-list-dot" data-status={task?.status} aria-hidden="true" />
                    <span className="chat-list-title">{room.name}</span>
                    {task && <span className="sr-only">, {taskLabels[task.status]}</span>}
                    {Boolean(unread[room.id]) && chat !== room.id && (
                      <span className="chat-list-unread">
                        {unread[room.id]! > 99 ? '99+' : unread[room.id]}
                        <span className="sr-only"> unread</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            <li className="chat-list-row">
              <Dialog open={creatingRoom} onOpenChange={setCreatingRoom}>
                <button
                  type="button"
                  className="chat-list-item"
                  onClick={() => setCreatingRoom(true)}
                >
                  <Plus size={16} aria-hidden="true" />
                  <span className="chat-list-title">New room</span>
                </button>
                {creatingRoom && (
                  <NewRoomDialog
                    agents={agents}
                    onCreated={async (id) => {
                      await refresh();
                      setCreatingRoom(false);
                      onChat(id);
                    }}
                  />
                )}
              </Dialog>
            </li>
          </ul>
        </section>
      )}
      {groups.map((group) => {
        const shown = open.filter((task) =>
          (group.statuses as readonly string[]).includes(task.status),
        );
        if (!shown.length) return null;
        return (
          <section key={group.label} className="chat-list-group" aria-label={group.label}>
            <h2>{group.label}</h2>
            <ul role="list">
              {shown.map((task) => (
                <li key={task.id} className="chat-list-row">
                  {renaming === task.id ? (
                    <form
                      className="chat-list-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void rename(task, true);
                      }}
                    >
                      <Input
                        autoFocus
                        value={draft}
                        maxLength={160}
                        aria-label={`Rename ${task.title}`}
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => void rename(task, false)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') return;
                          event.preventDefault();
                          stopRename(task, true);
                        }}
                      />
                    </form>
                  ) : (
                    <button
                      ref={(node) => {
                        if (node) items.current.set(task.id, node);
                        else items.current.delete(task.id);
                      }}
                      type="button"
                      className="chat-list-item"
                      aria-current={chat === task.id ? 'page' : undefined}
                      aria-keyshortcuts="F2"
                      onClick={() => {
                        captureAnalytics('task_action', { action: 'open_chat' });
                        onChat(task.id);
                      }}
                      onDoubleClick={() => startRename(task)}
                      onKeyDown={(event) => {
                        if (event.key !== 'F2') return;
                        event.preventDefault();
                        startRename(task);
                      }}
                    >
                      <span
                        className="chat-list-dot"
                        data-status={task.status}
                        aria-hidden="true"
                      />
                      <span className="chat-list-title">{task.title}</span>
                      <span className="sr-only">, {taskLabels[task.status]}</span>
                      {Boolean(unread[task.id]) && chat !== task.id && (
                        <span className="chat-list-unread">
                          {unread[task.id]! > 99 ? '99+' : unread[task.id]}
                          <span className="sr-only"> unread</span>
                        </span>
                      )}
                    </button>
                  )}
                  <ActionMenu
                    label={`Options for ${task.title}`}
                    className="chat-list-more"
                    contentClassName="action-menu-compact"
                    trigger={
                      <Button variant="ghost" size="icon" title="Chat options">
                        <Ellipsis size={16} aria-hidden="true" />
                      </Button>
                    }
                    onCloseAutoFocus={(event) => {
                      const next = renameNext.current;
                      if (!next) return;
                      renameNext.current = undefined;
                      event.preventDefault();
                      startRename(next);
                    }}
                  >
                    {(closeMenu) => (
                      <>
                        <ActionMenuItem
                          onClick={() => {
                            renameNext.current = task;
                            closeMenu();
                          }}
                        >
                          Rename
                        </ActionMenuItem>
                        {group.label === 'Done' && (
                          <ActionMenuItem
                            disabled={closing === task.id}
                            onClick={() => {
                              closeMenu();
                              void close(task);
                            }}
                          >
                            Close chat
                          </ActionMenuItem>
                        )}
                      </>
                    )}
                  </ActionMenu>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
