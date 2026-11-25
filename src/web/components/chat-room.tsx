import { useState } from 'react';
import type { Agent } from '../../shared/agents';
import { roomLimits, type Room } from '../../shared/rooms';
import { api, errorMessage } from '../lib/api';
import { money } from '../lib/money';
import { X } from './icons';
import { InlineName } from './inline-name';
import { Button, Checkbox, DialogContent, DialogTitle, Field, Input, Notice } from './ui';
import './chat-room.css';

export function NewRoomDialog({
  agents,
  onCreated,
}: {
  agents: Agent[];
  onCreated(id: string): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <DialogContent className="chat-agent-dialog" aria-describedby={undefined}>
      <DialogTitle>New room</DialogTitle>
      <form
        className="chat-agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void api<{ id: string }>('/api/rooms', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim(), agents: chosen }),
          })
            .then(({ id }) => onCreated(id))
            .catch((cause: unknown) => setError(errorMessage(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <Field label="Name">
          <Input
            value={name}
            maxLength={160}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <fieldset className="chat-room-members">
          <legend>Agents in this room</legend>
          {agents.length ? (
            agents.map((agent) => (
              <label key={agent.id} className="chat-agent-choice">
                <Checkbox
                  checked={chosen.includes(agent.id)}
                  disabled={!chosen.includes(agent.id) && chosen.length >= roomLimits.members}
                  onChange={(event) =>
                    setChosen((current) =>
                      event.target.checked
                        ? [...current, agent.id]
                        : current.filter((id) => id !== agent.id),
                    )
                  }
                />
                {agent.name}
              </label>
            ))
          ) : (
            <p className="field-hint">Make a chat an agent first, then add it here.</p>
          )}
        </fieldset>
        <p className="field-hint">
          Each agent answers in its own voice. Only your messages give permission: what one agent
          writes is never an order for another.
        </p>
        {error && <Notice>{error}</Notice>}
        <div className="chat-agent-actions">
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create room'}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function RoomHeader({
  room,
  agents,
  refresh,
}: {
  room: Room;
  agents: Agent[];
  refresh(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inside = new Set(room.members.map(({ id }) => id));
  const addable = agents.filter((agent) => !inside.has(agent.id));
  async function change(body: { add?: string[]; remove?: string[] }) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/rooms/${room.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ revision: room.revision, ...body }),
      });
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="work-model chat-room">
      <span className="work-model-label">Room</span>
      <InlineName
        value={room.name}
        label="room name"
        save={async (title) => {
          await api(`/api/tasks/${room.id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
          await refresh();
        }}
      />
      <ul className="chat-room-chips" role="list" aria-label="Members">
        {room.members.map((member) => (
          <li key={member.id} className="chat-room-chip">
            {member.name}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy}
              title={`Remove ${member.name}`}
              aria-label={`Remove ${member.name}`}
              onClick={() => void change({ remove: [member.id] })}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {addable.length > 0 && room.members.length < roomLimits.members && (
        <select
          className="input chat-room-add"
          aria-label="Add an agent"
          value=""
          disabled={busy}
          onChange={(event) => event.target.value && void change({ add: [event.target.value] })}
        >
          <option value="">Add an agent…</option>
          {addable.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      )}
      <span className="field-hint">Cost so far: {money(room.costUsd ?? 0)}</span>
      {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
    </div>
  );
}
