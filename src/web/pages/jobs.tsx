import { useEffect, useId, useRef, useState } from 'react';
import type { Artifact } from '../../shared/contracts';
import {
  defaultJobProfile,
  jobPlaceholders,
  type JobCv,
  type JobProfile,
  type JobProfileView,
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

function CvCard({ cv, refresh }: { cv: JobCv; refresh(): void }) {
  const format = useDateFormat();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(cv.label);
  const [markdown, setMarkdown] = useState(cv.markdown);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      refresh();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="saved-plan jobs-cv">
      <div className="saved-plan-title">
        <h2>{cv.label}</h2>
        {cv.isMain && <span className="jobs-badge jobs-badge-main">Main</span>}
        <span className="jobs-badge">{cv.status === 'ready' ? 'Ready' : 'Converting'}</span>
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
            if (await act(() => send(`/api/jobs/cvs/${cv.id}`, 'PATCH', { label, markdown })))
              setEditing(false);
          }}
        >
          <Field label="Name">
            <Input
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field label="CV text" hint="Markdown. Nod uses this text for scoring and messages.">
            <textarea
              className="input jobs-markdown"
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          </Field>
          <div className="jobs-actions">
            <Button type="submit" size="sm" disabled={busy || !label.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setLabel(cv.label);
                setMarkdown(cv.markdown);
                setEditing(false);
              }}
            >
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setLabel(cv.label);
              setMarkdown(cv.markdown);
              setEditing(true);
            }}
          >
            Edit
          </Button>
          {cv.status === 'converting' && (
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
                onClick={() => void act(() => send(`/api/jobs/cvs/${cv.id}`, 'DELETE'))}
              >
                Archive this CV
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Archive
            </Button>
          )}
        </div>
      )}
      {error && <Notice>{error}</Notice>}
    </article>
  );
}

function Cvs() {
  const cvs = usePageData<JobCv[]>('/api/jobs/cvs');
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
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
            <CvCard key={`${cv.id}:${cv.revision}:${cv.isMain}`} cv={cv} refresh={refreshAll} />
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

function Profile() {
  const data = usePageData<JobProfileView>('/api/jobs/profile');
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (data.data && !form) setForm(toForm(data.data.profile));
  }, [data.data, form]);
  if (data.error) return <Notice>Could not load your profile. {data.error}</Notice>;
  if (!form || !data.data) return <Loading label="Loading profile…" />;
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
          onChange={(event) => setForm({ ...form, [key]: event.target.value })}
        />
      ) : (
        <Input
          type={options.type}
          value={form[key]}
          onChange={(event) => setForm({ ...form, [key]: event.target.value })}
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
          });
          setForm(toForm(saved.profile));
          setMessage({ kind: 'success', text: 'Profile saved.' });
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
        hint: 'One per line, such as XX = ar-XX, with the company’s two-letter country code.',
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
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setForm(toForm(data.data?.profile ?? defaultJobProfile))}
        >
          Undo changes
        </Button>
      </div>
    </form>
  );
}

function Templates() {
  const data = usePageData<JobTemplatesView>('/api/jobs/templates');
  const [list, setList] = useState<JobTemplate[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (data.data && !list)
      setList(
        data.data.templates.map(({ language, body, greetings }) => ({ language, body, greetings })),
      );
  }, [data.data, list]);
  if (data.error) return <Notice>Could not load your templates. {data.error}</Notice>;
  if (!list || !data.data) return <Loading label="Loading templates…" />;
  const change = (index: number, value: Partial<JobTemplate>) =>
    setList(list.map((entry, position) => (position === index ? { ...entry, ...value } : entry)));
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
          });
          setList(
            saved.templates.map(({ language, body, greetings }) => ({ language, body, greetings })),
          );
          setMessage({ kind: 'success', text: 'Templates saved.' });
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
              onClick={() => setList(list.filter((_, position) => position !== index))}
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
          onClick={() => setList([...list, { language: '', body: '', greetings: { default: '' } }])}
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
