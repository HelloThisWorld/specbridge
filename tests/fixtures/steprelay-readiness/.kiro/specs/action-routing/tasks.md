# Implementation Plan

- [ ] 1. Implement next-message routing
  - Resolve the following action from the workflow configuration and hand the
    next message to the broker.
  - _Requirements: 1.1, 1.2_

- [ ] 2. Handle unroutable messages
  - Record the run as blocked and preserve the message.
  - _Requirements: 1.3_

- [ ] 3. Preserve run identity across hops
  - Carry the run identifier unchanged and record each transition.
  - _Requirements: 2.1, 2.2_
