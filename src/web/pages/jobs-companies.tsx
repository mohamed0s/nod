import { useEffect, useId, useState } from 'react';
import {
  jobCompanyFilters,
  jobPersonStatuses,
  type JobCompaniesView,
  type JobCompany,
  type JobCompanyFilter,
  type JobCompanyView,
  type JobNoLuckResult,
  type JobPerson,
  type JobPersonStatus,
} from '../../shared/job-companies';
import { ArrowLeft } from '../components/icons';
import { Tabs } from '../components/tabs';
import { Button, Checkbox, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { copyContent } from '../lib/clipboard';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { pageDataCache } from '../lib/page-data-cache';
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
  no_luck: 'No luck',
};
const emptyText: Record<JobCompanyFilter, string> = {
  all: 'No companies yet. They appear with the postings Nod finds and the people you tell Nod you invited.',
  waiting: 'Nobody you invited is waiting to accept.',
  to_ask: 'Nobody who accepted is waiting for your referral request.',
  asked: 'Nobody you asked is waiting to reply.',
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

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

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

function PersonCard({ person, onChanged }: { person: JobPerson; onChanged(): void }) {
  const format = useDateFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
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
      {(person.draft || person.status === 'accepted') && (
        <div className="jobs-draft">
          <h4>Prepared message</h4>
          {person.draft ? (
            <>
              <p className="jobs-draft-text" dir="auto">
                {person.draft}
              </p>
              <div className="jobs-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await copyContent(person.draft);
                      setCopied(true);
                    } catch (cause) {
                      setError(`Could not copy the message. ${errorMessage(cause)}`);
                    }
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">Nod puts the referral message here once it has prepared it.</p>
          )}
        </div>
      )}
      {error && <Notice>{error}</Notice>}
    </article>
  );
}

function noLuckText(company: JobCompany, limits: Limits, format: ReturnType<typeof useDateFormat>) {
  const since = company.noLuck.since ? formatDateTime(company.noLuck.since, format) : '';
  const rule = `nobody accepted within ${plural(limits.noAcceptDays, 'day')}, or replied within ${plural(limits.noReplyDays, 'day')} of being asked`;
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
              <PersonCard key={person.id} person={person} onChanged={refresh} />
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
