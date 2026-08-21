import type {
  ComputeLocality,
  DeepSeekHarnessComputeLocalityAttestation,
  DeepSeekHarnessProfileConfig,
} from '@specbridge/core';

/**
 * DeepSeek Harness compute-locality verification (vNext.4).
 *
 * The question this module answers is deliberately narrow and economic:
 *
 *   Does inference for THIS harness profile run on this machine at zero
 *   marginal monetary cost — or could it bill a remote provider?
 *
 * It is NOT a question about the harness (a harness is a tool loop, not a
 * location), the runner name, or the model name. `qwen` behind a public
 * endpoint is remote paid compute; a DeepSeek Harness runtime may equally
 * drive a local llama.cpp server or a metered API. Nothing here infers
 * locality from any of those strings — inferring it is exactly the bug this
 * function exists to prevent.
 *
 * What SpecBridge can and cannot know (an upstream limitation, stated
 * plainly): the tested public DSH SDK exposes NO provider-endpoint
 * introspection. The launched runtime profile (`cordis.yml`) owns its
 * routes, and the `initialize` handshake returns runtime identity only. So
 * verification combines the two things that ARE available:
 *
 *   1. an operator ATTESTATION of the mechanism (what the runtime routes to)
 *   2. the structural EVIDENCE that mechanism implies, which SpecBridge
 *      parses itself (a loopback URL, or its own managed local server)
 *
 * Both must hold. Anything else — including a missing or unparseable
 * endpoint — is UNKNOWN, and UNKNOWN never qualifies as LOCAL.
 */

/**
 * Environment-variable name patterns that look like paid-provider
 * credentials. A LOCAL-bound harness has no business inheriting these: a
 * runtime that can authenticate to a metered provider is one configuration
 * mistake away from billing a "free" lane.
 *
 * Detection is on NAMES only. Values are never read, compared, or logged.
 */
const PAID_CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /^(OPENAI|ANTHROPIC|DEEPSEEK|GOOGLE|GEMINI|MISTRAL|COHERE|GROQ|TOGETHER|FIREWORKS|PERPLEXITY|XAI|AZURE|AWS|BEDROCK|VERTEX)_/i,
  /(^|_)(API_?KEY|SECRET_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|CREDENTIALS?)($|_)/i,
];

/** Hostnames that are loopback by definition (no DNS resolution involved). */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/** Whether a hostname is a literal loopback address. Pure and offline. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTNAMES.has(normalized) || LOOPBACK_HOSTNAMES.has(hostname.trim().toLowerCase())) {
    return true;
  }
  // The whole 127.0.0.0/8 block is loopback. A literal address is checked
  // structurally; a NAME that merely resolves to loopback today is not
  // evidence (DNS is not a safety boundary), so nothing is resolved here.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (ipv4 !== null) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    if (octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127) return true;
  }
  return false;
}

export type DshLocalityRejection =
  | 'not-attested'
  | 'endpoint-missing'
  | 'endpoint-unparseable'
  | 'endpoint-remote'
  | 'endpoint-wildcard'
  | 'managed-model-unavailable'
  | 'credential-risk';

export interface DshLocalityAssessment {
  /** The verified locality. UNKNOWN is never upgraded by a guess. */
  locality: ComputeLocality;
  /** The attested mechanism this assessment was made against. */
  attestation: DeepSeekHarnessComputeLocalityAttestation;
  /** Human-readable grounds for the verdict (recorded, never a claim). */
  evidence: string;
  /** Structured rejection reasons; empty when locality is LOCAL. */
  rejections: DshLocalityRejection[];
  /**
   * Environment-variable NAMES forwarded to the runtime that look like paid
   * provider credentials. Never values. Non-empty is disqualifying for the
   * LOCAL lane: it makes accidental remote billing reachable.
   */
  credentialRisks: string[];
}

export interface VerifyDshLocalityInput {
  config: DeepSeekHarnessProfileConfig;
  /**
   * Whether the SpecBridge-managed local model server is enabled and
   * coherently configured. That server is manager-bound to 127.0.0.1 with
   * no configuration able to widen it, so its availability IS the evidence
   * for the `managed-local-model` attestation. Callers pass the result of
   * `validateLocalInferenceConfig` + `enabled`; this module never reads
   * configuration it was not given.
   */
  managedLocalModelAvailable?: boolean | undefined;
}

/** Credential-shaped passthrough names for one profile. NAMES only. */
export function dshPaidCredentialPassthrough(config: DeepSeekHarnessProfileConfig): string[] {
  return config.environmentPassthrough.filter((name) =>
    PAID_CREDENTIAL_NAME_PATTERNS.some((pattern) => pattern.test(name)),
  );
}

/**
 * Verify where a DSH profile's inference runs. Pure, offline, deterministic:
 * no network request, no DNS resolution, no credential read.
 */
export function verifyDshComputeLocality(
  input: VerifyDshLocalityInput,
): DshLocalityAssessment {
  const { config } = input;
  const attestation = config.computeLocality;
  const credentialRisks = dshPaidCredentialPassthrough(config);
  const rejections: DshLocalityRejection[] = [];

  if (attestation === 'unconfirmed') {
    return {
      locality: 'UNKNOWN',
      attestation,
      evidence:
        'the profile makes no locality claim (computeLocality = "unconfirmed"), and the public ' +
        'DSH SDK exposes no provider-endpoint introspection to derive one',
      rejections: ['not-attested'],
      credentialRisks,
    };
  }

  let locality: ComputeLocality;
  let evidence: string;

  if (attestation === 'managed-local-model') {
    if (input.managedLocalModelAvailable === true) {
      locality = 'LOCAL';
      evidence =
        'the profile attests it routes to the SpecBridge-managed local model server, which the ' +
        'local model manager binds to 127.0.0.1 (no configuration can widen the bind address)';
    } else {
      locality = 'UNKNOWN';
      evidence =
        input.managedLocalModelAvailable === false
          ? 'the profile attests the SpecBridge-managed local model server, but that server is not ' +
            'enabled and coherently configured, so no local endpoint exists to have been routed to'
          : 'the profile attests the SpecBridge-managed local model server; this context did not ' +
            'resolve whether that server is configured (the LOCAL lane binding verifies it)';
      rejections.push('managed-model-unavailable');
    }
  } else {
    const endpoint = config.providerEndpoint;
    if (endpoint === null) {
      locality = 'UNKNOWN';
      evidence =
        'the profile attests a loopback endpoint but does not state which one ' +
        '(providerEndpoint is null), so nothing can be verified';
      rejections.push('endpoint-missing');
    } else {
      const parsed = parseEndpoint(endpoint);
      if (parsed.kind === 'unparseable') {
        locality = 'UNKNOWN';
        evidence = `the attested providerEndpoint could not be parsed as a URL or local socket path (${parsed.detail})`;
        rejections.push('endpoint-unparseable');
      } else if (parsed.kind === 'local-socket') {
        locality = 'LOCAL';
        evidence = `the attested provider endpoint is a local socket path (${parsed.detail}), which cannot reach a remote host`;
      } else if (parsed.kind === 'wildcard') {
        // 0.0.0.0 / :: is a BIND address, not a destination: routing to it
        // proves nothing about where the listener actually is.
        locality = 'UNKNOWN';
        evidence = `the attested provider endpoint uses the wildcard address ${parsed.detail}, which is a bind address and not evidence of local compute`;
        rejections.push('endpoint-wildcard');
      } else if (parsed.kind === 'loopback') {
        locality = 'LOCAL';
        evidence = `the attested provider endpoint ${parsed.detail} is a literal loopback address`;
      } else {
        locality = 'REMOTE';
        evidence = `the attested provider endpoint host "${parsed.detail}" is not a loopback address; this profile runs REMOTE compute`;
        rejections.push('endpoint-remote');
      }
    }
  }

  if (credentialRisks.length > 0 && locality === 'LOCAL') {
    // Structurally local, but the runtime is handed paid-provider
    // credentials: one profile edit away from spending money on a lane
    // whose entire premise is that it cannot. Fail closed.
    rejections.push('credential-risk');
    return {
      locality: 'UNKNOWN',
      attestation,
      evidence: `${evidence}; however the profile forwards credential-shaped environment names (${credentialRisks.join(', ')}), so local-only execution cannot be relied on`,
      rejections,
      credentialRisks,
    };
  }

  return { locality, attestation, evidence, rejections, credentialRisks };
}

type ParsedEndpoint =
  | { kind: 'loopback' | 'remote' | 'wildcard' | 'local-socket' | 'unparseable'; detail: string };

function parseEndpoint(endpoint: string): ParsedEndpoint {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) return { kind: 'unparseable', detail: 'empty' };

  // Local socket forms: unix:/path, a Windows named pipe, or an absolute path.
  if (/^unix:/i.test(trimmed) || /^\\\\[.?]\\pipe\\/i.test(trimmed)) {
    return { kind: 'local-socket', detail: trimmed.slice(0, 120) };
  }
  if (/^\//.test(trimmed) && !trimmed.startsWith('//')) {
    return { kind: 'local-socket', detail: trimmed.slice(0, 120) };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: 'unparseable', detail: 'not an absolute URL (a scheme is required)' };
  }
  if (url.protocol === 'file:') return { kind: 'local-socket', detail: trimmed.slice(0, 120) };
  const hostname = url.hostname;
  if (hostname.length === 0) return { kind: 'unparseable', detail: 'the URL has no host' };
  if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') {
    return { kind: 'wildcard', detail: hostname };
  }
  if (isLoopbackHostname(hostname)) return { kind: 'loopback', detail: `${url.protocol}//${url.host}` };
  return { kind: 'remote', detail: hostname };
}
