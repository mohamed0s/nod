(() => {
  const panelUrl = chrome.runtime.getURL('sidepanel.html');
  const linkedIn = 'https://www.linkedin.com/';
  const nodAddress = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;
  const tokenShape = /^[A-Za-z0-9_-]{43}$/;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const statuses = new Set(['invited', 'accepted', 'asked', 'replied', 'referred', 'declined']);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const retries = 10;
  let trusted = '';
  let greeting = null;

  class Problem extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  const setUp = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.runtime.onInstalled.addListener(setUp);
  chrome.runtime.onStartup.addListener(setUp);

  const hex = (buffer) =>
    [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const base64url = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let start = 0; start < bytes.length; start += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromBase64 = (value) =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (letter) =>
      letter.charCodeAt(0),
    );
  const digest = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

  async function pairing() {
    try {
      const response = await fetch(chrome.runtime.getURL('.pairing.json'), { cache: 'no-store' });
      if (!response.ok) return null;
      const value = await response.json();
      if (!nodAddress.test(value?.nod) || !uuid.test(value?.id) || !tokenShape.test(value?.token))
        return null;
      const base = await crypto.subtle.importKey(
        'raw',
        await crypto.subtle.digest('SHA-256', encoder.encode(value.token)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const derived = (label) => crypto.subtle.sign('HMAC', base, encoder.encode(label));
      return {
        nod: value.nod,
        id: value.id,
        mac: await crypto.subtle.importKey(
          'raw',
          await derived('nod-helper-mac'),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign', 'verify'],
        ),
        secret: await crypto.subtle.importKey(
          'raw',
          await derived('nod-helper-encrypt'),
          { name: 'AES-GCM' },
          false,
          ['encrypt', 'decrypt'],
        ),
      };
    } catch {
      return null;
    }
  }

  async function seal(paired, plain, context) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      paired.secret,
      plain,
    );
    return JSON.stringify({ iv: base64url(iv), data: base64url(data) });
  }

  async function unseal(paired, bytes, context) {
    const envelope = JSON.parse(decoder.decode(bytes));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode(context) },
      paired.secret,
      fromBase64(envelope.data),
    );
    return JSON.parse(decoder.decode(plain));
  }

  function distrust(paired, status) {
    trusted = '';
    return new Problem(
      'unverified',
      `What answers at ${paired.nod} didn't prove it is the Nod this panel is paired with${status ? ` (HTTP ${status})` : ''}. It got only encrypted requests it can't read. Start Nod, then run pair-helper.ps1 again.`,
    );
  }

  async function send(paired, path, body) {
    const url = new URL(`/api/helper/${path}`, paired.nod);
    const time = String(Date.now());
    const context = ['nod-helper-request', 'POST', url.host, url.pathname + url.search, time].join(
      '\n',
    );
    const text = await seal(paired, encoder.encode(JSON.stringify(body)), context);
    const signature = base64url(
      await crypto.subtle.sign(
        'HMAC',
        paired.mac,
        encoder.encode(`${context}\n${await digest(encoder.encode(text))}`),
      ),
    );
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-nod-helper': paired.id,
          'x-nod-time': time,
          'x-nod-signature': signature,
        },
        body: text,
      });
    } catch (error) {
      trusted = '';
      throw new Problem(
        'offline',
        `Nod isn't answering at ${paired.nod}. Start Nod, or run pair-helper.ps1 again if it now uses another address. (${error.message})`,
      );
    }
    let opened;
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const answer = response.headers.get('x-nod-signature') || '';
      const genuine =
        tokenShape.test(answer) &&
        (await crypto.subtle.verify(
          'HMAC',
          paired.mac,
          fromBase64(answer),
          encoder.encode(
            ['nod-helper-response', signature, String(response.status), await digest(bytes)].join(
              '\n',
            ),
          ),
        ));
      if (!genuine) throw distrust(paired, response.status);
      opened = await unseal(paired, bytes, `nod-helper-response\n${signature}`);
    } catch (error) {
      throw error instanceof Problem ? error : distrust(paired, response.status);
    }
    const bytes = fromBase64(opened.body);
    if (response.ok) return { bytes, type: opened.type, disposition: opened.disposition };
    let reason = '';
    try {
      reason = JSON.parse(decoder.decode(bytes))?.error || '';
    } catch {
      reason = '';
    }
    const problem = new Problem(
      response.status === 400
        ? 'invalid'
        : response.status === 409
          ? 'conflict'
          : response.status === 429
            ? 'busy'
            : 'error',
      `${reason || 'Nod refused the request.'} (HTTP ${response.status})`,
    );
    problem.retryAfter = Number(opened.retryAfter) || 0;
    throw problem;
  }

  async function nod(path, body = {}) {
    const paired = await pairing();
    if (!paired)
      throw new Problem(
        'unpaired',
        'This panel is not paired with Nod yet. On the Jobs page, open Helper and select Pair the Edge panel, then run pair-helper.ps1.',
      );
    const name = `${paired.nod} ${paired.id}`;
    if (trusted !== name) {
      greeting ??= send(paired, 'hello', {}).finally(() => {
        greeting = null;
      });
      await greeting;
      trusted = name;
    }
    const { bytes, type, disposition } = await send(paired, path, body);
    return path === 'cv' ? { bytes, type, disposition } : JSON.parse(decoder.decode(bytes));
  }

  let chain = Promise.resolve();
  const serial = (task) => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };

  const changed = () => chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {});

  async function remember(problem) {
    await chrome.storage.local.set({ problem: { text: problem, at: new Date().toISOString() } });
    changed();
  }

  async function sendWaiting() {
    const { queue = [] } = await chrome.storage.local.get('queue');
    const waiting = [...queue];
    const now = Date.now();
    let sent = 0;
    for (let index = 0; index < waiting.length;) {
      const entry = waiting[index];
      if (entry.next > now) {
        index += 1;
        continue;
      }
      try {
        await nod('invites', { company: entry.invite.company, people: [entry.invite.person] });
        waiting.splice(index, 1);
        sent += 1;
      } catch (error) {
        if (error.kind === 'invalid' || error.kind === 'conflict') {
          waiting.splice(index, 1);
          await remember(
            `The invite for ${entry.invite.person.name} wasn't saved: ${error.message}`,
          );
        } else if (error.kind === 'busy') {
          waiting[index] = {
            ...entry,
            next: now + (error.retryAfter > 0 ? error.retryAfter * 1000 : 60_000),
          };
          await chrome.storage.local.set({ queue: waiting });
          break;
        } else if (error.kind === 'error') {
          const tries = entry.tries + 1;
          if (tries >= retries) {
            waiting.splice(index, 1);
            await remember(
              `The invite for ${entry.invite.person.name} wasn't saved after ${retries} tries: ${error.message}`,
            );
          } else
            waiting[index] = {
              ...entry,
              tries,
              next: now + Math.min(30_000 * 2 ** tries, 3_600_000),
            };
          await chrome.storage.local.set({ queue: waiting });
          break;
        } else break;
      }
      await chrome.storage.local.set({ queue: waiting });
    }
    if (sent) changed();
    return waiting.length;
  }

  const flush = () => serial(sendWaiting);

  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

  function inviteOf(message) {
    const { company, person } = message;
    if (
      !text(company?.slug, 100) ||
      !text(company?.name, 200) ||
      !text(person?.profileUrl, 300) ||
      !person.profileUrl.startsWith(`${linkedIn}in/`) ||
      !text(person?.name, 200) ||
      typeof person.headline !== 'string' ||
      person.headline.length > 400 ||
      (person.memberUrn !== undefined && !text(person.memberUrn, 130))
    )
      return null;
    return {
      company: { slug: company.slug, name: company.name },
      person: {
        profileUrl: person.profileUrl,
        name: person.name,
        headline: person.headline,
        ...(person.memberUrn ? { memberUrn: person.memberUrn } : {}),
      },
    };
  }

  async function observed(message) {
    if (message.type === 'invite') {
      const invite = inviteOf(message);
      if (!invite) return null;
      await serial(async () => {
        const { queue = [] } = await chrome.storage.local.get('queue');
        await chrome.storage.local.set({
          queue: [...queue, { invite, tries: 0, next: 0 }].slice(-200),
        });
      });
      return flush();
    }
    if (message.type === 'profile') {
      if (!text(message.profileUrl, 300) || !text(message.memberUrn, 130)) return null;
      const result = await nod('profile', {
        profileUrl: message.profileUrl,
        memberUrn: message.memberUrn,
      });
      if (result.person) changed();
      return null;
    }
    if (message.type === 'connections') {
      const { connections } = await chrome.storage.local.get({ connections: true });
      if (!connections || !Array.isArray(message.people)) return null;
      const people = message.people
        .filter((person) => text(person?.profileUrl, 300))
        .slice(0, 100)
        .map((person) => ({ profileUrl: person.profileUrl }));
      if (!people.length) return null;
      const result = await nod('connections', { people });
      if (result.accepted.length) changed();
      return null;
    }
    return null;
  }

  function fileName(header) {
    const raw = /filename\*=UTF-8''([^;]+)/i.exec(header || '')?.[1];
    let name = '';
    try {
      name = raw ? decodeURIComponent(raw) : '';
    } catch {
      name = '';
    }
    name = name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/^[.\s]+/, '')
      .slice(0, 120);
    if (!name) return 'CV.pdf';
    return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
  }

  async function downloadCv() {
    const { bytes, type, disposition } = await nod('cv');
    if (!/^application\/pdf(?:;|$)/i.test(type))
      throw new Problem('error', "Nod's answer wasn't a PDF.");
    let binary = '';
    for (let start = 0; start < bytes.length; start += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    const filename = fileName(disposition);
    await chrome.downloads.download({
      url: `data:application/pdf;base64,${btoa(binary)}`,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return { filename };
  }

  async function state(page) {
    const waiting = await flush().catch(() => 0);
    const stored = await chrome.storage.local.get({ connections: true, problem: null });
    const settings = { connections: stored.connections };
    try {
      const company = await nod(
        'company',
        page ? { slug: page.slug, ...(page.name ? { name: page.name } : {}) } : {},
      );
      const accepted = await nod('accepted');
      return {
        status: 'ready',
        ...company,
        accepted: accepted.people,
        waiting,
        settings,
        problem: stored.problem,
      };
    } catch (error) {
      return {
        status: error.kind || 'error',
        error: error.message,
        waiting,
        settings,
        problem: stored.problem,
      };
    }
  }

  async function command(message) {
    if (message.type === 'state') {
      const page = message.page;
      return state(
        page && text(page.slug, 100)
          ? { slug: page.slug, ...(text(page.name, 200) ? { name: page.name } : {}) }
          : null,
      );
    }
    if (message.type === 'status') {
      if (!uuid.test(message.id) || !statuses.has(message.status)) return null;
      return nod(`people/${message.id}/status`, {
        status: message.status,
        revision: message.revision,
      });
    }
    if (message.type === 'noLuck') {
      if (!uuid.test(message.id)) return null;
      return nod(`companies/${message.id}/no-luck`, {
        noLuck: message.noLuck,
        ...(Number.isInteger(message.revision) ? { revision: message.revision } : {}),
      });
    }
    if (message.type === 'cv') return downloadCv();
    if (message.type === 'settings') {
      await chrome.storage.local.set({ connections: message.connections === true });
      return null;
    }
    if (message.type === 'dismiss') {
      await chrome.storage.local.remove('problem');
      return null;
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string') return false;
    const fromPage =
      sender.tab !== undefined &&
      sender.frameId === 0 &&
      typeof sender.url === 'string' &&
      sender.url.startsWith(linkedIn);
    const fromPanel = sender.tab === undefined && sender.url === panelUrl;
    const work = fromPage ? observed(message) : fromPanel ? command(message) : null;
    if (!work) return false;
    work.then(
      (value) => reply({ ok: true, value }),
      (error) => reply({ ok: false, kind: error.kind || 'error', error: error.message }),
    );
    return true;
  });
})();
