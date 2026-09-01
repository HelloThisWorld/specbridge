---
name: specbridge-research
description: Research current or uncertain external facts for a SpecBridge design, with citations, freshness, contradictions, and separate engineering versus product implications.
---

# SpecBridge research

Research only when the ResearchGate outcome is `RESEARCH`: current or version-dependent information, external platform restrictions, high-impact compatibility, current pricing or standards, explicit uncertainty, or conflicting authoritative sources.

Prefer official and primary sources. Return a `ResearchReport` containing normalized question, scope, `researchedAt`, freshness, findings classified as `FACT`, `CONSTRAINT`, `OPTION`, or `RECOMMENDATION`, source metadata, contradictions, confidence, engineering implications, product implications, and unresolved points. Every finding must reference a declared source.

Call `design_research` to persist the report. Research supplies evidence, not product authority; ask the human when an option changes meaningful product behavior. Reuse a fresh matching report instead of researching again.
