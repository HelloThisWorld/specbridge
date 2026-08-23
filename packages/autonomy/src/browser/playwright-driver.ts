import type {
  BrowserDriver,
  BrowserDriverOpenRequest,
  BrowserSession,
  BrowserStepOutcome,
} from './contract.js';
import type { BrowserObservation, BrowserStep } from './state.js';

/**
 * The Playwright-backed browser driver.
 *
 * Playwright is loaded through a dynamic `import()` and is deliberately NOT a
 * dependency of this package. That is a real decision rather than a
 * packaging convenience:
 *
 *   Installing SpecBridge should not download three browsers. Most
 *   workspaces never run a browser scenario, and a hard dependency would
 *   make every CI run pay for a capability it does not use.
 *
 *   The Toolsmith already knows how to provide it. `BROWSER_RUNTIME` is a
 *   granted capability class, so a workspace that needs a browser gets one
 *   installed by the runtime that needs it, at the moment it needs it.
 *
 *   Absence must be a SKIP, not a failure and never a pass. `available()`
 *   reports the reason, the service records SKIPPED_NO_RUNTIME, and the
 *   closure oracle treats that as "not proven" — which is the truth.
 *
 * The `any`-typed handles below are the price of not taking the dependency.
 * They are confined to this file, every value crossing back out is typed,
 * and nothing else in the package knows Playwright exists.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type PlaywrightModule = {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<any>;
  };
};

async function loadPlaywright(): Promise<PlaywrightModule | undefined> {
  try {
    // The specifier is built at runtime so bundlers do not try to resolve a
    // dependency this package deliberately does not declare.
    const specifier = ['play', 'wright'].join('');
    return (await import(/* @vite-ignore */ specifier)) as PlaywrightModule;
  } catch {
    return undefined;
  }
}

export function createPlaywrightDriver(): BrowserDriver {
  return {
    label: 'playwright-chromium',

    async available() {
      const playwright = await loadPlaywright();
      if (playwright === undefined) {
        return {
          ok: false,
          reason:
            'Playwright is not installed in this workspace. Grant the BROWSER_RUNTIME Toolsmith ' +
            'capability, or add playwright as a dev dependency.',
        };
      }
      try {
        const browser = await playwright.chromium.launch({ headless: true });
        await browser.close();
        return { ok: true };
      } catch (cause) {
        return {
          ok: false,
          reason:
            'Playwright is installed but no browser binary could be launched: ' +
            `${(cause instanceof Error ? cause.message : String(cause)).slice(0, 200)}`,
        };
      }
    },

    async open(request: BrowserDriverOpenRequest): Promise<BrowserSession> {
      const playwright = await loadPlaywright();
      if (playwright === undefined) throw new Error('playwright is not installed');
      const browser = await playwright.chromium.launch({ headless: true });
      const observations: BrowserObservation[] = [];
      const contexts = new Map<string, { context: any; page: any }>();

      for (const name of request.scenario.contexts) {
        // A separate BrowserContext per named participant: separate cookies,
        // separate storage, separate session. Sharing one would make a
        // multi-user scenario a single-user scenario with extra steps.
        const context = await browser.newContext({ viewport: request.viewport });
        const page = await context.newPage();
        page.setDefaultTimeout(request.navigationTimeoutMs);
        page.on('console', (message: any) => {
          const type = String(message.type?.() ?? '');
          if (type !== 'error' && type !== 'warning') return;
          observations.push({
            context: name,
            kind: type === 'error' ? 'console-error' : 'console-warning',
            detail: String(message.text?.() ?? '').slice(0, 2_000),
            at: new Date().toISOString(),
          });
        });
        page.on('pageerror', (error: any) => {
          observations.push({
            context: name,
            kind: 'page-error',
            detail: String(error?.message ?? error).slice(0, 2_000),
            at: new Date().toISOString(),
          });
        });
        page.on('requestfailed', (failed: any) => {
          observations.push({
            context: name,
            kind: 'request-failed',
            detail: `${String(failed.method?.() ?? '')} ${String(failed.url?.() ?? '')}: ${String(
              failed.failure?.()?.errorText ?? 'failed',
            )}`.slice(0, 2_000),
            at: new Date().toISOString(),
          });
        });
        contexts.set(name, { context, page });
      }

      const pageFor = (name: string): any => {
        const entry = contexts.get(name);
        if (entry === undefined) throw new Error(`unknown browser context "${name}"`);
        return entry.page;
      };

      return {
        async step(step: BrowserStep): Promise<BrowserStepOutcome> {
          return runStep(pageFor(step.context), step, request, observations);
        },
        observations: () => observations,
        async snapshot(context: string, maxBytes: number): Promise<string> {
          try {
            const html = String(await pageFor(context).content());
            return html.slice(0, maxBytes);
          } catch {
            return '';
          }
        },
        async close(): Promise<void> {
          try {
            await browser.close();
          } catch {
            // A browser that will not close cleanly is not worth failing a
            // scenario over; the process exits shortly anyway.
          }
        },
      };
    },
  };
}

async function runStep(
  page: any,
  step: BrowserStep,
  request: BrowserDriverOpenRequest,
  observations: readonly BrowserObservation[],
): Promise<BrowserStepOutcome> {
  const timeout = step.timeoutMs ?? request.navigationTimeoutMs;
  try {
    switch (step.kind) {
      case 'NAVIGATE': {
        const url = absoluteUrl(request.scenario.baseUrl, step.url ?? '/');
        await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
        return { ok: true, detail: `navigated to ${url}` };
      }
      case 'RELOAD': {
        await page.reload({ timeout, waitUntil: 'domcontentloaded' });
        return { ok: true, detail: 'reloaded' };
      }
      case 'CLICK': {
        await page.click(requireSelector(step), { timeout });
        return { ok: true, detail: `clicked ${step.selector}` };
      }
      case 'TYPE': {
        await page.fill(requireSelector(step), step.value ?? '', { timeout });
        return { ok: true, detail: `typed into ${step.selector}` };
      }
      case 'FILL_FORM': {
        for (const [selector, value] of Object.entries(step.fields ?? {})) {
          await page.fill(selector, value, { timeout });
        }
        return { ok: true, detail: `filled ${Object.keys(step.fields ?? {}).length} field(s)` };
      }
      case 'SUBMIT': {
        await page.press(requireSelector(step), 'Enter', { timeout });
        return { ok: true, detail: `submitted ${step.selector}` };
      }
      case 'WAIT_FOR_SELECTOR': {
        await page.waitForSelector(requireSelector(step), { timeout });
        return { ok: true, detail: `${step.selector} appeared` };
      }
      case 'WAIT_FOR_TEXT': {
        // Expressed as a Playwright text locator rather than an in-page
        // function: this package compiles without the DOM lib on purpose,
        // and a locator keeps the "no arbitrary page script" rule intact.
        await page
          .locator(`text=${step.value ?? ''}`)
          .first()
          .waitFor({ state: 'visible', timeout });
        return { ok: true, detail: 'text appeared' };
      }
      case 'SET_VIEWPORT': {
        const [width, height] = (step.viewport ?? '1280x800').split('x').map(Number);
        await page.setViewportSize({ width: width ?? 1280, height: height ?? 800 });
        return { ok: true, detail: `viewport ${step.viewport}` };
      }
      case 'SCREENSHOT': {
        const data = (await page.screenshot({ fullPage: true })) as Buffer;
        return {
          ok: true,
          detail: `captured ${data.length} bytes`,
          evidence: { kind: 'SCREENSHOT', label: step.label ?? 'screenshot', data },
        };
      }
      case 'SWITCH_CONTEXT': {
        return { ok: true, detail: `context switched to ${step.context}` };
      }
      case 'EXPECT_SELECTOR': {
        const count = await page.locator(requireSelector(step)).count();
        return count > 0
          ? { ok: true, detail: `${step.selector} present (${count})` }
          : { ok: false, detail: `${step.selector} was not present` };
      }
      case 'EXPECT_ABSENT': {
        const count = await page.locator(requireSelector(step)).count();
        return count === 0
          ? { ok: true, detail: `${step.selector} absent` }
          : { ok: false, detail: `${step.selector} was present (${count})` };
      }
      case 'EXPECT_TEXT': {
        const body = String(await page.innerText('body')).slice(0, 200_000);
        return body.includes(step.value ?? '')
          ? { ok: true, detail: 'expected text present' }
          : { ok: false, detail: `expected text was not present on the page` };
      }
      case 'EXPECT_URL': {
        const current = String(page.url());
        return current.includes(step.url ?? '')
          ? { ok: true, detail: `url matches (${current})` }
          : { ok: false, detail: `url is ${current}` };
      }
      case 'EXPECT_NO_CONSOLE_ERRORS': {
        const errors = observations.filter(
          (entry) => entry.kind === 'console-error' || entry.kind === 'page-error',
        );
        return errors.length === 0
          ? { ok: true, detail: 'no console or page errors' }
          : { ok: false, detail: `${errors.length} console/page error(s): ${errors[0]?.detail ?? ''}`.slice(0, 500) };
      }
      case 'EXPECT_NO_FAILED_REQUESTS': {
        const failed = observations.filter((entry) => entry.kind === 'request-failed');
        return failed.length === 0
          ? { ok: true, detail: 'no failed requests' }
          : { ok: false, detail: `${failed.length} failed request(s): ${failed[0]?.detail ?? ''}`.slice(0, 500) };
      }
      default:
        return { ok: false, detail: `unsupported step ${String(step.kind)}` };
    }
  } catch (cause) {
    return {
      ok: false,
      detail: `${step.kind} failed: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 300)}`,
    };
  }
}

function requireSelector(step: BrowserStep): string {
  if (step.selector === undefined || step.selector.length === 0) {
    throw new Error(`${step.kind} needs a selector`);
  }
  return step.selector;
}

function absoluteUrl(baseUrl: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  return `${baseUrl.replace(/\/$/, '')}/${target.replace(/^\//, '')}`;
}
