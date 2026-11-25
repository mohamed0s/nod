import { useState } from 'react';
import type { Agent, AgentMemoryMode, AgentSchedules } from '../../shared/agents';
import type { ModelSelection } from '../../shared/models';
import { roomLimits, type Room } from '../../shared/rooms';
import { ActionMenu, ActionMenuItem } from '../components/action-menu';
import { BotPicture } from '../components/bot-picture';
import { BotDialog, botStarters, type BotStarter } from '../components/chat-agent';
import { NewRoomDialog } from '../components/chat-room';
import { CalendarClock, Ellipsis, MessageCircle, Plus, Users } from '../components/icons';
import { modelOf } from '../components/model-choices';
import { PageTitle } from '../components/page-title';
import { agentSchedulesPath } from '../components/schedule-agent';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Loading,
  Notice,
} from '../components/ui';
import { useModels } from '../hooks/use-models';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { navigate } from '../lib/navigation';

const memoryBadges: Record<AgentMemoryMode, string> = {
  shared: 'Shared memory',
  own: 'Own memory',
  own_and_shared: 'Own + shared memory',
};

const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

type Open =
  | { kind: 'new'; starter?: BotStarter }
  | { kind: 'new-room' }
  | { kind: 'edit' | 'room' | 'remove'; agent: Agent }
  | null;

function AddToRoom({
  agent,
  agents,
  rooms,
  refresh,
  onClose,
  onOpen,
}: {
  agent: Agent;
  agents: Agent[];
  rooms: Room[];
  refresh(): Promise<void>;
  onClose(): void;
  onOpen(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  if (creating)
    return (
      <NewRoomDialog
        agents={agents}
        members={[agent.id]}
        onCreated={async (id) => {
          await refresh();
          onClose();
          onOpen(id);
        }}
        onNewBot={onClose}
      />
    );
  async function add(room: Room) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/rooms/${room.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ revision: room.revision, add: [agent.id] }),
      });
      await refresh();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogContent className="chat-agent-dialog" aria-describedby={undefined}>
      <DialogTitle>Add {agent.name} to a room</DialogTitle>
      {rooms.length > 0 && (
        <ul className="bots-rooms" role="list">
          {rooms.map((room) => {
            const inside = room.members.some(({ id }) => id === agent.id);
            const full = room.members.length >= roomLimits.members;
            return (
              <li key={room.id}>
                <button
                  type="button"
                  className="bots-room"
                  disabled={busy || inside || full}
                  onClick={() => void add(room)}
                >
                  <Users size={16} aria-hidden="true" />
                  <span>
                    {room.name}
                    <small>
                      {inside
                        ? 'Already in this room'
                        : full
                          ? 'Full'
                          : counted(room.members.length, 'bot')}
                    </small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <Notice>{error}</Notice>}
      <div className="chat-agent-actions">
        <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus size={16} aria-hidden="true" />
          New room with {agent.name}
        </Button>
      </div>
    </DialogContent>
  );
}

function RemoveBot({
  agent,
  schedules,
  refresh,
  onClose,
}: {
  agent: Agent;
  schedules: number;
  refresh(): Promise<void>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
      await refresh();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <DialogContent
      className="delete-plan-dialog"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-keep-bot]')?.focus();
      }}
    >
      <DialogTitle>Remove bot?</DialogTitle>
      <DialogDescription>
        {agent.name}
        <span>
          Its chats stay as ordinary chats.
          {agent.memoryMode !== 'shared' && ' Its own memory is deleted.'}
          {schedules > 0 &&
            ` ${counted(schedules, 'schedule')} that ${schedules === 1 ? 'runs' : 'run'} as it will run without a bot.`}
        </span>
      </DialogDescription>
      {error && <Notice>{error}</Notice>}
      <div className="delete-plan-actions">
        <Button variant="ghost" data-keep-bot disabled={busy} onClick={onClose}>
          Keep bot
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          {busy ? 'Removing…' : 'Remove bot'}
        </Button>
      </div>
    </DialogContent>
  );
}

export function Bots({
  agents,
  rooms = [],
  refresh,
  onOpen,
  onStart,
}: {
  agents?: Agent[];
  rooms?: Room[];
  refresh(): Promise<void>;
  onOpen(chatId: string): void;
  onStart(agentId: string, model: ModelSelection | null): void;
}) {
  const format = useDateFormat();
  const models = useModels().data;
  const links = usePageData<AgentSchedules>(agentSchedulesPath).data?.links ?? [];
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const modelName = (agent: Agent) =>
    !agent.model
      ? 'Default model'
      : ((models && modelOf(models, agent.model)?.name) ?? 'Unavailable model');
  return (
    <div className="content-page secondary-page bots-page" data-analytics-private>
      <header className="page-heading secondary-heading">
        <PageTitle path="/bots" />
        <div className="secondary-heading-actions">
          <Button onClick={() => setOpen({ kind: 'new' })}>
            <Plus size={16} aria-hidden="true" />
            New bot
          </Button>
        </div>
      </header>
      <section className="bots-starters" aria-labelledby="bots-starters">
        <h2 id="bots-starters">Start from</h2>
        <ul role="list">
          {botStarters.map((starter) => (
            <li key={starter.name}>
              <button
                type="button"
                className="bots-starter"
                onClick={() => setOpen({ kind: 'new', starter })}
              >
                <BotPicture bot={{ ...starter, imageId: null }} size="lg" />
                <span>
                  <strong>{starter.name}</strong>
                  <span>{starter.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="bots-section" aria-labelledby="bots-yours">
        <h2 id="bots-yours">Your bots</h2>
        {!agents ? (
          <Loading label="Loading bots…" />
        ) : !agents.length ? (
          <div className="bots-empty">
            <BotPicture bot={{ emoji: '🤖', color: 'blush', imageId: null }} size="xl" />
            <h2>No bots yet</h2>
            <p>
              A bot is a chat with its own name, picture, instructions and memory. It stays when you
              reset the conversation. Start from one above, or make your own.
            </p>
            <Button variant="outline" onClick={() => setOpen({ kind: 'new' })}>
              <Plus size={16} aria-hidden="true" />
              New bot
            </Button>
          </div>
        ) : (
          <ul className="bots-grid" role="list" aria-label="Your bots">
            {agents.map((agent) => {
              const schedules = links.filter((link) => link.agentId === agent.id);
              const joined = rooms.filter((room) => room.members.some(({ id }) => id === agent.id));
              return (
                <li key={agent.id} className="bots-card">
                  <div className="bots-card-head">
                    <BotPicture bot={agent} size="lg" />
                    <div>
                      <h3>{agent.name}</h3>
                      {agent.description && <p>{agent.description}</p>}
                    </div>
                  </div>
                  <ul className="bots-badges" role="list" aria-label="Settings">
                    <li>{modelName(agent)}</li>
                    <li>{memoryBadges[agent.memoryMode]}</li>
                    <li>{agent.apps.length ? counted(agent.apps.length, 'app') : 'All apps'}</li>
                    {agent.skills.length > 0 && <li>{counted(agent.skills.length, 'skill')}</li>}
                  </ul>
                  {(schedules.length > 0 || joined.length > 0) && (
                    <ul className="bots-links" role="list" aria-label="Used by">
                      {schedules.map((link) => (
                        <li key={link.scheduleId}>
                          <button type="button" onClick={() => navigate('/tasks')}>
                            <CalendarClock size={14} aria-hidden="true" />
                            <span>{link.title}</span>
                          </button>
                        </li>
                      ))}
                      {joined.map((room) => (
                        <li key={room.id}>
                          <button type="button" onClick={() => onOpen(room.id)}>
                            <Users size={14} aria-hidden="true" />
                            <span>{room.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="bots-active">
                    {agent.lastActiveAt ? (
                      <>
                        Last active{' '}
                        <time dateTime={agent.lastActiveAt}>
                          {formatDateTime(agent.lastActiveAt, format)}
                        </time>
                      </>
                    ) : (
                      'Not used yet'
                    )}
                  </p>
                  <div className="bots-card-foot">
                    <div className="bots-actions">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          agent.chatId ? onOpen(agent.chatId) : onStart(agent.id, null)
                        }
                      >
                        <MessageCircle size={16} aria-hidden="true" />
                        Chat
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpen({ kind: 'edit', agent })}
                      >
                        Edit
                      </Button>
                      <ActionMenu
                        label={`More for ${agent.name}`}
                        contentClassName="action-menu-compact"
                        trigger={
                          <Button variant="ghost" size="icon" title="More">
                            <Ellipsis size={16} aria-hidden="true" />
                          </Button>
                        }
                      >
                        {(closeMenu) => (
                          <>
                            <ActionMenuItem
                              onClick={() => {
                                closeMenu();
                                setOpen({ kind: 'room', agent });
                              }}
                            >
                              Add to a room
                            </ActionMenuItem>
                            <ActionMenuItem
                              destructive
                              onClick={() => {
                                closeMenu();
                                setOpen({ kind: 'remove', agent });
                              }}
                            >
                              Remove
                            </ActionMenuItem>
                          </>
                        )}
                      </ActionMenu>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="bots-section" aria-labelledby="bots-rooms">
        <div className="bots-section-head">
          <h2 id="bots-rooms">Rooms</h2>
          <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'new-room' })}>
            <Plus size={16} aria-hidden="true" />
            New room
          </Button>
        </div>
        {rooms.length ? (
          <ul className="bots-room-list" role="list">
            {rooms.map((room) => (
              <li key={room.id}>
                <button type="button" className="bots-room-row" onClick={() => onOpen(room.id)}>
                  <span className="bots-room-faces" aria-hidden="true">
                    {room.members.slice(0, 4).map((member) => {
                      const bot = agents?.find(({ id }) => id === member.id);
                      return bot ? <BotPicture key={member.id} bot={bot} size="md" /> : null;
                    })}
                  </span>
                  <span>
                    <strong>{room.name}</strong>
                    <small>
                      {room.members.map(({ name }) => name).join(', ') || 'No bots yet'}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bots-note">
            A room is one chat where several of your bots answer you, each in its own voice.
          </p>
        )}
      </section>
      <Dialog open={open !== null} onOpenChange={(value) => !value && close()}>
        {open?.kind === 'new' && (
          <BotDialog
            agents={agents}
            starter={open.starter}
            onClose={close}
            onCreated={(id, model) => {
              close();
              onStart(id, model);
            }}
            refresh={refresh}
          />
        )}
        {open?.kind === 'new-room' && (
          <NewRoomDialog
            agents={agents ?? []}
            onCreated={async (id) => {
              await refresh();
              close();
              onOpen(id);
            }}
            onNewBot={() => setOpen({ kind: 'new' })}
          />
        )}
        {open?.kind === 'edit' && (
          <BotDialog agent={open.agent} agents={agents} onClose={close} refresh={refresh} />
        )}
        {open?.kind === 'room' && (
          <AddToRoom
            agent={open.agent}
            agents={agents ?? []}
            rooms={rooms}
            refresh={refresh}
            onClose={close}
            onOpen={onOpen}
          />
        )}
        {open?.kind === 'remove' && (
          <RemoveBot
            agent={open.agent}
            schedules={links.filter((link) => link.agentId === open.agent.id).length}
            refresh={refresh}
            onClose={close}
          />
        )}
      </Dialog>
    </div>
  );
}
