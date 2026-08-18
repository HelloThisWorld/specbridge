# Implementation Plan

- [ ] 1. Publish next messages to the shared work queue
  - One named queue; the action identifier travels in the message.
  - _Requirements: 1.1_

- [ ] 2. Dispatch by action identifier inside the worker
  - Unknown identifiers are returned to the queue unacknowledged.
  - _Requirements: 1.2, 1.3_

- [ ] 3. Record transitions before acknowledgement
  - Make redelivery safe by recording the completed transition first.
  - _Requirements: 2.1, 2.2_

- [ ] 4. Retry a failing handler up to the configured limit
  - _Requirements: 2.3_
