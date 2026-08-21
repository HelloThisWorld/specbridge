import type { AgentConfig, ApiSpendMode, ComputeLocality, DeepSeekHarnessProfileConfig } from '@specbridge/core';
import { isDeepSeekHarnessProfile } from '@specbridge/core';
import { dshConfigurationGaps, verifyDshComputeLocality } from '@specbridge/runners';

/**
 * The ApiHarnessBinding (vNext.5): the explicit, narrow connection
 *
 *   API economic lane  →  one harness runner profile  →  verified REMOTE
 *   compute  →  configured provider/model  →  an explicit spend policy
 *
 * The exact mirror of the vNext.4 LOCAL binding, and deliberately built the
 * same way — because the two must be mutually honest:
 *
 *   verified-local DSH profile   → eligible for LOCAL, never an API binding
 *   remote/PAYG DSH profile      → eligible for API,   never eligible for LOCAL
 *   UNKNOWN locality             → eligible for NEITHER by default
 *
 * Installation grants nothing. Enabling a profile grants nothing. A remote
 * DSH profile sitting in `runnerProfiles` does not become an API fallback:
 * it must be BOUND here, and spend must be authorized SEPARATELY (the spend
 * mode is not part of this binding on purpose — "which profile would run
 * paid work" and "may paid work run at all" are different questions, and
 * conflating them is how a diagnostic command turns into a purchase).
 *
 * Every refusal is a named status, never a silent absence: "why did my API
 * bridge not run?" must always be answerable from one record.
 */

export type ApiHarnessBindingStatus =
  /** Bound, verified remote, and usable for API execution (given authorization). */
  | 'BOUND'
  /** No harness profile is bound to the API lane (the default). */
  | 'NOT_CONFIGURED'
  /** The bound name does not exist in runnerProfiles. */
  | 'PROFILE_MISSING'
  /** The bound profile exists but is not a harness profile. */
  | 'PROFILE_NOT_HARNESS'
  /** The bound harness profile is disabled. */
  | 'PROFILE_DISABLED'
  /** provider/model are not both configured; the runtime cannot route. */
  | 'PROFILE_INCOMPLETE'
  /** The workspace write boundary is unattested; execution fails closed. */
  | 'BOUNDARY_UNCONFIRMED'
  /** Compute locality is UNKNOWN: not proven remote, so not admitted. */
  | 'NOT_VERIFIED_REMOTE'
  /** Compute is verifiably LOCAL: this is a LOCAL-lane profile, not a paid one. */
  | 'LOCAL_COMPUTE'
  /** The same profile is bound to the LOCAL lane; one profile, two economies. */
  | 'BOUND_TO_LOCAL_LANE';

export interface ApiHarnessBinding {
  status: ApiHarnessBindingStatus;
  /** True only for status BOUND. Availability is NOT authorization to spend. */
  available: boolean;
  /** The bound profile name, when one is configured. */
  profileName: string | null;
  /** Runner kind of the bound profile (identity, never a location). */
  runner: string | null;
  /** Provider route the profile declares; null when it declares none. */
  provider: string | null;
  /** Model identity when the profile states one; null when it does not. */
  model: string | null;
  /** Verified compute locality of the bound profile. */
  locality: ComputeLocality;
  /** Grounds for the locality verdict (recorded on decisions). */
  localityEvidence: string;
  /**
   * Credential-shaped environment NAMES forwarded to the runtime. For the
   * API lane these are EXPECTED, not disqualifying: a metered provider
   * legitimately needs credentials. Names only — values are never read,
   * compared, logged, or persisted.
   */
  credentialSources: string[];
  /** True when the experimental override admitted unverified locality. */
  localityOverridden: boolean;
  /** Human-readable problems; empty when BOUND. */
  problems: string[];
  /** Wall-clock ceiling for one API harness attempt, from policy. */
  maxWallTimeMs: number;
  /** The configured spend mode (recorded here for diagnostics, not gating). */
  spendMode: ApiSpendMode;
  /** True when a pricing profile exists, so cost is estimable at all. */
  pricingConfigured: boolean;
}

function unbound(
  status: ApiHarnessBindingStatus,
  profileName: string | null,
  problems: string[],
  base: Pick<ApiHarnessBinding, 'maxWallTimeMs' | 'spendMode' | 'pricingConfigured'>,
  extra: Partial<ApiHarnessBinding> = {},
): ApiHarnessBinding {
  return {
    status,
    available: false,
    profileName,
    runner: null,
    provider: null,
    model: null,
    locality: 'UNKNOWN',
    localityEvidence: 'not assessed',
    credentialSources: [],
    localityOverridden: false,
    problems,
    ...base,
    ...extra,
  };
}

/**
 * Resolve the API lane's harness binding from configuration. Pure and
 * deterministic: no process is started, no endpoint is contacted, no
 * credential VALUE is read, and nothing here can cause a charge.
 */
export function resolveApiHarnessBinding(config: AgentConfig): ApiHarnessBinding {
  const scheduler = config.orchestration.jobs.scheduler;
  const policy = scheduler.api;
  const base = {
    maxWallTimeMs: policy.maxApiWallTimeMs,
    spendMode: policy.spendMode,
    pricingConfigured: policy.pricing !== null,
  };
  const name = policy.harnessProfile;

  if (name === null) {
    return unbound(
      'NOT_CONFIGURED',
      null,
      [
        'no harness profile is bound to the API lane ' +
          '(orchestration.jobs.scheduler.api.harnessProfile is null)',
      ],
      base,
    );
  }

  // One profile may not serve both economies. Even if it somehow verified
  // both ways, sharing it would make "was this attempt free?" unanswerable
  // from the profile identity alone — and that question is the whole point
  // of keeping lane, runner, provider, and locality orthogonal.
  if (scheduler.localExecution.harnessProfile === name) {
    return unbound(
      'BOUND_TO_LOCAL_LANE',
      name,
      [
        `profile "${name}" is already bound to the LOCAL lane; a single profile cannot serve both ` +
          'the zero-marginal-cost lane and the metered lane',
      ],
      base,
    );
  }

  const profile = config.runnerProfiles[name];
  if (profile === undefined) {
    return unbound(
      'PROFILE_MISSING',
      name,
      [`the bound API harness profile "${name}" does not exist in runnerProfiles`],
      base,
    );
  }
  if (!isDeepSeekHarnessProfile(profile)) {
    return unbound(
      'PROFILE_NOT_HARNESS',
      name,
      [
        `profile "${name}" is a "${profile.runner}" profile; the API harness binding requires a ` +
          'harness runner (vNext.5 uses the already-adopted deepseek-harness)',
      ],
      base,
      { runner: profile.runner },
    );
  }

  const harness: DeepSeekHarnessProfileConfig = profile;
  // `managedLocalModelAvailable` is deliberately NOT passed: the managed
  // local server is evidence for a LOCAL claim, and a profile attesting it
  // is a local profile by construction. Leaving it unresolved keeps such a
  // profile UNKNOWN here rather than accidentally verifying it as remote.
  const locality = verifyDshComputeLocality({ config: harness });
  const identity = {
    profileName: name,
    runner: harness.runner,
    provider: harness.provider,
    model: harness.model,
    locality: locality.locality,
    localityEvidence: locality.evidence,
    // For the API lane these are credential SOURCES, not risks.
    credentialSources: locality.credentialRisks,
  };

  if (!harness.enabled) {
    return unbound('PROFILE_DISABLED', name, [`harness profile "${name}" is disabled`], base, identity);
  }
  const gaps = dshConfigurationGaps(harness);
  if (gaps.length > 0) {
    return unbound('PROFILE_INCOMPLETE', name, gaps, base, identity);
  }
  if (harness.workspaceBoundary !== 'runtime-profile') {
    return unbound(
      'BOUNDARY_UNCONFIRMED',
      name,
      [
        `harness profile "${name}" has an unconfirmed workspace write boundary; task execution ` +
          'fails closed until the runtime profile is attested',
      ],
      base,
      identity,
    );
  }

  if (locality.locality === 'LOCAL') {
    // Verified-local compute. The override deliberately does NOT apply: it
    // exists for "cannot be proven", never for "proven to be the free lane".
    // Paying a metered rate to a loopback endpoint is not continuity, it is
    // a configuration mistake with an invoice.
    return unbound(
      'LOCAL_COMPUTE',
      name,
      [
        `harness profile "${name}" runs verified LOCAL compute and can never serve the metered API ` +
          `lane: ${locality.evidence}`,
      ],
      base,
      identity,
    );
  }
  if (locality.locality === 'UNKNOWN') {
    if (policy.allowUnverifiedLocality) {
      return {
        ...base,
        ...identity,
        status: 'BOUND',
        available: true,
        localityOverridden: true,
        problems: [
          'compute locality is UNKNOWN and admitted only by the experimental ' +
            `allowUnverifiedLocality override: ${locality.evidence}`,
        ],
      };
    }
    return unbound(
      'NOT_VERIFIED_REMOTE',
      name,
      [
        `harness profile "${name}" is not verified remote, so its economics are unknown: ` +
          locality.evidence,
      ],
      base,
      identity,
    );
  }

  return {
    ...base,
    ...identity,
    status: 'BOUND',
    available: true,
    localityOverridden: false,
    problems: [],
  };
}
