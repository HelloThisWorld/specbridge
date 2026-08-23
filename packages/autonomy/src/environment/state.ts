import { z } from 'zod';
import {
  APPLICATION_LEVEL_PROBES,
  ENVIRONMENT_FAILURE_KINDS,
  ENVIRONMENT_STATUSES,
  READINESS_PROBE_KINDS,
  SERVICE_KINDS,
  SERVICE_STATUSES,
} from '../vocabulary.js';

/**
 * Environment plans, instances, and evidence.
 *
 * A product that needs Postgres, Kafka, a backend, and a frontend to
 * demonstrate anything cannot be verified by a test script that shells out
 * to `docker compose up` and sleeps. That approach fails in the two ways
 * that matter overnight: it cannot say WHY something is not ready, and it
 * leaves nothing behind when it gives up.
 *
 * So the environment is modelled the same way a job is: a PLAN (what should
 * exist), an INSTANCE (what does exist, right now, and how it got there),
 * and EVIDENCE (what was observed, retained for the morning). The plan is
 * declarative and reusable; the instance is disposable and honest.
 *
 * The readiness model is the part with teeth. `PROCESS_ALIVE` exists so a
 * plan can SAY it is only checking liveness, and the evidence marks that as
 * shallow. Every other probe talks to the service's actual protocol, because
 * a Kafka broker with an open port and no metadata is not ready, and a
 * readiness check that cannot tell the difference will hand a broken
 * environment to a test suite and blame the test.
 */

export const ENVIRONMENT_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

/**
 * One readiness probe.
 *
 * `argv` is an argv array for COMMAND_EXIT, exactly like trusted
 * verification commands: no shell, ever, and a single-element argv
 * containing whitespace is rejected as the shell string it almost certainly
 * is.
 */
export const readinessProbeSchema = z
  .object({
    kind: z.enum(READINESS_PROBE_KINDS),
    /** TCP/HTTP probes: the host to reach. Defaults to 127.0.0.1. */
    host: shortText.default('127.0.0.1'),
    port: z.number().int().min(1).max(65_535).optional(),
    /** HTTP probes: the path to request. */
    urlPath: shortText.optional(),
    /** HTTP_STATUS: the status codes that count as ready. */
    expectStatus: z.array(z.number().int().min(100).max(599)).max(10).default([200]),
    /** HTTP_BODY: a bounded pattern the response body must contain. */
    expectBody: z.string().max(500).optional(),
    /** COMMAND_EXIT: argv array run against the service. */
    argv: z.array(z.string().min(1).max(500)).max(30).default([]),
    /** PROTOCOL_HANDSHAKE: which protocol, for the evidence record. */
    protocol: shortText.optional(),
    timeoutMs: z.number().int().min(100).max(600_000).default(10_000),
  })
  .passthrough()
  .superRefine((probe, ctx) => {
    if ((probe.kind === 'TCP_CONNECT' || probe.kind === 'HTTP_STATUS' || probe.kind === 'HTTP_BODY') && probe.port === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['port'], message: `${probe.kind} needs a port` });
    }
    if (probe.kind === 'COMMAND_EXIT') {
      if (probe.argv.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['argv'], message: 'COMMAND_EXIT needs an argv array' });
      } else if (probe.argv.length === 1 && /\s/.test(probe.argv[0] ?? '')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['argv'],
          message: `"${probe.argv[0]}" looks like a shell string; readiness probes are argv arrays.`,
        });
      }
    }
  });
export type ReadinessProbe = z.infer<typeof readinessProbeSchema>;

export function isApplicationLevelProbe(probe: ReadinessProbe): boolean {
  return APPLICATION_LEVEL_PROBES.includes(probe.kind);
}

/**
 * One service in a plan.
 *
 * `dependsOn` builds the readiness dependency graph. It is about READINESS
 * rather than start order: an application server may be started immediately
 * and simply not be probed until its database is answering, which is both
 * faster and closer to how the services themselves behave.
 */
export const servicePlanSchema = z
  .object({
    serviceId: shortText,
    kind: z.enum(SERVICE_KINDS),
    /** Compose service name, container name, or process label. */
    name: shortText,
    /** Service ids that must be READY before this one is probed. */
    dependsOn: z.array(shortText).max(20).default([]),
    probes: z.array(readinessProbeSchema).min(1).max(5),
    /** Restarts of THIS service before the instance is unhealthy. */
    maxRestarts: z.number().int().min(0).max(20).default(3),
    /** Ceiling for this service to become ready. */
    readinessTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
    /** Ports the service publishes, for the diagnostics record. */
    ports: z.array(z.number().int().min(1).max(65_535)).max(20).default([]),
  })
  .passthrough();
export type ServicePlan = z.infer<typeof servicePlanSchema>;

/**
 * One environment plan.
 *
 * `composeFile` is workspace-relative and validated as such. A plan that
 * pointed outside the workspace would let an environment definition reach a
 * file nobody reviewed, which is the same class of problem as an unvalidated
 * verification command.
 */
export const environmentPlanSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    planId: shortText,
    name: shortText,
    /** Workspace-relative compose file, for COMPOSE_PROJECT services. */
    composeFile: shortText.optional(),
    /** Compose project name, so teardown targets exactly what was started. */
    projectName: shortText.optional(),
    services: z.array(servicePlanSchema).min(1).max(30),
    createdAt: shortText,
    /** The job that authored this plan, when one did. */
    jobId: shortText.optional(),
  })
  .passthrough()
  .superRefine((plan, ctx) => {
    const ids = new Set(plan.services.map((service) => service.serviceId));
    for (const service of plan.services) {
      for (const dependency of service.dependsOn) {
        if (!ids.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['services'],
            message: `service "${service.serviceId}" depends on unknown service "${dependency}"`,
          });
        }
      }
    }
  });
export type EnvironmentPlan = z.infer<typeof environmentPlanSchema>;

/** Runtime state of one service inside an instance. */
export const serviceStateSchema = z
  .object({
    serviceId: shortText,
    status: z.enum(SERVICE_STATUSES),
    startedAt: shortText.optional(),
    readyAt: shortText.optional(),
    restarts: z.number().int().min(0).default(0),
    /** Readiness probe attempts made for this service. */
    probeAttempts: z.number().int().min(0).default(0),
    /** The probe that last decided readiness, and what it observed. */
    lastProbeKind: shortText.optional(),
    lastProbeDetail: text.optional(),
    failureKind: z.enum(ENVIRONMENT_FAILURE_KINDS).optional(),
    /** Relative path of the retained log, when one was captured. */
    logRef: shortText.optional(),
  })
  .passthrough();
export type ServiceState = z.infer<typeof serviceStateSchema>;

export const environmentInstanceSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    instanceId: shortText,
    planId: shortText,
    jobId: shortText.optional(),
    status: z.enum(ENVIRONMENT_STATUSES),
    createdAt: shortText,
    readyAt: shortText.optional(),
    stoppedAt: shortText.optional(),
    services: z.array(serviceStateSchema).max(30).default([]),
    failureKind: z.enum(ENVIRONMENT_FAILURE_KINDS).optional(),
    failureDetail: text.optional(),
    /** True when diagnostics were retained rather than cleaned up. */
    diagnosticsRetained: z.boolean().default(false),
    /** Total repair attempts across all services. */
    repairs: z.number().int().min(0).default(0),
  })
  .passthrough();
export type EnvironmentInstance = z.infer<typeof environmentInstanceSchema>;

/**
 * Durable evidence about one environment.
 *
 * `readinessDepth` is the honesty field: an environment whose services were
 * all confirmed with `PROCESS_ALIVE` proved that four processes exist, and a
 * report that called that "ready" would be overstating it. The closure
 * oracle reads this when deciding whether a system scenario's environment
 * was real enough to close a contract item on.
 */
export const environmentEvidenceSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    instanceId: shortText,
    planId: shortText,
    recordedAt: shortText,
    status: z.enum(ENVIRONMENT_STATUSES),
    /** Services confirmed by a probe that spoke the service's own protocol. */
    applicationLevelReady: z.array(shortText).max(30).default([]),
    /** Services confirmed only by liveness. Shallow evidence, named as such. */
    livenessOnlyReady: z.array(shortText).max(30).default([]),
    /** Services that never became ready. */
    notReady: z.array(shortText).max(30).default([]),
    totalReadinessMs: z.number().int().min(0).nullable().default(null),
    /** Retained diagnostic log references, workspace-relative. */
    logRefs: z.array(shortText).max(60).default([]),
  })
  .passthrough();
export type EnvironmentEvidence = z.infer<typeof environmentEvidenceSchema>;
