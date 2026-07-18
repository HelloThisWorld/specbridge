/**
 * Version constants for the SpecBridge extension SDK.
 *
 * `EXTENSION_SDK_VERSION` tracks the published SDK package. The protocol and
 * manifest schema versions evolve independently so an SDK release does not
 * force a protocol break.
 */
export const EXTENSION_SDK_VERSION = '1.0.0';

/** Version of the `specbridge-extension.json` manifest schema. */
export const EXTENSION_MANIFEST_SCHEMA_VERSION = '1.0.0';

/** Version of the stdio extension protocol. */
export const EXTENSION_PROTOCOL_VERSION = '1.0.0';

/** Version of the `checksums.json` schema inside extension packages. */
export const EXTENSION_CHECKSUMS_SCHEMA_VERSION = '1.0.0';
