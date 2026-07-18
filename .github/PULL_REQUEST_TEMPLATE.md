# Summary

<!-- What this PR changes and why. One or two paragraphs; link the design
     discussion if there was one. -->

Closes #<!-- issue number, or remove this line -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass locally
- [ ] `pnpm check:public-contracts` passes — or a stable contract changed
      **intentionally** and the snapshot under `contracts/` is updated in
      this PR
- [ ] Documentation updated for any user-visible behavior change
- [ ] CHANGELOG entry added for any user-visible change (required whenever
      a contract snapshot changed)
- [ ] Everything is in English (code, comments, docs, commit messages)
- [ ] No employer or client proprietary content — examples and fixtures
      are synthetic
- [ ] No credentials, tokens, or secret values anywhere in the diff,
      fixtures, or recorded test output

<!-- Security-relevant change? Read SECURITY.md and
     docs/security/threat-model.md first, and say here which invariants
     the change touches. Never describe an unfixed vulnerability in a
     public PR. -->
