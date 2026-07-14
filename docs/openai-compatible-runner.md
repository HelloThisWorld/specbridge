# OpenAI-compatible runner

The `openai-compatible` runner (v0.6.1) is a production model-API adapter
for endpoints implementing the OpenAI-style `chat-completions` or
`responses` APIs (vLLM, llama.cpp server, LM Studio, hosted gateways, …).

**Authoring only.** Scope: stage generation, stage refinement, model listing
(only when the endpoint declares support), structured-output validation.
Explicitly unsupported: task execution, task resume, source modification,
autonomous tool loops, arbitrary function calling, shell execution,
repository writes. SpecBridge does not implement a coding agent around a
generic API — selection rejects task execution before any request.

## Profile

The built-in profile is `openai-compatible-local`, DISABLED by default:

```json
{
  "runnerProfiles": {
    "openai-compatible-local": {
      "runner": "openai-compatible",
      "enabled": false,
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiStyle": "chat-completions",
      "model": null,
      "structuredOutput": "json-schema",
      "allowStructuredOutputFallback": false,
      "apiKeyEnvironmentVariable": null,
      "modelsEndpoint": false,
      "timeoutMs": 300000,
      "maximumInputCharacters": 500000,
      "maximumOutputBytes": 2097152,
      "allowInsecureHttp": false
    }
  }
}
```

`apiStyle` is `chat-completions` (POST /chat/completions) or `responses`
(POST /responses). Do not assume every compatible endpoint implements
OpenAI's complete API — the profile declares what its endpoint supports;
nothing is probed by paid inference.

## Endpoint security

Accepted: HTTP loopback endpoints, HTTPS remote endpoints. Rejected:
remote plain HTTP (unless the clearly-labeled `allowInsecureHttp`
development override is set — it defaults to false and is surfaced in
runner plans and diagnostics), `file:`/`ftp:`/other schemes, embedded URL
credentials, null bytes, malformed URLs.

Redirect policy (v0.6.1 shared HTTP client): bounded redirect count (3),
the Authorization header (and every custom header) is never forwarded
across origins, HTTPS-to-HTTP downgrades are rejected, redirects to
unsupported schemes or credential-bearing targets are rejected, and safe
redirect metadata (count, final URL, cross-origin flag) is recorded.

## Authentication

Configuration may contain only `apiKeyEnvironmentVariable` — an
environment-variable NAME (schema-validated). SpecBridge never stores a
key value: at runtime it reads exactly that one variable, sends it as the
Authorization header, redacts it from every retained byte (raw bodies,
error excerpts, diagnostics), never logs it, never puts it in attempt
metadata, and never passes it to verification commands. Endpoints without
authentication remain fully supported. Credential-bearing header names
(`Authorization`, `x-api-key`, `Cookie`, …) are rejected in the custom
`headers` field so no key value can enter the configuration file.

## Structured-output modes

`structuredOutput` is explicit — one of:

1. `json-schema` — native JSON Schema constraining (strict mode) via
   `response_format`/`text.format`; the complete response is still
   validated with Zod.
2. `json-object` — native JSON-object mode plus full Zod validation.
3. `strict-json-prompt` — JSON-only prompt contract plus complete-response
   validation.

In every mode the ENTIRE response text must be one JSON document: Markdown
fences are rejected, extra prose is rejected, JSON is never extracted from
a substring, and malformed JSON is never repaired silently. An endpoint
that rejects the configured native mode produces
`structured_output_unsupported`; a downgrade to the next weaker mode
happens ONLY when `allowStructuredOutputFallback` is explicitly true, and
it is reported as a warning. Structured-output support is never inferred
from provider branding.

At most one correction retry runs for authoring. Authentication errors,
quota exhaustion, invalid profiles, unsupported structured output, and
user cancellation are never retried.

## Data boundary

Before network-backed execution, `--show-runner-plan` / dry-run reports:
endpoint host, API style, selected model, structured-output mode, included
documents, approximate input size, whether authentication is configured
(never the value), and whether a network request will occur. The default
authoring context contains only relevant steering, the current stage,
approved prerequisite stages, the explicit refinement instruction, and
bounded referenced content selected by the shared authoring logic — never
`.env`, credentials, unrelated sources, raw run logs, provider artifacts,
or the whole repository. Dry-run makes no HTTP request.

## Doctor and model listing

Ordinary `runner doctor` makes no inference request. When the profile
declares `modelsEndpoint: true`, the doctor may issue one safe
non-inference GET /models reachability probe; otherwise no request is made
and the diagnostics say so. `specbridge runner models
openai-compatible-local` works only with the declared endpoint, uses no
inference, never guesses model names, and reports only fields the endpoint
returns (id, owner, creation time) — model capabilities are never claimed
beyond what the endpoint reports.

`specbridge runner test openai-compatible-local --network` performs one
bounded inference request.
