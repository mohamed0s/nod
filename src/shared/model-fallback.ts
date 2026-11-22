export type ModelUnavailable = 'busy' | 'quota';

const refusal = /\b(?:content[ _-]?(?:filter|policy|management)|refusal|moderation)\b/i;
const overflow =
  /context (?:length|window)|maximum context|prompt is too long|input is too long|reduce the length/i;
const tokenRate = /\b(?:tokens? per (?:minute|day)|[tr]p[md])\b/i;
const quota =
  /insufficient_quota|quota|RESOURCE_EXHAUSTED|credits? (?:are |is )?(?:depleted|exhausted)|insufficient (?:credits|balance|funds)|usage limit|billing|payment required|requests to this model are paused/i;
const busy =
  /overloaded|at capacity|rate.?limit|too many requests|server.?busy|servers are (?:currently )?busy|high demand|(?:temporarily|service) unavailable|timed? ?out|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_[A-Z_]+|socket hang up|other side closed|fetch failed|network.?error|connection (?:error|reset|refused|closed|lost)|\bterminated\b|sent no response|upstream (?:connect|request|error)|stream (?:was interrupted|ended)/i;

function httpStatus(text: string) {
  const appended = [...text.matchAll(/\(HTTP (\d{3})\)/g)].at(-1)?.[1];
  const status = Number(
    appended ??
      /^(\d{3})\b|\bHTTP[ /]?(\d{3})\b|\bstatus(?: code)?:? ?(\d{3})\b|\berror \((\d{3})\)/i
        .exec(text)
        ?.slice(1)
        .find(Boolean),
  );
  return status >= 400 ? status : undefined;
}

export function modelUnavailable(
  text: string | undefined,
  retryable = false,
): ModelUnavailable | undefined {
  if (!text || refusal.test(text)) return;
  if (overflow.test(text) && !tokenRate.test(text)) return;
  const status = httpStatus(text);
  if (status === 402 || (status === 400 && /credit balance is too low/i.test(text))) return 'quota';
  if (status === 408) return 'busy';
  if (status === 429)
    return quota.test(text) && !/rate.?limit|too many requests|capacity|overloaded/i.test(text)
      ? 'quota'
      : 'busy';
  if (status !== undefined)
    return [500, 502, 503, 504, 529].includes(status) || (status >= 520 && status <= 524)
      ? 'busy'
      : undefined;
  if (quota.test(text)) return 'quota';
  if (retryable || busy.test(text)) return 'busy';
}

export function timedOut(text: string | undefined) {
  return Boolean(text && /timed? ?out|timeout|sent no response|ETIMEDOUT/i.test(text));
}

export function retryDelayMs(header: (name: string) => string | null | undefined, text = '') {
  const milliseconds = Number(header('retry-after-ms'));
  if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
  const value = header('retry-after');
  if (value) {
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  const stated =
    /\b(?:retry|try again)\w*\s*(?:after|in)?\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i.exec(
      text,
    );
  if (!stated) return;
  const delay = Number(stated[1]) * (/^m/i.test(stated[2]!) ? 1 : 1000);
  return delay > 0 ? delay : undefined;
}

export function fallbackWait(delay: number | undefined, cap: number, otherwise: number) {
  return Math.min(Math.max(0, delay ?? otherwise), cap);
}
