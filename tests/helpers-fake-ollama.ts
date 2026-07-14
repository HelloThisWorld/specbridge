import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Fake Ollama HTTP server for integration tests: a REAL loopback HTTP
 * server (never a mocked adapter method), with per-request scripted
 * behaviors and full request recording. No network beyond 127.0.0.1, no
 * model, fully offline.
 */

export type FakeChatBehavior =
  | 'valid'
  | 'valid-design'
  | 'invalid-json'
  | 'schema-invalid'
  | 'fenced-json'
  | 'http-500'
  | 'http-429'
  | 'http-401'
  | 'http-404-model'
  | 'timeout'
  | 'huge'
  | 'wrong-content-type'
  | 'redirect';

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

export interface FakeOllamaOptions {
  models?: string[];
  /** Behavior per successive /api/chat request; the last entry repeats. */
  chatBehaviors?: FakeChatBehavior[];
  /** Fail /api/version with HTTP 500 (endpoint present but broken). */
  brokenVersion?: boolean;
}

export interface FakeOllamaServer {
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  chatCalls: () => RecordedRequest[];
  close: () => Promise<void>;
}

export const VALID_STAGE_REPORT = {
  schemaVersion: '1.0.0',
  stage: 'requirements',
  markdown: [
    '# Requirements Document',
    '',
    '## Introduction',
    '',
    'Requirements produced by the fake Ollama server for tests.',
    '',
    '## Requirements',
    '',
    '### Requirement 1: Persist settings',
    '',
    '**User Story:** As a user, I want settings saved, so that they survive restarts.',
    '',
    '#### Acceptance Criteria',
    '',
    '1. WHEN the user saves a setting, THE SYSTEM SHALL persist it before confirming success.',
    '2. IF the persistence layer is unavailable, THEN THE SYSTEM SHALL report an error and keep the previous value.',
    '',
    '## Out of Scope',
    '',
    '- Cross-device synchronization is excluded.',
    '',
    '## Non-Functional Requirements',
    '',
    '- Saving SHALL complete within 200 ms on the reference environment.',
    '',
  ].join('\n'),
  summary: 'Created the requirements candidate (fake Ollama).',
  assumptions: [],
  openQuestions: [],
  referencedFiles: [],
};

export const VALID_DESIGN_REPORT = {
  ...VALID_STAGE_REPORT,
  stage: 'design',
  markdown: [
    '# Design Document',
    '',
    '## Overview',
    '',
    'Fake Ollama design overview.',
    '',
    '## Architecture',
    '',
    'A settings store module behind the service interface.',
    '',
    '## Components and Interfaces',
    '',
    '- Settings store with read and write operations.',
    '',
    '## Error Handling',
    '',
    'Typed errors; previous value preserved.',
    '',
    '## Security Considerations',
    '',
    'Input validation before persistence.',
    '',
    '## Testing Strategy',
    '',
    'Unit and integration tests.',
    '',
    '## Risks and Trade-offs',
    '',
    '- File-backed store favors simplicity.',
    '',
  ].join('\n'),
  summary: 'Created the design candidate (fake Ollama).',
};

/** The `thinking` content must never surface in SpecBridge artifacts. */
export const FAKE_THINKING_SECRET = 'OLLAMA-THINKING-SECRET-DO-NOT-EXPOSE';

function chatResponse(content: string): string {
  return JSON.stringify({
    model: 'fake-model',
    message: { role: 'assistant', content, thinking: `${FAKE_THINKING_SECRET} internal reasoning` },
    done: true,
    prompt_eval_count: 321,
    eval_count: 123,
    total_duration: 5_000_000,
  });
}

export async function startFakeOllama(options: FakeOllamaOptions = {}): Promise<FakeOllamaServer> {
  const requests: RecordedRequest[] = [];
  const behaviors = options.chatBehaviors ?? ['valid'];
  let chatIndex = 0;

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
      requests.push({ method: request.method ?? '', url: request.url ?? '', body });

      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (request.url === '/api/version') {
        if (options.brokenVersion === true) {
          json(500, { error: 'internal error' });
          return;
        }
        json(200, { version: '0.9.9-fake' });
        return;
      }
      if (request.url === '/api/tags') {
        json(200, {
          models: (options.models ?? ['qwen-fake:7b', 'deepseek-fake:1.5b']).map((name) => ({
            name,
            size: 4_000_000_000,
            modified_at: '2026-07-01T00:00:00Z',
            details: { family: 'fake', parameter_size: '7B', quantization_level: 'Q4_K_M' },
          })),
        });
        return;
      }
      if (request.url === '/api/chat') {
        const behavior = behaviors[Math.min(chatIndex, behaviors.length - 1)] as FakeChatBehavior;
        chatIndex += 1;
        switch (behavior) {
          case 'valid':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(chatResponse(JSON.stringify(VALID_STAGE_REPORT)));
            return;
          case 'valid-design':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(chatResponse(JSON.stringify(VALID_DESIGN_REPORT)));
            return;
          case 'invalid-json':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(chatResponse('this is { not json'));
            return;
          case 'schema-invalid':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(chatResponse(JSON.stringify({ schemaVersion: '1.0.0', stage: 'requirements' })));
            return;
          case 'fenced-json':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              chatResponse('```json\n' + JSON.stringify(VALID_STAGE_REPORT) + '\n```'),
            );
            return;
          case 'http-500':
            json(500, { error: 'internal server error' });
            return;
          case 'http-429':
            json(429, { error: 'rate limit exceeded' });
            return;
          case 'http-401':
            json(401, { error: 'unauthorized' });
            return;
          case 'http-404-model':
            json(404, { error: 'model "missing-model" not found, try pulling it first' });
            return;
          case 'timeout':
            // Never respond; the client must abort on its own timeout.
            return;
          case 'huge':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(chatResponse('x'.repeat(8 * 1024 * 1024)));
            return;
          case 'wrong-content-type':
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('<html>not json</html>');
            return;
          case 'redirect':
            response.writeHead(302, { location: 'http://evil.example.invalid/api/chat' });
            response.end();
            return;
        }
      }
      json(404, { error: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    chatCalls: () => requests.filter((entry) => entry.url === '/api/chat'),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error !== undefined && error !== null ? reject(error) : resolve()));
      }),
  };
}
