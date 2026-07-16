# Publishing checklist

1. Implement and test your handler (`node --test test/` for executable kinds).
2. Keep `dist/extension.cjs` self-contained — no node_modules at runtime.
3. `specbridge extension validate .`
4. `specbridge extension conformance . --yes` (executable kinds)
5. `specbridge extension package .` — note the printed archive SHA-256.
6. Host the archive at a stable HTTPS URL.
7. Add a registry entry (id, kind, version, archiveUrl, sha256, permissions,
   compatibility, license) — see the SpecBridge repository's
   registry/CONTRIBUTING.md.
8. Open a pull request. Registry listing is not endorsement; users review
   permissions before enabling.
