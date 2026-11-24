import { useState } from 'react';
import type { JobHelperPairing, JobHelperView } from '../../shared/job-helper';
import { Button, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage, post } from '../lib/api';
import { copyContent } from '../lib/clipboard';
import { formatDateTime, useDateFormat } from '../lib/date-format';

export const helperPath = '/api/jobs/helper';

type Message = { kind: 'info' | 'success' | 'error'; text: string } | null;

export function Helper() {
  const format = useDateFormat();
  const data = usePageData<JobHelperView>(helperPath);
  const [code, setCode] = useState<JobHelperPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const waiting = code && data.data?.pairing ? code : null;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (cause) {
      setMessage({ kind: 'error', text: errorMessage(cause) });
    } finally {
      setBusy(false);
      void data.refresh();
    }
  };
  const pair = () =>
    run(async () => {
      const next = await post<JobHelperPairing>(`${helperPath}/pairing`);
      setCode(next);
      try {
        await copyContent(next.code);
        setMessage({ kind: 'info', text: 'Code copied. Now run the pairing script.' });
      } catch {
        setMessage({ kind: 'info', text: 'Now run the pairing script and type this code.' });
      }
    });
  const cancel = () =>
    run(async () => {
      await api(`${helperPath}/pairing`, { method: 'DELETE' });
      setCode(null);
    });
  const revoke = (id: string) =>
    run(async () => {
      await post(`${helperPath}/${id}/revoke`);
      setMessage({ kind: 'success', text: 'Unpaired. That panel can no longer reach Nod.' });
    });
  return (
    <div className="jobs-panel">
      <section className="saved-plan" aria-labelledby="jobs-helper-title">
        <h2 id="jobs-helper-title">Edge panel beside LinkedIn</h2>
        <p className="jobs-meta">
          A panel in your own Edge logs each invite you send from a company&apos;s People tab and
          shows who accepted, with their profile, a Message link, the prepared message and your main
          CV. It only reads LinkedIn pages you open: it never clicks, types, scrolls, opens pages or
          loads anything on LinkedIn by itself.
        </p>
        <ol className="jobs-steps">
          <li>
            In Edge, open <code>edge://extensions</code>, turn on <strong>Developer mode</strong>,
            select <strong>Load unpacked</strong> and choose the{' '}
            <code>extensions\linkedin-helper</code> folder of your Nod checkout. You do this once.
          </li>
          <li>
            Select <strong>Pair the Edge panel</strong> below. Nod copies a one-time code.
          </li>
          <li>
            Run <code>scripts\windows\pair-helper.ps1</code>. It reads the code, asks Nod for the
            panel&apos;s key and saves it in the extension folder. The key never appears on screen.
          </li>
        </ol>
        {waiting ? (
          <div className="jobs-pairing">
            <p className="jobs-pairing-code" aria-label="Pairing code">
              {waiting.code}
            </p>
            <p className="jobs-meta">
              Valid until{' '}
              <time dateTime={waiting.expiresAt}>{formatDateTime(waiting.expiresAt, format)}</time>,
              once. Five wrong codes cancel it.
            </p>
            <div className="jobs-actions">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="jobs-actions">
            <Button size="sm" disabled={busy} onClick={() => void pair()}>
              Pair the Edge panel
            </Button>
          </div>
        )}
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </section>
      <section className="jobs-company-section" aria-labelledby="jobs-helpers-title">
        <h2 id="jobs-helpers-title">Paired panels</h2>
        {data.error ? (
          <Notice>Could not load the paired panels. {data.error}</Notice>
        ) : !data.data ? (
          <Loading label="Loading paired panels…" />
        ) : data.data.helpers.length ? (
          <div className="saved-plan-list">
            {data.data.helpers.map((helper) => (
              <article key={helper.id} className="saved-plan">
                <div className="saved-plan-title">
                  <h3>Edge panel</h3>
                  <span className="jobs-badge" title="Extension id">
                    {helper.extensionId.slice(0, 8)}
                  </span>
                </div>
                <p className="jobs-meta">
                  Paired{' '}
                  <time dateTime={helper.pairedAt}>{formatDateTime(helper.pairedAt, format)}</time>{' '}
                  ·{' '}
                  {helper.lastUsedAt ? (
                    <>
                      last used{' '}
                      <time dateTime={helper.lastUsedAt}>
                        {formatDateTime(helper.lastUsedAt, format)}
                      </time>
                    </>
                  ) : (
                    'not used yet'
                  )}
                </p>
                <div className="jobs-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void revoke(helper.id)}
                  >
                    Revoke
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No panel is paired.</p>
        )}
      </section>
    </div>
  );
}
