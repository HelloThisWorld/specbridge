import { z } from 'zod';
import {
  TOOLSMITH_DENIAL_REASONS,
  TOOLSMITH_REQUEST_STATUSES,
  TOOL_INSTALL_SCOPES,
} from '../vocabulary.js';

/**
 * Toolsmith records (`.specbridge/autonomy/toolsmith/<jobId>/`).
 *
 * The Toolsmith formalizes one sentence from the previous dogfood, where a
 * human had to type it into a prompt at midnight: *if you need a tool, build
 * it.* Missing package, missing test harness, missing local script, missing
 * browser binary — every one of those is an engineering problem, and none of
 * them should cost eight hours.
 *
 * What turns that from a slogan into something safe is the ledger below.
 * Every request names a CAPABILITY CLASS rather than a command, is decided
 * by a broker against policy rather than by the agent that wants it, and
 * leaves a durable record of what was granted and what it actually did. The
 * single rule the whole design exists to enforce:
 *
 *   Agents may create TOOLS. Agents may never create AUTHORITY.
 *
 * A request to add a verification command, widen a protected path, raise a
 * spend ceiling, or edit the autonomy policy is a request to change what
 * SpecBridge is allowed to do, wearing the costume of a request to install
 * something. `WOULD_CREATE_AUTHORITY` is the denial reason for exactly that.
 */

export const TOOLSMITH_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

/**
 * One capability request.
 *
 * `target` is a workspace-relative path or an opaque identifier (an image
 * reference, a package name). It is validated by the broker against the
 * workspace boundary and the protected paths — never trusted as given, and
 * never used to build a shell command, because there are no shell commands.
 */
export const toolsmithRequestSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    requestId: shortText,
    jobId: shortText,
    /** `ToolsmithCapability` from @specbridge/core. */
    capability: shortText,
    /** Why the runtime wants it, in one line. Recorded for the operator. */
    purpose: text,
    /** What it acts on: a relative path, a package name, an image reference. */
    target: shortText,
    /** Where the result would live. */
    scope: z.enum(TOOL_INSTALL_SCOPES),
    nodeId: shortText.optional(),
    requestedAt: shortText,
    status: z.enum(TOOLSMITH_REQUEST_STATUSES),
    decidedAt: shortText.optional(),
    denialReason: z.enum(TOOLSMITH_DENIAL_REASONS).optional(),
    denialDetail: text.optional(),
    /**
     * A portable alternative the broker suggests instead of the denied
     * request. Present when a machine-global install was refused but a
     * project-local or containerized route exists: the point of denying
     * `REQUIRES_ADMIN_PRIVILEGE` is to redirect, not to stop.
     */
    suggestedAlternative: text.optional(),
    appliedAt: shortText.optional(),
    /** What the grant actually produced. Never command output. */
    outcome: text.optional(),
    /** Bytes fetched, when the action fetched something measurable. */
    bytes: z.number().int().min(0).nullable().default(null),
    /** Workspace-relative paths the grant created, for the audit. */
    createdPaths: z.array(shortText).max(50).default([]),
  })
  .passthrough();
export type ToolsmithRequest = z.infer<typeof toolsmithRequestSchema>;

/** Per-job Toolsmith accounting, so grant budgets survive a restart. */
export const toolsmithLedgerSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    granted: z.number().int().min(0).default(0),
    denied: z.number().int().min(0).default(0),
    applied: z.number().int().min(0).default(0),
    failed: z.number().int().min(0).default(0),
    bytesFetched: z.number().int().min(0).default(0),
    updatedAt: shortText,
  })
  .passthrough();
export type ToolsmithLedger = z.infer<typeof toolsmithLedgerSchema>;
