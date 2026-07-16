import { z } from 'zod';
import { extensionDiagnosticsArraySchema } from './diagnostics.js';

/**
 * Exporter extensions receive a bounded spec context and return *candidate*
 * output files. The extension never writes target files: SpecBridge validates
 * every candidate path and writes atomically only after explicit user
 * confirmation, inside the explicitly selected output directory.
 */
export const MAX_EXPORTER_FILES = 100;
export const MAX_EXPORTER_FILE_CHARS = 5 * 1024 * 1024;
export const MAX_EXPORTER_INPUT_CONTENT_CHARS = 1024 * 1024;

/**
 * Candidate output paths are relative forward-slash paths. Leading dots,
 * traversal, backslashes, and absolute paths are rejected by the pattern.
 */
export const EXPORT_OUTPUT_PATH_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const exporterInputSchema = z
  .object({
    specName: z.string().min(1).max(200),
    specType: z.string().min(1).max(40),
    workflowMode: z.string().min(1).max(40),
    /** Stage documents keyed by stage name (requirements, design, tasks). */
    stages: z.record(z.string().max(MAX_EXPORTER_INPUT_CONTENT_CHARS)),
    approvals: z
      .record(
        z
          .object({
            status: z.string().min(1).max(40),
            approvedAt: z.string().min(1).max(60).optional(),
          })
          .strict(),
      )
      .optional(),
    metadata: z
      .object({
        specbridgeVersion: z.string().min(1).max(40).optional(),
        exportedAt: z.string().min(1).max(60).optional(),
      })
      .strict()
      .optional(),
    configuration: z.record(z.unknown()).optional(),
  })
  .strict();

export type ExporterInput = z.infer<typeof exporterInputSchema>;

export const exporterFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(500)
      .regex(EXPORT_OUTPUT_PATH_PATTERN, 'must be a safe relative forward-slash path'),
    mediaType: z.string().min(3).max(100),
    content: z.string().max(MAX_EXPORTER_FILE_CHARS),
  })
  .strict();

export type ExporterFile = z.infer<typeof exporterFileSchema>;

export const exporterResultSchema = z
  .object({
    files: z.array(exporterFileSchema).min(0).max(MAX_EXPORTER_FILES),
    diagnostics: extensionDiagnosticsArraySchema.optional(),
    summary: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type ExporterResult = z.infer<typeof exporterResultSchema>;
