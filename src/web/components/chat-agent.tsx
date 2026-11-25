import { useState } from 'react';
import type { Task } from '../../shared/contracts';
import { agentLimits, type Agent } from '../../shared/agents';
import { api, errorMessage } from '../lib/api';
import { Button, Dialog, DialogContent, DialogTitle, Field, Input, Notice } from './ui';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  const profile = { name: name.trim(), description: description.trim(), instructions };
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
        <p className="field-hint">
          Memory: this agent uses your shared memory. Its model is under Model in this chat.
        </p>
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
