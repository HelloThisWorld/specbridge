# Project Structure

- `src/` — application code, one directory per domain module
- `src/auth/`, `src/billing/`, `src/notifications/`
- `tests/` mirrors `src/` one-to-one
- Domain modules communicate only through `src/shared/`
