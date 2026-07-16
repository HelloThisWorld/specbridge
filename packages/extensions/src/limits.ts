/**
 * Host-side extension limits. All limits are tested; keep every bound here so
 * the values stay consistent across install, packaging, the process host, and
 * documentation. Protocol- and payload-level limits live in the SDK
 * (`MAX_PROTOCOL_MESSAGE_BYTES`, per-operation schema bounds) because both
 * sides enforce them.
 */
export const EXTENSION_LIMITS = {
  /** specbridge-extension.json document size. */
  maxManifestBytes: 256 * 1024,
  /** checksums.json document size. */
  maxChecksumsBytes: 256 * 1024,
  /** Packaged archive size on disk. */
  maxArchiveBytes: 50 * 1024 * 1024,
  /** Total size of all extracted/loaded package files. */
  maxExtractedTotalBytes: 100 * 1024 * 1024,
  /** Number of files in a package or archive. */
  maxArchiveFileCount: 1000,
  /** Directory nesting depth inside a package. */
  maxPackageDepth: 8,
  /** Bytes the host retains from an extension's stdout protocol stream. */
  maxProcessStdoutBytes: 10 * 1024 * 1024,
  /** Bytes the host retains from an extension's stderr log stream. */
  maxProcessStderrBytes: 5 * 1024 * 1024,
  /** Time for the process to answer `initialize`. */
  startupTimeoutMs: 10_000,
  /** Default per-operation timeout. */
  defaultOperationTimeoutMs: 5 * 60_000,
  /** Grace period between SIGTERM and SIGKILL on shutdown. */
  forceKillAfterMs: 2000,
} as const;
