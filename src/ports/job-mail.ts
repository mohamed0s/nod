export interface JobMailMessage {
  id: string;
  receivedAt: number;
  sender: string | null;
  recipients: string[];
  senderName: string;
  subject: string;
  authenticatedDomain: string | null;
  signedDomains: string[];
  text: string;
  links: string[];
}

export interface JobMailReader {
  list(
    accountId: string,
    query: string,
    max: number,
    signal: AbortSignal,
  ): Promise<{ ids: string[]; more: boolean }>;
  read(accountId: string, ids: string[], signal: AbortSignal): Promise<JobMailMessage[]>;
}
