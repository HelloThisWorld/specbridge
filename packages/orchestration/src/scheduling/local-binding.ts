import type { AgentConfig, ComputeLocality, DeepSeekHarnessProfileConfig } from '@specbridge/core';
import { isDeepSeekHarnessProfile, validateLocalInferenceConfig } from '@specbridge/core';
import { dshConfigurationGaps, verifyDshComputeLocality } from '@specbridge/runners';

/**
 * The LocalHarnessBinding (vNext.4): the explicit, narrow connection
 *
 *   LOCAL economic lane  →  one harness runner profile  →  verified local compute
 *
 * Installing a harness grants it nothing. Enabling a harness profile grants
 * it nothing either — it becomes an explicitly selectable runner, exactly as
 * in vNext.3. Automatic execution on the LOCAL lane additionally requires
 * ALL of:
 *
 *   1. an operator BINDING (scheduler.localExecution.harnessProfile)
 *   2. an enabled, complete, execution-capable profile
 *   3. compute VERIFIED local (or the explicit experimental override)
 *   4. no paid-provider credentials forwarded into the runtime
 *
 * Every refusal is a named status, never a silent absence: "why did my
 * harness not run?" must always be answerable from one record.
 *
 * Failing closed is the whole point. A LOCAL attempt that quietly reaches a
 * metered provider spends real money on a lane whose defining property is
 * that it cannot — so anything short of verified-local refuses, and the
 * lane keeps working through the direct path it already had.
 */

export type LocalHarnessBindingStatus =
  /** Bound, verified, and usable for automatic LOCAL harness execution. */
  | 'BOUND'
  /** No harness profile is bound to the lane (the default). */
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
  /** Compute locality is UNKNOWN: not proven local, so not admitted. */
  | 'NOT_VERIFIED_LOCAL'
  /** Compute locality is verifiably REMOTE: refused for the LOCAL lane. */
  | 'REMOTE_COMPUTE';

export interface LocalHarnessBinding {
  status: LocalHarnessBindingStatus;
  /** True only for status BOUND. */
  available: boolean;
  /** The bound profile name, when one is configured. */
  profileName: string | null;
  /** Runner kind of the bound profile (identity, never a location). */
  runner: string | null;
  /** Model identity when the profile states one; null when it does not. */
  model: string | null;
  /** Verified compute locality of the bound profile. */
  locality: ComputeLocality;
  /** Grounds for the locality verdict (recorded on decisions). */
  localityEvidence: string;
  /** Credential-shaped environment NAMES forwarded to the runtime. */
  credentialRisks: string[];
  /** True when the experimental override admitted unverified locality. */
  localityOverridden: boolean;
  /** Human-readable problems; empty when BOUND. */
  problems: string[];
  /** Wall-clock ceiling for one harness attempt, from policy. */
  maxWallTimeMs: number;
}

function unbound(
  status: LocalHarnessBindingStatus,
  profileName: string | null,
  problems: string[],
  maxWallTimeMs: number,
  extra: Partial<LocalHarnessBinding> = {},
): LocalHarnessBinding {
  return {
    status,
    available: false,
    profileName,
    runner: null,
    model: null,
    locality: 'UNKNOWN',
    localityEvidence: 'not assessed',
    credentialRisks: [],
    localityOverridden: false,
    problems,
    maxWallTimeMs,
    ...extra,
  };
}

/**
 * Resolve the LOCAL lane's harness binding from configuration. Pure and
 * deterministic: no process is started, no endpoint is contacted, no
 * credential is read.
 */
export function resolveLocalHarnessBinding(config: AgentConfig): LocalHarnessBinding {
  const policy = config.orchestration.jobs.scheduler.localExecution;
  const maxWallTimeMs = policy.maxHarnessWallTimeMs;
  const name = policy.harnessProfile;

  if (name === null) {
    return unbound(
      'NOT_CONFIGURED',
      null,
      [
        'no harness profile is bound to the LOCAL lane ' +
          '(orchestration.jobs.scheduler.localExecution.harnessProfile is null)',
      ],
      maxWallTimeMs,
    );
  }

  const profile = config.runnerProfiles[name];
  if (profile === undefined) {
    return unbound(
      'PROFILE_MISSING',
      name,
      [`the bound harness profile "${name}" does not exist in runnerProfiles`],
      maxWallTimeMs,
    );
  }
  if (!isDeepSeekHarnessProfile(profile)) {
    return unbound(
      'PROFILE_NOT_HARNESS',
      name,
      [
        `profile "${name}" is a "${profile.runner}" profile; the LOCAL harness binding requires a ` +
          'harness runner (vNext.4 supports deepseek-harness)',
      ],
      maxWallTimeMs,
      { runner: profile.runner },
    );
  }

  const harness: DeepSeekHarnessProfileConfig = profile;
  const managedLocalModelAvailable =
    config.localInference.enabled && validateLocalInferenceConfig(config.localInference).ok;
  const locality = verifyDshComputeLocality({ config: harness, managedLocalModelAvailable });
  const base = {
    profileName: name,
    runner: harness.runner,
    model: harness.model,
    locality: locality.locality,
    localityEvidence: locality.evidence,
    credentialRisks: locality.credentialRisks,
    maxWallTimeMs,
  };

  if (!harness.enabled) {
    return unbound('PROFILE_DISABLED', name, [`harness profile "${name}" is disabled`], maxWallTimeMs, base);
  }
  const gaps = dshConfigurationGaps(harness);
  if (gaps.length > 0) {
    return unbound('PROFILE_INCOMPLETE', name, gaps, maxWallTimeMs, base);
  }
  if (harness.workspaceBoundary !== 'runtime-profile') {
    return unbound(
      'BOUNDARY_UNCONFIRMED',
      name,
      [
        `harness profile "${name}" has an unconfirmed workspace write boundary; task execution ` +
          'fails closed until the runtime profile is attested',
      ],
      maxWallTimeMs,
      base,
    );
  }

  if (locality.locality === 'REMOTE') {
    // Verifiably remote compute. The override deliberately does NOT apply:
    // it exists for "cannot be proven", never for "proven to bill money".
    return unbound(
      'REMOTE_COMPUTE',
      name,
      [
        `harness profile "${name}" runs REMOTE compute and can never serve the LOCAL lane: ` +
          locality.evidence,
      ],
      maxWallTimeMs,
      base,
    );
  }
  if (locality.locality === 'UNKNOWN') {
    if (policy.allowUnverifiedLocality) {
      return {
        ...base,
        status: 'BOUND',
        available: true,
        localityOverridden: true,
        problems: [
          `compute locality is UNKNOWN and admitted only by the experimental ` +
            `allowUnverifiedLocality override: ${locality.evidence}`,
        ],
      };
    }
    return unbound(
      'NOT_VERIFIED_LOCAL',
      name,
      [`harness profile "${name}" is not verified local: ${locality.evidence}`],
      maxWallTimeMs,
      base,
    );
  }

  return {
    ...base,
    status: 'BOUND',
    available: true,
    localityOverridden: false,
    problems: [],
  };
}
