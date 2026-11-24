globalThis.nodLinkedInReaders = (() => {
  const site = 'https://www.linkedin.com';
  const member = /^ACoAA[A-Za-z0-9_-]{10,120}$/;
  const miniProfile = /^urn:li:fs_miniProfile:(ACoAA[A-Za-z0-9_-]{10,120})$/;
  const hiddenParts = '.visually-hidden, [hidden], script, style';

  const text = (node) => {
    if (!node) return '';
    const walker = node.ownerDocument.createTreeWalker(node, 4);
    let value = '';
    for (let current = walker.nextNode(); current; current = walker.nextNode())
      if (!current.parentElement?.closest(hiddenParts)) value += current.nodeValue;
    return value.replace(/\s+/g, ' ').trim();
  };

  const decoded = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return '';
    }
  };

  const onSite = (href) => {
    try {
      const url = new URL(href, site);
      return url.origin === site ? url : null;
    } catch {
      return null;
    }
  };

  function profileLink(href) {
    const url = onSite(href);
    if (!url) return null;
    const segment = /^\/in\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    const own = segment ? decoded(segment) : '';
    if (!own) return null;
    const fromQuery = miniProfile.exec(url.searchParams.get('miniProfileUrn') || '')?.[1];
    const memberUrn = member.test(own) ? own : fromQuery;
    return {
      profileUrl: `${site}/in/${segment}/`,
      ...(memberUrn ? { memberUrn } : {}),
    };
  }

  function companyContext(doc, loc) {
    const slug = /^\/company\/([^/]+)/.exec(loc.pathname)?.[1];
    if (!slug || !decoded(slug)) return null;
    const heading = text(doc.querySelector('main h1'));
    const title = (doc.title || '')
      .replace(/^\(\d+\+?\)\s*/, '')
      .split(' | ')[0]
      .split(': ')[0]
      .trim();
    const name = (heading || title).slice(0, 200);
    return { slug: decoded(slug).toLowerCase(), ...(name ? { name } : {}) };
  }

  const onPeopleTab = (loc) => /^\/company\/[^/]+\/people\/?$/.test(loc.pathname);
  const onConnections = (loc) => /^\/mynetwork\/invite-connect\/connections\/?$/.test(loc.pathname);

  function pending(card) {
    return [...card.querySelectorAll('button')].some((button) => {
      const label = (button.getAttribute('aria-label') || '').trim();
      return /^pending\b/i.test(label) || /^pending$/i.test(text(button));
    });
  }

  function personName(card, link) {
    const title = text(card.querySelector('.artdeco-entity-lockup__title'));
    if (title) return title;
    const label = /^View (.+?)[’']s profile$/.exec(link.getAttribute('aria-label') || '')?.[1];
    if (label) return label.trim();
    return text(link) || (link.querySelector('img')?.getAttribute('alt') || '').trim();
  }

  function peopleCards(doc) {
    const main = doc.querySelector('main') || doc.body;
    if (!main) return [];
    const cards = [...main.querySelectorAll('li')].filter(
      (item) =>
        item.querySelector('a[href*="/in/"]') &&
        item.querySelector('button') &&
        !item.querySelector(':scope li a[href*="/in/"]'),
    );
    const people = [];
    for (const card of cards) {
      const link = [...card.querySelectorAll('a[href*="/in/"]')].find((anchor) =>
        profileLink(anchor.getAttribute('href') || ''),
      );
      if (!link) continue;
      const profile = profileLink(link.getAttribute('href') || '');
      const name = personName(card, link).slice(0, 200);
      if (!profile || !name) continue;
      people.push({
        person: {
          ...profile,
          name,
          headline: text(card.querySelector('.artdeco-entity-lockup__subtitle')).slice(0, 400),
        },
        pending: pending(card),
      });
    }
    return people;
  }

  function profileIdentity(doc, loc) {
    const segment = /^\/in\/([^/]+)\/?$/.exec(loc.pathname)?.[1];
    const own = segment ? decoded(segment) : '';
    if (!own || member.test(own)) return null;
    const top = doc.querySelector('main h1')?.closest('section');
    if (!top) return null;
    const found = new Set();
    for (const anchor of top.querySelectorAll('a[href]')) {
      const url = onSite(anchor.getAttribute('href') || '');
      if (!url || !/^\/messaging\/compose\/?$/.test(url.pathname)) continue;
      const recipient = url.searchParams.get('recipient') || '';
      if (member.test(recipient)) found.add(recipient);
    }
    if (found.size !== 1) return null;
    return { profileUrl: `${site}/in/${segment}/`, memberUrn: [...found][0] };
  }

  function connections(doc) {
    const main = doc.querySelector('main');
    if (!main) return [];
    const seen = new Map();
    for (const anchor of main.querySelectorAll('a[href*="/in/"]')) {
      const profile = profileLink(anchor.getAttribute('href') || '');
      if (profile) seen.set(profile.profileUrl, { profileUrl: profile.profileUrl });
    }
    return [...seen.values()];
  }

  return {
    profileLink,
    companyContext,
    onPeopleTab,
    onConnections,
    peopleCards,
    profileIdentity,
    connections,
  };
})();
