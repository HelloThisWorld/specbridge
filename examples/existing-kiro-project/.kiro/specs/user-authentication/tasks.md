# Implementation Plan

- [x] 1. Set up authentication module scaffolding
  - Create `src/auth/` with service, routes, and repository stubs
  - _Requirements: 1.1_

- [x] 2. Implement credential validation
  - [x] 2.1 Add argon2id password hashing helper
    - Use a configurable cost profile
    - _Requirements: 1.1, 1.2_
  - [ ] 2.2 Add sign-in endpoint with generic error responses
    - _Requirements: 1.2_
  - [ ] 2.3 Implement failed-attempt lockout
    - _Requirements: 1.3_

- [ ] 3. Session management
  - [ ] 3.1 Issue session cookies on successful sign-in
    - _Requirements: 1.1, 2.2_
  - [ ] 3.2 Expire sessions after 30 minutes of inactivity
    - _Requirements: 2.1, 2.2_
  - [ ] 3.3 Invalidate sessions on sign-out
    - _Requirements: 2.3_

- [ ]* 4. Add property-based tests for expiry arithmetic
  - _Requirements: 2.1_
