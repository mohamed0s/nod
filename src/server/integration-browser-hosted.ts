import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IntegrationConnectionError,
  type IntegrationConnectionBrowser,
} from '../ports/integrations.ts';
import { logFailure } from './failure-log.ts';
import { defaultConnectionService } from '../shared/integrations.ts';

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const lock = icon(
  '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
);
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export const integrationPageStyle = `:root{color-scheme:light dark;--ink:light-dark(#191919,#fafafa);--muted:light-dark(#676767,#bfbfbf);--line:light-dark(#e0e0e0,#353535);--tile:light-dark(#fff,#242424);--soft:light-dark(#ffe8ec,#3d0019);--accent:light-dark(#87003c,#ff91ac)}body{font:16px system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;min-height:100svh;display:grid;place-items:center;background:light-dark(#fafafa,#191919);color:var(--ink)}main{box-sizing:border-box;width:min(420px,100%);padding:32px 24px;text-align:center}h1{font-size:24px;font-weight:500;letter-spacing:-.6px;margin:0 0 4px}p{margin:0;line-height:1.6;color:var(--muted)}a{color:var(--accent);text-underline-offset:3px}.route{display:flex;align-items:flex-start;justify-content:center;gap:8px;margin-bottom:16px}.tile{display:grid;place-items:center;width:56px;height:56px;border:1px solid var(--line);border-radius:16px;background:var(--tile);font-size:22px;font-weight:600}.tile svg{width:30px;height:30px}.dots{width:18px;margin-top:27px;border-top:2px dotted #ff91ac}.lock{display:grid;justify-items:center;gap:4px;margin-top:12px;font-size:11px;color:var(--muted);white-space:nowrap}.lock svg{box-sizing:content-box;width:16px;height:16px;padding:7px;border-radius:50%;background:var(--soft);color:var(--accent)}.lead{margin-bottom:20px}ul{list-style:none;margin:0 0 18px;padding:0;display:grid;gap:10px;text-align:left}li{display:flex;gap:12px;align-items:center;font-size:15px;font-weight:500}li svg{flex:none;box-sizing:content-box;width:18px;height:18px;padding:9px;border-radius:10px;background:var(--soft);color:var(--accent)}.fine{display:flex;gap:8px;text-align:left;font-size:13px;line-height:1.5;border-top:1px solid var(--line);padding-top:12px}.fine svg{flex:none;width:13px;height:13px;margin-top:3px}button{font:inherit;font-size:14px;font-weight:500;min-height:44px;margin-top:20px;padding:0 20px;border:0;border-radius:400px;background:#ff91ac;color:#191919;cursor:pointer}button:disabled{opacity:.5;cursor:default}#status:not(:empty){margin-top:16px}.failed .route{display:none}`;

export function integrationNotice(brokerOrigin: string, app?: string) {
  const label = app?.trim();
  const name = label ? escapeHtml(label) : undefined;
  const managed = brokerOrigin === defaultConnectionService;
  const service = managed ? 'n8n' : escapeHtml(new URL(brokerOrigin).host);
  const kept = managed
    ? 'Composio can keep a copy for up to a year.'
    : 'That service sets what Composio keeps.';
  return {
    title: name ? `Connect ${name}` : 'Connect your app',
    button: name ? `Continue to ${name}` : 'Continue to sign in',
    route: `<div class="route" aria-hidden="true"><span class="tile"><svg viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="10" stroke="currentColor" stroke-width="4"/><circle cx="29" cy="10" r="4" fill="#ff91ac"/></svg></span><span class="dots"></span><span class="lock">${lock}${service} · Composio</span><span class="dots"></span><span class="tile">${label ? escapeHtml([...label][0]!.toUpperCase()) : icon('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>')}</span></div>`,
    body: `<p class="lead">You stay in control.</p><ul><li>${icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>')}You see what Nod can access first</li><li>${icon('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>')}Nod asks before doing more than you asked</li><li>${icon('<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>')}Disconnect any time in Apps</li></ul><p class="fine">${lock}<span>What Nod reads or sends in ${name ?? 'this app'} passes through ${service} and Composio${brokerOrigin.startsWith('https:') ? ', encrypted on the way' : ''}. ${kept} <a href="https://nod.n8n.io/docs/trust/privacy/#composio-zero-data-retention" target="_blank" rel="noopener noreferrer">Details</a></span></p>`,
  };
}

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const input = z
  .object({
    browserKey: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: token, y: token }),
  })
  .strict();

function page(
  brokerOrigin: string,
  id: string,
  expiresAt: number,
  bridgeKey: string,
  nonce: string,
  app?: string,
) {
  const notice = integrationNotice(brokerOrigin, app);
  const values = JSON.stringify({ brokerOrigin, id, expiresAt, bridgeKey }).replaceAll(
    '<',
    '\\u003c',
  );
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${notice.title} · Nod</title><style nonce="${nonce}">${integrationPageStyle}</style></head><body><main>${notice.route}<h1>${notice.title}</h1>${notice.body}<button id="connect" type="button">${notice.button}</button><p id="status" role="status"></p></main><script nonce="${nonce}">
const {brokerOrigin,id,expiresAt,bridgeKey}=${values};
const button=document.getElementById('connect');
const status=document.getElementById('status');
let popup,key,started=false,signed=false,deadline=expiresAt;
const valid=()=>{if(Date.now()>=deadline)throw new Error();};
const fail=(message)=>{button.disabled=true;status.textContent=message||'Sign-in could not be completed. Return to Nod and try again.';popup?.close();};
const encoded=(bytes)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
window.addEventListener('message',async(event)=>{
if(!key||signed||event.origin!==brokerOrigin||event.source!==popup)return;
const value=event.data;
if(!value||value.type!=='nod:proxy-connect:challenge'||value.id!==id||typeof value.challenge!=='string'||value.challenge.length>512)return;
const parts=value.challenge.split('\n');
if(parts.length!==5||parts[0]!=='nod-proxy-connect-v2'||parts[1]!==id||parts[2]!==location.origin||!/^[a-f0-9]{64}$/.test(parts[3])||!/^[A-Za-z0-9_-]{43}$/.test(parts[4]))return;
signed=true;
try{valid();const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(value.challenge)));valid();if(signature.length!==64)throw new Error();key=undefined;popup.postMessage({type:'nod:proxy-connect:proof',id,signature:encoded(signature)},brokerOrigin);status.textContent='Finish signing in in the other window. You can then return to Nod.';}catch{fail();}
});
button.addEventListener('click',async()=>{
if(started)return;
try{valid();popup=window.open('about:blank','_blank','popup,width=520,height=720');if(!popup){status.textContent='Allow popups for Nod, then try again.';return;}started=true;button.disabled=true;
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);valid();key=pair.privateKey;
const response=await fetch(location.pathname,{method:'POST',credentials:'same-origin',headers:{'X-Nod-Bridge':bridgeKey,'Content-Type':'application/json'},body:JSON.stringify({browserKey:await crypto.subtle.exportKey('jwk',pair.publicKey)})});if(!response.ok){const reply=await response.json().catch(()=>({}));throw Object.assign(new Error(),{reply:typeof reply?.error==='string'?reply.error.slice(0,300):''});}
const attempt=await response.json();const target=new URL(attempt.url);if(attempt.id!==id||!Number.isSafeInteger(attempt.expiresAt)||target.origin!==brokerOrigin||target.pathname!=='/v2/connect/pair'||target.searchParams.size!==1||!target.searchParams.get('ticket')||target.username||target.password||target.hash)throw new Error();deadline=Math.min(deadline,attempt.expiresAt);valid();if(popup.closed)throw new Error();popup.location.replace(target.href);status.textContent='Finish signing in in the other window.';
}catch(error){key=undefined;fail(error?.reply);}
});
setTimeout(()=>{key=undefined;button.disabled=true;if(!signed)fail();},Math.max(0,expiresAt-Date.now()));
</script></body></html>`;
}

export function createHostedIntegrationBrowser(origin: string): IntegrationConnectionBrowser & {
  registerRoutes(app: FastifyInstance): void;
} {
  const attempts = new Map<
    string,
    {
      id: string;
      url: string;
      brokerOrigin: string;
      bridgeKey: string;
      expiresAt: number;
      bootstrapped: boolean;
      starting: boolean;
      remote?: string;
      timer: ReturnType<typeof setTimeout>;
      start: Parameters<IntegrationConnectionBrowser['open']>[2];
      app?: string;
    }
  >();
  let closed = false;
  function finish(id: string) {
    for (const [capability, attempt] of attempts) {
      if (attempt.id !== id) continue;
      clearTimeout(attempt.timer);
      attempts.delete(capability);
    }
  }
  return {
    async open(id, brokerOrigin, start, app) {
      token.parse(id);
      if (closed || attempts.size >= 20 || [...attempts.values()].some((value) => value.id === id))
        throw new Error('Another app connection is already being opened.');
      const capability = randomBytes(32).toString('base64url');
      const url = `${origin}/api/apps/connect/${capability}`;
      const expiresAt = Date.now() + 10 * 60_000;
      const timer = setTimeout(() => {
        const attempt = attempts.get(capability);
        if (attempt)
          logFailure('app_connection_expired', undefined, {
            step: attempt.remote ? 'consent' : attempt.bootstrapped ? 'start' : 'open',
          });
        finish(id);
      }, expiresAt - Date.now());
      timer.unref();
      attempts.set(capability, {
        id,
        url,
        brokerOrigin,
        bridgeKey: randomBytes(32).toString('base64url'),
        expiresAt,
        timer,
        start,
        app,
        bootstrapped: false,
        starting: false,
      });
      return url;
    },
    registerRoutes(app) {
      app.route<{ Params: { capability: string } }>({
        method: ['GET', 'POST'],
        url: '/api/apps/connect/:capability',
        bodyLimit: 4096,
        async handler(request, reply) {
          const attempt = attempts.get(request.params.capability);
          const nonce = randomBytes(24).toString('base64');
          reply
            .header('Cache-Control', 'no-store')
            .header('Referrer-Policy', 'no-referrer')
            .header('X-Content-Type-Options', 'nosniff')
            .header(
              'Content-Security-Policy',
              `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            );
          const unavailable = () =>
            reply.code(403).send({ error: 'This app connection is unavailable.' });
          if (
            !attempt ||
            closed ||
            attempt.expiresAt <= Date.now() ||
            request.url !== new URL(attempt.url).pathname ||
            request.headers.host !== new URL(origin).host ||
            (request.headers.origin !== undefined && request.headers.origin !== origin)
          )
            return unavailable();
          if (request.method === 'GET') {
            if (attempt.starting) return unavailable();
            attempt.bootstrapped = true;
            return reply
              .type('text/html; charset=utf-8')
              .send(
                page(
                  attempt.brokerOrigin,
                  attempt.id,
                  attempt.expiresAt,
                  attempt.bridgeKey,
                  nonce,
                  attempt.app,
                ),
              );
          }
          if (
            !attempt.bootstrapped ||
            attempt.starting ||
            request.headers.origin !== origin ||
            request.headers['sec-fetch-site'] === 'cross-site' ||
            request.headers['x-nod-bridge'] !== attempt.bridgeKey
          )
            return unavailable();
          attempt.starting = true;
          try {
            const { browserKey } = input.parse(request.body);
            const remote = new URL(await attempt.start(browserKey, origin));
            if (
              closed ||
              attempts.get(request.params.capability) !== attempt ||
              attempt.expiresAt <= Date.now() ||
              remote.origin !== attempt.brokerOrigin ||
              remote.pathname !== '/v2/connect/pair' ||
              remote.searchParams.size !== 1 ||
              !remote.searchParams.get('ticket') ||
              remote.username ||
              remote.password ||
              remote.hash
            )
              throw new Error('The app sign-in address could not be verified.');
            attempt.remote = remote.href;
            return { id: attempt.id, url: remote.href, expiresAt: attempt.expiresAt };
          } catch (error) {
            finish(attempt.id);
            logFailure('app_connection_start', error);
            return reply.code(400).send({
              error:
                error instanceof IntegrationConnectionError
                  ? error.message
                  : 'The app connection could not be started. Return to Nod and try again.',
            });
          }
        },
      });
    },
    owns: (url) =>
      [...attempts.values()].some(
        (attempt) => attempt.url === url && attempt.expiresAt > Date.now(),
      ),
    remote: (url) =>
      [...attempts.values()].find(
        (attempt) => attempt.url === url && attempt.expiresAt > Date.now(),
      )?.remote,
    finish,
    async close() {
      closed = true;
      for (const attempt of attempts.values()) finish(attempt.id);
    },
  };
}
