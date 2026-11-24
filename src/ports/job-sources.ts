export type TelegramPost = { id: number; date: string | null; text: string; links: string[] };

export interface TelegramChannels {
  read(channel: string, options: { before?: number; signal: AbortSignal }): Promise<TelegramPost[]>;
}
