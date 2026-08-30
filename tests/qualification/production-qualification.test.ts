import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@specbridge/core';
import {
  HISTORICAL_FAULT_CATALOG,
  PRODUCTION_QUALIFICATION_GATES,
  buildProductionQualificationManifest,
  computeProductionRuntimeDigest,
  createProductionCandidate,
  emptyProductionQualificationMetrics,
  productionQualificationEvidenceFileSchema,
  renderProductionQualificationMarkdown,
} from '@specbridge/orchestration';
import type {
  HistoricalFaultObservation,
  ProductionCandidateIdentity,
  ProductionEvidenceRef,
  ProductionGateObservation,
  ProductionQualificationMetrics,
} from '@specbridge/orchestration';

const NOW = '2026-08-30T00:00:00.000Z';

function candidate(): ProductionCandidateIdentity {
  return createProductionCandidate({
    version: '1.1.0',
    commit: 'a'.repeat(40),
    runtimeEntries: [
      { path: 'packages/core/src/index.ts', content: 'export const core = true;\n' },
      { path: 'contracts/schema-versions.json', content: '{"candidate":"1.0.0"}\n' },
    ],
    schemaVersions: { candidate: '1.0.0' },
    bundles: [{ name: 'codex-plugin', version: '1.1.0', digest: sha256Hex('bundle') }],
    sourceTreeClean: true,
    frozenAt: NOW,
  });
}

function evidence(subject: string, frozen = candidate()): ProductionEvidenceRef {
  return {
    kind: 'TEST_RUN',
    ref: `artifacts/${subject}.json`,
    digest: sha256Hex(subject),
    observedAt: NOW,
    candidateCommit: frozen.commit,
    runtimeDigest: frozen.runtimeDigest,
    producer: 'vitest',
  };
}

function gates(frozen = candidate()): ProductionGateObservation[] {
  return PRODUCTION_QUALIFICATION_GATES.map((gate) => ({
    id: gate.id,
    result: 'PASS',
    summary: `${gate.title} passed against the frozen candidate.`,
    evidence: [evidence(gate.id, frozen)],
    diagnostics: [],
  }));
}

function faults(frozen = candidate()): HistoricalFaultObservation[] {
  return HISTORICAL_FAULT_CATALOG.map((fault) => ({
    id: fault.id,
    result: 'PASS',
    evidence: [evidence(fault.id, frozen)],
    diagnostics: [],
  }));
}

function readyMetrics(frozen = candidate()): ProductionQualificationMetrics {
  return {
    ...emptyProductionQualificationMetrics(),
    humanInterventionsAfterSeal: 0,
    unexpectedBlocks: 0,
    unrecoveredDriverDeaths: 0,
    completedWorkRedoCount: 0,
    lostCandidates: 0,
    duplicateDispatches: 0,
    runtimeMutation: 0,
    zeroTouchAfterSeal: true,
    finalJobStatus: 'COMPLETED',
    controlPlaneSelfRepairEnabled: false,
    runtimeStartDigest: frozen.runtimeDigest,
    runtimeEndDigest: frozen.runtimeDigest,
    usefulWorkDuringSubscriptionCooldown: 7,
    strongBuilderAvoidanceRatio: 0.75,
    researchAvoidanceRatio: 0.5,
    soakDurationMs: 7_200_000,
  };
}

function manifestInput(frozen = candidate()) {
  return {
    qualificationRunId: 'qual-release-001',
    candidate: frozen,
    environment: {
      os: 'win32 x64',
      nodeVersion: 'v22.6.0',
      pnpmVersion: '9.15.9',
      gitVersion: 'git version 2.51.0',
      localModel: {
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
        modelHash: sha256Hex('qwen'),
        context: '32768',
        inferenceProfile: 'secondary-local',
      },
      deerFlow: {
        provider: 'deerflow',
        apiVersion: 'v1',
        endpointIdentity: 'https://research.example.invalid',
      },
      frontends: frozen.bundles.map((bundle) => ({ ...bundle })),
    },
    gates: gates(frozen),
    historicalFaults: faults(frozen),
    metrics: readyMetrics(frozen),
    knownLimitations: [],
    generatedAt: NOW,
  } as const;
}

describe('vNext.10.2 frozen production candidate', () => {
  it('hashes exact relative paths and bytes deterministically', () => {
    const first = computeProductionRuntimeDigest([
      { path: 'b.ts', content: 'b' },
      { path: 'a.ts', content: 'a' },
    ]);
    const reordered = computeProductionRuntimeDigest([
      { path: 'a.ts', content: 'a' },
      { path: 'b.ts', content: 'b' },
    ]);
    const changed = computeProductionRuntimeDigest([
      { path: 'a.ts', content: 'changed' },
      { path: 'b.ts', content: 'b' },
    ]);
    expect(first).toEqual(reordered);
    expect(changed.digest).not.toBe(first.digest);
    expect(() => computeProductionRuntimeDigest([{ path: '../escape.ts', content: 'x' }])).toThrow(/relative paths/);
    expect(() => computeProductionRuntimeDigest([
      { path: 'same.ts', content: 'a' },
      { path: 'same.ts', content: 'b' },
    ])).toThrow(/Duplicate/);
  });

  it('refuses credential-shaped evidence and endpoint identity', () => {
    expect(() => productionQualificationEvidenceFileSchema.parse({
      gates: [{
        id: 'security-authority',
        result: 'FAIL',
        summary: 'provider returned Authorization: Bearer abcdefghijklmnop',
      }],
    })).toThrow(/credential-shaped/);
    expect(() => productionQualificationEvidenceFileSchema.parse({
      deerFlow: {
        provider: 'deerflow',
        apiVersion: 'v1',
        endpointIdentity: 'https://user:secret@example.invalid',
      },
    })).toThrow(/credential-shaped/);
  });
});

describe('vNext.10.2 formal release matrix and historical replay', () => {
  it('contains every A-T gate exactly once and every catalog target exists', () => {
    expect(PRODUCTION_QUALIFICATION_GATES.map((gate) => gate.letter)).toEqual(
      'ABCDEFGHIJKLMNOPQRST'.split(''),
    );
    expect(new Set(PRODUCTION_QUALIFICATION_GATES.map((gate) => gate.id)).size).toBe(20);
    expect(PRODUCTION_QUALIFICATION_GATES.every((gate) => gate.required)).toBe(true);
    expect(HISTORICAL_FAULT_CATALOG).toHaveLength(14);
    for (const fault of HISTORICAL_FAULT_CATALOG) {
      expect(fault.regressionTargets.length).toBeGreaterThan(0);
      for (const target of fault.regressionTargets) {
        expect(existsSync(path.resolve(target)), `${fault.id}: ${target}`).toBe(true);
      }
    }
  });

  it('materializes missing gates as SKIPPED_NOT_ALLOWED and cannot emit the marker', () => {
    const input = manifestInput();
    const report = buildProductionQualificationManifest({
      ...input,
      gates: input.gates.filter((gate) => gate.id !== 'real-local-model'),
    });
    expect(report.gates.find((gate) => gate.id === 'real-local-model')?.result).toBe('SKIPPED_NOT_ALLOWED');
    expect(report.decision.status).toBe('NOT_READY');
    expect(report.decision.failedRequiredGateIds).toContain('real-local-model');
    expect(report.marker).toBeNull();
  });

  it('emits READY and PRODUCTION_READY only when all semantic gates and counters pass', () => {
    const report = buildProductionQualificationManifest(manifestInput());
    expect(report.decision).toEqual({ status: 'READY', failedRequiredGateIds: [], blockers: [] });
    expect(report.marker?.status).toBe('PRODUCTION_READY');
    expect(report.marker?.runtimeDigest).toBe(report.candidate.runtimeDigest);
    expect(renderProductionQualificationMarkdown(report)).toContain('**READY**');
  });

  it('rejects developer-asserted PASS evidence from a different candidate', () => {
    const input = manifestInput();
    const mismatched = [...input.gates];
    mismatched[0] = {
      ...mismatched[0]!,
      evidence: [{ ...mismatched[0]!.evidence[0]!, candidateCommit: 'b'.repeat(40) }],
    };
    const report = buildProductionQualificationManifest({ ...input, gates: mismatched });
    expect(report.decision.status).toBe('NOT_READY');
    expect(report.decision.failedRequiredGateIds).toContain('full-repository-suite');
    expect(report.decision.blockers.join('\n')).toMatch(/different candidate/);
  });

  it('maps fault regressions, runtime mutation, and self-repair to their mandatory gates', () => {
    const input = manifestInput();
    const historicalFaults = [...input.historicalFaults];
    historicalFaults[3] = { ...historicalFaults[3]!, result: 'FAIL', diagnostics: ['conflict residue'] };
    const report = buildProductionQualificationManifest({
      ...input,
      historicalFaults,
      metrics: {
        ...input.metrics,
        runtimeMutation: 1,
        controlPlaneSelfRepairEnabled: true,
      },
    });
    expect(report.decision.status).toBe('NOT_READY');
    expect(report.decision.failedRequiredGateIds).toEqual(expect.arrayContaining([
      'historical-fault-replay',
      'release-reproducibility',
      'security-authority',
    ]));
    expect(report.marker).toBeNull();
  });
});
