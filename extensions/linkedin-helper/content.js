(() => {
  const read = globalThis.nodLinkedInReaders;
  const cards = new Map();
  const sentConnections = new Set();
  let page = '';
  let sentProfile = '';
  let timer = 0;

  const send = (message) => {
    chrome.runtime.sendMessage(message).catch(() => {});
  };

  function scan() {
    if (location.href !== page) {
      page = location.href;
      cards.clear();
      sentProfile = '';
    }
    const company = read.companyContext(document, location);
    if (company?.name && read.onPeopleTab(location))
      for (const { person, pending } of read.peopleCards(document)) {
        const known = cards.get(person.profileUrl);
        if (!known) cards.set(person.profileUrl, { pending, sent: false });
        else {
          if (pending && !known.pending && !known.sent) {
            known.sent = true;
            send({ type: 'invite', company, person });
          }
          known.pending = pending;
        }
      }
    const identity = read.profileIdentity(document, location);
    const key = identity ? `${identity.profileUrl} ${identity.memberUrn}` : '';
    if (identity && key !== sentProfile) {
      sentProfile = key;
      send({ type: 'profile', ...identity });
    }
    if (read.onConnections(location)) {
      const fresh = read
        .connections(document)
        .filter((person) => !sentConnections.has(person.profileUrl));
      for (const person of fresh) sentConnections.add(person.profileUrl);
      for (let start = 0; start < fresh.length; start += 100)
        send({ type: 'connections', people: fresh.slice(start, start + 100) });
    }
  }

  const later = () => {
    if (!timer)
      timer = setTimeout(() => {
        timer = 0;
        scan();
      }, 400);
  };

  new MutationObserver(later).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-pressed', 'disabled'],
  });

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'context') return;
    reply({ company: read.companyContext(document, location) });
  });

  scan();
})();
