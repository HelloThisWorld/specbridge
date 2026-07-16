import { createRunnerExtension } from '@specbridge/extension-sdk';
import manifest from '../specbridge-extension.json' with { type: 'json' };

// See dist/extension.cjs for the full deterministic reference behavior.
createRunnerExtension({
  manifest,
  handlers: {
    detect() {
      return {
        available: true,
        authentication: 'not-applicable',
        capabilitySet: {
          stageGeneration: true, stageRefinement: false, taskExecution: true, taskResume: false,
          structuredFinalOutput: true, streamingEvents: false, repositoryRead: true,
          repositoryWrite: true, sandbox: false, toolRestriction: true, usageReporting: false,
          costReporting: false, localOnly: true, requiresNetwork: false, supportsSystemPrompt: false,
          supportsJsonSchema: false, supportsCancellation: true,
        },
        networkBacked: false,
        diagnostics: [],
      };
    },
  },
}).run();
