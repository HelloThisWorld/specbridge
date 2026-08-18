import { statSync } from 'node:fs';
import type { LocalInferenceConfig } from '@specbridge/core';
import { validateLocalInferenceConfig } from '@specbridge/core';
import { safeHttpRequest } from '../shared/http-client.js';

/**
 * Read-only local-model diagnostics.
 *
 * Static checks only: file presence, sizes, configuration coherence, and —
 * when a fixed port is configured — whether something already answers its
 * health endpoint. No process is spawned, no model is loaded, and no
 * inference of any kind runs from a doctor command.
 */

export interface LocalModelDoctorReport {
  provider: string;
  enabled: boolean;
  configProblems: string[];
  executable: { configured: string | null; found: boolean };
  model: { configured: string | null; found: boolean; sizeBytes: number | null };
  /** Constant by construction; reported so audits can quote it. */
  binding: 'loopback-only';
  port: number | 'dynamic';
  contextSize: number;
  parallel: number;
  /** How structured output is enforced for local roles. */
  structuredOutput: 'json-schema with full client-side validation';
  localOnly: true;
  /** Health of an already-running server on the configured fixed port. */
  endpoint?: { url: string; healthy: boolean };
  /** True when a start attempt could plausibly succeed right now. */
  startable: boolean;
}

export async function localModelDoctor(
  config: LocalInferenceConfig,
  options: { probeEndpoint?: boolean } = {},
): Promise<LocalModelDoctorReport> {
  const validation = validateLocalInferenceConfig(config);
  const executableFound = config.executable !== null && isFile(config.executable);
  const modelSize = config.model !== null ? fileSize(config.model) : null;

  const report: LocalModelDoctorReport = {
    provider: config.provider,
    enabled: config.enabled,
    configProblems: validation.problems,
    executable: { configured: config.executable, found: executableFound },
    model: { configured: config.model, found: modelSize !== null, sizeBytes: modelSize },
    binding: 'loopback-only',
    port: config.port === 0 ? 'dynamic' : config.port,
    contextSize: config.contextSize,
    parallel: config.parallel,
    structuredOutput: 'json-schema with full client-side validation',
    localOnly: true,
    startable: config.enabled && validation.ok && executableFound && modelSize !== null,
  };

  if (options.probeEndpoint === true && config.port !== 0) {
    const url = `http://127.0.0.1:${config.port}`;
    const health = await safeHttpRequest({
      method: 'GET',
      url: `${url}/health`,
      timeoutMs: 1_500,
      maxResponseBytes: 4_096,
    });
    report.endpoint = { url, healthy: health.ok && health.status === 200 };
  }

  return report;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function fileSize(candidate: string): number | null {
  try {
    const stat = statSync(candidate);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}
