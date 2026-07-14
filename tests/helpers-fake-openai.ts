import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VALID_DESIGN_REPORT, VALID_STAGE_REPORT } from './helpers-fake-ollama.js';

/**
 * Fake OpenAI-compatible HTTP server for integration tests: a REAL loopback
 * HTTP server (never a mocked adapter method) implementing the
 * chat-completions and responses API styles with scripted behaviors, full
 * request and HEADER recording (for Authorization-forwarding assertions),
 * and redirect scenarios. No network beyond 127.0.0.1, no model, offline.
 */

export type FakeOpenAiBehavior =
  | 'valid'
  | 'valid-design'
  | 'invalid-json'
  | 'schema-invalid'
  | 'extra-prose'
  | 'fenced-json'
  | 'http-500'
  | 'http-401'
  | 'http-429-rate'
  | 'http-429-quota'
  | 'http-400-schema-unsupported'
  | 'timeout'
  | 'huge'
  | 'wrong-content-type'
  | 'redirect-same-origin'
  | 'redirect-cross-origin'
  | 'redirect-loop'
  | 'redirect-ftp';

export interface RecordedOpenAiRequest {
  method: string;
  url: string;
  body: unknown;
  headers: IncomingHttpHeaders;
}

export interface FakeOpenAiOptions {
  /** Behavior per successive inference request; the last entry repeats. */
  behaviors?: FakeOpenAiBehavior[];
  models?: string[];
  /** Require this bearer token on every request (else HTTP 401). */
  requireBearer?: string;
  /** Base URL of ANOTHER server for cross-origin redirect scenarios. */
  redirectTargetUrl?: string;
}

export interface FakeOpenAiServer {
  baseUrl: string;
  port: number;
  requests: RecordedOpenAiRequest[];
  inferenceCalls: () => RecordedOpenAiRequest[];
  close: () => Promise<void>;
}

function chatCompletionsPayload(content: string): unknown {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model: 'fake-oai-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 222,
      completion_tokens: 111,
      prompt_tokens_details: { cached_tokens: 10 },
    },
  };
}

function responsesPayload(content: string): unknown {
  return {
    id: 'resp-fake',
    object: 'response',
    model: 'fake-oai-model',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] },
    ],
    usage: { input_tokens: 222, output_tokens: 111, input_tokens_details: { cached_tokens: 10 } },
  };
}

function isInferencePath(url: string): boolean {
  return /\/(chat\/completions|responses)(\?|$)/.test(url);
}

export async function startFakeOpenAi(options: FakeOpenAiOptions = {}): Promise<FakeOpenAiServer> {
  const requests: RecordedOpenAiRequest[] = [];
  const behaviors = options.behaviors ?? ['valid'];
  let inferenceIndex = 0;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
      } catch {
        body = rawBody;
      }
      const url = request.url ?? '';
      requests.push({ method: request.method ?? '', url, body, headers: request.headers });

      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (options.requireBearer !== undefined) {
        const header = request.headers['authorization'];
        if (header !== `Bearer ${options.requireBearer}`) {
          json(401, { error: { message: 'invalid or missing api key', type: 'invalid_request_error' } });
          return;
        }
      }

      if (/\/models(\?|$)/.test(url)) {
        json(200, {
          object: 'list',
          data: (options.models ?? ['fake-oai-model', 'fake-oai-mini']).map((id) => ({
            id,
            object: 'model',
            owned_by: 'fake-provider',
            created: 1_750_000_000,
          })),
        });
        return;
      }

      if (!isInferencePath(url)) {
        json(404, { error: { message: 'not found' } });
        return;
      }

      const isResponses = url.includes('/responses');
      const payloadFor = (content: string): unknown =>
        isResponses ? responsesPayload(content) : chatCompletionsPayload(content);
      // Redirected requests replay the ORIGINAL behavior index semantics: a
      // '/redirected' prefix marks the hop target and always answers valid.
      if (url.startsWith('/redirected')) {
        json(200, payloadFor(JSON.stringify(VALID_STAGE_REPORT)));
        return;
      }

      const behavior = behaviors[Math.min(inferenceIndex, behaviors.length - 1)] as FakeOpenAiBehavior;
      inferenceIndex += 1;
      switch (behavior) {
        case 'valid':
          json(200, payloadFor(JSON.stringify(VALID_STAGE_REPORT)));
          return;
        case 'valid-design':
          json(200, payloadFor(JSON.stringify(VALID_DESIGN_REPORT)));
          return;
        case 'invalid-json':
          json(200, payloadFor('this is { not json'));
          return;
        case 'schema-invalid':
          json(200, payloadFor(JSON.stringify({ schemaVersion: '1.0.0', stage: 'requirements' })));
          return;
        case 'extra-prose':
          json(
            200,
            payloadFor(`Sure! Here you go:\n\n${JSON.stringify(VALID_STAGE_REPORT)}\n\nHope this helps!`),
          );
          return;
        case 'fenced-json':
          json(200, payloadFor('```json\n' + JSON.stringify(VALID_STAGE_REPORT) + '\n```'));
          return;
        case 'http-500':
          json(500, { error: { message: 'internal server error' } });
          return;
        case 'http-401':
          json(401, { error: { message: 'invalid api key sk-SHOULD-NEVER-APPEAR', type: 'invalid_request_error' } });
          return;
        case 'http-429-rate':
          json(429, { error: { message: 'rate limit exceeded, slow down', type: 'rate_limit_error' } });
          return;
        case 'http-429-quota':
          json(429, { error: { message: 'you have exceeded your quota', type: 'insufficient_quota' } });
          return;
        case 'http-400-schema-unsupported':
          json(400, {
            error: { message: 'response_format json_schema is not supported by this endpoint', type: 'invalid_request_error' },
          });
          return;
        case 'timeout':
          // Never respond; the client must abort on its own timeout.
          return;
        case 'huge':
          json(200, payloadFor('x'.repeat(8 * 1024 * 1024)));
          return;
        case 'wrong-content-type':
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<html>not json</html>');
          return;
        case 'redirect-same-origin':
          response.writeHead(307, { location: `/redirected${url}` });
          response.end();
          return;
        case 'redirect-cross-origin':
          response.writeHead(307, {
            location: `${options.redirectTargetUrl ?? 'http://127.0.0.1:1/none'}/redirected${url}`,
          });
          response.end();
          return;
        case 'redirect-loop':
          response.writeHead(307, { location: url });
          response.end();
          return;
        case 'redirect-ftp':
          response.writeHead(307, { location: 'ftp://files.example.invalid/report.json' });
          response.end();
          return;
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    inferenceCalls: () => requests.filter((entry) => isInferencePath(entry.url)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error !== undefined && error !== null ? reject(error) : resolve()));
      }),
  };
}
