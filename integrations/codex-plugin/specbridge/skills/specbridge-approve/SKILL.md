---
name: specbridge-approve
description: Record explicit human natural-language approval of a review-ready SpecBridge design and compile its portable Spec Pack.
---

# SpecBridge approval

Use only after `design_evaluate` reports the design ready and the human explicitly approves the specification in natural language. Do not infer approval from silence, generation requests, or a successful evaluation.

Call `design_approve` with the human's actual approval text and identity when known. Report the generated Spec Pack path and revision. Approval compiles artifacts only; it must never launch implementation, create a worktree, send work to another agent, or begin coding.
