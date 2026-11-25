import { useState } from 'react';
import type { Task } from '../../shared/contracts';
import type { ModelSelection } from '../../shared/models';
import {
  agentColors,
  agentDefaultEmoji,
  agentLimits,
  agentMemoryModes,
  type Agent,
  type AgentChoices,
  type AgentColor,
  type AgentMemoryMode,
  type AgentSchedules,
} from '../../shared/agents';
import { usePageData } from '../hooks/use-page-data';
import { agentSchedulesPath } from './schedule-agent';
import { api, errorMessage } from '../lib/api';
import { BotPicture, PictureEditor, type BotLook } from './bot-picture';
import { NewChatModel } from './chat-model';
import { Button, Checkbox, Dialog, DialogContent, DialogTitle, Field, Input, Notice } from './ui';

export interface BotStarter {
  name: string;
  emoji: string;
  color: AgentColor;
  description: string;
  instructions: string;
}

export const botStarters: BotStarter[] = [
  {
    name: 'Research',
    emoji: '🔎',
    color: 'mist',
    description: 'Finds sources and sums them up',
    instructions:
      'Search widely before answering and prefer primary sources. Give the date of each source and link every claim to it. Say what is uncertain or disputed. End with a short summary and the open questions.',
  },
  {
    name: 'Writer',
    emoji: '✍️',
    color: 'blush',
    description: 'Drafts and edits clear writing',
    instructions:
      'Ask who the reader is when it is not clear. Write plainly, in short sentences and the active voice. Give one strong draft, then two or three changes worth considering. When editing, keep the original voice and say what you changed.',
  },
  {
    name: 'Planner',
    emoji: '🗓️',
    color: 'stone',
    description: 'Turns goals into steps and dates',
    instructions:
      'Break a goal into small next steps, each with a date. Point out what depends on what and what could slip. Keep plans short, and update them when something changes instead of starting over.',
  },
  {
    name: 'Tutor',
    emoji: '🎓',
    color: 'rose',
    description: 'Explains a topic step by step',
    instructions:
      'Find out what the learner already knows first. Explain one idea at a time with a small example, then check understanding with a short question before moving on. Give hints for exercises before answers.',
  },
];

const anyOf = <T,>(values: readonly T[]) => values[Math.floor(Math.random() * values.length)]!;

function freeName(base: string, agents: Agent[]) {
  const taken = new Set(agents.map(({ name }) => name.toLocaleLowerCase()));
  for (let count = 1; ; count++) {
    const name = count === 1 ? base : `${base} ${count}`;
    if (!taken.has(name.toLocaleLowerCase())) return name;
  }
}

function Allowlist({
  label,
  everything,
  options,
  value,
  onChange,
}: {
  label: string;
  everything: string;
  options: Array<{ id: string; label: string; within?: string }>;
  value: string[];
  onChange(value: string[]): void;
}) {
  const known = new Set(options.map(({ id }) => id));
  const listed: Array<{ id: string; label: string; within?: string }> = [
    ...options,
    ...value.filter((id) => !known.has(id)).map((id) => ({ id, label: `${id} (unavailable)` })),
  ];
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value, id] : value.filter((item) => item !== id));
  return (
    <fieldset className="chat-agent-allowlist">
      <legend>
        {label}: {value.length ? `${value.length} chosen` : everything}
      </legend>
      {!listed.length && <p className="field-hint">None yet.</p>}
      <div className="chat-agent-choices">
        {listed.map((option) => {
          const covered = option.within !== undefined && value.includes(option.within);
          return (
            <label
              key={option.id}
              className={
                option.within === undefined ? 'chat-agent-choice' : 'chat-agent-choice is-nested'
              }
            >
              <Checkbox
                checked={covered || value.includes(option.id)}
                disabled={covered}
                onChange={(event) => toggle(option.id, event.target.checked)}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function BotDialog({
  agent,
  chatId,
  starter,
  agents = [],
  onClose,
  onCreated,
  refresh,
}: {
  agent?: Agent;
  chatId?: string;
  starter?: BotStarter;
  agents?: Agent[];
  onClose(): void;
  onCreated?(id: string, model: ModelSelection | null): void;
  refresh(): Promise<void>;
}) {
  const creating = !agent && !chatId;
  const [name, setName] = useState(agent?.name ?? (starter ? freeName(starter.name, agents) : ''));
  const [description, setDescription] = useState(agent?.description ?? starter?.description ?? '');
  const [instructions, setInstructions] = useState(
    agent?.instructions ?? starter?.instructions ?? '',
  );
  const [look, setLook] = useState<BotLook>(() =>
    agent
      ? { emoji: agent.emoji, color: agent.color, imageId: agent.imageId }
      : {
          emoji: starter?.emoji ?? anyOf(agentDefaultEmoji),
          color: starter?.color ?? anyOf(agentColors),
          imageId: null,
        },
  );
  const [started, setStarted] = useState(starter?.name);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [memoryMode, setMemoryMode] = useState<AgentMemoryMode>(agent?.memoryMode ?? 'shared');
  const [apps, setApps] = useState(agent?.apps ?? []);
  const [skills, setSkills] = useState(agent?.skills ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const linked = usePageData<AgentSchedules>(agentSchedulesPath).data;
  const choices = usePageData<AgentChoices>('/api/agents/choices').data;
  const schedules = agent ? (linked?.links ?? []).filter((link) => link.agentId === agent.id) : [];
  const fallbackName = freeName('New bot', agents);
  function startFrom(choice: BotStarter) {
    setStarted(choice.name);
    setName(freeName(choice.name, agents));
    setDescription(choice.description);
    setInstructions(choice.instructions);
    setLook({ emoji: choice.emoji, color: choice.color, imageId: null });
  }
  async function run(request: () => Promise<string | void>) {
    setBusy(true);
    setError('');
    try {
      const created = await request();
      await refresh();
      if (created && onCreated) onCreated(created, model);
      else onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const lists = { apps, skills };
  const profile = {
    name: name.trim() || (creating ? fallbackName : ''),
    description: description.trim(),
    instructions,
    memoryMode,
    emoji: look.emoji,
    color: look.color,
    ...(look.imageId !== (agent?.imageId ?? null) ? { imageId: look.imageId } : {}),
    ...Object.fromEntries(
      (['apps', 'skills'] as const).flatMap((key) =>
        JSON.stringify(lists[key]) === JSON.stringify(agent?.[key] ?? [])
          ? []
          : [[key, lists[key]]],
      ),
    ),
  };
  const mode = agentMemoryModes.find(({ id }) => id === memoryMode);
  return (
    <DialogContent className="chat-agent-dialog" aria-describedby={undefined}>
      <DialogTitle>{agent ? 'Edit bot' : chatId ? 'Make this chat a bot' : 'New bot'}</DialogTitle>
      <form
        className="chat-agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (agent) {
              await api(`/api/agents/${agent.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ ...profile, revision: agent.revision }),
              });
              return;
            }
            const made = await api<{ id: string }>('/api/agents', {
              method: 'POST',
              body: JSON.stringify({ ...profile, ...(chatId ? { chatId } : {}) }),
            });
            if (creating) return made.id;
          });
        }}
      >
        {creating && (
          <div className="bot-starters" role="group" aria-label="Start from">
            {botStarters.map((choice) => (
              <button
                key={choice.name}
                type="button"
                className="bot-starter"
                aria-pressed={started === choice.name}
                onClick={() => startFrom(choice)}
              >
                <BotPicture bot={{ ...choice, imageId: null }} size="md" />
                {choice.name}
              </button>
            ))}
          </div>
        )}
        <div className="bot-form-identity">
          <PictureEditor value={look} onChange={setLook} />
          <div className="bot-form-fields">
            <Field label="Name" hint="Its chat takes this name.">
              <Input
                value={name}
                maxLength={agentLimits.name}
                required={!creating}
                placeholder={creating ? fallbackName : undefined}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="What it's for" hint="One line.">
              <Input
                value={description}
                maxLength={agentLimits.description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>
        </div>
        <Field
          label="Instructions"
          hint={`${instructions.length} / ${agentLimits.instructions}. Nod follows them for focus, tone and method in this chat. They never give permission: actions still need your words or your yes.`}
        >
          <textarea
            className="input chat-agent-instructions"
            value={instructions}
            maxLength={agentLimits.instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        {creating && <NewChatModel value={model} onChange={setModel} />}
        <Field label="Memory" hint={mode?.hint}>
          <select
            className="input"
            value={memoryMode}
            onChange={(event) => setMemoryMode(event.target.value as AgentMemoryMode)}
          >
            {agentMemoryModes.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <details className="bot-form-more">
          <summary>
            More
            <span>
              {apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'}` : 'All apps'},{' '}
              {skills.length
                ? `${skills.length} skill${skills.length === 1 ? '' : 's'}`
                : 'all skills'}
            </span>
          </summary>
          <p className="field-hint">
            Choose none to allow all. Choices only narrow what it can use.
          </p>
          <Allowlist
            label="Apps"
            everything="All connected apps"
            value={apps}
            onChange={setApps}
            options={(choices?.apps ?? []).flatMap((app) => [
              { id: app.slug, label: app.name },
              ...(app.accounts.length > 1 || app.accounts.some(({ id }) => apps.includes(id))
                ? app.accounts.map((account) => ({
                    id: account.id,
                    label: account.label,
                    within: app.slug,
                  }))
                : []),
            ])}
          />
          <Allowlist
            label="Skills"
            everything="All skills"
            value={skills}
            onChange={setSkills}
            options={(choices?.skills ?? []).map((skill) => ({
              id: skill.name,
              label: skill.learned ? `${skill.name} (learned)` : skill.name,
            }))}
          />
        </details>
        {!creating && <p className="field-hint">Its model is under Model in its chat.</p>}
        {schedules.length > 0 && (
          <p className="field-hint">
            Schedules that run as this bot: {schedules.map(({ title }) => title).join(', ')}. Change
            them on Scheduled.
          </p>
        )}
        {agent && agent.memoryMode !== 'shared' && (
          <p className="field-hint">Removing the bot also deletes its own memory.</p>
        )}
        {error && <Notice>{error}</Notice>}
        <div className="chat-agent-actions">
          {agent && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => api(`/api/agents/${agent.id}`, { method: 'DELETE' }))}
            >
              Remove bot, keep the chat
            </Button>
          )}
          <Button type="submit" size="sm" disabled={busy || !profile.name}>
            {busy ? 'Saving…' : creating ? 'Create and chat' : 'Save'}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function TaskChatAgent({
  task,
  agent,
  refresh,
}: {
  task: Task;
  agent?: Agent;
  refresh(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (!agent && !task.work) return null;
  return (
    <div className="work-model chat-agent">
      {agent ? (
        <>
          <BotPicture bot={agent} size="md" />
          <span className="chat-agent-identity">
            <strong>{agent.name}</strong>
            {agent.description && <span>{agent.description}</span>}
          </span>
        </>
      ) : (
        <>
          <span className="work-model-label">Bot</span>
          <span className="work-model-value">None</span>
        </>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {agent ? 'Edit' : 'Make this a bot'}
        </Button>
        {open && (
          <BotDialog
            chatId={task.id}
            agent={agent}
            onClose={() => setOpen(false)}
            refresh={refresh}
          />
        )}
      </Dialog>
    </div>
  );
}

export function BotWelcome({ agent }: { agent: Agent }) {
  return (
    <div className="welcome bot-welcome">
      <BotPicture bot={agent} size="hero" />
      <h2>{agent.name}</h2>
      <p>{agent.description || 'Your first message starts its chat.'}</p>
    </div>
  );
}
