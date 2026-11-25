import { useId, useState } from 'react';
import type { Schedule } from '../../shared/contracts';
import type { AgentSchedules } from '../../shared/agents';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import { SearchPicker } from './search-picker';
import { Checkbox, Notice } from './ui';

export const agentSchedulesPath = '/api/agents/schedules';

export function ScheduleAgent({ schedule }: { schedule: Schedule }) {
  const { data } = usePageData<AgentSchedules>(agentSchedulesPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  if (!data?.agents.length) return null;
  const link = data.links.find((item) => item.scheduleId === schedule.id);
  async function save(agentId: string | null, useAgentModel: boolean) {
    setBusy(true);
    setError('');
    try {
      const next = await api<AgentSchedules>(
        `${agentSchedulesPath}/${encodeURIComponent(schedule.id)}`,
        { method: 'PUT', body: JSON.stringify({ agentId, useAgentModel }) },
      );
      pageDataCache.update<AgentSchedules>(agentSchedulesPath, () => next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="work-model schedule-agent">
      <span className="work-model-label" id={`${id}-agent`}>
        Runs as
      </span>
      <SearchPicker
        value={link?.agentId ?? ''}
        onChange={(value) => void save(value || null, false)}
        disabled={busy}
        labelledBy={`${id}-agent`}
        options={[
          { value: '', label: 'No agent' },
          ...data.agents.map((agent) => ({ value: agent.id, label: agent.name })),
        ]}
        labels={{
          choose: 'Choose the agent this schedule runs as',
          search: 'Search agents',
          placeholder: 'Search agents',
          clear: 'Clear agent search',
          list: 'Agents',
          empty: 'No matching agents',
        }}
      />
      {link && !schedule.model && (
        <label className="schedule-agent-model">
          <Checkbox
            checked={link.useAgentModel}
            disabled={busy}
            onChange={(event) => void save(link.agentId, event.target.checked)}
          />
          Use the agent's model
        </label>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
