# Ollama runner

The `ollama` implementation is a **model authoring runner**: stage
generation, stage refinement, local model enumeration, and schema-validated
structured output over the native Ollama HTTP API. Nothing else.

Explicitly unsupported — by capability, not by promise: task execution,
task resume, repository modification, tool execution, shell execution,
source-file writing. There is no autonomous coding-agent loop around
Ollama; `spec run --runner ollama-local` is refused before any HTTP request.

## Setup

1. Install and run Ollama yourself (`ollama serve`), pull a model yourself
   (`ollama pull qwen3:8b`). SpecBridge never pulls, deletes, or updates
   models and never signs in.
2. Enable the profile and pick a model EXPLICITLY:

```jsonc
{
  "runnerProfiles": {
    "ollama-local": {
      "runner": "ollama",
      "enabled": true,                       // ← your explicit opt-in
      "baseUrl": "http://127.0.0.1:11434",   // loopback default
      "model": "qwen3:8b",                   // never auto-selected
      "temperature": 0,
      "timeoutMs": 300000,
      "maximumInputCharacters": 500000,
      "maximumOutputBytes": 2097152
    }
  }
}
```

`specbridge runner models ollama-local` lists locally available models
(name, size, family, parameter size, quantization, modified time) without
any inference — no quality claims, no structured-output claims. With no
model configured the profile is misconfigured for generation and detection
says so; SpecBridge never picks one for you.

## Endpoint safety

Allowed without ceremony: `http://localhost`, `http://127.0.0.1` (any
127.x address), `http://[::1]`. Rejected outright: `file:`/`ftp:`/other
schemes, URLs with embedded credentials, null bytes, query strings.

A non-loopback endpoint must be explicitly configured, uses HTTPS by
default (`allowInsecureHttp: true` is the clearly-labeled development
override for private plain-HTTP endpoints), is classified NETWORK-BACKED in
every plan, and is never selected implicitly (explicit `--runner` or an
operation default required). A remote Ollama server is never silently
treated as local. Redirects are never followed.

## Structured output

Requests are non-streaming `POST /api/chat` with the stage-report JSON
Schema in the provider `format` field and temperature 0 by default. The
response content must BE one JSON document — Markdown code fences and
JSON-in-prose are rejected. Zod validates the result; on failure:

1. the failed attempt is recorded (candidate retained, never applied),
2. at most ONE correction retry runs with the validation problems,
3. still invalid → `structured_output_invalid`; no further retries, and no
   provider switch unless an explicit fallback chain is configured.

Input and output size limits are enforced (`maximumInputCharacters`,
`maximumOutputBytes` — oversized responses abort mid-stream). Requests
honor timeouts and cancellation. `thinking` fields from reasoning models
are redacted before raw responses are retained and never surface in
reports or events.

## Data boundary

The runner plan (dry-run / `--show-runner-plan`) states the endpoint host,
local-or-network classification, model, included documents, approximate
input characters, and whether a network request will occur. An authoring
request contains ONLY the assembled prompt: relevant steering documents,
the current stage, approved prerequisite stages, and your refinement
instruction. Never sent: `.env`, credential files, raw provider logs,
unrelated source files, the repository, or `.specbridge` state. Dry-run
sends nothing at all.

## Cost

`cost.source` is `unavailable` for local Ollama — local does not mean free
(hardware and power are real); SpecBridge just cannot price it and never
invents numbers.
