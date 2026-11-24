import type { JobProfile } from '../shared/jobs.ts';

function bullets(items: string[], empty: string) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function careerOpsProfile(profile: JobProfile) {
  const link = (pattern: RegExp) => profile.links.find((entry) => pattern.test(entry.label))?.url;
  const linkedin = link(/linkedin/i);
  const github = link(/github/i);
  const portfolio = profile.links.find((entry) => !/linkedin|github/i.test(entry.label))?.url;
  return {
    candidate: {
      full_name: profile.name,
      location: profile.location,
      ...(linkedin ? { linkedin } : {}),
      ...(github ? { github } : {}),
      ...(portfolio ? { portfolio_url: portfolio } : {}),
    },
    target_roles: {
      primary: profile.targetRoles,
      archetypes: profile.targetRoles.map((name) => ({ name, fit: 'primary' })),
    },
    narrative: { headline: profile.intro },
    location: { visa_status: profile.workAuthorization },
    language: { output: profile.languageRule.default },
  };
}

function profileNotes(profile: JobProfile) {
  return `# Job search profile

Nod writes this file from the owner's job profile. Change the profile in Nod; edits here are replaced.

## Introduction
${profile.intro || 'Not set.'}

## Target roles
${bullets(profile.targetRoles, 'Not set.')}

## Regions
${bullets(profile.regions, 'Not set.')}

## Location
${profile.location || 'Not set.'}

## Work authorization
${profile.workAuthorization || 'Not set.'}

## Languages
${bullets(profile.languages, 'Not set.')}

## Programmes and tracks
${bullets(
  profile.programmes.map((entry) =>
    entry.tracks.length ? `${entry.name}: ${entry.tracks.join(', ')}` : entry.name,
  ),
  'None.',
)}
`;
}

function brief(profile: JobProfile) {
  return `# Triage brief

Nod writes this file from the owner's job profile for short checks. Full scoring also reads cv.md and modes/_profile.md.

## Identity
${[profile.name, profile.intro].filter(Boolean).join(': ') || 'Not set.'}
Location: ${profile.location || 'not set'}. Work authorization: ${profile.workAuthorization || 'not set'}.

## Target roles
${bullets(profile.targetRoles, 'Not set.')}

## Regions
${bullets(profile.regions, 'Any.')}

## Quick check
- A role that matches a target role in a listed region can pass.
- A role that needs work authorization the profile doesn't show, or a seniority far from the CV, fails.
- Anything else is marginal: say why in one line.
`;
}

const defaultBoards = [
  { name: 'Remotive', provider: 'remotive' },
  { name: 'Himalayas', provider: 'himalayas' },
  { name: 'Jobicy', provider: 'jobicy' },
  { name: 'Remote OK', provider: 'remoteok' },
  { name: 'We Work Remotely', provider: 'weworkremotely' },
  { name: 'Working Nomads', provider: 'workingnomads' },
];

export function scanConfig(profile: JobProfile, portals: Record<string, unknown>) {
  if (!profile.targetRoles.length && !Object.keys(portals).length) return undefined;
  return {
    title_filter: { positive: profile.targetRoles, negative: [] },
    ...(profile.regions.length
      ? { location_filter: { allow: [...new Set([...profile.regions, 'Remote'])] } }
      : {}),
    tracked_companies: [],
    job_boards: defaultBoards,
    ...portals,
  };
}

export function scanSummary(config: Record<string, unknown> | undefined) {
  const named = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter(
      (entry): entry is { name: string; enabled?: unknown } =>
        Boolean(entry) && typeof entry === 'object' && typeof entry.name === 'string',
    );
  return {
    boards: named(config?.job_boards)
      .filter((entry) => entry.enabled !== false)
      .map((entry) => entry.name),
    companies: named(config?.tracked_companies).filter((entry) => entry.enabled !== false).length,
  };
}

export function careerOpsFiles(input: {
  profile: JobProfile;
  portals: Record<string, unknown>;
  main?: { markdown: string } | undefined;
}) {
  const { profile, portals, main } = input;
  const files: Record<string, string> = {
    'config/profile.yml': `${JSON.stringify(careerOpsProfile(profile), null, 2)}\n`,
    'modes/_profile.md': profileNotes(profile),
    'modes/_brief.md': brief(profile),
  };
  const skipped: Record<string, string> = {};
  if (main?.markdown) files['cv.md'] = `${main.markdown}\n`;
  else
    skipped['cv.md'] = main ? 'The main CV has no converted text yet.' : 'There is no main CV yet.';
  const scan = scanConfig(profile, portals);
  if (scan) files['portals.yml'] = `${JSON.stringify(scan, null, 2)}\n`;
  else skipped['portals.yml'] = 'The profile has no target roles or scan sources yet.';
  return { files, skipped };
}
