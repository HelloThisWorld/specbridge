---
name: specbridge-review
description: Evaluate a SpecBridge design for completeness, grounding, contradictions, scope creep, security, reliability, traceability, and implementation readiness.
---

# SpecBridge review

After all design stages are recorded, perform a focused semantic review for contradictions, unjustified scope, missing failure behavior, and cross-document contract conflicts. Pass each genuine concern to `design_evaluate` as a `modelFindings` warning or failure; do not emit ceremonial PASS entries. The tool combines these with deterministic gates, and model findings can never erase deterministic failures. Summarize the combined findings by dimension and severity. Resolve every failing finding before approval, including missing goals or non-goals, blocking product decisions, stale repository claims, missing research, weak security or reliability design, and uncovered requirements.

Warnings must remain visible as open risks or be resolved with evidence. Never reduce the report to a single score. When the report is ready, show the Spec Pack scope, important assumptions, trade-offs, and remaining warnings to the human, then wait for explicit natural-language approval.
