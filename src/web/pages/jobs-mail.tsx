import { useState } from 'react';
import type { JobMailCount, JobMailView } from '../../shared/job-mail';
import { Field, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { pageDataCache } from '../lib/page-data-cache';

const mailPath = '/api/jobs/mail';

export function refreshJobMail() {
  void pageDataCache.refresh(mailPath, true);
}

const countLabels: Array<[JobMailCount, string, string]> = [
  ['accepted', 'accept', 'accepts'],
  ['personReplies', 'reply on LinkedIn', 'replies on LinkedIn'],
  ['employerReplies', 'employer reply', 'employer replies'],
  ['already', 'already up to date', 'already up to date'],
  ['seenBefore', 'read before', 'read before'],
  ['toAsk', 'not matched', 'not matched'],
  ['unverified', 'failed the sender check', 'failed the sender check'],
  ['misaddressed', 'sent to another address', 'sent to another address'],
  ['withheld', 'withheld', 'withheld'],
  ['noHeaders', 'without headers', 'without headers'],
  ['ignored', 'not job mail', 'not job mail'],
  ['unreadable', 'unreadable', 'unreadable'],
];

export function JobMail() {
  const format = useDateFormat();
  const data = usePageData<JobMailView>(mailPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (data.error) return <Notice>Could not load the job mail settings. {data.error}</Notice>;
  if (!data.data) return <Loading label="Loading job mail…" />;
  const view = data.data;
  const choose = async (account: string) => {
    setBusy(true);
    setError('');
    try {
      const next = await api<JobMailView>(mailPath, {
        method: 'PUT',
        body: JSON.stringify({ account: account || null, revision: view.revision }),
      });
      data.update(() => next);
    } catch (cause) {
      setError(errorMessage(cause));
      void data.refresh();
    } finally {
      setBusy(false);
    }
  };
  const run = view.lastRun;
  const counts = run
    ? countLabels.flatMap(([key, one, many]) =>
        run.counts[key] ? [`${run.counts[key]} ${run.counts[key] === 1 ? one : many}`] : [],
      )
    : [];
  return (
    <section className="saved-plan jobs-sources" aria-labelledby="jobs-mail-title">
      <h2 id="jobs-mail-title">Job mail</h2>
      <p className="jobs-meta">
        Nod reads LinkedIn's accept and message emails and replies from companies you applied to or
        contacted, in the Gmail account linked to your LinkedIn. It only records them and tells you:
        it never replies or changes your calendar.
      </p>
      {view.accounts.length ? (
        <Field
          label="Gmail account linked to LinkedIn"
          hint="Nod never guesses: it reads job mail only in the account you choose."
        >
          <select
            className="input"
            value={view.account?.id ?? ''}
            disabled={busy}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value="">Not chosen</option>
            {view.accounts.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.address}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p className="muted">Connect Gmail on the Apps page to read job mail.</p>
      )}
      {view.accountGone && (
        <Notice>
          The account you chose isn't connected anymore. Reconnect it on the Apps page, or choose
          another.
        </Notice>
      )}
      <p className="jobs-meta">
        {view.schedule
          ? `Schedule "${view.schedule.title}" is ${view.schedule.enabled ? 'on' : 'paused'}. It checks every 30 minutes and skips the run when the account has no new mail.`
          : 'No Job mail schedule yet. Ask Nod in chat to check your job mail every 30 minutes.'}
      </p>
      {run ? (
        <>
          <p className="jobs-meta">
            Last run {formatDateTime(run.at, format)}:{' '}
            {run.counts.emails
              ? `${run.counts.emails} ${run.counts.emails === 1 ? 'email' : 'emails'}${counts.length ? `, ${counts.join(', ')}` : ''}.`
              : 'no new job mail.'}
          </p>
          {run.reasons.length > 0 && (
            <ul className="jobs-mail-run">
              {run.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted">Nod hasn't read job mail yet.</p>
      )}
      {error && <Notice>{error}</Notice>}
    </section>
  );
}
