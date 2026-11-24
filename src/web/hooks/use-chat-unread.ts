import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, MessageHistoryPage } from '../../shared/contracts';
import { api } from '../lib/api';
import {
  hasUnreadHistory,
  latestChatReadCursor,
  mergeChatReadCursor,
  readChatReadCursor,
  readTaskReadCursors,
  reconcileUnreadChat,
  unreadChatMessageIds,
  writeChatReadCursor,
  writeTaskReadCursors,
  type ChatReadCursor,
} from '../lib/chat-unread';

const baseline = '*';

export function useChatUnread(ownerId: string, state: AppState | null) {
  const messages = useMemo(
    () => state?.messages.filter((message) => !message.taskId),
    [state?.messages],
  );
  const scope = useMemo(
    () =>
      state
        ? {
            ownerId,
            threadId: state.threadId,
            initial: latestChatReadCursor(messages!),
            pending: null as ChatReadCursor | null,
            cursor: null as ChatReadCursor | null,
            writing: false,
          }
        : null,
    [ownerId, state?.threadId],
  );
  const current = useRef(scope);
  current.current = scope;
  const [read, setRead] = useState<{ scope: typeof scope; cursor: ChatReadCursor } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [unavailable, setUnavailable] = useState<typeof scope>(null);
  const [history, setHistory] = useState<{
    scope: typeof scope;
    messages: AppState['messages'];
    cursor: ChatReadCursor;
    count: number;
    pending: boolean;
  } | null>(null);
  const persist = useCallback(async () => {
    if (!scope || current.current !== scope || scope.writing || !scope.cursor) return;
    scope.writing = true;
    try {
      while (scope.pending && current.current === scope) {
        const next = scope.pending;
        await writeChatReadCursor(scope.ownerId, scope.threadId, next);
        if (current.current !== scope) return;
        scope.cursor = mergeChatReadCursor(scope.cursor, next);
        if (scope.pending === next) scope.pending = null;
        setRead({ scope, cursor: scope.cursor });
        setUnavailable(null);
      }
    } catch {
      if (current.current === scope) setUnavailable(scope);
    } finally {
      scope.writing = false;
    }
  }, [scope]);
  useEffect(() => {
    if (!scope) return;
    let active = true;
    void readChatReadCursor(scope.ownerId, scope.threadId)
      .then((saved) => {
        if (!active || current.current !== scope) return;
        const stored = saved ?? scope.initial;
        const baseline = scope.cursor ? mergeChatReadCursor(stored, scope.cursor) : stored;
        scope.cursor = baseline;
        if (scope.pending || !saved)
          scope.pending = mergeChatReadCursor(baseline, scope.pending ?? baseline);
        setUnavailable(null);
        setRead({ scope, cursor: baseline });
        void persist();
      })
      .catch(() => {
        if (active && current.current === scope) setUnavailable(scope);
      });
    return () => {
      active = false;
    };
  }, [scope, attempt, persist]);
  useEffect(() => {
    const retry = () => setAttempt((value) => value + 1);
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    };
  }, []);
  const cursor = read?.scope === scope ? read.cursor : null;
  const earlier = state?.hasEarlierMessages === true;
  const count = cursor && messages ? Math.min(unreadChatMessageIds(messages, cursor).size, 100) : 0;
  const missing =
    !!cursor && !!messages && count < 100 && hasUnreadHistory(messages, earlier, cursor);
  useEffect(() => {
    if (!scope || !cursor || !messages || !missing) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const update = (count: number, pending: boolean) => {
      if (!controller.signal.aborted && current.current === scope)
        setHistory({ scope, cursor, messages, count, pending });
    };
    void reconcileUnreadChat(
      messages,
      earlier,
      cursor,
      (before, signal) => {
        const query = new URLSearchParams({
          threadId: scope.threadId,
          before: before.createdAt,
          beforeId: before.id,
          task: 'main',
        });
        return api<MessageHistoryPage>(`/api/messages?${query}`, { signal });
      },
      signal,
      (count) => update(count, count < 100),
    )
      .then((count) => update(count, false))
      .catch(() => {});
    return () => controller.abort();
  }, [scope, cursor, messages, earlier, missing, attempt]);
  const markRead = useCallback(
    (threadId: string) => {
      if (!scope || current.current !== scope || threadId !== scope.threadId || !messages) return;
      const next = latestChatReadCursor(messages);
      if (!scope.cursor) {
        scope.pending = scope.pending ? mergeChatReadCursor(scope.pending, next) : next;
        return;
      }
      const merged = mergeChatReadCursor(scope.cursor, next);
      if (JSON.stringify(merged) === JSON.stringify(scope.cursor)) return;
      scope.pending = mergeChatReadCursor(scope.pending ?? scope.cursor, merged);
      void persist();
    },
    [scope, messages, persist],
  );
  const [taskRead, setTaskRead] = useState<{
    scope: typeof scope;
    cursors: Record<string, ChatReadCursor>;
  } | null>(null);
  useEffect(() => {
    if (scope) setTaskRead({ scope, cursors: readTaskReadCursors(scope.ownerId, scope.threadId) });
  }, [scope]);
  const taskCursors = taskRead?.scope === scope ? taskRead.cursors : undefined;
  useEffect(() => {
    if (!scope || !cursor || !taskCursors || taskCursors[baseline]) return;
    const cursors = { ...taskCursors, [baseline]: cursor };
    writeTaskReadCursors(scope.ownerId, scope.threadId, cursors);
    setTaskRead({ scope, cursors });
  }, [scope, cursor, taskCursors]);
  const taskCounts: Record<string, number> = {};
  for (const message of taskCursors?.[baseline] ? (state?.messages ?? []) : []) {
    const from = message.taskId && (taskCursors![message.taskId] ?? taskCursors![baseline]);
    if (from && unreadChatMessageIds([message], from).size)
      taskCounts[message.taskId!] = (taskCounts[message.taskId!] ?? 0) + 1;
  }
  const markTaskRead = useCallback(
    (taskId: string) => {
      if (!scope || current.current !== scope || !state || !taskCursors) return;
      const latest = latestChatReadCursor(
        state.messages.filter((message) => message.taskId === taskId),
      );
      const saved = taskCursors[taskId] ?? taskCursors[baseline];
      const next = saved ? mergeChatReadCursor(saved, latest) : latest;
      if (JSON.stringify(next) === JSON.stringify(saved)) return;
      const cursors = { ...taskCursors, [taskId]: next };
      writeTaskReadCursors(scope.ownerId, scope.threadId, cursors);
      setTaskRead({ scope, cursors });
    },
    [scope, state?.messages, taskCursors],
  );
  const reconciled =
    history?.scope === scope && history.cursor === cursor && history.messages === messages;
  return {
    cursor,
    unavailable: unavailable === scope && !cursor,
    count: Math.min(
      (reconciled ? history.count : count) +
        Object.values(taskCounts).reduce((total, value) => total + value, 0),
      100,
    ),
    pending: (!!scope && unavailable === scope) || (reconciled ? history.pending : missing),
    markRead,
    taskCounts,
    markTaskRead,
  };
}
