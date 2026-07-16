import { z } from 'zod';
import { analyzerInputSchema, analyzerResultSchema } from './analyzer.js';
import { exporterInputSchema, exporterResultSchema } from './exporter.js';
import {
  runnerDetectInputSchema,
  runnerDetectOutputSchema,
  runnerModelListOutputSchema,
  runnerStageInputSchema,
  runnerStageOutputSchema,
  runnerTaskInputSchema,
  runnerTaskOutputSchema,
} from './runner.js';
import { verifierInputSchema, verifierResultSchema } from './verifier.js';

export interface OperationSchemaPair {
  readonly input: z.ZodTypeAny;
  readonly output: z.ZodTypeAny;
}

/**
 * Built-in payload/output schemas per operation. Both the SDK server and the
 * SpecBridge host validate against these, so malformed data fails safely on
 * whichever side produced it.
 */
export const OPERATION_SCHEMAS: Readonly<Record<string, OperationSchemaPair>> = {
  'analyzer.analyze': { input: analyzerInputSchema, output: analyzerResultSchema },
  'verifier.verify': { input: verifierInputSchema, output: verifierResultSchema },
  'exporter.export': { input: exporterInputSchema, output: exporterResultSchema },
  'runner.detect': { input: runnerDetectInputSchema, output: runnerDetectOutputSchema },
  'runner.generateStage': { input: runnerStageInputSchema, output: runnerStageOutputSchema },
  'runner.refineStage': { input: runnerStageInputSchema, output: runnerStageOutputSchema },
  'runner.executeTask': { input: runnerTaskInputSchema, output: runnerTaskOutputSchema },
  'runner.resumeTask': { input: runnerTaskInputSchema, output: runnerTaskOutputSchema },
  'runner.listModels': {
    input: z.object({}).strict(),
    output: runnerModelListOutputSchema,
  },
};

export function operationSchemas(operation: string): OperationSchemaPair | undefined {
  return Object.prototype.hasOwnProperty.call(OPERATION_SCHEMAS, operation)
    ? OPERATION_SCHEMAS[operation]
    : undefined;
}
