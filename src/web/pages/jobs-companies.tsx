import { useEffect, useId, useState } from 'react';
import {
  jobCompanyFilters,
  jobPersonStatuses,
  type JobCompaniesView,
  type JobCompany,
  type JobCompanyFilter,
  type JobCompanyView,
  type JobNoLuckResult,
  type JobDraft,
  type JobPerson,
  type JobPersonStatus,
  type JobWaves,
} from '../../shared/job-companies';
import type { JobTemplatesView } from '../../shared/jobs';
import { ArrowLeft } from '../components/icons';
import { Tabs } from '../components/tabs';
import { Button, Checkbox, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { copyContent } from '../lib/clipboard';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { pageDataCache } from '../lib/page-data-cache';
import { languageName, textDirection } from './jobs-language';
import { PostingCard } from './jobs-postings';

type Message = { kind: 'info' | 'success' | 'error'; text: string } | null;
type Limits = JobCompaniesView['limits'];

let listPath = '';
let companyPath = '';

export function refreshCompanies() {
  if (listPath) void pageDataCache.refresh(listPath, true);
  if (companyPath) void pageDataCache.refresh(companyPath, true);
}

const filterLabels: Record<JobCompanyFilter, string> = {
  all: 'All',
  waiting: 'Waiting for an accept',
  to_ask: 'Accepted, not asked yet',
  asked: 'Asked, no reply',
  next_wave: 'Next wave',
  no_luck: 'No luck',
};
const emptyText: Record<JobCompanyFilter, string> = {
  all: 'No companies yet. They appear with the postings Nod finds and the people you tell Nod you invited.',
  waiting: 'Nobody you invited is waiting to accept.',
  to_ask: 'Nobody who accepted is waiting for your referral request.',
  asked: 'Nobody you asked is waiting to reply.',
  next_wave: 'No company is ready for its next wave of invites.',
  no_luck: 'No company counts as no luck.',
};
const statusLabels: Record<JobPersonStatus, string> = {
  invited: 'Invited',
  accepted: 'Accepted',
  asked: 'Asked',
  replied: 'Replied',
  referred: 'Referred',
  declined: 'Declined',
};

const draftStateLabels: Record<JobDraft['state'], string> = {
  filled: 'Template filled in',
  tailoring: 'Tailoring…',
  tailored: 'Tailored',
  failed: 'Not tailored',
  edited: 'Edited',
  missing: 'Needs details',
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function waveText(waves: JobWaves, format: ReturnType<typeof useDateFormat>) {
  const limit = waves.today >= waves.daily ? "today's" : "this week's";
  const invite = (wave: string) =>
    waves.more
      ? `${wave}: invite ${plural(waves.more, 'more person', 'more people')} today`
      : `${wave}: ${plural(waves.left, 'more person', 'more people')} to invite once ${limit} invite limit frees up`;
  if (waves.state === 'open') return invite(`Wave ${waves.wave}`);
  if (waves.state === 'next') return invite(`Wave ${waves.wave} can start`);
  if (waves.state === 'stopped') return 'Someone referred you here, so the waves stop.';
  if (waves.state === 'done') return `All ${waves.max} invited, and everyone had their chance.`;
  return `Wave ${waves.wave} is full. ${
    waves.until
      ? `The next one opens on ${formatDateTime(waves.until, format)} if nobody helps by then.`
      : waves.owed
        ? `It waits for you: ${plural(waves.owed, 'person', 'people')} accepted or replied.`
        : 'It waits for the people you invited.'
  }`;
}

function invitesText(invites: { today: number; week: number; daily: number; weekly: number }) {
  const counts = `Invites today: ${invites.today} of ${invites.daily}. This week: ${invites.week} of ${invites.weekly}.`;
  if (invites.today > invites.daily || invites.week > invites.weekly)
    return `${counts} That's past your ${invites.today > invites.daily ? 'daily' : 'weekly'} limit. Nod still logs every invite you send, but LinkedIn may restrict your account.`;
  return counts;
}

function peopleText(counts: JobCompany['counts']) {
  if (!counts.invited) return 'Nobody invited yet';
  return [
    `${counts.invited} invited`,
    `${counts.accepted} accepted`,
    `${counts.asked} asked`,
    `${counts.replied} replied`,
    ...(counts.referred ? [`${counts.referred} referred`] : []),
  ].join(' · ');
}

function postingsText(company: JobCompany) {
  return company.openPostings ? plural(company.openPostings, 'open posting') : 'No open postings';
}

function NoLuckBadge({ company }: { company: JobCompany }) {
  if (!company.noLuck.value) return null;
  return (
    <span className="jobs-badge jobs-badge-warning">
      {company.noLuck.by === 'owner' ? 'No luck' : 'No luck · automatic'}
    </span>
  );
}

function CompanyCard({ company, onOpen }: { company: JobCompany; onOpen(id: string): void }) {
  const format = useDateFormat();
  return (
    <article className="saved-plan jobs-company">
      <div className="saved-plan-title">
        <h2 dir="auto">
          <button type="button" className="jobs-link-button" onClick={() => onOpen(company.id)}>
            {company.name}
          </button>
        </h2>
        {company.bestScore !== null && (
          <span className="jobs-badge jobs-badge-main" title="Best score of its open postings">
            {company.bestScore.toFixed(1)}
          </span>
        )}
        <NoLuckBadge company={company} />
      </div>
      <p className="jobs-meta">
        {postingsText(company)} · {peopleText(company.counts)}
      </p>
      {!company.noLuck.value && <p className="jobs-meta">{waveText(company.waves, format)}</p>}
    </article>
  );
}

function CompanyList({
  filter,
  onFilter,
  onOpen,
}: {
  filter: JobCompanyFilter;
  onFilter(filter: JobCompanyFilter): void;
  onOpen(id: string): void;
}) {
  const tabsId = useId();
  const [limit, setLimit] = useState(100);
  const path = `/api/jobs/companies?${new URLSearchParams({ filter, limit: String(limit) })}`;
  useEffect(() => {
    listPath = path;
    return () => {
      listPath = '';
    };
  }, [path]);
  const data = usePageData<JobCompaniesView>(path);
  return (
    <div className="jobs-panel">
      <div className="jobs-filters">
        <Tabs
          id={tabsId}
          panelId={`${tabsId}-list`}
          label="Company filter"
          size="compact"
          variant="underline"
          value={filter}
          items={jobCompanyFilters.map((value) => ({
            value,
            label: filterLabels[value],
            count: data.data?.counts[value],
          }))}
          onValueChange={(value) => {
            onFilter(value);
            setLimit(100);
          }}
        />
      </div>
      <div id={`${tabsId}-list`} role="tabpanel" aria-labelledby={`${tabsId}-${filter}`}>
        {data.data && <p className="jobs-meta jobs-invites">{invitesText(data.data.invites)}</p>}
        {data.error ? (
          <Notice>Could not load companies. {data.error}</Notice>
        ) : !data.data ? (
          <Loading label="Loading companies…" />
        ) : data.data.companies.length ? (
          <div className="saved-plan-list">
            {data.data.companies.map((company) => (
              <CompanyCard key={company.id} company={company} onOpen={onOpen} />
            ))}
            {data.data.companies.length < data.data.total && limit < 500 && (
              <Button size="sm" variant="ghost" onClick={() => setLimit(limit + 100)}>
                Show more
              </Button>
            )}
          </div>
        ) : (
          <p className="muted">{emptyText[filter]}</p>
        )}
      </div>
    </div>
  );
}

function DraftBox({
  person,
  languages,
  onChanged,
}: {
  person: JobPerson;
  languages: string[];
  onChanged(): void;
}) {
  const draft = person.draftInfo;
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const languageId = useId();
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const remake = () =>
    run(async () => {
      const result = await api<{ person: JobPerson; missing: string[] }>(
        `/api/jobs/people/${person.id}/draft`,
        { method: 'POST', body: JSON.stringify({ draftRevision: person.draftRevision }) },
      );
      if (result.missing.length) setError(missingText(result.missing));
    });
  const switchLanguage = (language: string) =>
    run(async () => {
      await api(`/api/jobs/people/${person.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ language, revision: person.revision }),
      });
    });
  const save = (text: string) =>
    run(async () => {
      await api(`/api/jobs/people/${person.id}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ text, draftRevision: person.draftRevision }),
      });
      setEditing(null);
    });
  const choices = [...new Set([...languages, ...(person.language ? [person.language] : [])])];
  return (
    <div className="jobs-draft">
      <div className="jobs-draft-head">
        <h4>Prepared message</h4>
        {draft && <span className="jobs-badge">{draftStateLabels[draft.state]}</span>}
        {draft?.language && <span className="jobs-meta">{languageName(draft.language)}</span>}
      </div>
      {editing !== null ? (
        <>
          <textarea
            className="input jobs-message"
            dir={textDirection(draft?.language ?? '')}
            value={editing}
            aria-label="Message"
            onChange={(event) => setEditing(event.target.value)}
          />
          <p className="field-hint">
            {'{greeting}'} becomes the greeting for the time of day when Nod shows the message.
          </p>
          <div className="jobs-actions">
            <Button size="sm" disabled={busy || !editing.trim()} onClick={() => void save(editing)}>
              {busy ? 'Saving…' : 'Save message'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </>
      ) : draft?.text ? (
        <p className="jobs-draft-text" dir={textDirection(draft.language)}>
          {draft.text}
        </p>
      ) : (
        <p className="muted">
          {draft?.state === 'missing'
            ? missingText(draft.missing)
            : 'Nod puts the referral message here once it has prepared it.'}
        </p>
      )}
      {draft?.note && editing === null && (
        <p className="jobs-meta" dir="auto">
          What Nod changed and why: {draft.note}
        </p>
      )}
      {draft?.reason && editing === null && <p className="jobs-meta">{draft.reason}</p>}
      {editing === null && (
        <div className="jobs-actions">
          {draft?.text && (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                try {
                  await copyContent(draft.text);
                  setCopied(true);
                } catch (cause) {
                  setError(`Could not copy the message. ${errorMessage(cause)}`);
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
          {draft?.raw && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(draft.raw)}>
              Edit
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remake()}>
            {draft?.text ? 'Remake' : 'Make it'}
          </Button>
          {choices.length > 0 && (
            <label className="jobs-inline-field" htmlFor={languageId}>
              <span>Language</span>
              <select
                id={languageId}
                className="input"
                value={person.language}
                disabled={busy}
                onChange={(event) => void switchLanguage(event.target.value)}
              >
                <option value="">Automatic</option>
                {choices.map((tag) => (
                  <option key={tag} value={tag}>
                    {languageName(tag)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {draft?.state === 'edited' && editing === null && (
        <p className="field-hint">Remake or a language switch replaces your edits.</p>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

function missingText(missing: string[]) {
  return missing.includes('template')
    ? 'Save a message template on the Templates tab, then select Make it.'
    : `Nod needs ${missing.map((name) => `{${name}}`).join(', ')} to fill your template. Add it to your profile or the posting, or tell Nod in chat, then select Make it.`;
}

function PersonCard({
  person,
  languages,
  onChanged,
}: {
  person: JobPerson;
  languages: string[];
  onChanged(): void;
}) {
  const format = useDateFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const statusId = useId();
  const move = async (status: JobPersonStatus) => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/jobs/people/${person.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, revision: person.revision }),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <article className="saved-plan jobs-person">
      <div className="saved-plan-title">
        <h3 dir="auto">{person.name || person.profileKey}</h3>
        <span className="jobs-badge">{statusLabels[person.status]}</span>
      </div>
      {person.headline && (
        <p className="jobs-posting-place" dir="auto">
          {person.headline}
        </p>
      )}
      {person.statusAt && (
        <p className="jobs-meta">
          {statusLabels[person.status]}{' '}
          <time dateTime={person.statusAt}>{formatDateTime(person.statusAt, format)}</time>
        </p>
      )}
      <div className="jobs-actions jobs-person-actions">
        <Button size="sm" variant="secondary" asChild>
          <a href={person.profileUrl} target="_blank" rel="noopener noreferrer">
            Open profile
          </a>
        </Button>
        {person.messageUrl && (
          <Button size="sm" variant="secondary" asChild>
            <a href={person.messageUrl} target="_blank" rel="noopener noreferrer">
              Message
            </a>
          </Button>
        )}
        <label className="jobs-inline-field" htmlFor={statusId}>
          <span>Status</span>
          <select
            id={statusId}
            className="input"
            value={person.status}
            disabled={busy}
            onChange={(event) => void move(event.target.value as JobPersonStatus)}
          >
            {jobPersonStatuses.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(person.draftInfo || person.status === 'accepted') && (
        <DraftBox person={person} languages={languages} onChanged={onChanged} />
      )}
      {error && <Notice>{error}</Notice>}
    </article>
  );
}

function noLuckText(company: JobCompany, limits: Limits, format: ReturnType<typeof useDateFormat>) {
  const since = company.noLuck.since ? formatDateTime(company.noLuck.since, format) : '';
  const rule = `you invited ${plural(limits.waves.max, 'person', 'people')} there and none of them helped: nobody accepted within ${plural(limits.noAcceptDays, 'day')}, or replied within ${plural(limits.noReplyDays, 'day')} of being asked`;
  const marked = `You marked it no luck${since ? ` on ${since}` : ''}`;
  if (company.noLuck.choice === 'no_luck')
    return company.applyChat?.state === 'open'
      ? `${marked}. Nod opened one chat to apply on the company's own site, and asks you before anything is submitted.`
      : company.applyChat?.state === 'starting'
        ? `${marked}. Nod is opening its apply chat.`
        : `${marked}, but its apply chat isn't open.`;
  if (company.noLuck.choice === 'keep_trying')
    return "You're keeping this company open, so Nod doesn't count it as no luck.";
  if (company.noLuck.value)
    return `Nod counts it as no luck${since ? ` since ${since}` : ''}: ${rule}. Nod doesn't apply until you tick the box.`;
  return `Nod counts a company as no luck when ${rule}, unless someone referred you.`;
}

function CompanyDetail({ id, onBack }: { id: string; onBack(): void }) {
  const format = useDateFormat();
  const path = `/api/jobs/companies/${id}`;
  useEffect(() => {
    companyPath = path;
    return () => {
      companyPath = '';
    };
  }, [path]);
  const data = usePageData<JobCompanyView>(path);
  const templates = usePageData<JobTemplatesView>('/api/jobs/templates');
  const languages = templates.data?.examples
    ? []
    : (templates.data?.templates.map((entry) => entry.language) ?? []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const refresh = () => {
    void data.refresh();
    if (listPath) void pageDataCache.refresh(listPath, true);
  };
  const choose = async (noLuck: boolean | null) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<JobNoLuckResult>(`${path}/no-luck`, {
        method: 'PUT',
        body: JSON.stringify(
          noLuck === true ? { noLuck } : { noLuck, revision: data.data?.revision ?? 0 },
        ),
      });
      data.update(() => result.company);
      if (result.apply?.state === 'started')
        setMessage({ kind: 'info', text: 'Nod opened a chat to apply to this company.' });
      else if (result.apply?.state === 'failed')
        setMessage({
          kind: 'error',
          text: `The company is marked no luck, but its apply chat didn't start: ${result.apply.error}`,
        });
    } catch (cause) {
      setMessage({ kind: 'error', text: errorMessage(cause) });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const back = (
    <div>
      <Button size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        Companies
      </Button>
    </div>
  );
  if (data.error)
    return (
      <div className="jobs-panel">
        {back}
        <Notice>Could not load this company. {data.error}</Notice>
      </div>
    );
  if (!data.data)
    return (
      <div className="jobs-panel">
        {back}
        <Loading label="Loading company…" />
      </div>
    );
  const company = data.data;
  const ticked = company.noLuck.choice === 'no_luck';
  const chat = company.applyChat;
  return (
    <div className="jobs-panel">
      {back}
      <section className="saved-plan jobs-company-head" aria-labelledby={`${id}-title`}>
        <div className="saved-plan-title">
          <h2 id={`${id}-title`} dir="auto">
            {company.name}
          </h2>
          <NoLuckBadge company={company} />
        </div>
        <p className="jobs-meta">
          {postingsText(company)} · {peopleText(company.counts)}
          {company.careersUrl && /^https?:\/\//i.test(company.careersUrl) && (
            <>
              {' · '}
              <a href={company.careersUrl} target="_blank" rel="noopener noreferrer">
                Careers page
              </a>
            </>
          )}
          {company.linkedinUrl && (
            <>
              {' · '}
              <a href={company.linkedinUrl} target="_blank" rel="noopener noreferrer">
                LinkedIn page
              </a>
            </>
          )}
        </p>
        {!company.noLuck.value && <p className="jobs-meta">{waveText(company.waves, format)}</p>}
        <p className="jobs-meta">{invitesText(company.waves)}</p>
        <label className="jobs-tick">
          <Checkbox
            checked={ticked}
            disabled={busy}
            onChange={(event) => void choose(event.target.checked)}
          />
          <span>No luck, apply here</span>
        </label>
        <p className="jobs-meta">{noLuckText(company, company.limits, format)}</p>
        <div className="jobs-actions">
          {chat?.state === 'open' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('nod:open-chat', { detail: { taskId: chat.id } }),
                )
              }
            >
              Open the apply chat
            </Button>
          )}
          {ticked && (!chat || chat.state === 'lost') && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void choose(true)}>
              Start the apply chat
            </Button>
          )}
          {company.noLuck.choice === 'auto' && company.noLuck.value && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void choose(false)}>
              Keep trying
            </Button>
          )}
          {company.noLuck.choice !== 'auto' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void choose(null)}>
              Let Nod decide
            </Button>
          )}
        </div>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </section>
      <section className="jobs-company-section" aria-labelledby={`${id}-people`}>
        <h2 id={`${id}-people`}>People</h2>
        {company.people.length ? (
          <div className="saved-plan-list">
            {company.people.map((person) => (
              <PersonCard
                key={person.id}
                person={person}
                languages={languages}
                onChanged={refresh}
              />
            ))}
          </div>
        ) : (
          <p className="muted">
            Nobody here yet. When you invite someone at this company on LinkedIn, tell Nod in chat
            or Telegram, or share their profile with "Sent".
          </p>
        )}
      </section>
      <section className="jobs-company-section" aria-labelledby={`${id}-postings`}>
        <h2 id={`${id}-postings`}>Postings</h2>
        {company.postings.length ? (
          <div className="saved-plan-list">
            {company.postings.map((posting) => (
              <PostingCard key={posting.id} posting={posting} onChanged={refresh} />
            ))}
          </div>
        ) : (
          <p className="muted">No postings from this company yet.</p>
        )}
      </section>
    </div>
  );
}

export function Companies() {
  const [filter, setFilter] = useState<JobCompanyFilter>('all');
  const [open, setOpen] = useState<string | null>(null);
  return open ? (
    <CompanyDetail id={open} onBack={() => setOpen(null)} />
  ) : (
    <CompanyList filter={filter} onFilter={setFilter} onOpen={setOpen} />
  );
}
