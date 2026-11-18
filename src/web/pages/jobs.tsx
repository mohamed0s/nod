import { useEffect, useId, useRef, useState } from 'react';
import type { Artifact } from '../../shared/contracts';
import {
  jobPlaceholders,
  type JobCv,
  type JobProfile,
  type JobProfileView,
  type JobRevision,
  type JobSetup,
  type JobTemplate,
  type JobTemplatesView,
} from '../../shared/jobs';
import { CircleCheck, Circle } from '../components/icons';
import { PageTitle } from '../components/page-title';
import { Tabs } from '../components/tabs';
import { Button, Field, Input, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage, post } from '../lib/api';
import { subscribeAppEvents } from '../lib/app-events';
import { pageDataCache } from '../lib/page-data-cache';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import './jobs.css';

type View = 'cvs' | 'profile' | 'templates';
type Message = { kind: 'info' | 'success' | 'error'; text: string } | null;

const checklist: Record<JobSetup['items'][number]['key'], string> = {
  cv: 'Add your CV. Nod converts it and drafts your profile.',
  profile: 'Profile drafted from your main CV',
  templates: 'Message templates saved',
};

const send = <T,>(path: string, method: string, body?: unknown) =>
  api<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const jobPaths = ['/api/jobs/setup', '/api/jobs/cvs', '/api/jobs/profile', '/api/jobs/templates'];
const refreshAll = () => {
  for (const path of jobPaths) void pageDataCache.refresh(path, true);
};

const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function Checklist({ setup }: { setup: JobSetup }) {
  if (setup.items.every((item) => item.done)) return null;
  return (
    <section className="jobs-checklist" aria-labelledby="jobs-checklist-title">
      <h2 id="jobs-checklist-title">Get started</h2>
      <ul>
        {setup.items.map((item) => (
          <li key={item.key} data-done={item.done}>
            {item.done ? (
              <CircleCheck size={16} aria-label="Done" />
            ) : (
              <Circle size={16} aria-label="To do" />
            )}
            {checklist[item.key]}
          </li>
        ))}
      </ul>
    </section>
  );
}

function History<T>({
  path,
  describe,
  onRestore,
}: {
  path: string;
  describe(entry: JobRevision<T>): string;
  onRestore(entry: JobRevision<T>): Promise<void>;
}) {
  const format = useDateFormat();
  const [entries, setEntries] = useState<JobRevision<T>[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let active = true;
    api<JobRevision<T>[]>(path).then(
      (value) => active && setEntries(value),
      (cause) => active && setError(errorMessage(cause)),
    );
    return () => {
      active = false;
    };
  }, [path]);
  if (error) return <Notice>Could not load earlier versions. {error}</Notice>;
  if (!entries) return <Loading label="Loading earlier versions…" />;
  if (!entries.length) return <p className="muted">No earlier versions yet.</p>;
  return (
    <ol className="jobs-history" role="list">
      {entries.map((entry, index) => (
        <li key={entry.id}>
          <span>
            Version {entry.revision} · {entry.actor === 'owner' ? 'you' : 'Nod'} ·{' '}
            <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt, format)}</time> ·{' '}
            {describe(entry)}
          </span>
          {index > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={async () => {
                setBusy(entry.id);
                setError('');
                try {
                  await onRestore(entry);
                } catch (cause) {
                  setError(errorMessage(cause));
                } finally {
                  setBusy('');
                }
              }}
            >
              {busy === entry.id ? 'Restoring…' : 'Restore'}
            </Button>
          )}
        </li>
      ))}
    </ol>
  );
}

function CvCard({ cv }: { cv: JobCv }) {
  const format = useDateFormat();
  const [editing, setEditing] = useState<{ base: number; label: string; markdown: string } | null>(
    null,
  );
  const [history, setHistory] = useState(false);
  const [confirming, setConfirming] = useState<'archive' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      refreshAll();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const start = () => setEditing({ base: cv.revision, label: cv.label, markdown: cv.markdown });
  return (
    <article className="saved-plan jobs-cv">
      <div className="saved-plan-title">
        <h2>{cv.label}</h2>
        {cv.isMain && <span className="jobs-badge jobs-badge-main">Main</span>}
        <span className="jobs-badge">
          {cv.converting ? 'Converting' : cv.status === 'ready' ? 'Ready' : 'Not converted'}
        </span>
      </div>
      <p className="jobs-meta">
        {cv.file ? (
          <a href={cv.file.url} target="_blank" rel="noreferrer">
            {cv.file.name}
          </a>
        ) : (
          'File unavailable'
        )}
        {cv.pdf && cv.pdf.id !== cv.file?.id && (
          <>
            {' · '}
            <a href={cv.pdf.url} target="_blank" rel="noreferrer">
              PDF
            </a>
          </>
        )}
        {' · Updated '}
        <time dateTime={cv.updatedAt}>{formatDateTime(cv.updatedAt, format)}</time>
      </p>
      {editing ? (
        <form
          className="form-stack"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await act(() =>
                send(`/api/jobs/cvs/${cv.id}`, 'PATCH', {
                  label: editing.label,
                  markdown: editing.markdown,
                  revision: editing.base,
                }),
              )
            )
              setEditing(null);
          }}
        >
          {cv.revision !== editing.base && (
            <Notice kind="info">
              A newer version of this CV&apos;s text was saved while you were editing.{' '}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing({ ...editing, base: cv.revision, markdown: cv.markdown })}
              >
                Load the newer version
              </Button>
            </Notice>
          )}
          <Field label="Name">
            <Input
              value={editing.label}
              maxLength={80}
              onChange={(event) => setEditing({ ...editing, label: event.target.value })}
            />
          </Field>
          <Field label="CV text" hint="Markdown. Nod uses this text for scoring and messages.">
            <textarea
              className="input jobs-markdown"
              value={editing.markdown}
              onChange={(event) => setEditing({ ...editing, markdown: event.target.value })}
            />
          </Field>
          <div className="jobs-actions">
            <Button type="submit" size="sm" disabled={busy || !editing.label.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="jobs-actions">
          {!cv.isMain && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void act(() => post(`/api/jobs/cvs/${cv.id}/main`))}
            >
              Mark as main
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={start}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={history}
            onClick={() => setHistory(!history)}
          >
            History
          </Button>
          {cv.status === 'converting' && !cv.converting && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void act(() => post(`/api/jobs/cvs/${cv.id}/convert`))}
            >
              Convert again
            </Button>
          )}
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    confirming === 'archive'
                      ? post(`/api/jobs/cvs/${cv.id}/archive`)
                      : send(`/api/jobs/cvs/${cv.id}`, 'DELETE'),
                  )
                }
              >
                {confirming === 'archive' ? 'Archive this CV' : 'Delete this CV and its files'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirming('archive')}>
                Archive
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming('delete')}>
                Delete
              </Button>
            </>
          )}
        </div>
      )}
      {history && !editing && (
        <History<{ markdown: string }>
          key={cv.revision}
          path={`/api/jobs/cvs/${cv.id}/revisions`}
          describe={(entry) => `${entry.data.markdown.length} characters`}
          onRestore={async (entry) => {
            await post(`/api/jobs/cvs/${cv.id}/revisions/${entry.id}/restore`);
            refreshAll();
          }}
        />
      )}
      {error && <Notice>{error}</Notice>}
    </article>
  );
}

function Cvs() {
  const cvs = usePageData<JobCv[]>('/api/jobs/cvs');
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const upload = async (file: File) => {
    setUploading(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const artifact = await api<Artifact>('/api/uploads', { method: 'POST', body });
      const result = await post<{ cv: JobCv; conversion: string }>('/api/jobs/cvs', {
        uploadId: artifact.id,
        label: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'CV',
      });
      setMessage(
        result.conversion === 'started'
          ? {
              kind: 'info',
              text: `Nod is converting ${result.cv.label} in a new chat and will draft your profile from it.`,
            }
          : {
              kind: 'error',
              text: `The CV is saved, but its conversion didn't start: ${result.conversion}`,
            },
      );
      refreshAll();
    } catch (cause) {
      setMessage({ kind: 'error', text: errorMessage(cause) });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="jobs-panel">
      <div className="jobs-toolbar">
        <p>PDF or Word. The main CV is the one Nod sends and scores against.</p>
        <input
          ref={input}
          type="file"
          hidden
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button size="sm" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? 'Uploading…' : 'Add a CV'}
        </Button>
      </div>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {cvs.error ? (
        <Notice>Could not load your CVs. {cvs.error}</Notice>
      ) : !cvs.data ? (
        <Loading label="Loading CVs…" />
      ) : cvs.data.length ? (
        <div className="saved-plan-list">
          {cvs.data.map((cv) => (
            <CvCard key={cv.id} cv={cv} />
          ))}
        </div>
      ) : (
        <p className="muted">No CVs yet.</p>
      )}
    </div>
  );
}

type ProfileForm = Record<
  | 'name'
  | 'intro'
  | 'location'
  | 'targetRoles'
  | 'regions'
  | 'languages'
  | 'languageDefault'
  | 'byCountry'
  | 'programmes'
  | 'workAuthorization'
  | 'links'
  | 'daily'
  | 'weekly'
  | 'noAcceptDays'
  | 'noReplyDays',
  string
>;

function toForm(profile: JobProfile): ProfileForm {
  return {
    name: profile.name,
    intro: profile.intro,
    location: profile.location,
    targetRoles: profile.targetRoles.join('\n'),
    regions: profile.regions.join('\n'),
    languages: profile.languages.join('\n'),
    languageDefault: profile.languageRule.default,
    byCountry: Object.entries(profile.languageRule.byCountry)
      .map(([country, language]) => `${country} = ${language}`)
      .join('\n'),
    programmes: profile.programmes
      .map((entry) =>
        entry.tracks.length ? `${entry.name}: ${entry.tracks.join(', ')}` : entry.name,
      )
      .join('\n'),
    workAuthorization: profile.workAuthorization,
    links: profile.links.map((entry) => `${entry.label}: ${entry.url}`).join('\n'),
    daily: String(profile.inviteLimits.daily),
    weekly: String(profile.inviteLimits.weekly),
    noAcceptDays: String(profile.noLuck.noAcceptDays),
    noReplyDays: String(profile.noLuck.noReplyDays),
  };
}

function fromForm(form: ProfileForm): JobProfile {
  const split = (line: string, separator: RegExp) => {
    const match = separator.exec(line);
    return match
      ? [line.slice(0, match.index).trim(), line.slice(match.index + match[0].length).trim()]
      : [line, ''];
  };
  return {
    name: form.name.trim(),
    intro: form.intro.trim(),
    location: form.location.trim(),
    targetRoles: lines(form.targetRoles),
    regions: lines(form.regions),
    languages: lines(form.languages),
    languageRule: {
      default: form.languageDefault.trim() || 'en',
      byCountry: Object.fromEntries(
        lines(form.byCountry).map((line) => {
          const [country, language] = split(line, /\s*[=:]\s*/);
          return [country!.toUpperCase(), language!];
        }),
      ),
    },
    programmes: lines(form.programmes).map((line) => {
      const [name, tracks] = split(line, /:\s*/);
      return {
        name: name!,
        tracks: tracks
          ? tracks
              .split(',')
              .map((track) => track.trim())
              .filter(Boolean)
          : [],
      };
    }),
    workAuthorization: form.workAuthorization.trim(),
    links: lines(form.links).map((line) => {
      const [label, url] = split(line, /:\s+/);
      return { label: label!, url: url! };
    }),
    inviteLimits: { daily: Number(form.daily), weekly: Number(form.weekly) },
    noLuck: { noAcceptDays: Number(form.noAcceptDays), noReplyDays: Number(form.noReplyDays) },
  };
}

function useDraft<T, D>(data: T | null, revision: (value: T) => number, draft: (value: T) => D) {
  const [state, setState] = useState<{ base: number; value: D; dirty: boolean } | null>(null);
  useEffect(() => {
    if (data && (!state || (!state.dirty && revision(data) !== state.base)))
      setState({ base: revision(data), value: draft(data), dirty: false });
  }, [data, state, revision, draft]);
  return {
    state,
    stale: Boolean(data && state && revision(data) !== state.base),
    edit: (value: D) => state && setState({ ...state, value, dirty: true }),
    reset: () => data && setState({ base: revision(data), value: draft(data), dirty: false }),
    replace: (value: T) => setState({ base: revision(value), value: draft(value), dirty: false }),
  };
}

const profileRevision = (view: JobProfileView) => view.revision;
const profileDraft = (view: JobProfileView) => toForm(view.profile);

function Profile() {
  const data = usePageData<JobProfileView>('/api/jobs/profile');
  const { state, stale, edit, reset, replace } = useDraft(data.data, profileRevision, profileDraft);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  if (data.error) return <Notice>Could not load your profile. {data.error}</Notice>;
  if (!state || !data.data) return <Loading label="Loading profile…" />;
  const form = state.value;
  const field = (
    key: keyof ProfileForm,
    label: string,
    options: { hint?: string; area?: boolean; type?: string } = {},
  ) => (
    <Field label={label} hint={options.hint}>
      {options.area ? (
        <textarea
          className="input jobs-list-input"
          value={form[key]}
          onChange={(event) => edit({ ...form, [key]: event.target.value })}
        />
      ) : (
        <Input
          type={options.type}
          value={form[key]}
          onChange={(event) => edit({ ...form, [key]: event.target.value })}
        />
      )}
    </Field>
  );
  return (
    <form
      className="jobs-panel form-stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setMessage(null);
        try {
          const saved = await send<JobProfileView>('/api/jobs/profile', 'PUT', {
            profile: fromForm(form),
            revision: state.base,
          });
          setMessage({ kind: 'success', text: 'Profile saved.' });
          await pageDataCache.refresh('/api/jobs/profile', true);
          replace(saved);
          refreshAll();
        } catch (cause) {
          setMessage({ kind: 'error', text: errorMessage(cause) });
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="muted">
        Nod drafts this from your main CV. Change anything here; nothing on this tab is required.
      </p>
      {stale && (
        <Notice kind="info">
          The profile changed since you opened it.{' '}
          <Button type="button" size="sm" variant="ghost" onClick={reset}>
            Load the newer version
          </Button>
        </Notice>
      )}
      {field('name', 'Name in messages')}
      {field('intro', 'Introduction', {
        hint: 'One line, as you’d introduce yourself.',
        area: true,
      })}
      {field('location', 'Location')}
      {field('targetRoles', 'Target roles', { hint: 'One per line.', area: true })}
      {field('regions', 'Regions', { hint: 'One per line.', area: true })}
      {field('languages', 'Languages you speak', { hint: 'One per line.', area: true })}
      {field('languageDefault', 'Message language', { hint: 'A language tag, such as en.' })}
      {field('byCountry', 'Language by country', {
        hint: 'One per line, such as XX = fr-XX, with the company’s two-letter country code.',
        area: true,
      })}
      {field('programmes', 'Programmes and tracks', {
        hint: 'One per line: programme: track, track.',
        area: true,
      })}
      {field('workAuthorization', 'Work authorization')}
      {field('links', 'Links', { hint: 'One per line: label: https://…', area: true })}
      <div className="jobs-numbers">
        {field('daily', 'Invites a day', { type: 'number' })}
        {field('weekly', 'Invites a week', { type: 'number' })}
        {field('noAcceptDays', 'No luck after days without an accept', { type: 'number' })}
        {field('noReplyDays', 'No luck after days without a reply', { type: 'number' })}
      </div>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="jobs-actions">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          Undo changes
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={history}
          onClick={() => setHistory(!history)}
        >
          History
        </Button>
      </div>
      {history && (
        <History<{ profile: JobProfile }>
          key={data.data.revision}
          path="/api/jobs/profile/revisions"
          describe={(entry) => entry.data.profile.name || 'no name'}
          onRestore={async (entry) => {
            const restored = await post<JobProfileView>(
              `/api/jobs/profile/revisions/${entry.id}/restore`,
            );
            await pageDataCache.refresh('/api/jobs/profile', true);
            replace(restored);
            refreshAll();
          }}
        />
      )}
    </form>
  );
}

const templatesRevision = (view: JobTemplatesView) => view.revision;
const templatesDraft = (view: JobTemplatesView): JobTemplate[] =>
  view.templates.map(({ language, body, greetings }) => ({ language, body, greetings }));

function Templates() {
  const data = usePageData<JobTemplatesView>('/api/jobs/templates');
  const { state, stale, edit, reset, replace } = useDraft(
    data.data,
    templatesRevision,
    templatesDraft,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  if (data.error) return <Notice>Could not load your templates. {data.error}</Notice>;
  if (!state || !data.data) return <Loading label="Loading templates…" />;
  const list = state.value;
  const change = (index: number, value: Partial<JobTemplate>) =>
    edit(list.map((entry, position) => (position === index ? { ...entry, ...value } : entry)));
  return (
    <form
      className="jobs-panel form-stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setMessage(null);
        try {
          const saved = await send<JobTemplatesView>('/api/jobs/templates', 'PUT', {
            templates: list,
            revision: state.base,
          });
          setMessage({ kind: 'success', text: 'Templates saved.' });
          await pageDataCache.refresh('/api/jobs/templates', true);
          replace(saved);
          refreshAll();
        } catch (cause) {
          setMessage({ kind: 'error', text: errorMessage(cause) });
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="muted">
        Referral messages. Nod fills {jobPlaceholders.map((name) => `{${name}}`).join(' ')} for each
        person.
        {data.data.examples && ' These are examples until you save them.'}
      </p>
      {stale && (
        <Notice kind="info">
          The templates changed since you opened them.{' '}
          <Button type="button" size="sm" variant="ghost" onClick={reset}>
            Load the newer version
          </Button>
        </Notice>
      )}
      {list.map((entry, index) => (
        <fieldset key={index} className="saved-plan jobs-template">
          <div className="jobs-numbers">
            <Field label="Language">
              <Input
                value={entry.language}
                onChange={(event) => change(index, { language: event.target.value })}
              />
            </Field>
            <Field label="Greeting">
              <Input
                value={entry.greetings.default ?? ''}
                onChange={(event) =>
                  change(index, { greetings: { ...entry.greetings, default: event.target.value } })
                }
              />
            </Field>
          </div>
          <Field label="Message">
            <textarea
              className="input jobs-markdown"
              dir="auto"
              value={entry.body}
              onChange={(event) => change(index, { body: event.target.value })}
            />
          </Field>
          <div className="jobs-actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => edit(list.filter((_, position) => position !== index))}
            >
              Remove
            </Button>
          </div>
        </fieldset>
      ))}
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="jobs-actions">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save templates'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => edit([...list, { language: '', body: '', greetings: { default: '' } }])}
        >
          Add a language
        </Button>
      </div>
    </form>
  );
}

export function Jobs() {
  const tabsId = useId();
  const [view, setView] = useState<View>('cvs');
  const setup = usePageData<JobSetup>('/api/jobs/setup');
  const cvs = usePageData<JobCv[]>('/api/jobs/cvs');
  useEffect(
    () =>
      subscribeAppEvents(undefined, {
        open: refreshAll,
        error() {},
        message: (event) => {
          if (JSON.parse(event.data).type === 'jobs') refreshAll();
        },
      }),
    [],
  );
  return (
    <div className="content-page secondary-page jobs-page" data-analytics-private>
      <header className="page-heading secondary-heading">
        <PageTitle path="/jobs" />
      </header>
      {setup.data && <Checklist setup={setup.data} />}
      <Tabs
        id={tabsId}
        panelId={`${tabsId}-panel`}
        label="Job search views"
        value={view}
        items={[
          { value: 'cvs', label: 'CVs', count: cvs.data?.length },
          { value: 'profile', label: 'Profile' },
          { value: 'templates', label: 'Templates' },
        ]}
        onValueChange={setView}
      />
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${view}`}>
        {view === 'cvs' && <Cvs />}
        {view === 'profile' && <Profile />}
        {view === 'templates' && <Templates />}
      </div>
    </div>
  );
}
