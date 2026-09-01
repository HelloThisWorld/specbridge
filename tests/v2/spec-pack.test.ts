import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOLDEN_SCENARIOS,
  completeScenario,
  createSyntheticRepository,
} from './fixtures.js';

describe('Spec Pack compiler', () => {
  for (const scenario of GOLDEN_SCENARIOS) {
    it('compiles the ' + scenario.title + ' golden design', () => {
      const root = createSyntheticRepository(scenario.title, {
        greenfield: scenario.title === 'greenfield-web-service',
      });
      const { service, subject } = completeScenario(root, scenario);
      const session = service.store.read(subject);
      const snapshot = service.bootstrap().snapshot;
      expect(snapshot.projectType).toBe(
        scenario.title === 'greenfield-web-service' ? 'GREENFIELD' : 'BROWNFIELD',
      );
      expect(session.snapshotPath).toContain('.specbridge/repository/current-system.json');
      const quality = service.evaluate(subject);
      expect(quality.findings.filter((finding) => finding.severity === 'FAIL')).toEqual([]);
      expect(quality.ready).toBe(true);
      expect(quality.findings.some((finding) => finding.dimension === 'SECURITY')).toBe(true);
      expect(quality.findings.some((finding) => finding.dimension === 'RELIABILITY')).toBe(true);
      const result = service.approve(subject, 'I approve this product contract.', 'fixture-owner');
      expect(result.files).toContain('AGENT_HANDOFF.md');
      expect(result.files).toContain('spec-quality.md');
      expect(result.files).toHaveLength(19);
      for (const file of result.files) {
        expect(existsSync(path.join(result.directory, file))).toBe(true);
      }
      const handoff = readFileSync(
        path.join(result.directory, 'AGENT_HANDOFF.md'),
        'utf8',
      );
      expect(handoff).toContain('SpecBridge does not supervise or execute implementation');
      expect(handoff).not.toContain('Strong Builder');
      const manifest = service.readSpec(result.manifest.name);
      expect(manifest.manifest.status).toBe('approved');
      expect(manifest.manifest.openBlockingDecisions).toEqual([]);
      expect(() => service.readSpec('../repository')).toThrow(/outside/i);
      if (scenario.title === 'synthetic-yoga-support-saas') {
        expect(session.decisions.filter((decision) => decision.authority === 'HUMAN')).toHaveLength(3);
        expect(session.decisions.every((decision) => decision.status === 'DECIDED')).toBe(true);
        expect(session.research).toHaveLength(1);
        const requirements = service.readSpec(result.manifest.name, 'requirements').content;
        const goals = service.readSpec(result.manifest.name, 'goals').content;
        const architecture = service.readSpec(result.manifest.name, 'architecture').content;
        const interfaces = service.readSpec(result.manifest.name, 'interfaces').content;
        const acceptance = service.readSpec(result.manifest.name, 'acceptance').content;
        const research = service.readSpec(result.manifest.name, 'research').content;
        expect(requirements).toMatch(/WhatsApp and WeChat|Tenant management portal/);
        expect(goals).toMatch(/multiple locations|cannot read tenant conversation content/i);
        expect(architecture).toMatch(/Channel gateway|Tenant portal|Operations and analytics/);
        expect(interfaces).toMatch(/MessageReceived|ConversationEscalated/);
        expect(acceptance).toMatch(/cross-tenant|provider contract tests/i);
        expect(research).toMatch(/WhatsApp and WeChat|Researched:/);
      }
    });
  }
});
