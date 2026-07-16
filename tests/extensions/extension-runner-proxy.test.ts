import { describe, expect, it } from 'vitest';
import type { AgentConfig, ExtensionRunnerProfileConfig } from '@specbridge/core';
import { defaultResolvedAgentConfig, extensionRunnerProfileSchema } from '@specbridge/core';
import {
  checkOperationSupport,
  createDefaultRunnerRegistry,
  runnerCapabilitySetSchema,
} from '@specbridge/runners';
import { createExtensionRunnerFactory, ExtensionRunnerProxy } from '@specbridge/extensions';
import { freshKiroWorkspace } from '../helpers-templates';
import {
  installAndEnableTestExtension,
  PLAIN_RUNNER_ENTRYPOINT,
  runnerManifest,
} from '../helpers-extensions';

const EXECUTION = {
  workspaceRoot: 'unused',
  runDir: 'unused',
  timeoutMs: 10_000,
};

function extensionProfile(overrides?: Partial<ExtensionRunnerProfileConfig>): ExtensionRunnerProfileConfig {
  return extensionRunnerProfileSchema.parse({
    runner: 'extension',
    extensionId: 'demo-runner',
    ...overrides,
  });
}

async function enabledRunnerWorkspace(): Promise<ReturnType<typeof createExtensionRunnerFactory>> {
  const { workspace } = await installAndEnableTestExtension(freshKiroWorkspace(), runnerManifest(), {
    'dist/extension.cjs': PLAIN_RUNNER_ENTRYPOINT,
  });
  return createExtensionRunnerFactory(workspace);
}

describe('extension runner proxy (frozen v0.6.0 contract)', () => {
  it('profiles are disabled by default and never register while disabled', async () => {
    const profile = extensionProfile();
    expect(profile.enabled).toBe(false);

    const factory = await enabledRunnerWorkspace();
    const config: AgentConfig = {
      ...defaultResolvedAgentConfig(),
      runnerProfiles: {
        ...defaultResolvedAgentConfig().runnerProfiles,
        'custom-agent': profile,
      },
    };
    const registry = createDefaultRunnerRegistry(config, { extensionRunner: factory });
    expect(registry.has('custom-agent')).toBe(false);

    const enabledConfig: AgentConfig = {
      ...config,
      runnerProfiles: {
        ...config.runnerProfiles,
        'custom-agent': extensionProfile({ enabled: true }),
      },
    };
    const enabledRegistry = createDefaultRunnerRegistry(enabledConfig, { extensionRunner: factory });
    expect(enabledRegistry.has('custom-agent')).toBe(true);
    expect(enabledRegistry.get('custom-agent').name).toBe('extension');

    // Without a factory the profile is absent, never a crash.
    const noFactory = createDefaultRunnerRegistry(enabledConfig);
    expect(noFactory.has('custom-agent')).toBe(false);
  });

  it('detects, generates, and executes through the protocol with valid claims', async () => {
    const factory = await enabledRunnerWorkspace();
    const proxy = factory(extensionProfile({ enabled: true }));

    expect(runnerCapabilitySetSchema.parse(proxy.declaredCapabilities)).toBeTruthy();
    expect(proxy.declaredSupportLevel).toBe('preview');
    expect(proxy.category).toBe('experimental');
    expect(checkOperationSupport('stage-generation', proxy.declaredCapabilities).supported).toBe(true);

    const detection = await proxy.detect({ workspaceRoot: 'unused' });
    expect(detection.status).toBe('available');
    expect(detection.supportLevel).toBe('preview');
    expect(runnerCapabilitySetSchema.parse(detection.capabilitySet)).toBeTruthy();
    // Detection never adds capabilities beyond the declaration.
    expect(detection.capabilitySet.stageRefinement).toBe(false);

    const stage = await proxy.generateStage(
      {
        specName: 'demo',
        stage: 'requirements',
        intent: 'generate',
        prompt: 'Generate requirements.',
        promptVersion: '1',
        toolPolicy: 'read-only',
      },
      EXECUTION,
    );
    expect(stage.outcome).toBe('completed');
    expect(stage.report?.stage).toBe('requirements');
    expect(stage.runner).toBe('extension');

    const task = await proxy.executeTask(
      {
        specName: 'demo',
        taskId: '1.1',
        prompt: 'Do the task.',
        promptVersion: '1',
        toolPolicy: 'implementation',
      },
      EXECUTION,
    );
    expect(task.outcome).toBe('completed');
    expect(task.resumeSupported).toBe(false);
    // The report is a claim; nothing here updates checkboxes or evidence.
    expect(task.report?.summary).toContain('claim');
  });

  it('degrades to a failed result when the extension is missing (never throws)', async () => {
    const { requireWorkspace } = await import('@specbridge/core');
    const workspace = requireWorkspace(freshKiroWorkspace());
    const proxy = new ExtensionRunnerProxy(workspace, extensionProfile({ enabled: true }));

    const detection = await proxy.detect({ workspaceRoot: 'unused' });
    expect(detection.status).toBe('misconfigured');
    expect(detection.supportLevel).toBe('unavailable');

    const result = await proxy.executeTask(
      {
        specName: 'demo',
        taskId: '1.1',
        prompt: 'Do the task.',
        promptVersion: '1',
        toolPolicy: 'implementation',
      },
      EXECUTION,
    );
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('process_failed');
  });
});
