import type { JobPosting } from './job-postings';

export const jobPersonStatuses = [
  'invited',
  'accepted',
  'asked',
  'replied',
  'referred',
  'declined',
] as const;
export type JobPersonStatus = (typeof jobPersonStatuses)[number];

export const jobCompanyFilters = [
  'all',
  'waiting',
  'to_ask',
  'asked',
  'next_wave',
  'no_luck',
] as const;
export type JobCompanyFilter = (typeof jobCompanyFilters)[number];

export const jobNoLuckChoices = ['auto', 'no_luck', 'keep_trying'] as const;
export type JobNoLuckChoice = (typeof jobNoLuckChoices)[number];

export type JobCompanyCounts = {
  invited: number;
  accepted: number;
  asked: number;
  replied: number;
  referred: number;
};

export type JobNoLuck = {
  value: boolean;
  by: 'owner' | 'rule' | null;
  since: string | null;
  choice: JobNoLuckChoice;
};

export const jobWaveStates = ['open', 'waiting', 'next', 'stopped', 'done'] as const;
export type JobWaveState = (typeof jobWaveStates)[number];

export type JobWaves = {
  state: JobWaveState;
  wave: number;
  inWave: number;
  left: number;
  more: number;
  invited: number;
  size: number;
  max: number;
  today: number;
  week: number;
  daily: number;
  weekly: number;
  over: 'day' | 'week' | null;
  until: string | null;
  owed: number;
};

export type JobLimits = {
  noAcceptDays: number;
  noReplyDays: number;
  waves: { size: number; max: number };
};

export const jobDraftStates = [
  'filled',
  'tailoring',
  'tailored',
  'failed',
  'edited',
  'missing',
] as const;
export type JobDraftState = (typeof jobDraftStates)[number];

export type JobDraft = {
  text: string;
  raw: string;
  state: JobDraftState;
  reason: string;
  note: string;
  early: boolean;
  language: string;
  languageBy: 'owner' | 'guess' | 'default' | null;
  templateRevision: number | null;
  missing: string[];
  editedBy: 'owner' | 'nod' | null;
  at: string | null;
};

export type JobCompany = {
  id: string;
  name: string;
  linkedinUrl: string | null;
  careersUrl: string | null;
  openPostings: number;
  bestScore: number | null;
  counts: JobCompanyCounts;
  noLuck: JobNoLuck;
  applyChat: { id: string; state: 'open' | 'starting' | 'lost' } | null;
  waves: JobWaves;
  revision: number;
  lastActivityAt: string | null;
};

export type JobCompaniesView = {
  companies: JobCompany[];
  total: number;
  counts: Record<JobCompanyFilter, number>;
  limits: JobLimits;
  invites: { today: number; week: number; daily: number; weekly: number };
};

export type JobPerson = {
  id: string;
  companyId: string;
  name: string;
  headline: string;
  language: string;
  profileKey: string;
  profileUrl: string;
  messageUrl: string | null;
  status: JobPersonStatus;
  statusAt: string | null;
  times: Partial<Record<JobPersonStatus, string>>;
  draft: string;
  draftRevision: number;
  draftInfo: JobDraft | null;
  revision: number;
  updatedAt: string;
};

export type JobCompanyView = JobCompany & {
  people: JobPerson[];
  postings: JobPosting[];
  limits: JobLimits;
};

export type JobNoLuckResult = {
  company: JobCompanyView;
  apply: null | { state: 'started' | 'reused' } | { state: 'failed'; error: string };
};
