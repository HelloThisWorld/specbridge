# Testing Standards

- Every bugfix lands with a regression test that failed before the fix
- Integration tests own the database schema via migrations, never fixtures
- Flaky tests are quarantined the day they flake
