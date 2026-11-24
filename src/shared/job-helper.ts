import type { JobCompanyView, JobPerson } from './job-companies';

export type JobHelper = {
  id: string;
  extensionId: string;
  pairedAt: string;
  lastUsedAt: string | null;
};

export type JobHelperView = {
  helpers: JobHelper[];
  pairing: { expiresAt: string } | null;
};

export type JobHelperPairing = { code: string; expiresAt: string };

export type JobHelperInvites = { today: number; week: number; daily: number; weekly: number };

export type JobHelperCompany = {
  company: Omit<JobCompanyView, 'postings'> | null;
  invites: JobHelperInvites;
};

export type JobHelperAccepted = { people: Array<JobPerson & { company: string }> };
