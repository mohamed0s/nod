export const pageBytes = 2 * 1024 * 1024;
export const keptPageVersions = 10;
export const pageTitleLength = 120;

export function pageTitle(value: string) {
  return [
    ...value
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, pageTitleLength)
    .join('')
    .trim();
}

export type PageSource =
  | { kind: 'schedule'; id: string; title: string | null }
  | { kind: 'task'; id: string; title: string }
  | { kind: 'chat'; current: boolean }
  | { kind: 'owner' };

export interface PageFile {
  id: string;
  url: string;
  size: number;
}

export interface PageView {
  id: string;
  title: string;
  revision: number;
  file: PageFile | null;
  source: PageSource;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface PageVersion {
  revision: number;
  file: PageFile | null;
  source: PageSource;
  createdAt: string;
}
