---
name: specbridge-design
description: Turn a rough software idea into a repository-grounded, research-backed, implementation-ready system design specification. Use for requests such as design this system, turn this into a full spec, 帮我完善这个需求, 帮我做系统设计, or 把这个想法扩展成可开发规格.
---

# SpecBridge design

Use SpecBridge only for work before implementation.

1. Call `workspace_detect`, then `workspace_bootstrap` when no current snapshot exists or the repository baseline changed materially.
2. Call `design_start` with a concise title and the user's rough idea.
3. Repeatedly call `design_read`. Present only open `HUMAN` product decisions; decide routine engineering choices yourself.
4. When a current external fact is required, follow the `specbridge-research` skill and record the structured report.
5. Produce and submit exactly one validated stage at a time with `design_generate`, in the order returned by the session.
6. Expand sparse requests into required architectural capabilities. Mark every expansion as derived, and turn it into a human product decision when it introduces meaningful new behavior rather than a necessary architectural implication.
7. Use repository context and cited research as evidence. Label derived requirements and assumptions. Never present observed code as sealed product truth.
8. After all fourteen stages, follow `specbridge-review`.

Do not implement the design, create tasks for implementation workers, spawn coding agents, create worktrees, or manage implementation retries. SpecBridge ends at the approved Spec Pack.
