import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import { TEMPLATE_PROVIDER_TEMPLATES_DIR } from '@specbridge/extension-sdk';
import type { ExtensionTemplatePackInput } from '@specbridge/templates';
import { requireEnabledExtension } from './enablement.js';
import { readExtensionPackageDirectory } from './manifest-loader.js';
import { readExtensionState } from './state.js';

/**
 * Collect template packs contributed by enabled template-provider
 * extensions. Data-only by construction: this reads installed package files
 * through the guarded directory reader and never starts a process. Disabled
 * or integrity-failing extensions contribute nothing (reported as
 * diagnostics), and each pack stays attributed to its extension so the
 * catalog can qualify references as `extension:<extension-id>/<template-id>`.
 */
export interface ExtensionTemplatePacksResult {
  readonly packs: readonly ExtensionTemplatePackInput[];
  readonly diagnostics: readonly Diagnostic[];
}

export function collectExtensionTemplatePacks(
  workspace: WorkspaceInfo | undefined,
): ExtensionTemplatePacksResult {
  if (workspace === undefined) {
    return { packs: [], diagnostics: [] };
  }
  const { state, diagnostics: stateDiagnostics } = readExtensionState(workspace);
  const diagnostics: Diagnostic[] = [...stateDiagnostics];
  const packs: ExtensionTemplatePackInput[] = [];

  for (const id of Object.keys(state.enabled).sort((a, b) => a.localeCompare(b, 'en'))) {
    const record = state.installed.find(
      (candidate) => candidate.id === id && candidate.version === state.enabled[id]?.version,
    );
    if (record === undefined || record.kind !== 'template-provider') {
      continue;
    }
    try {
      const enabled = requireEnabledExtension(workspace, id);
      const files = readExtensionPackageDirectory(enabled.installedDir);
      const prefix = `${TEMPLATE_PROVIDER_TEMPLATES_DIR}/`;
      const grouped = new Map<string, Map<string, string>>();
      for (const [name, content] of files) {
        if (!name.startsWith(prefix)) {
          continue;
        }
        const rest = name.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) {
          continue;
        }
        const templateId = rest.slice(0, slash);
        const packRelative = rest.slice(slash + 1);
        const pack = grouped.get(templateId) ?? new Map<string, string>();
        pack.set(packRelative, content.toString('utf8'));
        grouped.set(templateId, pack);
      }
      for (const [templateId, packFiles] of grouped) {
        packs.push({
          extensionId: id,
          templateId,
          data: { origin: `extension:${id}/${templateId}`, files: packFiles },
        });
      }
    } catch (cause) {
      diagnostics.push({
        severity: 'warning',
        code: 'EXTENSION_TEMPLATES_UNAVAILABLE',
        message:
          `template-provider extension "${id}" is enabled but its templates are unavailable: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  return { packs, diagnostics };
}
