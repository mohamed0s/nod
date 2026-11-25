import { useState } from 'react';
import { usePageData } from '../hooks/use-page-data';

export function useMemoryDocument(onChange: () => void) {
  const agents = usePageData<Array<{ id: string; name: string }>>('/api/memory/agents').data ?? [];
  const [chosen, setChosen] = useState('');
  const agent = agents.find(({ id }) => id === chosen);
  return {
    base: agent ? `/api/memory/agents/${agent.id}` : '/api/memory',
    agent,
    picker: (locked: boolean) =>
      agents.length ? (
        <label className="memory-document">
          <span>Memory of</span>
          <select
            className="input"
            value={agent?.id ?? ''}
            disabled={locked}
            onChange={(event) => {
              setChosen(event.target.value);
              onChange();
            }}
          >
            <option value="">Shared</option>
            {agents.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : null,
  };
}
