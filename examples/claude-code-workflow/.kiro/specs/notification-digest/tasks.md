# Implementation Plan

- [ ] 1. Create the digest queue data model and store
  - _Requirements: 1.1_
- [ ] 2. Implement the daily window scheduler and digest sender
  - _Requirements: 1.2, 1.3_
- [ ] 3. Add the per-user digest preference and urgent bypass
  - _Requirements: 2.1, 2.2_
- [ ] 4. Record delivery failures, retries, and the alert metric
  - _Requirements: 3.1, 3.2_
- [ ] 5. Add automated tests and verify digest delivery end to end
  - Unit tests for queue append, urgent bypass, and the empty window
  - Failure-injection test for the retry and alert path
  - _Requirements: 1.2, 2.2, 3.1_
