import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@specbridge/core';
import {
  INTAKE_LIMITS,
  chunkText,
  normativeChunks,
  parseSpecificationDocument,
  readIntakeEvents,
  readSpecSource,
  runIntakeDiscovery,
  startSpecIntake,
  startSpecIntakeFromFile,
} from '@specbridge/intake';
import { readTurns, requireMissionState } from '@specbridge/mission';
import { goldenSpecPath, goldenSpecText, setupIntakeFixture } from '../helpers-intake.js';

/**
 * §1 — Full spec intake.
 *
 * The claim under test is narrow and load-bearing: a substantial submitted
 * specification is INGESTED, not summarized. Everything else in vNext.10.1
 * rests on the original document staying inspectable and on the parse being
 * an index over it rather than a replacement for it.
 *
 * Nothing here touches a model, a network, or git.
 */

describe('spec intake — ingesting a full specification', () => {
  it('stores the submitted document verbatim, content-addressed, with provenance', () => {
    const fixture = setupIntakeFixture();
    const content = goldenSpecText();
    const started = startSpecIntakeFromFile(fixture.intake, {
      name: 'steprelay-workbench',
      file: goldenSpecPath(),
    });

    const stored = path.join(fixture.root, started.source.storedAt);
    expect(existsSync(stored)).toBe(true);
    // Byte-exact. Not "equivalent", not "normalized": the same bytes.
    expect(readFileSync(stored, 'utf8')).toBe(content);
    expect(started.source.contentHash).toBe(sha256Hex(content));
    expect(started.source.byteLength).toBe(Buffer.byteLength(content, 'utf8'));

    // Provenance is structural: where it came from, when, and through what.
    expect(started.source.kind).toBe('file');
    expect(started.source.originPath).toContain('steprelay-airport-demo.md');
    expect(started.source.receivedVia).toBe('test');
    expect(started.source.receivedAt).toBe('2026-08-20T21:00:00.000Z');
  });

  it('records ingestion as an intake event with the digest', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'demo',
      kind: 'text',
      content: goldenSpecText(),
    });
    const events = readIntakeEvents(fixture.workspace, started.intake.intakeId).events;
    const ingested = events.find((event) => event['type'] === 'source_ingested');
    expect(ingested).toBeDefined();
    expect(ingested?.['contentHash']).toBe(started.source.contentHash);
    expect(Number(ingested?.['chunks'])).toBeGreaterThan(40);
  });

  it('parses a long document into addressable chunks that recover the original bytes', () => {
    const content = goldenSpecText();
    const parsed = parseSpecificationDocument(content);

    expect(parsed.chunks.length).toBeGreaterThan(40);
    expect(parsed.outline).toContain('Edge cases');
    expect(parsed.outline).toContain('Generic visualization');

    // Every chunk's byte range recovers its own text from the stored source.
    for (const chunk of parsed.chunks.slice(0, 40)) {
      const recovered = chunkText(content, chunk).trim();
      expect(recovered.startsWith(chunk.text.slice(0, 40))).toBe(true);
    }
  });

  it('cuts an enumerated edge-case list into one chunk per case', () => {
    const parsed = parseSpecificationDocument(goldenSpecText());
    const scenarios = parsed.chunks.filter((chunk) => chunk.kind === 'scenario');
    // Eleven enumerated edge cases in the Golden Spec, each its own chunk. A
    // parser that kept the list whole would let a discovery pass account for
    // "the edge cases" collectively and silently drop four of them.
    const bullets = scenarios.filter((chunk) => chunk.text.startsWith('-'));
    expect(bullets.length).toBeGreaterThanOrEqual(11);
    expect(bullets.some((chunk) => chunk.text.includes('boarding pass missing'))).toBe(true);
    expect(bullets.some((chunk) => chunk.text.includes('malformed face data'))).toBe(true);
  });

  it('gives a list its introducing sentence, so each item is closable on its own', () => {
    // The dogfood's sealed ledger carried "The console must support:" as an
    // acceptance criterion — a colon-terminated fragment nobody can close —
    // while the ten capabilities beneath it became neither a requirement nor
    // a criterion. The intro belongs to its list.
    const parsed = parseSpecificationDocument(
      [
        '## Operations console',
        '',
        'The console must support:',
        '',
        '- discover/view workflow definitions;',
        '- list workflow executions;',
        '',
        'A later paragraph that introduces nothing.',
        '',
        '- an unrelated bullet.',
        '',
      ].join('\n'),
    );
    const capability = parsed.chunks.find((chunk) => chunk.text.includes('list workflow executions'));
    expect(capability?.headingPath).toEqual(['Operations console', 'The console must support']);

    // The intro's own chunk still exists — nothing is dropped from the
    // index — and a paragraph that does NOT end in a colon does not claim
    // the list beneath it.
    expect(parsed.chunks.some((chunk) => chunk.text === 'The console must support:')).toBe(true);
    const unrelated = parsed.chunks.find((chunk) => chunk.text.includes('an unrelated bullet'));
    expect(unrelated?.headingPath).toEqual(['Operations console']);
  });

  it('classifies non-goals, examples, and headings apart from requirements', () => {
    const parsed = parseSpecificationDocument(
      [
        '# Feature',
        '',
        'The console must list executions.',
        '',
        '## Non-goals',
        '',
        '- No multi-tenant isolation in v1.',
        '',
        '## Example',
        '',
        '```json',
        '{"state": "GateOne"}',
        '```',
        '',
        'This section explains the background of the work.',
        '',
      ].join('\n'),
    );
    const kindOf = (prefix: string): string | undefined =>
      parsed.chunks.find((chunk) => chunk.text.startsWith(prefix))?.kind;
    expect(kindOf('# Feature')).toBe('heading');
    expect(kindOf('The console must list')).toBe('normative');
    expect(kindOf('- No multi-tenant')).toBe('non-goal');
    expect(kindOf('```json')).toBe('example');
    expect(kindOf('This section explains')).toBe('narrative');
  });

  it('records the submitted specification as ONE user turn, honestly bounded', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'demo',
      kind: 'text',
      content: goldenSpecText(),
    });
    // Discovery has not run, so the only turn is the ingestion one, written
    // when canonical truth is first compiled. Run one pass to produce it.
    runIntakeDiscovery(fixture.intake, started.intake.intakeId);

    const turns = readTurns(fixture.workspace, started.mission.missionId).turns;
    const submission = turns.find((turn) => turn.text.includes('Submitted product specification'));
    expect(submission).toBeDefined();
    expect(submission?.speaker).toBe('user');
    // The turn names the digest and where the whole document lives, so a
    // decision citing it can be traced to the real evidence rather than to a
    // paraphrase.
    expect(submission?.text).toContain(started.source.contentHash.slice(0, 16));
    expect(submission?.text).toContain('.specbridge/intake/');
  });

  it('marks a truncated turn as an excerpt rather than pretending to be complete', () => {
    const fixture = setupIntakeFixture();
    const long = [
      '# Long specification',
      '',
      ...Array.from(
        { length: 400 },
        (_, index) => `- The system must satisfy enumerated obligation number ${index + 1}.`,
      ),
      '',
    ].join('\n');
    const started = startSpecIntake(fixture.intake, {
      name: 'long-spec',
      kind: 'text',
      content: long,
    });
    runIntakeDiscovery(fixture.intake, started.intake.intakeId);
    const turns = readTurns(fixture.workspace, started.mission.missionId).turns;
    const submission = turns.find((turn) => turn.text.includes('Submitted product specification'));
    expect(submission?.text).toContain('EXCERPT');
    expect(submission?.text).toContain('the complete document is the record at');
  });

  it('derives a goal from the document and keeps it on the mission', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'steprelay-workbench',
      kind: 'text',
      content: goldenSpecText(),
    });
    const mission = requireMissionState(fixture.workspace, started.mission.missionId);
    expect(mission.goal).toContain('StepRelay demo/workbench');
    expect(mission.name).toBe('steprelay-workbench');
  });

  it('refuses an empty specification and one over the size bound', () => {
    const fixture = setupIntakeFixture();
    expect(() =>
      startSpecIntake(fixture.intake, { name: 'x', kind: 'text', content: '' }),
    ).toThrow(/empty/i);
    expect(() =>
      startSpecIntake(fixture.intake, {
        name: 'x',
        kind: 'text',
        content: 'x'.repeat(INTAKE_LIMITS.maxSourceBytes + 1),
      }),
    ).toThrow(/bound/i);
  });

  it('keeps the normative set — the coverage gate operates on it', () => {
    const parsed = parseSpecificationDocument(goldenSpecText());
    const normative = normativeChunks(parsed.chunks);
    expect(normative.length).toBeGreaterThan(30);
    // Headings, prose, and code blocks are evidence, never obligations.
    expect(normative.every((chunk) => chunk.kind !== 'heading')).toBe(true);
    expect(normative.every((chunk) => chunk.kind !== 'example')).toBe(true);
    expect(normative.every((chunk) => chunk.kind !== 'narrative')).toBe(true);
  });

  it('re-ingesting identical bytes reuses the stored file rather than rewriting it', () => {
    const fixture = setupIntakeFixture();
    const content = goldenSpecText();
    const first = startSpecIntake(fixture.intake, { name: 'a', kind: 'text', content });
    const stored = path.join(fixture.root, first.source.storedAt);
    const before = readFileSync(stored, 'utf8');
    const again = startSpecIntake(fixture.intake, {
      name: 'a',
      kind: 'text',
      content,
      intakeId: first.intake.intakeId,
    });
    expect(again.source.contentHash).toBe(first.source.contentHash);
    expect(readFileSync(stored, 'utf8')).toBe(before);
    expect(readSpecSource(fixture.workspace, first.intake.intakeId)?.contentHash).toBe(
      first.source.contentHash,
    );
  });
});
