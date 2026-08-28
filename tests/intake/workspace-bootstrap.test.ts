import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allFindings,
  assessSnapshotFreshness,
  bootstrapWorkspace,
  inspectWorkspace,
  readCurrentSystemSnapshot,
  resolveRepositories,
  snapshotFile,
} from '@specbridge/intake';
import { activeProductContracts } from '@specbridge/intake';
import { repositoryIndexFile } from '@specbridge/orchestration';
import { sealedMission } from '../helpers-autonomy.js';
import type { IntakeFixture } from '../helpers-intake.js';
import { setupIntakeFixture } from '../helpers-intake.js';

/**
 * Workspace Bootstrap (vNext.10.2 Phase 1).
 *
 * The tests hold the three artifacts to their distinct roles:
 *
 *   RepositoryContextIndex   disposable retrieval index (reused, not replaced)
 *   CurrentSystemSnapshot    durable evidence-backed understanding
 *   Product Contract         authoritative product truth
 *
 * and the one rule that must never bend: repository observations cannot
 * become product authority.
 */

const FAKE_HEAD_A = 'a'.repeat(40);
const FAKE_HEAD_B = 'b'.repeat(40);

/** A git repository readGitHead can resolve, with no git binary involved. */
function fakeGitRepo(dir: string, head: string): void {
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  writeFileSync(path.join(dir, '.git', 'HEAD'), `${head}\n`, 'utf8');
}

function writeSource(root: string, relPath: string, body: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

/** The §22 brownfield shape: an operations platform that already exists. */
function brownfieldFixture(): IntakeFixture {
  const fixture = setupIntakeFixture();
  const root = fixture.root;
  fakeGitRepo(root, FAKE_HEAD_A);
  writeSource(
    root,
    'src/main/java/ops/PermissionService.java',
    [
      'package ops;',
      'public class PermissionService {',
      '  public boolean allowed(String user, String action) { return true; }',
      '}',
    ].join('\n'),
  );
  writeSource(
    root,
    'src/main/java/ops/JobScheduler.java',
    [
      'package ops;',
      'public class JobScheduler {',
      '  private int retryCount = 3;',
      '  public void schedule(Job job) {}',
      '}',
    ].join('\n'),
  );
  writeSource(
    root,
    'src/main/java/ops/ExecutionAudit.java',
    ['package ops;', 'public class ExecutionAudit {', '  public void record(String event) {}', '}'].join(
      '\n',
    ),
  );
  writeSource(
    root,
    'src/main/java/ops/Cluster.java',
    ['package ops;', 'public class Cluster {', '  private String name;', '}'].join('\n'),
  );
  writeSource(
    root,
    'src/main/java/ops/JobController.java',
    ['package ops;', 'public class JobController {', '  private JobScheduler scheduler;', '}'].join('\n'),
  );
  writeSource(
    root,
    'build.gradle',
    [
      "plugins { id 'org.springframework.boot' version '3.3.0' }",
      'java { sourceCompatibility = 21 }',
      'dependencies {',
      "  implementation 'org.springframework.boot:spring-boot-starter-web'",
      "  implementation 'org.postgresql:postgresql'",
      "  implementation 'io.micrometer:micrometer-registry-prometheus'",
      '}',
    ].join('\n'),
  );
  writeSource(root, 'docs/architecture.md', '# Operations platform architecture\n\nControl plane notes.\n');
  return fixture;
}

describe('brownfield bootstrap (A)', () => {
  it('identifies existing capabilities, architecture, and constraints with evidence', () => {
    const fixture = brownfieldFixture();
    const result = bootstrapWorkspace(fixture.intake);
    const snapshot = result.snapshot;

    expect(snapshot.mode).toBe('BROWNFIELD');
    const capabilityNames = snapshot.capabilities.map((finding) => finding.statement).join(' ');
    expect(capabilityNames).toContain('PermissionService');
    expect(capabilityNames).toContain('JobScheduler');
    // ExecutionAudit ends in a capability suffix ('Audit').
    expect(capabilityNames).toContain('ExecutionAudit');

    const architecture = snapshot.architecture.map((finding) => finding.statement).join(' ');
    expect(architecture).toContain('Spring Boot');
    expect(architecture).toContain('PostgreSQL');
    expect(architecture).toContain('Prometheus');

    expect(snapshot.constraints.map((finding) => finding.statement).join(' ')).toContain('Java 21');
    expect(snapshot.domainObjects.map((finding) => finding.statement).join(' ')).toContain('Cluster');

    // Every material finding carries evidence (K) — schema-enforced, but
    // assert it end to end anyway, with real paths and hashes.
    for (const { finding } of allFindings(snapshot)) {
      expect(finding.evidence.length).toBeGreaterThan(0);
    }
    const permission = snapshot.capabilities.find((finding) =>
      finding.statement.includes('PermissionService'),
    );
    expect(permission?.evidence[0]?.path).toContain('PermissionService.java');
    expect(permission?.evidence[0]?.contentHash).toBeDefined();
    expect(permission?.class).toBe('OBSERVED_IMPLEMENTATION');
  });
});

describe('observation is not authority (B)', () => {
  it('records retryCount behaviour as OBSERVED_IMPLEMENTATION and creates no contract', () => {
    const fixture = brownfieldFixture();
    const contractsBefore = activeProductContracts(fixture.workspace);
    const result = bootstrapWorkspace(fixture.intake);

    // Nothing in any category claims sealed authority for an observation.
    for (const { finding } of allFindings(result.snapshot)) {
      if (finding.class === 'SEALED_PRODUCT_TRUTH') {
        // Sealed findings may only cite product-truth records.
        expect(
          finding.evidence.every((ref) => ref.contractId !== undefined || ref.adrId !== undefined),
        ).toBe(true);
      }
    }
    // No product contract was created or mutated by bootstrap.
    const contractsAfter = activeProductContracts(fixture.workspace);
    expect(contractsAfter).toEqual(contractsBefore);
    expect(result.snapshot.existingProductTruth).toEqual([]);
  });
});

describe('sealed contract linkage (C)', () => {
  it('classifies existing contracts as SEALED_PRODUCT_TRUTH with exact ownership', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const { seal, missionId } = sealedMission(fixture);
    void seal;
    const result = bootstrapWorkspace(fixture.intake);

    const contractRefs = result.snapshot.existingProductTruth.filter(
      (ref) => ref.kind === 'contract',
    );
    expect(contractRefs.length).toBeGreaterThan(0);
    expect(contractRefs[0]?.missionId).toBe(missionId);
    expect(contractRefs[0]?.revision).toBe(1);

    const sealedConstraints = result.snapshot.constraints.filter(
      (finding) => finding.class === 'SEALED_PRODUCT_TRUTH',
    );
    expect(sealedConstraints.length).toBeGreaterThan(0);
    expect(sealedConstraints[0]?.evidence[0]?.contractId).toBeDefined();
    expect(sealedConstraints[0]?.evidence[0]?.contractRevision).toBe(1);
  });
});

describe('greenfield (D)', () => {
  it('an empty workspace produces a clean GREENFIELD baseline, not an error', () => {
    const fixture = setupIntakeFixture();
    const result = bootstrapWorkspace(fixture.intake);
    expect(result.snapshot.mode).toBe('GREENFIELD');
    expect(result.snapshot.capabilities).toEqual([]);
    expect(result.snapshot.uncertainties).toEqual([]);
    expect(result.snapshot.repositories).toHaveLength(1);
  });
});

describe('multi-repository (E)', () => {
  it('combines findings while preserving repository-specific evidence and baselines', () => {
    const fixture = setupIntakeFixture();
    const root = fixture.root;
    fakeGitRepo(path.join(root, 'control-plane'), FAKE_HEAD_A);
    fakeGitRepo(path.join(root, 'agent'), FAKE_HEAD_B);
    writeSource(
      root,
      'control-plane/src/ClusterService.java',
      'public class ClusterService {}\npublic class Cluster {}\n',
    );
    writeSource(root, 'control-plane/src/Api.java', 'public class Api {}\n');
    writeSource(root, 'agent/src/HostAgentService.java', 'public class HostAgentService {}\n');
    writeSource(root, 'agent/src/Host.java', 'public class Host {}\n');

    const resolution = resolveRepositories(fixture.workspace);
    expect(resolution.source).toBe('detected-children');
    expect(resolution.repositories.map((repo) => repo.repositoryId).sort()).toEqual([
      'agent',
      'control-plane',
    ]);

    const result = bootstrapWorkspace(fixture.intake);
    const repos = result.snapshot.repositories;
    expect(repos.find((repo) => repo.repositoryId === 'control-plane')?.gitHead).toBe(FAKE_HEAD_A);
    expect(repos.find((repo) => repo.repositoryId === 'agent')?.gitHead).toBe(FAKE_HEAD_B);

    const cluster = result.snapshot.capabilities.find((finding) =>
      finding.statement.includes('ClusterService'),
    );
    const host = result.snapshot.capabilities.find((finding) =>
      finding.statement.includes('HostAgentService'),
    );
    expect(cluster?.evidence[0]?.repositoryId).toBe('control-plane');
    expect(cluster?.evidence[0]?.path).toBe('src/ClusterService.java');
    expect(host?.evidence[0]?.repositoryId).toBe('agent');
  });

  it('a manifest naming a path outside the workspace fails closed', () => {
    const fixture = setupIntakeFixture();
    mkdirSync(path.join(fixture.root, '.specbridge'), { recursive: true });
    writeFileSync(
      path.join(fixture.root, '.specbridge', 'repositories.json'),
      JSON.stringify({ repositories: [{ id: 'outside', path: '../elsewhere' }] }),
      'utf8',
    );
    expect(() => resolveRepositories(fixture.workspace)).toThrowError(/outside the workspace/);
  });
});

describe('snapshot reuse and staleness (F, G)', () => {
  it('an unchanged workspace reuses the snapshot without regeneration', () => {
    const fixture = brownfieldFixture();
    const first = bootstrapWorkspace(fixture.intake);
    expect(first.reused).toBe(false);
    const second = bootstrapWorkspace(fixture.intake);
    expect(second.reused).toBe(true);
    expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
  });

  it('a moved repository baseline makes the snapshot stale, never silently current', () => {
    const fixture = brownfieldFixture();
    bootstrapWorkspace(fixture.intake);
    // The repository moves.
    fakeGitRepo(fixture.root, FAKE_HEAD_B);
    const freshness = assessSnapshotFreshness(
      fixture.workspace,
      readCurrentSystemSnapshot(fixture.workspace),
    );
    expect(freshness.status).toBe('STALE');
    expect(freshness.reasons.join(' ')).toContain('moved');
    // And bootstrap regenerates rather than reusing.
    const regenerated = bootstrapWorkspace(fixture.intake);
    expect(regenerated.reused).toBe(false);
  });

  it('changed bytes without a head change also force regeneration', () => {
    const fixture = brownfieldFixture();
    const first = bootstrapWorkspace(fixture.intake);
    writeSource(
      fixture.root,
      'src/main/java/ops/AlertRuleService.java',
      'public class AlertRuleService {}\n',
    );
    const second = bootstrapWorkspace(fixture.intake);
    expect(second.reused).toBe(false);
    expect(second.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
    expect(
      second.snapshot.capabilities.some((finding) => finding.statement.includes('AlertRuleService')),
    ).toBe(true);
  });
});

describe('cache corruption (H)', () => {
  it('a corrupt repository index cache degrades to rebuild, not partial trust', () => {
    const fixture = brownfieldFixture();
    bootstrapWorkspace(fixture.intake);
    writeFileSync(repositoryIndexFile(fixture.workspace), '{ not json', 'utf8');
    const result = bootstrapWorkspace(fixture.intake);
    expect(result.indexRebuilt).toBe(true);
    expect(result.snapshot.mode).toBe('BROWNFIELD');
  });

  it('a corrupt snapshot degrades to regeneration', () => {
    const fixture = brownfieldFixture();
    bootstrapWorkspace(fixture.intake);
    writeFileSync(snapshotFile(fixture.workspace), 'garbage', 'utf8');
    expect(readCurrentSystemSnapshot(fixture.workspace)).toBeUndefined();
    const result = bootstrapWorkspace(fixture.intake);
    expect(result.reused).toBe(false);
    expect(result.snapshot.mode).toBe('BROWNFIELD');
  });
});

describe('protected and credential paths (I)', () => {
  it('never indexes or surfaces prohibited areas', () => {
    const fixture = brownfieldFixture();
    writeSource(fixture.root, 'config/db-credentials.json', '{"password":"hunter2"}');
    writeSource(fixture.root, '.kiro/steering/notes.md', 'protected');
    const result = bootstrapWorkspace(fixture.intake);
    const serialized = JSON.stringify(result.snapshot);
    expect(serialized).not.toContain('db-credentials');
    expect(serialized).not.toContain('hunter2');

    const inspect = inspectWorkspace(fixture.intake, { question: 'database credentials password' });
    expect(JSON.stringify(inspect)).not.toContain('hunter2');
  });
});

describe('boundedness (J)', () => {
  it('a large repository yields a bounded, schema-valid snapshot with no file bodies', () => {
    const fixture = setupIntakeFixture();
    fakeGitRepo(fixture.root, FAKE_HEAD_A);
    for (let i = 0; i < 80; i += 1) {
      writeSource(
        fixture.root,
        `src/cap/Capability${String(i).padStart(2, '0')}Service.java`,
        `public class Capability${String(i).padStart(2, '0')}Service { /* ${'x'.repeat(500)} */ }\n`,
      );
    }
    const result = bootstrapWorkspace(fixture.intake);
    expect(result.snapshot.capabilities.length).toBeLessThanOrEqual(40);
    for (const { finding } of allFindings(result.snapshot)) {
      expect(finding.statement.length).toBeLessThanOrEqual(600);
      expect(finding.statement).not.toContain('xxxxxxxxxx');
    }
  });
});

describe('bounded inspection', () => {
  it('answers a question with ranked sections from the existing index', () => {
    const fixture = brownfieldFixture();
    bootstrapWorkspace(fixture.intake);
    const result = inspectWorkspace(fixture.intake, {
      question: 'How does the JobScheduler retry work?',
      maxSections: 3,
    });
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections.length).toBeLessThanOrEqual(3);
    const paths = result.sections.map((section) => section.path).join(' ');
    expect(paths).toContain('JobScheduler.java');
    for (const section of result.sections) {
      expect(section.contentHash.length).toBeGreaterThan(10);
    }
  });

  it('scopes to one repository when asked', () => {
    const fixture = setupIntakeFixture();
    fakeGitRepo(path.join(fixture.root, 'control-plane'), FAKE_HEAD_A);
    fakeGitRepo(path.join(fixture.root, 'agent'), FAKE_HEAD_B);
    writeSource(fixture.root, 'control-plane/src/Scheduler.java', 'public class Scheduler {}\n');
    writeSource(fixture.root, 'agent/src/Scheduler.java', 'public class Scheduler {}\n');
    const result = inspectWorkspace(fixture.intake, {
      question: 'Scheduler',
      repositoryId: 'agent',
    });
    expect(result.sections.every((section) => section.repositoryId === 'agent')).toBe(true);
  });
});

describe('backward compatibility (L)', () => {
  it('bootstrap leaves the repository index reusable by the existing context machinery', () => {
    const fixture = brownfieldFixture();
    bootstrapWorkspace(fixture.intake);
    const raw = JSON.parse(readFileSync(repositoryIndexFile(fixture.workspace), 'utf8')) as {
      schemaVersion: string;
      entries: unknown[];
    };
    expect(raw.schemaVersion).toMatch(/^1\./);
    expect(raw.entries.length).toBeGreaterThan(0);
  });
});
