import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeProductContracts,
  allFindings,
  bootstrapWorkspace,
  readWorkspaceSnapshot,
  runIntakeDiscovery,
  startSpecIntake,
} from '@specbridge/intake';
import type { IntakeFixture } from '../helpers-intake.js';
import { setupIntakeFixture } from '../helpers-intake.js';

/**
 * Phase 1 qualification (vNext.10.2 §22).
 *
 * The Brownfield lifecycle, end to end:
 *
 *   Workspace Bootstrap → CurrentSystemSnapshot identifies what exists
 *     → the conversation gets repository-aware context
 *     → the DELTA spec reuses the existing system instead of recreating it
 *     → formal Spec Intake still runs its own grounding and still owns
 *       product authority.
 *
 * And Greenfield: an empty repository bootstraps to a clean baseline and
 * the normal intake path stays usable, unchanged.
 */

function write(root: string, relPath: string, body: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

/** §22: a Spring Boot operations platform that already exists. */
function operationsPlatform(): IntakeFixture {
  const fixture = setupIntakeFixture();
  const root = fixture.root;
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'HEAD'), `${'c'.repeat(40)}\n`, 'utf8');
  write(
    root,
    'build.gradle',
    [
      "plugins { id 'org.springframework.boot' version '3.3.0' }",
      'java { sourceCompatibility = 21 }',
      "dependencies { implementation 'io.micrometer:micrometer-registry-prometheus' }",
    ].join('\n'),
  );
  write(
    root,
    'src/main/java/ops/PermissionService.java',
    'package ops;\npublic class PermissionService { public boolean check(String u, String a) { return true; } }\n',
  );
  write(
    root,
    'src/main/java/ops/JobScheduler.java',
    'package ops;\npublic class JobScheduler { private int retryCount = 3; }\n',
  );
  write(
    root,
    'src/main/java/ops/ExecutionAudit.java',
    'package ops;\npublic class ExecutionAudit { public void record(String e) {} }\n',
  );
  return fixture;
}

/** The delta specification the repository-aware conversation produces. */
const DELTA_SPEC = [
  '# Automated Inspection and Self-Healing',
  '',
  '## Goal',
  '',
  'Add automated inspection and self-healing to the existing operations platform.',
  '',
  '## Requirements',
  '',
  '- Inspection findings must be evaluated against remediation rules before any action runs.',
  '- Remediation actions must reuse the existing PermissionService for authorization decisions.',
  '- Remediation execution must be scheduled through the existing JobScheduler.',
  '- Every remediation execution must be recorded through the existing ExecutionAudit.',
  '- High-risk remediation must not execute automatically; it must wait for an operator approval.',
  '',
  '## Edge cases',
  '',
  '- An inspection finding with no matching remediation rule is recorded and takes no action.',
  '',
  '## Non-goals',
  '',
  '- Replacing the existing permission, scheduling, or audit systems.',
  '',
  '## Data visibility',
  '',
  'Remediation records may store the finding, the rule, the decision, and the outcome.',
].join('\n');

describe('brownfield qualification', () => {
  it('bootstrap → snapshot → delta intake, with authority untouched throughout', () => {
    const fixture = operationsPlatform();

    // 1. Workspace Bootstrap identifies the existing system, with evidence.
    const bootstrap = bootstrapWorkspace(fixture.intake);
    const snapshot = bootstrap.snapshot;
    expect(snapshot.mode).toBe('BROWNFIELD');
    const capabilities = snapshot.capabilities.map((finding) => finding.statement).join(' ');
    expect(capabilities).toContain('PermissionService');
    expect(capabilities).toContain('JobScheduler');
    expect(capabilities).toContain('ExecutionAudit');
    expect(snapshot.architecture.map((f) => f.statement).join(' ')).toContain('Spring Boot');
    expect(snapshot.architecture.map((f) => f.statement).join(' ')).toContain('Prometheus');
    for (const { finding } of allFindings(snapshot)) {
      expect(finding.evidence.length).toBeGreaterThan(0);
    }

    // 2. The conversation can obtain the summary without dumping the repo.
    const read = readWorkspaceSnapshot(fixture.workspace);
    expect(read.freshness.status).toBe('FRESH');
    expect(JSON.stringify(read.snapshot)).not.toContain('public class');

    // 3. Bootstrap created NO product authority.
    expect(activeProductContracts(fixture.workspace)).toEqual([]);
    expect(snapshot.existingProductTruth).toEqual([]);

    // 4. Formal Spec Intake runs on the DELTA spec — and performs its OWN
    //    repository grounding (double-grounding is intentional).
    const started = startSpecIntake(fixture.intake, {
      name: 'auto-remediation',
      kind: 'text',
      content: DELTA_SPEC,
    });
    const discovery = runIntakeDiscovery(fixture.intake, started.intake.intakeId);
    expect(discovery.grounding.evidence.length).toBeGreaterThan(0);

    // 5. The delta reuses the existing systems rather than recreating them:
    //    reuse statements survive verbatim, and no statement asks for a NEW
    //    permission/scheduler/audit system.
    const statements = discovery.analysis.items.map((item) => item.statement).join('\n');
    expect(statements).toContain('existing PermissionService');
    expect(statements).toContain('existing JobScheduler');
    expect(statements).toContain('existing ExecutionAudit');
    expect(statements).not.toMatch(/new (RBAC|permission system|scheduler|audit system)/i);

    // 6. The observed implementation detail (retryCount = 3) was never
    //    promoted into the product conversation's authority path.
    expect(statements).not.toContain('retryCount');
    expect(statements).not.toMatch(/retry exactly three/i);
  });
});

describe('greenfield qualification', () => {
  it('an empty repository bootstraps to a clean baseline and intake stays usable', () => {
    const fixture = setupIntakeFixture();
    const bootstrap = bootstrapWorkspace(fixture.intake);
    expect(bootstrap.snapshot.mode).toBe('GREENFIELD');
    expect(bootstrap.snapshot.capabilities).toEqual([]);

    const started = startSpecIntake(fixture.intake, {
      name: 'settings-export',
      kind: 'text',
      content: [
        '# Settings Export',
        '',
        '## Goal',
        '',
        'Add a settings export command so a user can save their configuration to a file.',
        '',
        '## Requirements',
        '',
        '- The export command must write every configured setting to one JSON file.',
      ].join('\n'),
    });
    const discovery = runIntakeDiscovery(fixture.intake, started.intake.intakeId);
    expect(discovery.analysis.items.length).toBeGreaterThan(0);
  });
});
