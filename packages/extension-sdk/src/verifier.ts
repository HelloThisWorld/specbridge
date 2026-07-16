import { z } from 'zod';
import { extensionDiagnosticsArraySchema } from './diagnostics.js';

/**
 * Verifier extensions receive a bounded verification context and return a
 * status plus diagnostics. They never update task checkboxes, never write
 * evidence, and never define commands for SpecBridge to execute; the existing
 * quality-gate logic decides the final result.
 */
export const VERIFIER_STATUS_VALUES = ['passed', 'warning', 'failed', 'not-applicable'] as const;
export type VerifierStatus = (typeof VERIFIER_STATUS_VALUES)[number];

export const MAX_VERIFIER_CHANGED_FILES = 2000;
export const MAX_VERIFIER_FILE_CONTENT_CHARS = 1024 * 1024;
export const MAX_VERIFIER_INLINE_FILES = 50;

export const verifierChangedFileSchema = z
  .object({
    path: z.string().min(1).max(500),
    changeType: z.enum(['added', 'modified', 'deleted', 'renamed', 'unknown']),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
  })
  .strict();

export type VerifierChangedFile = z.infer<typeof verifierChangedFileSchema>;

export const verifierInputSchema = z
  .object({
    specName: z.string().min(1).max(200),
    taskId: z.string().min(1).max(100).optional(),
    requirementIds: z.array(z.string().min(1).max(100)).max(500).optional(),
    changedFiles: z.array(verifierChangedFileSchema).max(MAX_VERIFIER_CHANGED_FILES),
    diffStats: z
      .object({
        files: z.number().int().min(0),
        additions: z.number().int().min(0),
        deletions: z.number().int().min(0),
      })
      .strict()
      .optional(),
    /** Safe summaries of existing evidence — never raw credentials or env. */
    evidenceSummary: z
      .object({
        outcome: z.string().min(1).max(60).optional(),
        evidenceStatus: z.string().min(1).max(60).optional(),
        commandsRun: z.number().int().min(0).optional(),
        testsReported: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    commandResults: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            exitCode: z.number().int(),
            durationMs: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    /**
     * Selected repository file content. Present only when the extension holds
     * the repositoryRead permission and the host explicitly included files.
     */
    files: z
      .record(z.string().max(MAX_VERIFIER_FILE_CONTENT_CHARS))
      .optional(),
    configuration: z.record(z.unknown()).optional(),
  })
  .strict();

export type VerifierInput = z.infer<typeof verifierInputSchema>;

export const verifierResultSchema = z
  .object({
    status: z.enum(VERIFIER_STATUS_VALUES),
    diagnostics: extensionDiagnosticsArraySchema,
    summary: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type VerifierResult = z.infer<typeof verifierResultSchema>;
