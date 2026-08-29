/** Shared safety policy for configured HTTP provider endpoints. */

export interface BaseUrlValidation {
  ok: boolean;
  problems: string[];
  /** True for localhost / 127.0.0.0/8 / [::1]. */
  loopback: boolean;
  protocol?: string;
  hostname?: string;
  port?: string;
}
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Reject non-http(s) schemes, embedded credentials, malformed hosts, and
 * remote plain HTTP unless a clearly labelled development override exists.
 */
export function validateRunnerBaseUrl(
  raw: string,
  options?: { allowInsecureHttp?: boolean },
): BaseUrlValidation {
  const problems: string[] = [];
  if (raw.includes('\0')) {
    return { ok: false, problems: ['must not contain null bytes'], loopback: false };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problems: [`"${raw}" is not a valid absolute URL`], loopback: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`unsupported URL scheme "${url.protocol}" — only http: and https: are allowed`);
  }
  if (url.username !== '' || url.password !== '') {
    problems.push('must not embed credentials (username/password) in the URL');
  }
  if (url.hostname === '') problems.push('must include a hostname');
  if (url.search !== '' || url.hash !== '') {
    problems.push('must not include a query string or fragment');
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === 'http:' && !loopback && options?.allowInsecureHttp !== true) {
    problems.push(
      'remote endpoints must use https: by default. For a private development endpoint, ' +
        'set "allowInsecureHttp": true on the profile (clearly labeled as insecure).',
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    loopback,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
  };
}
