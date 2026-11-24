(() => {
  const panelUrl = chrome.runtime.getURL('sidepanel.html');
  const linkedIn = 'https://www.linkedin.com/';
  const nodAddress = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/;
  const tokenShape = /^[A-Za-z0-9_-]{43}$/;
  const personId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const statuses = new Set(['invited', 'accepted', 'asked', 'replied', 'referred', 'declined']);

  class Problem extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  const setUp = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.runtime.onInstalled.addListener(setUp);
  chrome.runtime.onStartup.addListener(setUp);

  async function pairing() {
    try {
      const response = await fetch(chrome.runtime.getURL('pairing.json'), { cache: 'no-store' });
      if (!response.ok) return null;
      const value = await response.json();
      return nodAddress.test(value?.nod) && tokenShape.test(value?.token)
        ? { nod: value.nod, token: value.token }
        : null;
    } catch {
      return null;
    }
  }

  async function nod(path, body = {}) {
    const paired = await pairing();
    if (!paired)
      throw new Problem(
        'unpaired',
        'This panel is not paired with Nod yet. On the Jobs page, open Helper and select Pair the Edge panel, then run pair-helper.ps1.',
      );
    let response;
    try {
      response = await fetch(`${paired.nod}/api/helper/${path}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Problem(
        'offline',
        `Nod isn't answering at ${paired.nod}. Start Nod, or run pair-helper.ps1 again if it now uses another address. (${error.message})`,
      );
    }
    if (response.ok) return path === 'cv' ? response : response.json();
    const reason = await response
      .json()
      .then((value) => value?.error)
      .catch(() => '');
    throw new Problem(
      response.status === 401 || response.status === 403 ? 'unpaired' : 'error',
      `${reason || 'Nod refused the request.'} (HTTP ${response.status})`,
    );
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
    let sent = 0;
    while (waiting.length) {
      const invite = waiting[0];
      try {
        await nod('invites', { company: invite.company, people: [invite.person] });
        sent += 1;
      } catch (error) {
        if (error.kind !== 'error') break;
        await remember(`The invite for ${invite.person.name} wasn't saved: ${error.message}`);
      }
      waiting.shift();
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
        await chrome.storage.local.set({ queue: [...queue, invite].slice(-200) });
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
    const response = await nod('cv');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    const filename = fileName(response.headers.get('content-disposition'));
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
      const [company, accepted] = await Promise.all([
        nod('company', page ? { slug: page.slug, ...(page.name ? { name: page.name } : {}) } : {}),
        nod('accepted'),
      ]);
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
      if (!personId.test(message.id) || !statuses.has(message.status)) return null;
      return nod(`people/${message.id}/status`, {
        status: message.status,
        revision: message.revision,
      });
    }
    if (message.type === 'noLuck') {
      if (!personId.test(message.id)) return null;
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
