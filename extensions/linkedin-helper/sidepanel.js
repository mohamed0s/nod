(() => {
  const site = 'https://www.linkedin.com/';
  const rightToLeft = new Set(['ar', 'ckb', 'dv', 'fa', 'he', 'ps', 'sd', 'ug', 'ur', 'yi']);
  const statusLabels = {
    invited: 'Invited',
    accepted: 'Accepted',
    asked: 'Asked',
    replied: 'Replied',
    referred: 'Referred',
    declined: 'Declined',
  };
  const stateLabels = {
    ready: 'Connected',
    unpaired: 'Not paired',
    offline: "Nod isn't running",
    unverified: "Can't confirm Nod",
    invalid: 'Problem',
    error: 'Problem',
  };
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let busy = false;

  function element(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.dir) node.dir = options.dir;
    for (const [name, value] of Object.entries(options.attributes || {}))
      node.setAttribute(name, value);
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function direction(language) {
    const base = (language || '').split('-')[0].toLowerCase();
    if (!base) return 'auto';
    return rightToLeft.has(base) ? 'rtl' : 'ltr';
  }

  function link(label, href) {
    if (typeof href !== 'string' || !href.startsWith(site)) return null;
    return element('a', {
      className: 'button',
      text: label,
      attributes: { href, target: '_blank', rel: 'noopener noreferrer' },
    });
  }

  function button(label, action, className = '') {
    const node = element('button', { className, text: label, attributes: { type: 'button' } });
    node.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      node.disabled = true;
      try {
        await action(node);
      } catch (error) {
        showNotice(error.message);
      } finally {
        busy = false;
        node.disabled = false;
      }
    });
    return node;
  }

  async function ask(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || 'The helper did not answer. Reload the panel.');
    return reply.value;
  }

  function showNotice(text, dismiss) {
    const notice = document.getElementById('notice');
    notice.replaceChildren(element('p', { text, dir: 'auto' }));
    if (dismiss)
      notice.append(
        button('Dismiss', async () => {
          await dismiss();
          notice.hidden = true;
        }),
      );
    notice.hidden = false;
  }

  async function currentPage() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith(site)) return null;
    const slug = /^\/company\/([^/]+)/.exec(new URL(tab.url).pathname)?.[1];
    if (!slug) return null;
    let company = null;
    try {
      company = (await chrome.tabs.sendMessage(tab.id, { type: 'context' }))?.company ?? null;
    } catch {
      company = null;
    }
    if (company?.slug) return company;
    try {
      return { slug: decodeURIComponent(slug).toLowerCase() };
    } catch {
      return null;
    }
  }

  function renderInvites(invites) {
    const section = document.getElementById('invites');
    if (!invites) {
      section.hidden = true;
      return;
    }
    const part = (count, limit, label) =>
      element('span', {
        className: count >= limit ? 'limit' : '',
        text: `${count} of ${limit} ${label}`,
      });
    section.replaceChildren(
      element('h2', { text: 'Invites you sent' }),
      element('p', { className: 'meta' }, [
        part(invites.today, invites.daily, 'in the last day'),
        document.createTextNode(' · '),
        part(invites.week, invites.weekly, 'in the last 7 days'),
      ]),
    );
    section.hidden = false;
  }

  function personCard(person, extra = []) {
    return element('article', { className: 'card' }, [
      element('div', { className: 'title' }, [
        element('h3', { text: person.name || person.profileKey, dir: 'auto' }),
        element('span', {
          className: 'badge',
          text: statusLabels[person.status] || person.status,
          attributes: { 'data-status': person.status },
        }),
      ]),
      person.headline
        ? element('p', { className: 'meta', text: person.headline, dir: 'auto' })
        : null,
      ...extra,
    ]);
  }

  function renderCompany(page, company) {
    const section = document.getElementById('company');
    if (!page) {
      section.replaceChildren(
        element('p', {
          className: 'muted',
          text: "Open a company's People tab on LinkedIn. Each invite you send there shows up here.",
        }),
      );
      return;
    }
    if (!company) {
      section.replaceChildren(
        element('h2', { text: page.name || page.slug, dir: 'auto' }),
        element('p', {
          className: 'muted',
          text: 'Nobody invited here yet. Invites you send on its People tab show up here.',
        }),
      );
      return;
    }
    const counts = company.counts;
    const tick = element('input', { attributes: { type: 'checkbox' } });
    tick.checked = company.noLuck.choice === 'no_luck';
    tick.addEventListener('change', async () => {
      tick.disabled = true;
      try {
        const result = await ask({
          type: 'noLuck',
          id: company.id,
          noLuck: tick.checked,
          revision: company.revision,
        });
        if (result?.apply?.state === 'failed')
          showNotice(`Marked no luck, but the apply chat didn't start: ${result.apply.error}`);
      } catch (error) {
        tick.checked = !tick.checked;
        showNotice(error.message);
      } finally {
        tick.disabled = false;
        void refresh();
      }
    });
    const noLuck = company.noLuck.value
      ? company.noLuck.by === 'owner'
        ? 'You marked it no luck. Nod applies on its own site and asks before anything is submitted.'
        : 'Nod counts it as no luck. Tick the box to let Nod apply on its own site.'
      : '';
    section.replaceChildren(
      element('h2', { text: company.name, dir: 'auto' }),
      element('p', {
        className: 'meta',
        text: `${counts.invited} invited · ${counts.accepted} accepted · ${counts.asked} asked · ${counts.replied} replied`,
      }),
      element('label', { className: 'tick' }, [
        tick,
        element('span', { text: 'No luck, apply here' }),
      ]),
      element('p', { className: 'meta', text: noLuck }),
      company.people.length
        ? element(
            'div',
            { className: 'list' },
            company.people.map((person) =>
              personCard(person, [
                element('div', { className: 'row' }, [link('Open profile', person.profileUrl)]),
              ]),
            ),
          )
        : element('p', { className: 'muted', text: 'Nobody invited here yet.' }),
    );
  }

  function acceptedCard(person) {
    const actions = element('div', { className: 'row' }, [
      link('Open profile', person.profileUrl),
      link('Message', person.messageUrl),
      button('CV', async (node) => {
        const result = await ask({ type: 'cv' });
        node.textContent = 'CV downloaded';
        node.title = result.filename;
      }),
      button('I sent it', async () => {
        await ask({ type: 'status', id: person.id, status: 'asked', revision: person.revision });
        await refresh();
      }),
    ]);
    const draft = person.draft
      ? [
          element('p', {
            className: 'message',
            text: person.draft,
            dir: direction(person.language),
          }),
          element('div', { className: 'row' }, [
            button('Copy message', async (node) => {
              await navigator.clipboard.writeText(person.draft);
              node.textContent = 'Copied';
            }),
          ]),
        ]
      : [
          element('p', {
            className: 'muted',
            text: 'The prepared message appears here once Nod has written it.',
          }),
        ];
    return personCard(person, [
      element('p', {
        className: 'meta',
        text: `${person.company}${person.times?.accepted ? ` · accepted ${when.format(new Date(person.times.accepted))}` : ''}`,
        dir: 'auto',
      }),
      actions,
      ...draft,
    ]);
  }

  function renderAccepted(people) {
    const section = document.getElementById('accepted');
    section.replaceChildren(
      element('h2', { text: 'Accepted, waiting for your message' }),
      people?.length
        ? element('div', { className: 'list' }, people.map(acceptedCard))
        : element('p', { className: 'muted', text: 'Nobody is waiting for your message.' }),
    );
  }

  function render(page, state) {
    const status = document.getElementById('status');
    status.textContent = stateLabels[state.status] || stateLabels.error;
    status.dataset.state = state.status;
    document.getElementById('connections').checked = state.settings?.connections !== false;
    const notice = document.getElementById('notice');
    if (state.status !== 'ready') showNotice(state.error);
    else if (state.problem) showNotice(state.problem.text, () => ask({ type: 'dismiss' }));
    else notice.hidden = true;
    if (state.status !== 'ready') {
      renderInvites(null);
      document.getElementById('company').replaceChildren();
      document.getElementById('accepted').replaceChildren();
      return;
    }
    renderInvites(state.invites);
    renderCompany(page, state.company);
    renderAccepted(state.accepted);
    if (state.waiting)
      document.getElementById('accepted').append(
        element('p', {
          className: 'meta',
          text: `${state.waiting} invite${state.waiting === 1 ? '' : 's'} waiting to reach Nod.`,
        }),
      );
  }

  async function refresh() {
    try {
      const page = await currentPage();
      const state = await ask({ type: 'state', page });
      render(page, state);
    } catch (error) {
      showNotice(error.message);
    }
  }

  document.getElementById('refresh').addEventListener('click', () => void refresh());
  document.getElementById('connections').addEventListener('change', async (event) => {
    await ask({ type: 'settings', connections: event.target.checked }).catch((error) =>
      showNotice(error.message),
    );
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'changed') void refresh();
  });
  chrome.tabs.onActivated.addListener(() => void refresh());
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.active && change.url) void refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, 20_000);
  void refresh();
})();
