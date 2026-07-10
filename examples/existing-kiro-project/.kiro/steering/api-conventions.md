---
inclusion: fileMatch
fileMatchPattern: "src/api/**"
---

# API Conventions

- REST endpoints are versioned under `/api/v1`
- Errors use RFC 9457 problem+json
- Every mutating endpoint is idempotent via an `Idempotency-Key` header
