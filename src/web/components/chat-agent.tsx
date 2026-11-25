import { useState } from 'react';
import type { Task } from '../../shared/contracts';
import {
  agentLimits,
  agentMemoryModes,
  type Agent,
  type AgentChoices,
  type AgentMemoryMode,
  type AgentSchedules,
} from '../../shared/agents';
import { usePageData } from '../hooks/use-page-data';
import { agentSchedulesPath } from './schedule-agent';
import { api, errorMessage } from '../lib/api';
import { Button, Checkbox, Dialog, DialogContent, DialogTitle, Field, Input, Notice } from './ui';

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
    <details className="chat-agent-allowlist">
      <summary>
        {label}: {value.length ? `${value.length} chosen` : everything}
      </summary>
      <p className="field-hint">Choose none to allow all. Choices only narrow what it can use.</p>
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
    </details>
  );
}

function AgentDialog({
  chatId,
  agent,
  onClose,
  refresh,
}: {
  chatId: string;
  agent?: Agent;
  onClose(): void;
  refresh(): Promise<void>;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const [memoryMode, setMemoryMode] = useState<AgentMemoryMode>(agent?.memoryMode ?? 'shared');
  const [apps, setApps] = useState(agent?.apps ?? []);
  const [skills, setSkills] = useState(agent?.skills ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const linked = usePageData<AgentSchedules>(agentSchedulesPath).data;
  const choices = usePageData<AgentChoices>('/api/agents/choices').data;
  const schedules = agent ? (linked?.links ?? []).filter((link) => link.agentId === agent.id) : [];
  async function run(request: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await request();
      await refresh();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const lists = { apps, skills };
  const profile = {
    name: name.trim(),
    description: description.trim(),
    instructions,
    memoryMode,
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
      <DialogTitle>{agent ? 'Edit agent' : 'Make this chat an agent'}</DialogTitle>
      <form
        className="chat-agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            agent
              ? api(`/api/agents/${agent.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ ...profile, revision: agent.revision }),
                })
              : api('/api/agents', {
                  method: 'POST',
                  body: JSON.stringify({ ...profile, chatId }),
                }),
          );
        }}
      >
        <Field label="Name" hint="The chat takes this name.">
          <Input
            value={name}
            maxLength={agentLimits.name}
            required
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
        <p className="field-hint">Its model is under Model in this chat.</p>
        {schedules.length > 0 && (
          <p className="field-hint">
            Schedules that run as this agent: {schedules.map(({ title }) => title).join(', ')}.
            Change them on Scheduled.
          </p>
        )}
        {agent && agent.memoryMode !== 'shared' && (
          <p className="field-hint">Removing the agent also deletes its own memory.</p>
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
              Remove agent, keep the chat
            </Button>
          )}
          <Button type="submit" size="sm" disabled={busy || !profile.name}>
            {busy ? 'Saving…' : 'Save'}
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
      <span className="work-model-label">Agent</span>
      <span className="work-model-value" title={agent?.description || undefined}>
        {agent ? (
          <>
            <strong>{agent.name}</strong>
            {agent.description && ` · ${agent.description}`}
          </>
        ) : (
          'None'
        )}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {agent ? 'Edit' : 'Make this an agent'}
        </Button>
        {open && (
          <AgentDialog
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

export function NewAgentChat({ agent }: { agent: Agent }) {
  return (
    <div className="work-model chat-agent">
      <span className="work-model-label">Agent</span>
      <span className="work-model-value" title={agent?.description || undefined}>
        <strong>{agent.name}</strong>
        {agent.description && ` · ${agent.description}`}
      </span>
      <span className="field-hint">Your message starts its chat in this conversation.</span>
    </div>
  );
}
