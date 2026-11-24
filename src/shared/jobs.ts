import { z } from 'zod';

export const jobPlaceholders = [
  'greeting',
  'first_name',
  'company',
  'programme',
  'track',
  'role',
  'my_name',
  'my_intro',
] as const;

export const cvMimeTypes = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
} as const;

const text = (max: number) => z.string().trim().max(max);
const item = (max: number) => z.string().trim().min(1).max(max);
export const languageTag = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'Use a language tag such as en or fr-CA.');

export const jobProfileFields = {
  name: text(120),
  intro: text(600),
  location: text(200),
  targetRoles: z.array(item(120)).max(30),
  regions: z.array(item(120)).max(30),
  languages: z.array(item(60)).max(20),
  languageRule: z
    .object({
      default: languageTag,
      byCountry: z.record(
        z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code such as CA.'),
        languageTag,
      ),
    })
    .strict(),
  programmes: z
    .array(z.object({ name: item(160), tracks: z.array(item(160)).max(50) }).strict())
    .max(50),
  workAuthorization: text(400),
  links: z.array(z.object({ label: item(60), url: z.url().max(500) }).strict()).max(20),
  inviteLimits: z
    .object({ daily: z.int().min(0).max(100), weekly: z.int().min(0).max(500) })
    .strict(),
  noLuck: z
    .object({ noAcceptDays: z.int().min(1).max(90), noReplyDays: z.int().min(1).max(90) })
    .strict(),
  waves: z.object({ size: z.int().min(1).max(50), max: z.int().min(1).max(200) }).strict(),
};

export const defaultJobProfile: JobProfile = {
  name: '',
  intro: '',
  location: '',
  targetRoles: [],
  regions: [],
  languages: [],
  languageRule: { default: 'en', byCountry: {} },
  programmes: [],
  workAuthorization: '',
  links: [],
  inviteLimits: { daily: 15, weekly: 80 },
  noLuck: { noAcceptDays: 7, noReplyDays: 5 },
  waves: { size: 5, max: 10 },
};

export const jobProfileSchema = z.object(jobProfileFields).strict();
export type JobProfile = z.infer<typeof jobProfileSchema>;
export const jobProfilePatch = z
  .object({
    ...jobProfileFields,
    languageRule: jobProfileFields.languageRule.partial(),
    inviteLimits: jobProfileFields.inviteLimits.partial(),
    noLuck: jobProfileFields.noLuck.partial(),
    waves: jobProfileFields.waves.partial(),
  })
  .partial()
  .strict();
export type JobProfilePatch = z.infer<typeof jobProfilePatch>;

export const jobPortalsSchema = z.record(z.string().min(1).max(80), z.unknown());

export const jobTemplateSchema = z
  .object({
    language: languageTag,
    body: z.string().trim().min(1).max(4000),
    greetings: z.record(z.string().regex(/^[a-z_]{1,30}$/), item(80)),
  })
  .strict();
export type JobTemplate = z.infer<typeof jobTemplateSchema>;

export function unknownPlaceholders(body: string) {
  return [
    ...new Set(
      [...body.matchAll(/\{([^{}]*)\}/g)]
        .map((match) => match[1]!)
        .filter((name) => !(jobPlaceholders as readonly string[]).includes(name)),
    ),
  ];
}

export const jobLimitFields = ['inviteLimits', 'noLuck', 'waves'] as const;

export type JobCv = {
  id: string;
  label: string;
  isMain: boolean;
  status: 'converting' | 'ready';
  revision: number;
  markdown: string;
  file: { id: string; name: string; mimeType: string; url: string } | null;
  pdf: { id: string; name: string; url: string } | null;
  pdfFile: string;
  converting: boolean;
  createdAt: string;
  updatedAt: string;
};

export type JobRevision<T> = {
  id: string;
  revision: number;
  actor: 'owner' | 'nod';
  createdAt: string;
  data: T;
};

export type JobSetup = {
  items: Array<{ key: 'cv' | 'profile' | 'templates'; done: boolean }>;
  mainCv: { id: string; label: string; status: JobCv['status'] } | null;
};

export type JobProfileView = {
  profile: JobProfile;
  portals: Record<string, unknown>;
  revision: number;
};

export type JobTemplatesView = {
  templates: Array<JobTemplate & { revision: number }>;
  examples: boolean;
  revision: number;
};
