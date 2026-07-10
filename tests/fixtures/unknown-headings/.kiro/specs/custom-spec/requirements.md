# Custom Requirements Format

This team does not use the "Requirement N" convention. SpecBridge must
preserve the structure and report that no requirement blocks were
recognized — without failing.

## Business Goals

- Reduce checkout abandonment by 10%
- Ship before the holiday freeze

## Constraints

- No new third-party dependencies
- Must work with the legacy cart service

## Success Metrics

- p95 checkout latency under 800 ms
