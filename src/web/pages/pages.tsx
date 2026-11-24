import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  pageBytes,
  pageLink,
  pageTitleLength,
  type PageFile,
  type PageSource,
  type PageVersion,
  type PageView,
} from '../../shared/pages';
import { SandboxedFrame, sandboxedDocument } from '../components/attachment-frame';
import { PageTitle } from '../components/page-title';
import { Button, Input, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, apiBytes, errorMessage, post } from '../lib/api';
import { subscribeAppEvents } from '../lib/app-events';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { navigate, replaceNavigation } from '../lib/navigation';
import { pageDataCache } from '../lib/page-data-cache';
import './pages.css';

const listPath = '/api/pages';
const refreshList = () => void pageDataCache.refresh(listPath, true);
const linkCatcher =
  "<script>addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href],area[href]');if(!a)return;var h=a.getAttribute('href')||'';e.preventDefault();if(h.charAt(0)==='#'){try{location.hash=h}catch(x){}}else if(/^\\s*https:\\/\\//i.test(h))parent.postMessage({'nod:link':h},'*')},true)</script>";

function publisher(source: PageSource) {
  if (source.kind === 'schedule') return source.title ?? 'a schedule';
  if (source.kind === 'task') return source.title;
  if (source.kind === 'chat') return source.current ? 'Main chat' : 'an earlier chat';
  return 'you';
}

function sourceAction(source: PageSource) {
  if (source.kind === 'schedule')
    return { label: 'Open schedules', open: () => navigate('/tasks') };
  if (source.kind === 'task')
    return {
      label: 'Open chat',
      open: () =>
        window.dispatchEvent(new CustomEvent('nod:open-chat', { detail: { taskId: source.id } })),
    };
  if (source.kind === 'chat' && source.current)
    return { label: 'Open chat', open: () => navigate('/') };
  return null;
}

function Frame({ file, title }: { file: PageFile; title: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError('');
    setLeft(false);
    apiBytes(file.url, pageBytes, { signal: controller.signal }).then(
      (bytes) => setText(new TextDecoder().decode(bytes)),
      (cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      },
    );
    return () => controller.abort();
  }, [file.url]);
  const html = useMemo(() => (text === null ? null : sandboxedDocument(text, linkCatcher)), [text]);
  const leave = useCallback(() => setLeft(true), []);
  const open = useCallback(
    (href: string) => {
      const url = text === null ? null : pageLink(href, text, window.location.origin);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    },
    [text],
  );
  if (error) return <Notice>Could not load this page. {error}</Notice>;
  if (left)
    return (
      <Notice kind="info">
        This page tried to open a website, so Nod stopped showing it.{' '}
        <Button size="sm" variant="ghost" onClick={() => setLeft(false)}>
          Show it again
        </Button>
      </Notice>
    );
  if (html === null) return <Loading label="Loading the page…" />;
  return (
    <SandboxedFrame key={file.id} html={html} title={title} scripts onLeave={leave} onLink={open} />
  );
}

function History({
  page,
  viewing,
  onView,
}: {
  page: PageView;
  viewing: number | null;
  onView(version: PageVersion | null): void;
}) {
  const format = useDateFormat();
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    api<PageVersion[]>(`/api/pages/${page.id}/versions`).then(
      (value) => active && setVersions(value),
      (cause) => active && setError(errorMessage(cause)),
    );
    return () => {
      active = false;
    };
  }, [page.id, page.revision]);
  if (error) return <Notice>Could not load earlier versions. {error}</Notice>;
  if (!versions) return <Loading label="Loading earlier versions…" />;
  return (
    <ol className="pages-history" role="list">
      {versions.map((version) => {
        const current = version.revision === page.revision;
        const shown = viewing === null ? current : viewing === version.revision;
        return (
          <li key={version.revision} data-shown={shown}>
            <span>
              Version {version.revision} ·{' '}
              <time dateTime={version.createdAt}>{formatDateTime(version.createdAt, format)}</time>{' '}
              · {publisher(version.source)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={shown || !version.file}
              onClick={() => onView(current ? null : version)}
            >
              {shown ? 'Showing' : version.file ? 'View' : 'Unavailable'}
            </Button>
          </li>
        );
      })}
    </ol>
  );
}

function Viewer({ page, onGone }: { page: PageView; onGone(): void }) {
  const format = useDateFormat();
  const [renaming, setRenaming] = useState<{ from: string; title: string } | null>(null);
  const [history, setHistory] = useState(false);
  const [viewing, setViewing] = useState<PageVersion | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      refreshList();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const source = sourceAction(page.source);
  const shown = viewing?.file ?? page.file;
  return (
    <section className="pages-viewer" aria-label={page.title}>
      <header className="pages-viewer-header">
        {renaming ? (
          <form
            className="pages-rename"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await act(() =>
                  api(`/api/pages/${page.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ title: renaming.title, current: renaming.from }),
                  }),
                )
              )
                setRenaming(null);
            }}
          >
            <Input
              aria-label="Page name"
              value={renaming.title}
              maxLength={pageTitleLength}
              autoFocus
              onChange={(event) => setRenaming({ ...renaming, title: event.target.value })}
            />
            <Button type="submit" size="sm" disabled={busy || !renaming.title.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </form>
        ) : (
          <h2>{page.title}</h2>
        )}
        <p className="pages-meta">
          Version {page.revision} · Updated{' '}
          <time dateTime={page.updatedAt}>{formatDateTime(page.updatedAt, format)}</time> by{' '}
          {publisher(page.source)}
          {page.archivedAt && ' · Archived'}
        </p>
        <div className="pages-actions">
          {source && (
            <Button size="sm" variant="secondary" onClick={source.open}>
              {source.label}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={history}
            onClick={() => setHistory(!history)}
          >
            History
          </Button>
          {!renaming && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRenaming({ from: page.title, title: page.title })}
            >
              Rename
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(() =>
                post(`/api/pages/${page.id}/${page.archivedAt ? 'unarchive' : 'archive'}`),
              )
            }
          >
            {page.archivedAt ? 'Unarchive' : 'Archive'}
          </Button>
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  if (await act(() => api(`/api/pages/${page.id}`, { method: 'DELETE' }))) onGone();
                }}
              >
                Delete this page and its versions
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </div>
      </header>
      {error && <Notice>{error}</Notice>}
      {history && <History page={page} viewing={viewing?.revision ?? null} onView={setViewing} />}
      {viewing && (
        <Notice kind="info">
          You&apos;re looking at version {viewing.revision} from{' '}
          {formatDateTime(viewing.createdAt, format)}.{' '}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              if (
                await act(() =>
                  post(`/api/pages/${page.id}/versions/${viewing.revision}/restore`, {
                    revision: page.revision,
                  }),
                )
              )
                setViewing(null);
            }}
          >
            Make it the current version
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>
            Back to the current version
          </Button>
        </Notice>
      )}
      <div className="pages-frame">
        {shown ? (
          <Frame key={shown.id} file={shown} title={page.title} />
        ) : (
          <Notice>This page&apos;s file is unavailable.</Notice>
        )}
      </div>
    </section>
  );
}

export function Pages() {
  const format = useDateFormat();
  const list = usePageData<PageView[]>(listPath);
  const [selected, setSelected] = useState(() =>
    new URLSearchParams(window.location.search).get('page'),
  );
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    const sync = () => setSelected(new URLSearchParams(window.location.search).get('page'));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(
    () =>
      subscribeAppEvents(undefined, {
        open: refreshList,
        error() {},
        message: (event) => {
          if (JSON.parse(event.data).type === 'pages') refreshList();
        },
      }),
    [],
  );
  const pages = list.data ?? [];
  const current = pages.filter((page) => !page.archivedAt);
  const archived = pages.filter((page) => page.archivedAt);
  const page = pages.find((entry) => entry.id === selected) ?? current[0] ?? null;
  const choose = (id: string | null) => {
    setSelected(id);
    replaceNavigation(id ? `/pages?page=${id}` : '/pages');
  };
  const item = (entry: PageView) => (
    <li key={entry.id}>
      <button
        type="button"
        className="pages-item"
        aria-current={entry.id === page?.id ? 'page' : undefined}
        onClick={() => choose(entry.id)}
      >
        <span className="pages-item-title">{entry.title}</span>
        <span className="pages-item-meta">
          Updated <time dateTime={entry.updatedAt}>{formatDateTime(entry.updatedAt, format)}</time>{' '}
          by {publisher(entry.source)}
        </span>
      </button>
    </li>
  );
  return (
    <div className="content-page secondary-page pages-page" data-analytics-private>
      <header className="page-heading secondary-heading">
        <PageTitle path="/pages" />
      </header>
      {list.error && !list.data ? (
        <Notice>Could not load your pages. {list.error}</Notice>
      ) : !list.data ? (
        <Loading label="Loading pages…" />
      ) : !pages.length ? (
        <p className="pages-empty">
          Ask Nod in chat for a page, such as “make a page that tracks my reading list and update it
          every morning”.
        </p>
      ) : (
        <div className="pages-layout">
          <nav className="pages-list" aria-label="Pages">
            <ul role="list">{current.map(item)}</ul>
            {archived.length > 0 && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived(!showArchived)}
                >
                  Archived ({archived.length})
                </Button>
                {showArchived && <ul role="list">{archived.map(item)}</ul>}
              </>
            )}
          </nav>
          {page ? (
            <Viewer key={page.id} page={page} onGone={() => choose(null)} />
          ) : (
            <p className="pages-empty">All your pages are archived.</p>
          )}
        </div>
      )}
    </div>
  );
}
