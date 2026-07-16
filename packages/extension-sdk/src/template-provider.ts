/**
 * Template-provider extensions are data-only.
 *
 * A template-provider package contributes one or more v0.7.0-compatible
 * template packs under `templates/<template-id>/`, each with its own
 * `specbridge-template.json` manifest. The packs are read as data by the
 * existing SpecBridge template system: no entrypoint is declared, no process
 * is ever started, and no second template format exists.
 */
export const TEMPLATE_PROVIDER_TEMPLATES_DIR = 'templates';

/** Maximum template packs one provider package may contribute. */
export const MAX_TEMPLATE_PROVIDER_PACKS = 20;

/**
 * Qualified reference form for templates contributed by an extension:
 * `extension:<extension-id>/<template-id>`.
 */
export const EXTENSION_TEMPLATE_SOURCE_PREFIX = 'extension:';

export function formatExtensionTemplateReference(extensionId: string, templateId: string): string {
  return `${EXTENSION_TEMPLATE_SOURCE_PREFIX}${extensionId}/${templateId}`;
}

export interface ExtensionTemplateReference {
  readonly extensionId: string;
  readonly templateId: string;
}

/** Parse `extension:<extension-id>/<template-id>`; undefined when malformed. */
export function parseExtensionTemplateReference(
  raw: string,
): ExtensionTemplateReference | undefined {
  if (!raw.startsWith(EXTENSION_TEMPLATE_SOURCE_PREFIX)) {
    return undefined;
  }
  const rest = raw.slice(EXTENSION_TEMPLATE_SOURCE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) {
    return undefined;
  }
  const extensionId = rest.slice(0, slash);
  const templateId = rest.slice(slash + 1);
  if (extensionId.length === 0 || templateId.length === 0 || templateId.includes('/')) {
    return undefined;
  }
  return { extensionId, templateId };
}
