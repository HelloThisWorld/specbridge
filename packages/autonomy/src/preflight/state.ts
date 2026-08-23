import { z } from 'zod';
import { PREFLIGHT_CAPABILITIES, PREFLIGHT_OUTCOMES, PREFLIGHT_VERDICTS } from '../vocabulary.js';

/**
 * The durable overnight preflight report
 * (`.specbridge/autonomy/preflight/<reportId>.json`).
 *
 * Its whole reason to exist is a timing argument. Every human-only
 * prerequisite an unattended run can hit is discoverable BEFORE the run
 * starts: a missing Docker daemon, an unauthenticated CLI, an undeclared
 * spend ceiling, an incomplete seal. Discovering one of them at 02:40 costs
 * the entire night; discovering it at 22:30 costs ninety seconds.
 *
 * So the report is deliberately structured around ONE question per
 * capability — "can this run proceed without a person?" — and the answer
 * space has a third option that most readiness checks lack:
 * `SATISFIABLE_AUTONOMOUSLY`. A missing browser runtime the Toolsmith may
 * install is not a blocker and is not ready; it is work, and saying so is
 * the difference between a report an operator trusts and one they learn to
 * skim.
 */

export const PREFLIGHT_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

export const capabilityCheckSchema = z
  .object({
    capability: z.enum(PREFLIGHT_CAPABILITIES),
    outcome: z.enum(PREFLIGHT_OUTCOMES),
    /** What was observed, in one line. Never a credential or a token. */
    observed: text,
    /** What a person would do about it, when they need to do something. */
    remediation: z.array(text).max(6).default([]),
    /**
     * The Toolsmith capability that would satisfy this autonomously, present
     * exactly when the outcome is SATISFIABLE_AUTONOMOUSLY. Naming it keeps
     * the promise checkable: a report cannot claim self-service for
     * something no grant could actually provide.
     */
    satisfiedBy: shortText.optional(),
    /** Measured detail, when the probe measured something (bytes, ms). */
    measurement: z.number().nullable().default(null),
    checkedAt: shortText,
  })
  .passthrough();
export type CapabilityCheck = z.infer<typeof capabilityCheckSchema>;

export const preflightReportSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    reportId: shortText,
    createdAt: shortText,
    host: shortText,
    /** The mission or spec this preflight was run for. */
    subject: shortText,
    missionId: shortText.optional(),
    sealId: shortText.optional(),
    autonomyMode: shortText,
    humanGate: shortText,
    verdict: z.enum(PREFLIGHT_VERDICTS),
    checks: z.array(capabilityCheckSchema).max(PREFLIGHT_CAPABILITIES.length).default([]),
    /** Capabilities that need a person, extracted for the headline. */
    humanActions: z.array(text).max(40).default([]),
    /** Capabilities the runtime will provide itself, extracted likewise. */
    autonomousActions: z.array(text).max(40).default([]),
    /**
     * Capabilities whose probe could not decide. Non-empty means the verdict
     * is INDETERMINATE, because an unattended launch on an unknown
     * prerequisite is a guess dressed as a decision.
     */
    unknowns: z.array(text).max(40).default([]),
  })
  .passthrough();
export type PreflightReport = z.infer<typeof preflightReportSchema>;
