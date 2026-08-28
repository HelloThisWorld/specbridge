import { z } from 'zod';

/**
 * Overnight autonomy policy (vNext.10), stored additively inside
 * `.specbridge/config.json` under `autonomy`.
 *
 * It lives in @specbridge/core with every other configuration schema so the
 * configuration reader stays the single place a policy can come from.
 * @specbridge/autonomy consumes the resolved policy; it never parses
 * configuration itself, and no value here may ever originate from spec text,
 * model output, agent proposals, or repository content.
 *
 * The organising rule of this block, stated once:
 *
 *   Configuration may grant ENGINEERING latitude.
 *   Configuration may never grant PRODUCT AUTHORITY.
 *
 * Everything that can be turned on below is an ordinary engineering
 * decision — how to implement, what to install, which container to start,
 * how to recover from a crashed provider. The authority boundaries (sealed
 * contract modification, security-boundary expansion, spend past an
 * authorized ceiling, human-only credentials, external irreversible action)
 * have DELIBERATELY NO KNOB ANYWHERE IN THIS FILE. They are not defaults
 * that could be overridden; they have no representation, so no configuration
 * file, environment variable, or agent proposal can express "let the machine
 * decide this one". `HARD_HUMAN_AUTHORITY_SURFACES` below names them so the
 * policy is complete and printable, not because the list is what stops them.
 *
 * Backward compatibility: the whole block is optional with safe defaults, so
 * every existing configuration file keeps parsing unchanged and no migration
 * is required. Defaults are the CONSERVATIVE ones — `mode: INTERACTIVE`,
 * `humanGate: ALL` — so upgrading SpecBridge never makes an existing
 * workspace more autonomous than it was.
 */

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * How much of the engineering loop the runtime owns.
 *
 *   INTERACTIVE  the historical behaviour: a human is expected at the
 *                keyboard, plan reviews and clarifications gate progress.
 *   SUPERVISED   the supervisor owns liveness and operational recovery, but
 *                ordinary engineering gates still apply.
 *   OVERNIGHT    delegated engineering authority. The runtime owns every
 *                engineering decision inside the sealed intent, escalates
 *                only across an authority boundary, and is expected to run
 *                unattended for hours.
 *   ZERO_TOUCH   OVERNIGHT plus the closure lifecycle running to a terminal
 *                product state without any optional operator checkpoint.
 *
 * OVERNIGHT and ZERO_TOUCH differ in ambition, not in authority: neither can
 * decide anything the other cannot.
 */
export const AUTONOMY_MODES = ['INTERACTIVE', 'SUPERVISED', 'OVERNIGHT', 'ZERO_TOUCH'] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** Modes in which the runtime is expected to proceed without a human present. */
export const UNATTENDED_AUTONOMY_MODES: readonly AutonomyMode[] = ['OVERNIGHT', 'ZERO_TOUCH'];

export function isUnattendedMode(mode: AutonomyMode): boolean {
  return UNATTENDED_AUTONOMY_MODES.includes(mode);
}

/**
 * Which gates stop for a human.
 *
 *   ALL             every configured gate (plan review, clarification,
 *                   dependency policy) stops for a human.
 *   AUTHORITY_ONLY  only an authority boundary stops for a human. Complexity,
 *                   risk, diff size, architecture impact, and failed attempts
 *                   explicitly do NOT.
 */
export const HUMAN_GATE_MODES = ['ALL', 'AUTHORITY_ONLY'] as const;
export type HumanGateMode = (typeof HUMAN_GATE_MODES)[number];

/** A per-surface delegation switch. `HUMAN` always means a real human. */
export const DELEGATION_SETTINGS = ['AUTO', 'HUMAN'] as const;
export type DelegationSetting = (typeof DELEGATION_SETTINGS)[number];

/**
 * The authority surfaces a human always holds.
 *
 * Named here so `specbridge autonomy policy` can print a complete picture.
 * There is no schema field for any of them: the firewall in
 * @specbridge/autonomy resolves them from this frozen list, not from config.
 */
export const HARD_HUMAN_AUTHORITY_SURFACES = Object.freeze([
  'sealed-contract-modification',
  'product-semantics-change',
  'wire-protocol-change',
  'persistence-compatibility-change',
  'security-boundary-expansion',
  'spend-beyond-authorized-ceiling',
  'human-only-credential',
  'external-irreversible-action',
] as const);
export type HardHumanAuthoritySurface = (typeof HARD_HUMAN_AUTHORITY_SURFACES)[number];

// ---------------------------------------------------------------------------
// Delegated engineering decisions
// ---------------------------------------------------------------------------

/**
 * Engineering surfaces the runtime may own under delegated authority.
 *
 * Every one of these is a decision a competent engineer makes without asking
 * a product owner. They are individually switchable so a cautious operator
 * can delegate implementation but keep, say, dependency selection — but the
 * OVERNIGHT preset turns them all on, because a run that must ask before
 * choosing a CSS strategy is not unattended.
 */
export const delegatedDecisionsSchema = z
  .object({
    /** Implementation structure, algorithms, internal APIs, module layout. */
    implementation: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Internal architecture inside the sealed contracts. */
    internalArchitecture: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Adding, upgrading, or replacing a project dependency. */
    dependencySelection: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Creating project-local tools, scripts, generators, fixtures. */
    toolingCreation: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Test harnesses, fixtures, fault injectors, conformance kits. */
    testInfrastructure: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Provisioning local runtime environments (compose, brokers, databases). */
    environmentProvisioning: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Driving a real browser against the product under test. */
    browserVerification: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Decomposing sealed work into tasks and revising that decomposition. */
    workDecomposition: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
  })
  .passthrough();
export type DelegatedDecisions = z.infer<typeof delegatedDecisionsSchema>;

/**
 * Recovery surfaces the runtime may own.
 *
 * These are the ones the previous dogfood proved must never wait for a
 * person: a crashed llama.cpp, a dead worker, a missing package, a failing
 * test, an exhausted context window.
 */
export const delegatedRecoverySchema = z
  .object({
    /** Provider failover, restart, cooldown, and health recovery. */
    provider: z.enum(DELEGATION_SETTINGS).default('AUTO'),
    /** Restarting dead drivers and reconciling interrupted attempts. */
    process: z.enum(DELEGATION_SETTINGS).default('AUTO'),
    /** Installing or building missing project-local engineering tooling. */
    toolchain: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Repairing a failing implementation against fresh evidence. */
    implementation: z.enum(DELEGATION_SETTINGS).default('AUTO'),
    /** Checkpoint, compact, reconstruct, continue in a fresh session. */
    context: z.enum(DELEGATION_SETTINGS).default('AUTO'),
    /** Restarting and repairing local runtime environments. */
    environment: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
    /** Governed self-repair of a recoverable SpecBridge/toolchain defect. */
    controlPlane: z.enum(DELEGATION_SETTINGS).default('HUMAN'),
  })
  .passthrough();
export type DelegatedRecovery = z.infer<typeof delegatedRecoverySchema>;

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/**
 * Supervisor policy.
 *
 * The supervisor is the thing that makes a job's liveness independent of a
 * user's terminal. Every bound here can only make it give up SOONER — there
 * is no field that lets it restart forever, and `maxConsecutiveRestarts`
 * exists specifically so a driver that crashes on startup does not become an
 * infinite respawn loop burning an overnight window.
 */
export const supervisorPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** How often the owning process refreshes its lease. */
    heartbeatIntervalMs: z.number().int().min(1_000).max(300_000).default(15_000),
    /**
     * How long a lease stays valid without a heartbeat. A lease older than
     * this is reclaimable: the owner is presumed dead. Must be comfortably
     * larger than the heartbeat interval; the schema enforces 3x.
     */
    leaseTtlMs: z.number().int().min(5_000).max(1_800_000).default(90_000),
    /** How often the supervisor re-evaluates sleeping/waiting jobs. */
    pollIntervalMs: z.number().int().min(1_000).max(600_000).default(20_000),
    /** Hard ceiling on driver restarts for one job, ever. */
    maxRestarts: z.number().int().min(0).max(1_000).default(50),
    /** Consecutive restarts with no progress before the job is given up. */
    maxConsecutiveRestarts: z.number().int().min(1).max(50).default(5),
    /** Backoff floor and ceiling between restarts. */
    restartBackoffMs: z.number().int().min(100).max(600_000).default(5_000),
    maxRestartBackoffMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    /**
     * Wall-clock ceiling on one unattended supervision session. Reaching it
     * is not a failure: the job is checkpointed and left resumable.
     */
    maxSessionMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 3_600_000)
      .default(14 * 3_600_000),
    /**
     * Longest a job may sit in WAITING_RESOURCE with NO identified future
     * recovery before it is classified honestly rather than waited on.
     */
    maxIndefiniteWaitMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 3_600_000)
      .default(2 * 3_600_000),
  })
  .passthrough()
  .superRefine((policy, ctx) => {
    if (policy.leaseTtlMs < policy.heartbeatIntervalMs * 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leaseTtlMs'],
        message:
          `leaseTtlMs (${policy.leaseTtlMs}) must be at least 3x heartbeatIntervalMs ` +
          `(${policy.heartbeatIntervalMs}); a tighter lease reclaims jobs from live owners.`,
      });
    }
    if (policy.maxRestartBackoffMs < policy.restartBackoffMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxRestartBackoffMs'],
        message: 'maxRestartBackoffMs must be at least restartBackoffMs',
      });
    }
  });
export type SupervisorPolicy = z.infer<typeof supervisorPolicySchema>;

// ---------------------------------------------------------------------------
// Toolsmith
// ---------------------------------------------------------------------------

/**
 * The capability classes a Toolsmith request can ask for.
 *
 * A capability is what the runtime is allowed to DO, never a specific
 * command: the broker grants "may write a project-local script", not
 * "may run an arbitrary shell line". Members are appended, never repurposed.
 */
export const TOOLSMITH_CAPABILITIES = [
  /** Write a script/tool inside the workspace (never outside it). */
  'PROJECT_LOCAL_SCRIPT',
  /** Add a dev/test dependency to the project's own manifest. */
  'PROJECT_DEPENDENCY',
  /** Run the project's package manager to install declared dependencies. */
  'PACKAGE_MANAGER_INSTALL',
  /** Download a language/build toolchain into a project-local directory. */
  'PROJECT_LOCAL_TOOLCHAIN',
  /** Download a browser runtime into a project-local or user-local cache. */
  'BROWSER_RUNTIME',
  /** Pull a container image from a configured registry. */
  'CONTAINER_IMAGE',
  /** Start/stop containers and compose projects for the product under test. */
  'CONTAINER_LIFECYCLE',
  /** Install a CLI tool into a user-local (never system) prefix. */
  'USER_LOCAL_CLI',
  /** Generate fixtures, fakes, simulators, and fault injectors. */
  'CODE_GENERATION',
] as const;
export type ToolsmithCapability = (typeof TOOLSMITH_CAPABILITIES)[number];

/**
 * Capabilities enabled by the OVERNIGHT preset.
 *
 * `USER_LOCAL_CLI` is deliberately NOT here: writing outside the workspace
 * into a user profile is a bigger promise than "engineering inside this
 * project", and an operator who wants it says so explicitly.
 */
export const OVERNIGHT_TOOLSMITH_CAPABILITIES: readonly ToolsmithCapability[] = [
  'PROJECT_LOCAL_SCRIPT',
  'PROJECT_DEPENDENCY',
  'PACKAGE_MANAGER_INSTALL',
  'PROJECT_LOCAL_TOOLCHAIN',
  'BROWSER_RUNTIME',
  'CONTAINER_IMAGE',
  'CONTAINER_LIFECYCLE',
  'CODE_GENERATION',
];

export const toolsmithPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** The capability classes the broker may grant. Empty means none. */
    capabilities: z
      .array(z.enum(TOOLSMITH_CAPABILITIES))
      .max(TOOLSMITH_CAPABILITIES.length)
      .default([]),
    /** Hard ceiling on granted requests for one job. */
    maxGrantsPerJob: z.number().int().min(0).max(500).default(40),
    /** Hard ceiling on bytes one grant may fetch, when the fetch is measurable. */
    maxDownloadBytes: z
      .number()
      .int()
      .min(0)
      .max(8 * 1024 * 1024 * 1024)
      .default(2 * 1024 * 1024 * 1024),
    /** Wall-clock ceiling for one provisioning action. */
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
    /**
     * Registries a CONTAINER_IMAGE grant may pull from. Empty means "the
     * daemon's default", which is the operator's own docker configuration —
     * SpecBridge does not add registries.
     */
    allowedImageRegistries: z.array(z.string().min(1).max(200)).max(20).default([]),
    /**
     * Package registries a PACKAGE_MANAGER_INSTALL may reach. Empty means
     * the project's own configured registry.
     */
    allowedPackageRegistries: z.array(z.string().min(1).max(200)).max(20).default([]),
    /**
     * User-local prefix for USER_LOCAL_CLI grants, relative to the user's
     * home. Never absolute, never a system path.
     */
    userLocalPrefix: z.string().min(1).max(120).default('.specbridge/tools'),
  })
  .passthrough();
export type ToolsmithPolicy = z.infer<typeof toolsmithPolicySchema>;

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export const environmentPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Concurrent environment instances one job may hold. */
    maxInstances: z.number().int().min(1).max(20).default(3),
    /** Ceiling for one service to become ready. */
    readinessTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(180_000),
    /** Interval between readiness probe attempts. */
    probeIntervalMs: z.number().int().min(100).max(60_000).default(2_000),
    /** Bounded restarts of one service before the instance is unhealthy. */
    maxServiceRestarts: z.number().int().min(0).max(20).default(3),
    /** Keep logs and container state when provisioning fails. */
    retainDiagnosticsOnFailure: z.boolean().default(true),
    /** Ceiling on retained log bytes per service. */
    maxLogBytesPerService: z
      .number()
      .int()
      .min(1_024)
      .max(64 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    /** Tear down instances when the owning job reaches a final status. */
    teardownOnJobFinal: z.boolean().default(true),
  })
  .passthrough();
export type EnvironmentPolicy = z.infer<typeof environmentPolicySchema>;

// ---------------------------------------------------------------------------
// Browser verification
// ---------------------------------------------------------------------------

export const browserPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Isolated contexts one scenario may open (multi-user products need >1). */
    maxContexts: z.number().int().min(1).max(16).default(4),
    /** Per-navigation ceiling. */
    navigationTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
    /** Whole-scenario ceiling. */
    scenarioTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    /** Capture screenshots as durable evidence. */
    captureScreenshots: z.boolean().default(true),
    /** Capture console and network failures as durable evidence. */
    captureConsole: z.boolean().default(true),
    /** Ceiling on retained evidence bytes for one scenario. */
    maxEvidenceBytes: z
      .number()
      .int()
      .min(1_024)
      .max(256 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    /** Viewports a responsive check exercises, as `WIDTHxHEIGHT`. */
    viewports: z
      .array(z.string().regex(/^\d{2,5}x\d{2,5}$/))
      .max(8)
      .default(['1280x800', '390x844']),
  })
  .passthrough();
export type BrowserPolicy = z.infer<typeof browserPolicySchema>;

// ---------------------------------------------------------------------------
// UX critic
// ---------------------------------------------------------------------------

/**
 * How much authority the UX critic holds.
 *
 *   DISABLED  never runs.
 *   ADVISORY  findings are recorded and reported; they never create work.
 *   BLOCKING  MATERIAL findings create bounded gap-closure work.
 *
 * There is deliberately no mode in which the critic can PASS something
 * deterministic evidence failed. Negative authority only, in every mode.
 */
export const CRITIC_MODES = ['DISABLED', 'ADVISORY', 'BLOCKING'] as const;
export type CriticMode = (typeof CRITIC_MODES)[number];

export const criticPolicySchema = z
  .object({
    mode: z.enum(CRITIC_MODES).default('DISABLED'),
    /** Repair cycles the critic alone may cause for one scenario. */
    maxCriticRepairCycles: z.number().int().min(0).max(10).default(2),
    /** Findings retained per critique. */
    maxFindings: z.number().int().min(1).max(200).default(25),
  })
  .passthrough();
export type CriticPolicy = z.infer<typeof criticPolicySchema>;

// ---------------------------------------------------------------------------
// Contract closure and the gap-closure lifecycle
// ---------------------------------------------------------------------------

export const closurePolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Audit then generate gap work then implement then audit again, bounded. */
    maxGapClosureCycles: z.number().int().min(0).max(50).default(8),
    /** System-scenario qualification attempts before the phase gives up. */
    maxSystemQualificationCycles: z.number().int().min(0).max(20).default(4),
    /** Gap work units one closure cycle may generate. */
    maxGapWorkPerCycle: z.number().int().min(1).max(100).default(12),
    /**
     * Require mission-level system acceptance scenarios when the sealed
     * acceptance criteria imply them. Turning this off does not make an
     * unproven requirement closed — it removes the SCENARIO phase, and the
     * requirement then has to close on other evidence.
     */
    requireSystemScenarios: z.boolean().default(true),
    /**
     * Require the release qualification: the full trusted verification suite
     * must pass against the INTEGRATED tree before completion. Per-unit
     * verification proves each change in its own worktree; this proves the
     * changes still hold together after all of them landed.
     */
    requireReleaseQualification: z.boolean().default(true),
    /** Run the reproducibility phase (clean build, fresh environment). */
    requireReproducibility: z.boolean().default(true),
    /** Ceiling for one reproducibility qualification. */
    reproducibilityTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 3_600_000)
      .default(3_600_000),
  })
  .passthrough();
export type ClosurePolicy = z.infer<typeof closurePolicySchema>;

// ---------------------------------------------------------------------------
// Control-plane self-repair
// ---------------------------------------------------------------------------

export const controlPlaneRepairPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Absolute path to the SpecBridge source checkout a repair may patch. */
    sourcePath: z.string().min(1).max(4_096).optional(),
    /** Governed repairs one product job may trigger. */
    maxRepairsPerJob: z.number().int().min(0).max(10).default(2),
    /** Run the full SpecBridge qualification before a repaired build is used. */
    requireFullQualification: z.boolean().default(true),
    /** Re-run the exact failed operation against the repaired build. */
    requireCanary: z.boolean().default(true),
    /** Ceiling for one repair task, end to end. */
    timeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 3_600_000)
      .default(2 * 3_600_000),
  })
  .passthrough();
export type ControlPlaneRepairPolicy = z.infer<typeof controlPlaneRepairPolicySchema>;

// ---------------------------------------------------------------------------
// The autonomy block
// ---------------------------------------------------------------------------

export const autonomyPolicySchema = z
  .object({
    mode: z.enum(AUTONOMY_MODES).default('INTERACTIVE'),
    humanGate: z.enum(HUMAN_GATE_MODES).default('ALL'),
    decisions: delegatedDecisionsSchema.default({}),
    recovery: delegatedRecoverySchema.default({}),
    supervisor: supervisorPolicySchema.default({}),
    toolsmith: toolsmithPolicySchema.default({}),
    environments: environmentPolicySchema.default({}),
    browser: browserPolicySchema.default({}),
    critic: criticPolicySchema.default({}),
    closure: closurePolicySchema.default({}),
    controlPlaneRepair: controlPlaneRepairPolicySchema.default({}),
  })
  .passthrough();
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

export function defaultAutonomyPolicy(): AutonomyPolicy {
  return autonomyPolicySchema.parse({});
}

/**
 * The OVERNIGHT preset: what `specbridge autonomy setup --mode overnight`
 * writes, spelled out in ONE place so the documented behaviour and the
 * behaviour are the same object.
 *
 * Nothing here grants product authority; see the header. It is exactly the
 * set of engineering latitudes an unattended run needs, plus the supervisor
 * that makes "unattended" mean anything at all.
 */
export function overnightAutonomyPreset(): AutonomyPolicy {
  return autonomyPolicySchema.parse({
    mode: 'OVERNIGHT',
    humanGate: 'AUTHORITY_ONLY',
    decisions: {
      implementation: 'AUTO',
      internalArchitecture: 'AUTO',
      dependencySelection: 'AUTO',
      toolingCreation: 'AUTO',
      testInfrastructure: 'AUTO',
      environmentProvisioning: 'AUTO',
      browserVerification: 'AUTO',
      workDecomposition: 'AUTO',
    },
    recovery: {
      provider: 'AUTO',
      process: 'AUTO',
      toolchain: 'AUTO',
      implementation: 'AUTO',
      context: 'AUTO',
      environment: 'AUTO',
      controlPlane: 'AUTO',
    },
    supervisor: { enabled: true },
    toolsmith: { enabled: true, capabilities: [...OVERNIGHT_TOOLSMITH_CAPABILITIES] },
    environments: { enabled: true },
    browser: { enabled: true },
    critic: { mode: 'BLOCKING' },
    closure: { enabled: true },
    // controlPlaneRepair is deliberately NOT enabled here. It is the one
    // capability that cannot work from a preset: it needs `sourcePath`, the
    // SpecBridge checkout a repair may patch, and only the operator knows
    // where that is. Enabling it blind would make every preflight report a
    // prerequisite the preset itself created.
  });
}

/**
 * Stable fingerprint of the autonomy values a sealed Mission is bound to.
 *
 * Recorded on the seal so a run that resumes weeks later can say honestly
 * "the autonomy policy changed since this intent was sealed" rather than
 * quietly executing under latitudes the human never granted. Operational
 * tuning (intervals, timeouts, byte ceilings) is deliberately EXCLUDED: it
 * changes how patiently the runtime waits, never what it is allowed to do.
 */
export function autonomyPolicyFingerprint(policy: AutonomyPolicy): string {
  const canonical = {
    mode: policy.mode,
    humanGate: policy.humanGate,
    decisions: {
      implementation: policy.decisions.implementation,
      internalArchitecture: policy.decisions.internalArchitecture,
      dependencySelection: policy.decisions.dependencySelection,
      toolingCreation: policy.decisions.toolingCreation,
      testInfrastructure: policy.decisions.testInfrastructure,
      environmentProvisioning: policy.decisions.environmentProvisioning,
      browserVerification: policy.decisions.browserVerification,
      workDecomposition: policy.decisions.workDecomposition,
    },
    recovery: {
      provider: policy.recovery.provider,
      process: policy.recovery.process,
      toolchain: policy.recovery.toolchain,
      implementation: policy.recovery.implementation,
      context: policy.recovery.context,
      environment: policy.recovery.environment,
      controlPlane: policy.recovery.controlPlane,
    },
    supervisor: { enabled: policy.supervisor.enabled, maxRestarts: policy.supervisor.maxRestarts },
    toolsmith: {
      enabled: policy.toolsmith.enabled,
      capabilities: [...policy.toolsmith.capabilities].sort(),
      maxGrantsPerJob: policy.toolsmith.maxGrantsPerJob,
    },
    environments: { enabled: policy.environments.enabled },
    browser: { enabled: policy.browser.enabled },
    critic: { mode: policy.critic.mode },
    closure: {
      enabled: policy.closure.enabled,
      maxGapClosureCycles: policy.closure.maxGapClosureCycles,
      requireSystemScenarios: policy.closure.requireSystemScenarios,
      requireReleaseQualification: policy.closure.requireReleaseQualification,
      requireReproducibility: policy.closure.requireReproducibility,
    },
    controlPlaneRepair: {
      enabled: policy.controlPlaneRepair.enabled,
      maxRepairsPerJob: policy.controlPlaneRepair.maxRepairsPerJob,
      requireFullQualification: policy.controlPlaneRepair.requireFullQualification,
      requireCanary: policy.controlPlaneRepair.requireCanary,
    },
  };
  return JSON.stringify(canonical);
}

/**
 * Whether a delegation setting authorizes the runtime to act alone.
 * A one-line helper so no call site ever writes a bare string comparison
 * and drifts from the enum.
 */
export function isDelegated(setting: DelegationSetting): boolean {
  return setting === 'AUTO';
}
