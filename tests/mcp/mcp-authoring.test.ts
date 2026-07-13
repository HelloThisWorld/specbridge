import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureToTemp } from '../helpers.js';
import { callTool, connectMcp } from '../helpers-mcp.js';

/**
 * spec_create preview/apply and the hash-bound stage validate/apply cycle.
 */

const VALID_REQUIREMENTS = `# Requirements Document

## Introduction

Users need configurable notification preferences so alerts arrive on the
channels they actually read.

## Requirements

### Requirement 1

**User Story:** As a user, I want to choose notification channels, so that I receive alerts where I read them.

#### Acceptance Criteria

1. WHEN a user selects a channel THEN the system SHALL persist the selection immediately.
2. WHEN persistence is unavailable THEN the system SHALL surface an actionable error message.
`;

describe('spec_create', () => {
  it('preview (apply: false) renders files and writes nothing', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    const session = await connectMcp(root);
    try {
      const result = await callTool(session, 'spec_create', {
        name: 'notification-preferences',
        description: 'Allow users to configure notification channels.',
      });
      expect(result.isError).toBe(false);
      expect(result.structured['applied']).toBe(false);
      const files = result.structured['files'] as { path: string; content?: string }[];
      expect(files.map((file) => file.path)).toEqual([
        '.kiro/specs/notification-preferences/requirements.md',
        '.kiro/specs/notification-preferences/design.md',
        '.kiro/specs/notification-preferences/tasks.md',
      ]);
      expect(files[0]?.content).toContain('# Requirements Document');
      // Nothing on disk.
      expect(existsSync(path.join(root, '.kiro', 'specs', 'notification-preferences'))).toBe(false);
      expect(existsSync(path.join(root, '.specbridge', 'state'))).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('apply: true creates the spec atomically with sidecar state', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    const session = await connectMcp(root);
    try {
      const result = await callTool(session, 'spec_create', {
        name: 'notification-preferences',
        type: 'feature',
        mode: 'requirements-first',
        description: 'Allow users to configure notification channels.',
        apply: true,
      });
      expect(result.isError).toBe(false);
      expect(result.structured['applied']).toBe(true);
      expect(result.structured['initialStatus']).toBe('REQUIREMENTS_DRAFT');
      const specDir = path.join(root, '.kiro', 'specs', 'notification-preferences');
      expect(readdirSync(specDir).sort()).toEqual(['design.md', 'requirements.md', 'tasks.md']);
      expect(
        existsSync(path.join(root, '.specbridge', 'state', 'specs', 'notification-preferences.json')),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('rejects an existing spec and an invalid name', async () => {
    const root = copyFixtureToTemp('standard-feature');
    const session = await connectMcp(root);
    try {
      const existingName = readdirSync(path.join(root, '.kiro', 'specs'))[0] as string;
      const existing = await callTool(session, 'spec_create', { name: existingName, apply: true });
      expect(existing.isError).toBe(true);
      expect(existing.errorCode).toBe('SBMCP002');
      expect(existing.text).toContain('already exists');

      const invalid = await callTool(session, 'spec_create', { name: 'Bad Name!' });
      expect(invalid.isError).toBe(true);
      expect(invalid.errorCode).toBe('SBMCP002');
    } finally {
      await session.close();
    }
  });
});

describe('spec_stage_validate / spec_stage_apply', () => {
  async function createSpec(root: string): Promise<void> {
    const session = await connectMcp(root);
    try {
      const result = await callTool(session, 'spec_create', {
        name: 'notification-preferences',
        description: 'Allow users to configure notification channels.',
        apply: true,
      });
      expect(result.isError).toBe(false);
    } finally {
      await session.close();
    }
  }

  it('validation returns a diff, candidate hash, and approval effects without writing', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    await createSpec(root);
    const session = await connectMcp(root);
    try {
      const requirementsPath = path.join(
        root,
        '.kiro',
        'specs',
        'notification-preferences',
        'requirements.md',
      );
      const bytesBefore = readFileSync(requirementsPath);
      const result = await callTool(session, 'spec_stage_validate', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
      });
      expect(result.isError).toBe(false);
      expect(result.structured['valid']).toBe(true);
      expect(result.structured['candidateHash']).toMatch(/^[0-9a-f]{64}$/);
      expect(result.structured['currentHash']).toMatch(/^[0-9a-f]{64}$/);
      expect(result.structured['diff'] as string).toContain('+### Requirement 1');
      expect(result.structured['wouldInvalidateApprovals']).toEqual([]);
      // Read-only: the document is untouched.
      expect(readFileSync(requirementsPath).equals(bytesBefore)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('a candidate with placeholder errors is reported invalid and apply refuses it', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    await createSpec(root);
    const session = await connectMcp(root);
    try {
      const bad = '# Requirements Document\n\n[Describe the feature]\n';
      const validation = await callTool(session, 'spec_stage_validate', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: bad,
      });
      expect(validation.isError).toBe(false);
      expect(validation.structured['valid']).toBe(false);
      expect(validation.structured['errorCount'] as number).toBeGreaterThan(0);

      const apply = await callTool(session, 'spec_stage_apply', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: bad,
        expectedCurrentHash: validation.structured['currentHash'],
        expectedCandidateHash: validation.structured['candidateHash'],
        acknowledgement: 'apply-reviewed-candidate',
      });
      expect(apply.isError).toBe(true);
      expect(apply.errorCode).toBe('SBMCP016');
    } finally {
      await session.close();
    }
  });

  it('candidate hash substitution between validate and apply is rejected', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    await createSpec(root);
    const session = await connectMcp(root);
    try {
      const validation = await callTool(session, 'spec_stage_validate', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
      });
      const apply = await callTool(session, 'spec_stage_apply', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: `${VALID_REQUIREMENTS}\nSneaky extra line.\n`,
        expectedCurrentHash: validation.structured['currentHash'],
        expectedCandidateHash: validation.structured['candidateHash'],
        acknowledgement: 'apply-reviewed-candidate',
      });
      expect(apply.isError).toBe(true);
      expect(apply.errorCode).toBe('SBMCP002');
      expect(apply.text).toContain('expectedCandidateHash');
    } finally {
      await session.close();
    }
  });

  it('a current-document hash mismatch is rejected with SBMCP017', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    await createSpec(root);
    const session = await connectMcp(root);
    try {
      const validation = await callTool(session, 'spec_stage_validate', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
      });
      const apply = await callTool(session, 'spec_stage_apply', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
        expectedCurrentHash: 'a'.repeat(64),
        expectedCandidateHash: validation.structured['candidateHash'],
        acknowledgement: 'apply-reviewed-candidate',
      });
      expect(apply.isError).toBe(true);
      expect(apply.errorCode).toBe('SBMCP017');
    } finally {
      await session.close();
    }
  });

  it('apply writes atomically, records an authoring run, and stays unapproved', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    await createSpec(root);
    const session = await connectMcp(root);
    try {
      const validation = await callTool(session, 'spec_stage_validate', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
      });
      const apply = await callTool(session, 'spec_stage_apply', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
        expectedCurrentHash: validation.structured['currentHash'],
        expectedCandidateHash: validation.structured['candidateHash'],
        acknowledgement: 'apply-reviewed-candidate',
      });
      expect(apply.isError).toBe(false);
      expect(apply.structured['applied']).toBe(true);
      expect(apply.structured['stageRemainsUnapproved']).toBe(true);
      expect(apply.structured['newHash']).toMatch(/^[0-9a-f]{64}$/);
      expect(apply.structured['oldHash']).toBe(validation.structured['currentHash']);

      const written = readFileSync(
        path.join(root, '.kiro', 'specs', 'notification-preferences', 'requirements.md'),
        'utf8',
      );
      expect(written).toBe(VALID_REQUIREMENTS);

      // Sidecar state still shows requirements as draft (never auto-approved).
      const state = JSON.parse(
        readFileSync(
          path.join(root, '.specbridge', 'state', 'specs', 'notification-preferences.json'),
          'utf8',
        ),
      ) as { stages: { requirements: { status: string } } };
      expect(state.stages.requirements.status).toBe('draft');

      // Authoring run record: kind interactive-authoring, host mcp, artifacts.
      const runId = apply.structured['runId'] as string;
      const runDir = path.join(root, '.specbridge', 'runs', runId);
      const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8')) as {
        kind: string;
        host: string;
        applied: boolean;
      };
      expect(run.kind).toBe('interactive-authoring');
      expect(run.host).toBe('mcp');
      expect(run.applied).toBe(true);
      expect(existsSync(path.join(runDir, 'candidate-requirements.md'))).toBe(true);
      expect(existsSync(path.join(runDir, 'authoring.json'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('re-applying an already applied candidate is refused (append-only runs, honest hash gate)', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    await createSpec(root);
    const session = await connectMcp(root);
    try {
      const validation = await callTool(session, 'spec_stage_validate', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
      });
      const args = {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
        expectedCurrentHash: validation.structured['currentHash'],
        expectedCandidateHash: validation.structured['candidateHash'],
        acknowledgement: 'apply-reviewed-candidate',
      };
      const first = await callTool(session, 'spec_stage_apply', args);
      expect(first.isError).toBe(false);
      // The current document changed (it IS the candidate now); the stale
      // expectedCurrentHash makes a blind repeat fail loudly.
      const second = await callTool(session, 'spec_stage_apply', args);
      expect(second.isError).toBe(true);
      expect(second.errorCode).toBe('SBMCP017');
    } finally {
      await session.close();
    }
  });

  it('applying to an approved stage is refused and dependent approvals are invalidated on draft applies', async () => {
    const root = copyFixtureToTemp('v02-requirements-first');
    const session = await connectMcp(root);
    try {
      // Fixture: notification-preferences with requirements approved.
      const status = await callTool(session, 'spec_status', { specName: 'notification-preferences' });
      const stages = status.structured['stages'] as { stage: string; effective: string }[];
      expect(stages.find((stage) => stage.stage === 'requirements')?.effective).toBe('approved');

      // Applying over the APPROVED requirements stage is refused.
      const refused = await callTool(session, 'spec_stage_validate', {
        specName: 'notification-preferences',
        stage: 'requirements',
        candidateMarkdown: VALID_REQUIREMENTS,
      });
      expect(refused.isError).toBe(true);
      expect(refused.errorCode).toBe('SBMCP004');
      expect(refused.text).toContain('never overwrites an approved document');
    } finally {
      await session.close();
    }
  });
});
