import { EventEmitter } from 'node:events';
import type { Activity } from '../shared/contracts.ts';

type DeltaEvent = {
  type: 'delta';
  ownerId: string;
  channel: string;
  threadId: string;
  turnId: string;
  text: string;
  streamId?: string;
  done?: boolean;
};
type ActivityEvent = { type: 'activity'; ownerId: string; items: Activity[] };
type TraceEvent = { type: 'trace'; ownerId: string; turnId: string };
export type ServerEvent =
  { type: 'refresh' } | { type: 'working' } | DeltaEvent | ActivityEvent | TraceEvent;

export const events = new EventEmitter<{ event: [ServerEvent] }>();
events.setMaxListeners(50);
export function refresh() {
  events.emit('event', { type: 'refresh' });
}
export function working() {
  events.emit('event', { type: 'working' });
}
export function delta(event: Omit<DeltaEvent, 'type'>) {
  events.emit('event', { type: 'delta', ...event });
}
