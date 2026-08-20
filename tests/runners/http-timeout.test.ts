import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createBoundedAbort, safeHttpRequest } from '@specbridge/runners';
import { trackedServerLifecycle } from '../helpers-fake-ollama.js';

/**
 * The shared HTTP client's abort scope.
 *
 * Regression coverage for the intermittent node-20 CI hang: the client
 * previously composed `AbortSignal.any([AbortSignal.timeout(ms), external])`
 * inline, and on Node 20 the composite holds only WEAK references to its
 * sources — an otherwise-unreferenced timeout signal could be garbage
 * collected before its timer fired, so a request against an endpoint that
 * never answers hung forever ("a timeout aborts the request
 * deterministically" burning the whole 30 s Vitest budget). The GC race
 * itself cannot be forced from a test, so these tests pin the REPLACEMENT
 * mechanism: an explicit controller with a real timer (no GC dependence),
 * released in the request's `finally` — plus the listener hygiene `any()`
 * never had.
 */

interface HangingServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** A server that accepts requests and never answers (optionally headers-only). */
async function startHangingServer(mode: 'silent' | 'headers-then-stall'): Promise<HangingServer> {
  const server: Server = createServer((request, response) => {
    void request;
    if (mode === 'headers-then-stall') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"partial":');
      // …and never finish the body.
    }
    // 'silent': never respond at all; the client's abort is the only exit.
  });
  const lifecycle = trackedServerLifecycle(server, `hanging-http-${mode}`);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => lifecycle.close() };
}

describe('safeHttpRequest total-timeout abort (node-20 GC regression)', () => {
  it('a never-responding endpoint times out deterministically, far under the test budget', async () => {
    const server = await startHangingServer('silent');
    try {
      const started = Date.now();
      const result = await safeHttpRequest({
        method: 'POST',
        url: `${server.baseUrl}/api/chat`,
        body: { hang: true },
        timeoutMs: 750,
        maxResponseBytes: 1024 * 1024,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await server.close();
    }
  });

  it('the timeout also covers body streaming: headers-then-stall is a timeout, not a hang', async () => {
    const server = await startHangingServer('headers-then-stall');
    try {
      const started = Date.now();
      const result = await safeHttpRequest({
        method: 'GET',
        url: `${server.baseUrl}/api/tags`,
        timeoutMs: 750,
        maxResponseBytes: 1024 * 1024,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await server.close();
    }
  });

  it('an external abort classifies as cancelled, never as timeout', async () => {
    const server = await startHangingServer('silent');
    try {
      const controller = new AbortController();
      const pending = safeHttpRequest({
        method: 'GET',
        url: `${server.baseUrl}/api/tags`,
        timeoutMs: 30_000,
        maxResponseBytes: 1024,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 100);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('cancelled');
    } finally {
      await server.close();
    }
  });

  it('sequential requests sharing one external signal leave no abort listeners behind', async () => {
    // AbortSignal.any() subscribed to the external signal once per request
    // and never unsubscribed — a long-lived controller (a driver run) would
    // accumulate one leaked listener per HTTP call. release() must detach.
    const server = await startHangingServer('silent');
    try {
      const controller = new AbortController();
      for (let index = 0; index < 15; index += 1) {
        const result = await safeHttpRequest({
          method: 'GET',
          url: `${server.baseUrl}/probe-${index}`,
          timeoutMs: 50,
          maxResponseBytes: 1024,
          signal: controller.signal,
        });
        expect(result.ok).toBe(false);
      }
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe('createBoundedAbort', () => {
  it('fires after the timeout and is inert after release()', async () => {
    const fired = createBoundedAbort(30);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fired.signal.aborted).toBe(true);
    fired.release();

    const released = createBoundedAbort(30);
    released.release();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(released.signal.aborted).toBe(false);
  });

  it('propagates an external abort and honors an already-aborted external signal', async () => {
    const external = new AbortController();
    const bounded = createBoundedAbort(30_000, external.signal);
    expect(bounded.signal.aborted).toBe(false);
    external.abort();
    expect(bounded.signal.aborted).toBe(true);
    bounded.release();
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);

    const preAborted = createBoundedAbort(30_000, AbortSignal.abort());
    expect(preAborted.signal.aborted).toBe(true);
    preAborted.release();
  });

  it('release() detaches the external listener without aborting anything', () => {
    const external = new AbortController();
    const bounded = createBoundedAbort(30_000, external.signal);
    bounded.release();
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);
    external.abort();
    expect(bounded.signal.aborted).toBe(false);
  });
});
