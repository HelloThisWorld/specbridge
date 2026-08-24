import type { ZeroTouchExpectation, ZeroTouchFault } from '../vocabulary.js';

/**
 * The zero-touch certification matrix.
 *
 * One row per fault class the specification requires, and each row states
 * what the fault IS, how it is injected, and what must happen. The matrix is
 * production data rather than test data on purpose: it is the list of things
 * SpecBridge CLAIMS to survive without waking anybody, and a claim that
 * lives only in a test file is a claim nobody can read.
 *
 * The last row is the one that makes the whole suite mean something. Fifteen
 * faults must produce `SELF_RECOVERED`; the sixteenth must produce
 * `NEEDS_AUTHORITY`. A certification that only proved the first fifteen
 * would certify a runtime that never asks — including when it should — and
 * that is a worse product than one that asks too often.
 */

export interface CertificationScenario {
  id: string;
  fault: ZeroTouchFault;
  title: string;
  /** What actually goes wrong, in the operator's words. */
  situation: string;
  /** Where the fault is injected. Always a SpecBridge-controlled seam. */
  injection: string;
  expectation: ZeroTouchExpectation;
  /** What the runtime must do instead of asking. */
  expectedBehaviour: string;
}

export const CERTIFICATION_MATRIX: readonly CertificationScenario[] = Object.freeze([
  {
    id: 'ZT-01',
    fault: 'STRONG_PROVIDER_UNAVAILABLE',
    title: 'the subscription provider is temporarily down',
    situation: 'The strong worker returns 529/overloaded for every dispatch.',
    injection: 'driver host returns a crashed outcome carrying the provider signature',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour:
      'WAITING_RESOURCE with a provider cooldown, re-checked and resumed without a human',
  },
  {
    id: 'ZT-02',
    fault: 'STRONG_QUOTA_EXHAUSTED',
    title: 'the subscription quota is exhausted until a known reset',
    situation: 'The provider reports no remaining capacity and names a reset time.',
    injection: 'driver host returns a deferred stop carrying retryAt',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'WAITING_RESOURCE with wakeAt set; the supervisor sleeps and wakes itself',
  },
  {
    id: 'ZT-03',
    fault: 'LOCAL_RUNTIME_CRASH',
    title: 'the local llama.cpp process crashes',
    situation: 'The managed local inference server exits mid-dispatch.',
    injection: 'driver host crashes with a local-model signature',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'RECOVERING_PROVIDER, the runtime restarts the local runtime and continues',
  },
  {
    id: 'ZT-04',
    fault: 'INVALID_STRUCTURED_OUTPUT',
    title: 'a model returns structured output that does not validate',
    situation: 'The local model produces JSON the agent contract rejects.',
    injection: 'driver host crashes with an invalid-output signature',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'a bounded retry, then escalation to a stronger tier. Never a question',
  },
  {
    id: 'ZT-05',
    fault: 'CONTEXT_EXHAUSTION',
    title: 'the context window is exceeded mid-task',
    situation: 'A dispatch fails because the prompt exceeds the model context.',
    injection: 'driver host crashes with a context-length signature',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour:
      'checkpoint, compact, reconstruct in a fresh session, continue. Task memory is not the context window',
  },
  {
    id: 'ZT-06',
    fault: 'WORKER_PROCESS_TERMINATED',
    title: 'a worker process is killed',
    situation: 'The runner child process is terminated by the OS.',
    injection: 'driver host crashes with a process-termination signature',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'the attempt is reconciled as INTERRUPTED and re-dispatched',
  },
  {
    id: 'ZT-07',
    fault: 'DRIVER_PROCESS_TERMINATED',
    title: 'the driver itself dies',
    situation: 'The orchestrating driver process is killed without cleanup.',
    injection: 'driver host crashes on its first run and succeeds on the next',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'the supervisor observes the dead driver and restarts it under the same lease',
  },
  {
    id: 'ZT-08',
    fault: 'CONTAINER_SERVICE_CRASH',
    title: 'a container service crashes',
    situation: 'A compose service exits during a system scenario.',
    injection: 'driver host crashes with a container signature',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'REPAIRING_ENVIRONMENT; the service is restarted within its budget',
  },
  {
    id: 'ZT-09',
    fault: 'DELAYED_SERVICE_READINESS',
    title: 'a service takes far longer than expected to become ready',
    situation: 'Postgres accepts TCP long before it accepts a connection.',
    injection: 'readiness probe reports not-ready for several attempts',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'the readiness loop waits, restarts within budget, and proceeds when it answers',
  },
  {
    id: 'ZT-10',
    fault: 'MISSING_PROJECT_DEPENDENCY',
    title: 'a project dependency is missing',
    situation: 'A build fails with "cannot find module".',
    injection: 'driver host crashes with a missing-module signature',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'REPAIRING_TOOLCHAIN; the Toolsmith installs it. A missing package is engineering',
  },
  {
    id: 'ZT-11',
    fault: 'MISSING_BROWSER_RUNTIME',
    title: 'no browser runtime is installed',
    situation: 'A UI acceptance criterion needs a browser and none exists.',
    injection: 'browser driver reports unavailable',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour:
      'the scenario records SKIPPED_NO_RUNTIME, the criterion stays unclosed, and the Toolsmith is asked for the runtime',
  },
  {
    id: 'ZT-12',
    fault: 'FAILING_IMPLEMENTATION_TEST',
    title: 'the implementation is wrong and the tests say so',
    situation: 'A trusted verification command fails against the produced code.',
    injection: 'closure evidence registered as failing',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'the item stays unclosed with EVIDENCE_FAILED and gap work repairs it',
  },
  {
    id: 'ZT-13',
    fault: 'WRONG_STRATEGY_REQUIRES_REPLAN',
    title: 'the approach is wrong and needs replanning',
    situation: 'A replan proposes restructuring the internal architecture.',
    injection: 'the authority resolver is asked about an architecture-flavoured replan',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'the replan proceeds under delegated authority. Internal architecture is not a promise',
  },
  {
    id: 'ZT-14',
    fault: 'TRANSIENT_NETWORK_FAILURE',
    title: 'a transient network failure',
    situation: 'A registry or provider connection is refused once.',
    injection: 'driver host crashes with a network signature, then succeeds',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour: 'RECOVERING_PROVIDER and a bounded retry',
  },
  {
    id: 'ZT-15',
    fault: 'CONTROL_PLANE_RUNNER_DEFECT',
    title: 'a SpecBridge runner defect',
    situation: 'The provider CLI rejects an argument SpecBridge passes.',
    injection: 'driver host crashes with an unknown-option signature',
    expectation: 'SELF_RECOVERED',
    expectedBehaviour:
      'REPAIRING_CONTROL_PLANE; the governed repair path runs and the operator does not become the SpecBridge maintainer',
  },
  {
    id: 'ZT-16',
    fault: 'SEALED_CONTRACT_CHANGE_REQUIRED',
    title: 'completing the work requires changing a sealed public contract',
    situation:
      'The only way to satisfy a requirement is to change the public API the human already approved.',
    injection: 'the authority resolver is asked about a public-api replan',
    expectation: 'NEEDS_AUTHORITY',
    expectedBehaviour:
      'the job stops in NEEDS_AUTHORITY with the question recorded, and the sealed contract is NOT modified',
  },
]);

export function scenarioById(id: string): CertificationScenario | undefined {
  return CERTIFICATION_MATRIX.find((scenario) => scenario.id === id);
}

/** Scenarios whose expectation is self-recovery. Fifteen of sixteen. */
export function selfRecoveryScenarios(): readonly CertificationScenario[] {
  return CERTIFICATION_MATRIX.filter((scenario) => scenario.expectation === 'SELF_RECOVERED');
}

/** Scenarios whose expectation is a correct authority stop. */
export function authorityScenarios(): readonly CertificationScenario[] {
  return CERTIFICATION_MATRIX.filter((scenario) => scenario.expectation === 'NEEDS_AUTHORITY');
}
