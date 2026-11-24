import { z } from 'zod';

export const jobPostingStatuses = ['new', 'shortlisted', 'skipped'] as const;
export type JobPostingStatus = (typeof jobPostingStatuses)[number];

export const jobSourceKinds = ['career-ops', 'telegram', 'email', 'web'] as const;
export type JobSourceKind = (typeof jobSourceKinds)[number];

export const jobSwitches = ['scan', 'scan:full', 'email'] as const;
export type JobSwitch = (typeof jobSwitches)[number];
export const jobSwitchDefaults: Record<JobSwitch, boolean> = {
  scan: true,
  'scan:full': false,
  email: true,
};

export const telegramChannel = z
  .string()
  .trim()
  .max(200)
  .refine((value) => !/(?:^|\/)(?:joinchat\b|\+)/i.test(value), {
    message: "That's an invite link. Nod reads public channels only, by their name.",
  })
  .transform((value) =>
    value
      .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?/i, '')
      .replace(/^@/, '')
      .replace(/[/?#].*$/, ''),
  )
  .pipe(
    z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9_]{4,31}$/,
        'Use a public channel name such as example_jobs, @example_jobs or https://t.me/example_jobs.',
      ),
  );

export type JobPosting = {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  sources: Array<{ kind: JobSourceKind; detail: string; url: string }>;
  postedAt: string | null;
  score: number | null;
  scoreKind: 'short' | 'full' | null;
  summary: string;
  excerpt: string;
  status: JobPostingStatus;
  programme: string;
  track: string;
  revision: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type JobPostingsView = {
  postings: JobPosting[];
  total: number;
  counts: Record<JobPostingStatus, number>;
};

export type JobChannel = {
  name: string;
  enabled: boolean;
  revision: number;
  lastPostId: number | null;
  lastReadAt: string | null;
  lastError: string | null;
};

export type JobSourcesView = {
  channels: JobChannel[];
  switches: Array<{ key: JobSwitch; enabled: boolean; revision: number }>;
  boards: string[];
  companies: number;
};
