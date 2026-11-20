import type { ChannelLinkStatus } from '../shared/contracts.ts';

export class MessagingConnectionError extends Error {}

export class MessagingTopicError extends Error {}

export class MessagingAttachmentError extends Error {
  constructor(readonly maxBytes: number) {
    super('The channel file is too large.');
  }
}

export interface MessagingChannel {
  id: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
  accountId?: string;
  allowedSenderIds: string[];
  replyWindowMs?: number;
  supportsAttachments?: boolean;
  available?: boolean;
  error?: string;
  presenceMs?: number;
}

export interface MessagingAttachment {
  name: string;
  mimeType: string;
  size: number;
  voice?: boolean;
  source?: 'sticker' | 'sticker-preview' | 'location' | 'contact';
  read(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface InboundMessage {
  channelId: string;
  accountId: string;
  senderId: string;
  messageId: string;
  threadId: string;
  topicId?: string;
  text: string;
  attachments?: MessagingAttachment[];
  replyToMessageId?: string;
  sentAt: Date;
}

export interface InboundReaction {
  channelId: string;
  accountId: string;
  senderId: string;
  messageId: string;
  reaction: string | null;
}

export interface ChannelPairingRequest {
  channelId: string;
  accountId: string;
  senderId: string;
  senderName: string;
  senderUsername?: string;
  messageId: string;
  threadId: string;
  code: string;
  sentAt: Date;
}

interface MessagingWebhook {
  channelId: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
  body: Uint8Array;
}

export interface MessagingWebhookResult {
  status: number;
  body: string | Record<string, unknown>;
  contentType?: string;
  messages?: InboundMessage[];
  reactions?: InboundReaction[];
  pairing?: ChannelPairingRequest;
}

export interface MessagingTransport {
  channels: MessagingChannel[];
  pairing?(): Promise<ChannelLinkStatus>;
  cancelPairing?(pairingId: string, restart?: boolean): Promise<boolean>;
  unlink?(): Promise<void>;
  poll?(
    accept: (message: InboundMessage) => Promise<void>,
    pair?: (request: ChannelPairingRequest) => Promise<void>,
    react?: (reaction: InboundReaction) => Promise<void>,
  ): Promise<void>;
  receive(request: MessagingWebhook): Promise<MessagingWebhookResult>;
  post(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    topicId?: string;
    text: string;
    attachments?: MessagingAttachment[];
    replyToMessageId?: string;
    replyToText?: string;
    attachmentFailure?: (names: string[]) => Promise<string | undefined>;
  }): Promise<{ id: string; ids?: string[] }>;
  topics?(input: { channelId: string; accountId: string; signal?: AbortSignal }): Promise<boolean>;
  createTopic?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    name: string;
    signal?: AbortSignal;
  }): Promise<string>;
  renameTopic?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    topicId: string;
    name: string;
    signal?: AbortSignal;
  }): Promise<void>;
  react?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    reaction: string | null;
    signal?: AbortSignal;
  }): Promise<'sent' | 'unsupported'>;
  presence?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    status?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  progress?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    text: string;
    status: string | null;
    signal: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
}
