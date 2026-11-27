import { SpeechProviderError } from '../ports/speech.ts';
import { modelServiceError } from './model-error.ts';
import { appPages } from '../shared/app-links.ts';

export async function readSpeechResponse(
  response: Response,
  limit: number,
  provider = 'The voice service',
  secrets: string[] = [],
) {
  if (!response.ok || !response.body) {
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new SpeechProviderError(
        response.status === 401
          ? `${provider} needs to be reconnected. Open ${appPages['/settings/voice']}.`
          : `${provider} did not allow this audio request. Check the connection’s speech permissions.`,
      );
    }
    const failure = await modelServiceError(response, provider, secrets);
    throw new SpeechProviderError(
      response.status === 429
        ? `${provider} rate-limited this request${failure.reason ? `: ${Array.from(failure.reason).slice(0, 300).join('')}` : '.'}`
        : response.status === 402
          ? `${failure.message} Check its credits.`
          : failure.message,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks);
      size += part.value.length;
      if (size > limit) throw new Error('The speech response is too large.');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
