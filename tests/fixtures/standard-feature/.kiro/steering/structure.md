# Project Structure

## Layout

- `src/` — application code, one directory per domain module
- `src/auth/` — authentication and session management
- `src/billing/` — invoices and payment methods
- `tests/` — mirrors `src/` one-to-one

## Rules

- Domain modules never import from each other directly; use `src/shared/`
- Database access stays inside repository classes
