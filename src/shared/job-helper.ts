import type { JobCompanyView, JobDraft, JobPerson, JobWaves } from './job-companies';

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

export type JobHelperPerson = Omit<JobPerson, 'draftInfo'> & {
  draftInfo: Omit<JobDraft, 'raw' | 'templateRevision' | 'languageBy' | 'at'> | null;
};

export type JobHelperCompany = {
  company: (Omit<JobCompanyView, 'postings' | 'people'> & { people: JobHelperPerson[] }) | null;
  invites: JobHelperInvites;
};

export type JobHelperAccepted = {
  people: Array<JobHelperPerson & { company: string; waves: JobWaves }>;
  languages: string[];
};
