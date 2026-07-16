import { z } from 'zod';
import { extensionDiagnosticsArraySchema } from './diagnostics.js';

/**
 * Analyzer extensions receive bounded, structured spec content and return
 * diagnostics. They never modify files, never approve stages, and their
 * results never override the built-in deterministic analysis.
 */
export const MAX_ANALYZER_CONTENT_CHARS = 1024 * 1024;

const CONTENT = z.string().max(MAX_ANALYZER_CONTENT_CHARS);

export const analyzerInputSchema = z
  .object({
    specName: z.string().min(1).max(200),
    specType: z.string().min(1).max(40),
    workflowMode: z.string().min(1).max(40),
    stage: z.string().min(1).max(40),
    stageFile: z.string().min(1).max(300).optional(),
    stageContent: CONTENT,
    /** Approved prerequisite stage content, keyed by stage name. */
    approvedContent: z.record(CONTENT).optional(),
    /** Steering documents, keyed by file name (only with specRead). */
    steering: z.record(CONTENT).optional(),
    sourceMetadata: z
      .object({
        specDir: z.string().min(1).max(300).optional(),
        origin: z.string().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    configuration: z.record(z.unknown()).optional(),
  })
  .strict();

export type AnalyzerInput = z.infer<typeof analyzerInputSchema>;

export const analyzerResultSchema = z
  .object({
    diagnostics: extensionDiagnosticsArraySchema,
    summary: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type AnalyzerResult = z.infer<typeof analyzerResultSchema>;
