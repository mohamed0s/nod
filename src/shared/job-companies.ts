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

export const jobCompanyFilters = ['all', 'waiting', 'to_ask', 'asked', 'no_luck'] as const;
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
  revision: number;
  lastActivityAt: string | null;
};

export type JobCompaniesView = {
  companies: JobCompany[];
  total: number;
  counts: Record<JobCompanyFilter, number>;
  limits: { noAcceptDays: number; noReplyDays: number };
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
  revision: number;
  updatedAt: string;
};

export type JobCompanyView = JobCompany & {
  people: JobPerson[];
  postings: JobPosting[];
  limits: { noAcceptDays: number; noReplyDays: number };
};

export type JobNoLuckResult = {
  company: JobCompanyView;
  apply: null | { state: 'started' | 'reused' } | { state: 'failed'; error: string };
};
