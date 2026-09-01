import { describe, expect, it } from 'vitest';
import {
  performResearch,
  researchGate,
  routeQuestion,
} from '@specbridge/design';
import { researchReport } from './fixtures.js';

describe('product authority and research', () => {
  it('asks humans only for product behavior', () => {
    expect(
      routeQuestion({
        question: 'Can platform admins read tenant conversations?',
        whyItMatters: 'It changes privacy behavior.',
        options: ['yes', 'no'],
        recommendation: 'no',
        blocking: true,
        repositoryCanAnswer: false,
        stableTechnicalFact: false,
        engineeringChoice: false,
        externalCurrentFact: false,
        definesProductBehavior: true,
      }),
    ).toBe('ASK_HUMAN');
    expect(
      routeQuestion({
        question: 'Which internal SQL index should be used?',
        whyItMatters: 'It affects query performance.',
        options: [],
        recommendation: 'Use the measured selective index.',
        blocking: false,
        repositoryCanAnswer: false,
        stableTechnicalFact: false,
        engineeringChoice: true,
        externalCurrentFact: false,
        definesProductBehavior: false,
      }),
    ).toBe('ENGINEERING_DECISION');
  });

  it('researches current external facts and reuses fresh reports', async () => {
    const question = 'What current external platform constraints affect this design?';
    const report = researchReport(question);
    expect(
      researchGate({
        question,
        repositoryEvidenceAvailable: false,
        priorReports: [],
        currentOrVersionDependent: true,
        modelUncertain: false,
        highImpactCompatibility: false,
        externalPlatformRestriction: true,
        currentPricingLawOrStandard: false,
        contradictoryAuthoritativeSources: false,
        routineTechnicalFact: false,
        engineeringChoice: false,
        definesProductBehavior: false,
      }).decision,
    ).toBe('RESEARCH');
    const provider = {
      available: async () => true,
      research: async () => report,
    };
    await expect(
      performResearch(provider, {
        question,
        scope: 'platform',
        preferOfficialSources: true,
        relevantVersion: '2026-01',
      }),
    ).resolves.toEqual(report);
    expect(
      researchGate({
        question,
        repositoryEvidenceAvailable: false,
        priorReports: [report],
        currentOrVersionDependent: true,
        modelUncertain: false,
        highImpactCompatibility: false,
        externalPlatformRestriction: true,
        currentPricingLawOrStandard: false,
        contradictoryAuthoritativeSources: false,
        routineTechnicalFact: false,
        engineeringChoice: false,
        definesProductBehavior: false,
      }).decision,
    ).toBe('REUSE_RESEARCH');
  });
});
