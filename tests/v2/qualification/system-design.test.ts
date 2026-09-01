import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_STAGES } from '@specbridge/core';
import {
  completeScenario,
  createSyntheticRepository,
  GOLDEN_SCENARIOS,
} from '../fixtures.js';

describe('end-to-end AI system design qualification', () => {
  it('turns a rough brownfield multi-channel SaaS idea into a ready portable Spec Pack', () => {
    const scenario = GOLDEN_SCENARIOS.find(
      (candidate) => candidate.title === 'synthetic-yoga-support-saas',
    )!;
    const root = createSyntheticRepository('synthetic-support-agent');
    const { service, subject } = completeScenario(root, scenario);
    const session = service.store.read(subject);

    expect(Object.keys(session.stages).sort()).toEqual([...DESIGN_STAGES].sort());
    expect(session.decisions.filter((decision) => decision.authority === 'HUMAN')).toHaveLength(3);
    expect(session.decisions.every((decision) => decision.status === 'DECIDED')).toBe(true);
    expect(session.research).toHaveLength(1);
    expect(session.research[0]?.sources).toHaveLength(1);

    const quality = service.evaluate(subject);
    expect(quality.ready).toBe(true);
    expect(quality.blockingDecisionIds).toEqual([]);
    expect(quality.uncoveredRequirementIds).toEqual([]);
    expect(quality.orphanAcceptanceIds).toEqual([]);

    const compiled = service.approve(subject, 'I approve this complete product contract.');
    expect(compiled.files).toHaveLength(19);
    expect(existsSync(path.join(compiled.directory, 'spec.yaml'))).toBe(true);
    expect(existsSync(path.join(compiled.directory, 'AGENT_HANDOFF.md'))).toBe(true);

    const combined = [
      'goals',
      'requirements',
      'research',
      'architecture',
      'dataModel',
      'interfaces',
      'security',
      'reliability',
      'deployment',
      'acceptance',
    ]
      .map((document) => service.readSpec(compiled.manifest.name, document).content)
      .join('\n');
    for (const evidence of [
      'WhatsApp',
      'WeChat',
      'multiple locations',
      'Tenant portal',
      'Operations and analytics',
      'MessageReceived',
      'ConversationEscalated',
      'Tenant isolation',
      'Provider outage',
      'Brownfield',
      'Required Evidence',
    ]) {
      expect(combined).toMatch(new RegExp(evidence, 'i'));
    }

    const handoff = readFileSync(path.join(compiled.directory, 'AGENT_HANDOFF.md'), 'utf8');
    expect(handoff).toContain('You own implementation planning and execution.');
    expect(handoff).toContain('SpecBridge does not supervise or execute implementation.');
  });
});
