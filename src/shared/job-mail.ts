import type { JobOutcomeLabel } from './job-companies';

export const jobMailCounts = [
  'emails',
  'accepted',
  'personReplies',
  'employerReplies',
  'already',
  'seenBefore',
  'toAsk',
  'unverified',
  'withheld',
  'noHeaders',
  'ignored',
] as const;
export type JobMailCount = (typeof jobMailCounts)[number];

export type JobMailRun = {
  at: string;
  counts: Record<JobMailCount, number>;
  reasons: string[];
};

export type JobMailView = {
  accounts: Array<{ id: string; address: string }>;
  account: { id: string; address: string } | null;
  accountGone: boolean;
  schedule: { id: string; title: string; enabled: boolean } | null;
  revision: number;
  lastRun: JobMailRun | null;
};

export type JobFunnel = {
  invited: number;
  accepted: number;
  asked: number;
  replied: number;
  referred: number;
  rates: {
    accepted: number | null;
    asked: number | null;
    replied: number | null;
    referred: number | null;
  };
};

export type JobReport = {
  since: string;
  until: string;
  timeZone: string;
  period: {
    invited: number;
    accepted: number;
    asked: number;
    replied: number;
    referred: number;
    applications: number;
    employerReplies: number;
    interviews: number;
    rejections: number;
  };
  funnel: {
    all: JobFunnel;
    byCompany: Array<JobFunnel & { company: string }>;
    byLanguage: Array<JobFunnel & { language: string }>;
    byTemplate: Array<JobFunnel & { language: string; revision: number | null }>;
  };
  applications: Array<{
    company: string;
    title: string;
    appliedAt: string | null;
    outcome: JobOutcomeLabel | null;
    outcomeAt: string | null;
  }>;
  interviews: Array<{ company: string; title: string | null; at: string }>;
  replies: Array<{
    kind: 'person' | 'employer';
    company: string;
    name: string | null;
    label: JobOutcomeLabel | null;
    at: string;
  }>;
  followUpsDue: Array<{
    personId: string;
    name: string;
    company: string;
    askedAt: string;
    dueAt: string;
  }>;
};
