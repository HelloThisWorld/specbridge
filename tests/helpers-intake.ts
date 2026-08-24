import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntakeDeps } from '@specbridge/intake';
import { setupAutonomyFixture } from './helpers-autonomy.js';
import type { AutonomyFixture, AutonomyFixtureOptions } from './helpers-autonomy.js';

/**
 * Shared setup for vNext.10.1 spec-intake tests.
 *
 * Built on the autonomy fixture rather than beside it, because an intake IS
 * an orchestration of the mission, autonomy, and orchestration authorities —
 * a fixture that stood up its own parallel workspace would be testing
 * something the product does not do.
 *
 * Everything is offline and deterministic. No git spawn, no model, no
 * container, no browser: the intake pipeline reads the repository through
 * plain filesystem calls, and every probe the automatic preflight runs is
 * injected by the caller.
 */

export interface IntakeFixture extends AutonomyFixture {
  intake: IntakeDeps;
}

export function setupIntakeFixture(options: AutonomyFixtureOptions = {}): IntakeFixture {
  const base = setupAutonomyFixture(options);
  return {
    ...base,
    intake: {
      workspace: base.workspace,
      config: base.config,
      clock: base.clock,
      idFactory: base.deps.idFactory,
      host: 'test',
    },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Golden Spec: the real StepRelay airport demo/workbench request.
 *
 * Kept as a FIXTURE FILE rather than an inline string on purpose. It is the
 * artifact the dogfood submits, it contains genuinely unresolved product
 * questions, and a test that inlined a tidied-up version of it would be
 * asserting against a document nobody would actually write.
 */
export function goldenSpecText(): string {
  return readFileSync(
    path.join(here, 'fixtures', 'spec-intake', 'steprelay-airport-demo.md'),
    'utf8',
  );
}

export function goldenSpecPath(): string {
  return path.join(here, 'fixtures', 'spec-intake', 'steprelay-airport-demo.md');
}

/**
 * A short specification with one unambiguous requirement and no hedges.
 *
 * The control case: an intake that should converge with NO questions at all,
 * which is how a test proves the question generator is evidence-driven
 * rather than reflexive.
 */
export function unambiguousSpecText(): string {
  return [
    '# Settings Export',
    '',
    '## Goal',
    '',
    'Add a settings export command so a user can save their configuration to a file.',
    '',
    '## Requirements',
    '',
    '- The export command must write every configured setting to one JSON file.',
    '- The export command must refuse to overwrite an existing file.',
    '- The exported file must be readable by the existing import command without changes.',
    '',
    '## Scenarios',
    '',
    '- Exporting to a new path writes the file and reports the path.',
    '- Exporting to an existing path fails and changes nothing.',
    '',
    '## System boundaries',
    '',
    'The export command lives in the existing CLI module and changes no other component.',
    '',
    '## Canonical model',
    '',
    'The exported document is a Settings record: a map of setting name to value.',
    '',
    '## Compatibility',
    '',
    'The exported format is additive-only within a major version: fields may be added, ',
    'never removed or re-meaned.',
    '',
    '## Non-goals',
    '',
    '- No remote or cloud export in this feature.',
    '',
  ].join('\n');
}
