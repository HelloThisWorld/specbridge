import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { DESIGN_STAGES, SpecBridgeError } from '@specbridge/core';
import type { ResearchReport } from '@specbridge/core';
import { DesignService, isDesignStage } from '@specbridge/design';
import type { ModelEvaluationFinding } from '@specbridge/design';
import { serveStdio } from '@specbridge/mcp-server';

const program = new Command();

function service(): DesignService {
  return new DesignService({ rootDir: process.cwd() });
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.resolve(file), 'utf8')) as unknown;
}

program
  .name('specbridge')
  .description(
    'Turn rough ideas into repository-grounded, research-backed, implementation-ready Spec Packs.',
  )
  .version('2.0.0');

program
  .command('bootstrap')
  .description('Build CurrentSystemSnapshot and the deterministic repository index.')
  .option('--max-files <count>', 'Maximum files to index', Number)
  .option('--max-file-bytes <bytes>', 'Maximum bytes read from one file', Number)
  .action((options: { maxFiles?: number; maxFileBytes?: number }) => {
    print(
      service().bootstrap({
        ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
        ...(options.maxFileBytes === undefined
          ? {}
          : { maxFileBytes: options.maxFileBytes }),
      }),
    );
  });

const design = program.command('design').description('Create and inspect DesignSessions.');

design
  .command('start <title> [idea...]')
  .description('Start a design from a rough product idea.')
  .action((title: string, idea: string[]) => {
    print(service().start(title, idea.join(' ')));
  });

design
  .command('list')
  .description('List DesignSessions.')
  .action(() => print({ sessions: service().list() }));

design
  .command('read <subject>')
  .description('Show a DesignSession, its next action, and bounded repository context.')
  .action((subject: string) => print(service().read(subject)));

design
  .command('generate <subject> <stage>')
  .description('Validate and record one structured stage from a JSON file.')
  .requiredOption('--file <path>', 'JSON file containing the stage output')
  .action((subject: string, stageValue: string, options: { file: string }) => {
    if (!isDesignStage(stageValue)) {
      throw new SpecBridgeError('INVALID_DESIGN_STAGE', 'Unknown design stage.', {
        stage: stageValue,
        allowed: DESIGN_STAGES,
      });
    }
    print(service().recordStage(subject, stageValue, readJson(options.file)));
  });

design
  .command('answer <subject> <decisionId> [answer...]')
  .description('Record the human answer to one product decision.')
  .action((subject: string, decisionId: string, answer: string[]) => {
    print(service().answer(subject, decisionId, answer.join(' ')));
  });

design
  .command('research <subject>')
  .description('Record one provider-neutral ResearchReport from JSON.')
  .requiredOption('--file <path>', 'JSON file containing the ResearchReport')
  .action((subject: string, options: { file: string }) => {
    print(
      service().recordResearch(
        subject,
        readJson(options.file) as ResearchReport,
      ),
    );
  });

design
  .command('evaluate <subject>')
  .description('Evaluate design quality and implementation readiness.')
  .option('--model-findings <path>', 'Optional JSON array of semantic review findings')
  .action((subject: string, options: { modelFindings?: string }) =>
    print(
      service().evaluate(
        subject,
        options.modelFindings === undefined
          ? []
          : (readJson(options.modelFindings) as ModelEvaluationFinding[]),
      ),
    ),
  );

design
  .command('approve <subject> [approval...]')
  .description('Record natural-language approval and compile the Spec Pack.')
  .option('--by <name>', 'Approver identity', 'human')
  .action(
    (
      subject: string,
      approval: string[],
      options: { by: string },
    ) => print(service().approve(subject, approval.join(' '), options.by)),
  );

const spec = program.command('spec').description('Inspect portable Spec Packs.');

spec
  .command('list')
  .description('List compiled Spec Packs.')
  .action(() => print({ specs: service().listSpecs() }));

spec
  .command('show <name> [document]')
  .description('Show a Spec Pack manifest or referenced document.')
  .action((name: string, document?: string) => {
    const result = service().readSpec(name, document);
    process.stdout.write(result.content);
  });

program
  .command('mcp')
  .description('Serve the compact SpecBridge design MCP over stdio.')
  .action(async () => {
    await serveStdio(process.cwd());
  });

program.parseAsync(process.argv).catch((cause: unknown) => {
  if (cause instanceof SpecBridgeError) {
    process.stderr.write(cause.code + ': ' + cause.message + '\n');
  } else {
    process.stderr.write(
      (cause instanceof Error ? cause.stack ?? cause.message : String(cause)) + '\n',
    );
  }
  process.exitCode = 1;
});
