import { useEffect, type ReactNode } from 'react';
import type { Task } from '../../shared/contracts';
import { appPages } from '../../shared/app-links';
import { routeModel, type ModelSelection, type WorkUsageResponse } from '../../shared/models';
import { useModels } from '../hooks/use-models';
import { usePageData } from '../hooks/use-page-data';
import { modelOf, taskTarget } from './model-choices';
import { ModelPicker, type ModelTarget } from './models';

function ChatModelLine({
  value,
  detail,
  children,
}: {
  value: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="work-model chat-model">
      <span className="work-model-label">Model</span>
      <span className="work-model-value">
        <strong>{value}</strong>
        {detail && ` · ${detail}`}
      </span>
      {children}
    </div>
  );
}

const shown = (name: string | undefined, own: boolean) =>
  own ? (name ?? 'Model unavailable') : `Default (${name ?? 'no model'})`;

export function TaskChatModel({ task }: { task: Task }) {
  const models = useModels();
  const usage = usePageData<WorkUsageResponse>('/api/usage/work');
  const data = models.data;
  const kind = task.work;
  if (!data || !kind) return null;
  const current = routeModel(data, kind, { task: task.model, schedule: task.scheduleModel });
  if (!current) return null;
  const target = taskTarget(data, { ...task, work: kind }, usage.data?.tasks[task.id]);
  return (
    <ChatModelLine
      value={shown(modelOf(data, current.selection)?.name, current.follows === 'task')}
    >
      <ModelPicker
        manageConnections={false}
        target={{
          ...target,
          title: 'Model for this chat',
          defaults: target.defaults.map((item) => ({ ...item, label: 'Default' })),
        }}
        label="Change"
        appearance="quiet"
      />
    </ChatModelLine>
  );
}

export function NewChatModel({
  value,
  onChange,
}: {
  value: ModelSelection | null;
  onChange(value: ModelSelection | null): void;
}) {
  const { data } = useModels();
  const chosen = Boolean(
    value &&
    data?.connections.some(
      (item) =>
        item.id === value.connectionId &&
        item.status === 'connected' &&
        item.models.some(
          (model) =>
            model.id === value.modelId && !model.audio && model.efforts.includes(value.effort),
        ),
    ),
  );
  useEffect(() => {
    if (data && value && !chosen) onChange(null);
  }, [data, value, chosen]);
  if (!data?.selection) return null;
  const target: ModelTarget = {
    title: 'Model for this chat',
    value: chosen ? value : null,
    defaults: [{ value: null, label: 'Default', model: data.selection }],
    save: async (choice) => {
      onChange(choice && choice !== 'light' ? choice : null);
      return true;
    },
  };
  return (
    <ChatModelLine
      value={shown(modelOf(data, chosen ? value : data.selection)?.name, Boolean(chosen))}
    >
      <ModelPicker manageConnections={false} target={target} label="Change" appearance="quiet" />
    </ChatModelLine>
  );
}

export function MainChatModel() {
  const { data } = useModels();
  const name = data && modelOf(data, data.selection)?.name;
  if (!name) return null;
  return (
    <ChatModelLine value={name} detail="your default">
      <a href="/settings/models">Change in {appPages['/settings/models']}</a>
    </ChatModelLine>
  );
}
