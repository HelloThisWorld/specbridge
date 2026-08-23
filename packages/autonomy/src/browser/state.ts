import { z } from 'zod';
import {
  BROWSER_ASSERTION_STEPS,
  BROWSER_EVIDENCE_KINDS,
  BROWSER_SCENARIO_STATUSES,
  BROWSER_STEP_KINDS,
} from '../vocabulary.js';

/**
 * Browser scenarios, results, and evidence.
 *
 * The reason browser verification is a first-class evidence source rather
 * than "a test the project happens to write" is one sentence from the
 * specification, and it is correct: a frontend build passing is not proof
 * that a UI works. A React app compiles fine with a modal that never opens.
 *
 * Two structural decisions carry most of the weight here.
 *
 * Steps are a CLOSED vocabulary, not a script. A scenario cannot execute
 * arbitrary JavaScript in the page, which means a scenario cannot be written
 * that passes by asserting nothing, and the evidence record can state
 * exactly which assertions ran. `BROWSER_ASSERTION_STEPS` is the subset that
 * can fail; everything else acts.
 *
 * Contexts are first-class. Multi-user products — the future Felt Ready case
 * with Player A, Player B, and a spectator — are the interesting ones, and
 * a model where a scenario is implicitly single-session cannot express them
 * at all. Every step names its context; a single-context scenario just uses
 * the same name throughout.
 */

export const BROWSER_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

/**
 * One step.
 *
 * `selector` is a CSS selector or a text= locator, bounded. There is
 * deliberately no `script` field: a scenario that could evaluate arbitrary
 * page JavaScript could also fabricate the DOM it then asserts against, and
 * evidence that can forge itself is not evidence.
 */
export const browserStepSchema = z
  .object({
    kind: z.enum(BROWSER_STEP_KINDS),
    /** Which isolated browser context this step acts in. */
    context: shortText.default('default'),
    /** NAVIGATE / EXPECT_URL: the target URL or expected fragment. */
    url: z.string().max(2_000).optional(),
    /** Element locator for interaction and assertion steps. */
    selector: z.string().max(500).optional(),
    /** TYPE / FILL_FORM / EXPECT_TEXT: the value or expected text. */
    value: z.string().max(2_000).optional(),
    /** FILL_FORM: selector-to-value pairs. */
    fields: z.record(z.string().max(2_000)).optional(),
    /** SET_VIEWPORT: `WIDTHxHEIGHT`. */
    viewport: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
    /** SCREENSHOT: the evidence label. */
    label: shortText.optional(),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
  })
  .passthrough();
export type BrowserStep = z.infer<typeof browserStepSchema>;

export function isAssertionStep(step: BrowserStep): boolean {
  return BROWSER_ASSERTION_STEPS.includes(step.kind);
}

export const browserScenarioSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    scenarioId: shortText,
    name: shortText,
    /** What this scenario demonstrates, in one line, for the report. */
    intent: text,
    /** Base URL the application under test is served from. */
    baseUrl: z.string().max(2_000),
    /** Named isolated contexts. One entry per simultaneous user. */
    contexts: z.array(shortText).min(1).max(16).default(['default']),
    steps: z.array(browserStepSchema).min(1).max(200),
    /** Sealed acceptance criteria this scenario is evidence for. */
    criterionIds: z.array(shortText).max(40).default([]),
    /** Contract ids this scenario is evidence for. */
    contractIds: z.array(shortText).max(40).default([]),
    /** The environment instance the app under test runs in, when it has one. */
    environmentInstanceId: shortText.optional(),
    createdAt: shortText,
    jobId: shortText.optional(),
  })
  .passthrough()
  .superRefine((scenario, ctx) => {
    const known = new Set(scenario.contexts);
    for (const [index, step] of scenario.steps.entries()) {
      if (!known.has(step.context)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'context'],
          message: `step names context "${step.context}", which the scenario does not declare`,
        });
      }
    }
    if (!scenario.steps.some((step) => BROWSER_ASSERTION_STEPS.includes(step.kind))) {
      // A scenario that asserts nothing cannot fail, and a test that cannot
      // fail is not evidence about anything. Refused at authoring time.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'a browser scenario must contain at least one assertion step',
      });
    }
  });
export type BrowserScenario = z.infer<typeof browserScenarioSchema>;

/** What one step actually did. */
export const stepResultSchema = z
  .object({
    index: z.number().int().min(0),
    kind: z.enum(BROWSER_STEP_KINDS),
    context: shortText,
    ok: z.boolean(),
    /** One line. Never a page dump. */
    detail: text,
    durationMs: z.number().int().min(0).nullable().default(null),
    /** Evidence file reference this step produced, when it produced one. */
    evidenceRef: shortText.optional(),
  })
  .passthrough();
export type StepResult = z.infer<typeof stepResultSchema>;

/** One captured console message or failed request. */
export const browserObservationSchema = z
  .object({
    context: shortText,
    kind: z.enum(['console-error', 'console-warning', 'page-error', 'request-failed']),
    detail: text,
    at: shortText,
  })
  .passthrough();
export type BrowserObservation = z.infer<typeof browserObservationSchema>;

export const browserScenarioResultSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    resultId: shortText,
    scenarioId: shortText,
    jobId: shortText.optional(),
    status: z.enum(BROWSER_SCENARIO_STATUSES),
    startedAt: shortText,
    finishedAt: shortText.optional(),
    /** Which driver ran it, and whether it was real. */
    driver: shortText,
    /** Present when the status is SKIPPED_NO_RUNTIME. Never a silent pass. */
    skipReason: text.optional(),
    steps: z.array(stepResultSchema).max(200).default([]),
    assertionsRun: z.number().int().min(0).default(0),
    assertionsPassed: z.number().int().min(0).default(0),
    observations: z.array(browserObservationSchema).max(200).default([]),
    /** Workspace-relative evidence references. */
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(BROWSER_EVIDENCE_KINDS),
            ref: shortText,
            label: shortText.optional(),
            context: shortText.optional(),
          })
          .passthrough(),
      )
      .max(200)
      .default([]),
    /** The first failing step's detail, hoisted for the report. */
    failureDetail: text.optional(),
  })
  .passthrough();
export type BrowserScenarioResult = z.infer<typeof browserScenarioResultSchema>;

/**
 * Whether a result may CLOSE a contract item.
 *
 * `SKIPPED_NO_RUNTIME` deliberately cannot. A scenario that did not run
 * proved nothing, and the whole reason that status exists as a separate
 * member from FAILED is so a report can be honest about the difference
 * without either of them being mistaken for a pass.
 */
export function isClosingBrowserResult(result: BrowserScenarioResult): boolean {
  return result.status === 'PASSED' && result.assertionsRun > 0;
}
