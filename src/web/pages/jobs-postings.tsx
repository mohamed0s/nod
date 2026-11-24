import { useEffect, useId, useState } from 'react';
import type {
  JobPosting,
  JobPostingStatus,
  JobPostingsView,
  JobSourceKind,
  JobSourcesView,
  JobSwitch,
} from '../../shared/job-postings';
import { Tabs } from '../components/tabs';
import { Button, Field, Input, Loading, Notice, Switch } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage, post } from '../lib/api';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { pageDataCache } from '../lib/page-data-cache';

type StatusFilter = JobPostingStatus | 'all';

const sourcesPath = '/api/jobs/sources';
let postingsPath = '';

export function refreshPostings() {
  void pageDataCache.refresh(sourcesPath, true);
  if (postingsPath) void pageDataCache.refresh(postingsPath, true);
}

const statusLabels: Record<StatusFilter, string> = {
  new: 'New',
  shortlisted: 'Shortlisted',
  skipped: 'Skipped',
  all: 'All',
};
const sourceLabels: Record<JobSourceKind, string> = {
  'career-ops': 'Scans',
  telegram: 'Telegram',
  email: 'Alert emails',
  web: 'Web',
};
const switchLabels: Record<JobSwitch, { label: string; hint: string }> = {
  scan: {
    label: 'Company career sites and job boards',
    hint: 'career-ops reads the companies you follow and the boards below through their public APIs.',
  },
  'scan:full': {
    label: 'Weekly sweep of Greenhouse, Lever and Ashby',
    hint: 'Reads every company those services list publicly, once a week. It takes a while.',
  },
  email: {
    label: 'Job-alert emails',
    hint: 'Nod reads recent job alerts in your Gmail when it is connected. It never opens their links to import them.',
  },
};

const send = <T,>(path: string, method: string, body?: unknown) =>
  api<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const safeLink = (url: string) => /^https?:\/\//i.test(url);

function sourceText(source: JobPosting['sources'][number]) {
  if (source.kind === 'telegram') return `Telegram @${source.detail}`;
  return source.detail
    ? `${sourceLabels[source.kind]} · ${source.detail}`
    : sourceLabels[source.kind];
}

export function PostingCard({ posting, onChanged }: { posting: JobPosting; onChanged(): void }) {
  const format = useDateFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const move = async (status: JobPostingStatus) => {
    setBusy(true);
    setError('');
    try {
      await send(`/api/jobs/postings/${posting.id}`, 'PATCH', {
        status,
        revision: posting.revision,
      });
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const place = [posting.company, posting.location].filter(Boolean).join(' · ');
  const programme = [posting.programme, posting.track].filter(Boolean).join(' · ');
  const note = posting.summary || posting.excerpt;
  return (
    <article className="saved-plan jobs-posting">
      <div className="saved-plan-title">
        <h2 dir="auto">
          {safeLink(posting.url) ? (
            <a href={posting.url} target="_blank" rel="noopener noreferrer">
              {posting.title}
            </a>
          ) : (
            posting.title
          )}
        </h2>
        {posting.score !== null && (
          <span
            className="jobs-badge jobs-badge-main"
            title={posting.scoreKind === 'full' ? 'Full score' : 'Short check'}
          >
            {posting.score.toFixed(1)}
            {posting.scoreKind === 'full' ? ' · full' : ''}
          </span>
        )}
        {posting.status !== 'new' && (
          <span className="jobs-badge">{statusLabels[posting.status]}</span>
        )}
      </div>
      {place && (
        <p className="jobs-posting-place" dir="auto">
          {place}
        </p>
      )}
      {programme && (
        <p className="jobs-meta" dir="auto">
          {programme}
        </p>
      )}
      {note && (
        <p className={posting.summary ? 'jobs-posting-note' : 'jobs-posting-note muted'} dir="auto">
          {note}
        </p>
      )}
      <p className="jobs-meta">
        {posting.sources.map(sourceText).join(', ')}
        {' · Found '}
        <time dateTime={posting.firstSeenAt}>{formatDateTime(posting.firstSeenAt, format)}</time>
        {posting.postedAt && (
          <>
            {' · Posted '}
            <time dateTime={posting.postedAt}>{formatDateTime(posting.postedAt, format)}</time>
          </>
        )}
      </p>
      <div className="jobs-actions">
        {posting.status !== 'shortlisted' && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void move('shortlisted')}
          >
            Shortlist
          </Button>
        )}
        {posting.status !== 'skipped' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void move('skipped')}>
            Skip
          </Button>
        )}
        {posting.status !== 'new' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void move('new')}>
            Back to new
          </Button>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
    </article>
  );
}

export function Postings() {
  const tabsId = useId();
  const [status, setStatus] = useState<StatusFilter>('new');
  const [minScore, setMinScore] = useState('');
  const [source, setSource] = useState<JobSourceKind | ''>('');
  const [limit, setLimit] = useState(100);
  const query = new URLSearchParams({ status, limit: String(limit) });
  if (minScore) query.set('minScore', minScore);
  if (source) query.set('source', source);
  const path = `/api/jobs/postings?${query}`;
  useEffect(() => {
    postingsPath = path;
    return () => {
      postingsPath = '';
    };
  }, [path]);
  const data = usePageData<JobPostingsView>(path);
  const counts = data.data?.counts;
  const total = counts ? Object.values(counts).reduce((sum, count) => sum + count, 0) : undefined;
  return (
    <div className="jobs-panel">
      <div className="jobs-filters">
        <Tabs
          id={tabsId}
          panelId={`${tabsId}-list`}
          label="Posting status"
          size="compact"
          variant="underline"
          value={status}
          items={(['new', 'shortlisted', 'skipped', 'all'] as const).map((value) => ({
            value,
            label: statusLabels[value],
            count: value === 'all' ? total : counts?.[value],
          }))}
          onValueChange={(value) => {
            setStatus(value);
            setLimit(100);
          }}
        />
        <div className="jobs-numbers">
          <Field label="Score">
            <select
              className="input"
              value={minScore}
              onChange={(event) => setMinScore(event.target.value)}
            >
              <option value="">Any score</option>
              <option value="3">3 or more</option>
              <option value="4">4 or more</option>
            </select>
          </Field>
          <Field label="Source">
            <select
              className="input"
              value={source}
              onChange={(event) => setSource(event.target.value as JobSourceKind | '')}
            >
              <option value="">Every source</option>
              {(Object.keys(sourceLabels) as JobSourceKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {sourceLabels[kind]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <div id={`${tabsId}-list`} role="tabpanel" aria-labelledby={`${tabsId}-${status}`}>
        {data.error ? (
          <Notice>Could not load postings. {data.error}</Notice>
        ) : !data.data ? (
          <Loading label="Loading postings…" />
        ) : data.data.postings.length ? (
          <div className="saved-plan-list">
            {data.data.postings.map((posting) => (
              <PostingCard key={posting.id} posting={posting} onChanged={refreshPostings} />
            ))}
            {data.data.postings.length < data.data.total && limit < 500 && !minScore && !source && (
              <Button size="sm" variant="ghost" onClick={() => setLimit(limit + 100)}>
                Show more
              </Button>
            )}
          </div>
        ) : (
          <p className="muted">
            {status === 'new'
              ? 'No new postings. The Job radar adds them each morning, or ask Nod to look for jobs.'
              : 'No postings here.'}
          </p>
        )}
      </div>
    </div>
  );
}

export function Sources() {
  const format = useDateFormat();
  const data = usePageData<JobSourcesView>(sourcesPath);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState('');
  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await run();
      await pageDataCache.refresh(sourcesPath, true);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      void pageDataCache.refresh(sourcesPath, true);
      return false;
    } finally {
      setBusy('');
    }
  };
  if (data.error) return <Notice>Could not load your job sources. {data.error}</Notice>;
  if (!data.data) return <Loading label="Loading sources…" />;
  const view = data.data;
  return (
    <div className="jobs-panel">
      <p className="muted">
        Nod reads the sources that are on during each Job radar run, or when you ask it to look for
        jobs.
      </p>
      {error && <Notice>{error}</Notice>}
      <section className="saved-plan jobs-sources" aria-labelledby="jobs-channels-title">
        <h2 id="jobs-channels-title">Telegram channels</h2>
        <p className="jobs-meta">
          Public channels only. Nod reads their web preview at t.me/s, without signing in. Add one
          by its name, @name or t.me link.
        </p>
        {view.channels.length ? (
          <ul className="jobs-source-list" role="list">
            {view.channels.map((channel) => (
              <li key={channel.name}>
                <div className="jobs-source-name">
                  <a
                    href={`https://t.me/s/${channel.name}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    @{channel.name}
                  </a>
                  <span className="jobs-meta">
                    {channel.lastError
                      ? `Last read failed: ${channel.lastError}`
                      : channel.lastReadAt
                        ? `Read ${formatDateTime(channel.lastReadAt, format)}`
                        : 'Not read yet'}
                  </span>
                </div>
                <div className="jobs-actions">
                  <Switch
                    checked={channel.enabled}
                    aria-label={`Read @${channel.name}`}
                    disabled={Boolean(busy)}
                    onCheckedChange={(enabled) =>
                      void act(channel.name, () =>
                        send(`/api/jobs/sources/telegram/${channel.name}`, 'PATCH', {
                          enabled,
                          revision: channel.revision,
                        }),
                      )
                    }
                  />
                  {removing === channel.name ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void act(channel.name, () =>
                            send(`/api/jobs/sources/telegram/${channel.name}`, 'DELETE'),
                          )
                        }
                      >
                        Remove
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving('')}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(channel.name)}>
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No channels yet. Nod suggests some when it sets up your search.</p>
        )}
        <form
          className="jobs-add-channel"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await act('add', () => post(`${sourcesPath}/telegram`, { name }))) setName('');
          }}
        >
          <Field label="Add a channel">
            <Input
              value={name}
              maxLength={200}
              placeholder="@example_jobs"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Button type="submit" size="sm" disabled={!name.trim() || Boolean(busy)}>
            {busy === 'add' ? 'Adding…' : 'Add'}
          </Button>
        </form>
      </section>
      <section className="saved-plan jobs-sources" aria-labelledby="jobs-scanners-title">
        <h2 id="jobs-scanners-title">Scanners</h2>
        <ul className="jobs-source-list" role="list">
          {view.switches.map((entry) => (
            <li key={entry.key}>
              <div className="jobs-source-name">
                <span>{switchLabels[entry.key].label}</span>
                <span className="jobs-meta">
                  {switchLabels[entry.key].hint}
                  {entry.key === 'scan' &&
                    (view.boards.length || view.companies
                      ? ` Boards: ${view.boards.join(', ') || 'none'}. Companies you follow: ${view.companies}.`
                      : ' It starts once your profile has target roles.')}
                </span>
              </div>
              <Switch
                checked={entry.enabled}
                aria-label={switchLabels[entry.key].label}
                disabled={Boolean(busy)}
                onCheckedChange={(enabled) =>
                  void act(entry.key, () =>
                    send(`${sourcesPath}/switches/${encodeURIComponent(entry.key)}`, 'PUT', {
                      enabled,
                      revision: entry.revision,
                    }),
                  )
                }
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
