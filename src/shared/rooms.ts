export const roomLimits = { members: 8, hops: 4, turnsPerHour: 30 } as const;

export interface RoomMember {
  id: string;
  name: string;
}

export interface Room {
  id: string;
  name: string;
  revision: number;
  members: RoomMember[];
  costUsd: number | null;
}

export function roomApprovalContent(args: unknown) {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const names = (key: string) =>
    Array.isArray(input[key])
      ? (input[key] as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
  return {
    fields: [
      ...(typeof input.room === 'string' ? [{ label: 'Room', value: input.room }] : []),
      ...(names('add').length ? [{ label: 'Add', value: names('add').join(', ') }] : []),
      ...(names('remove').length ? [{ label: 'Remove', value: names('remove').join(', ') }] : []),
    ],
  };
}
