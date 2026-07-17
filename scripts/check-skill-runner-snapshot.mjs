// Compare the environment-independent fields of a SpecBridge `runner list`
// snapshot against a freshly generated one: the profile set, each profile's
// implementation, and its enablement. Capability probes (capabilities,
// version, authentication) legitimately differ per machine — the committed
// skill-verification snapshot was generated on a workstation with runner
// CLIs installed, while CI runners have none — so those fields are ignored.
//
// Used by the skill-verification CI job together with the byte-level drift
// check that covers every other fixture file.
//
// usage: node scripts/check-skill-runner-snapshot.mjs <committed.json> <rebuilt.json>
import { readFileSync } from "node:fs";

const [committedPath, rebuiltPath] = process.argv.slice(2);
if (!committedPath || !rebuiltPath) {
  console.error("usage: node scripts/check-skill-runner-snapshot.mjs <committed.json> <rebuilt.json>");
  process.exit(2);
}

const normalize = (path) => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return (raw.profiles ?? [])
    .map((profile) => ({
      profile: profile.profile,
      implementation: profile.implementation,
      enabled: profile.enabled,
    }))
    .sort((a, b) => a.profile.localeCompare(b.profile));
};

const committed = JSON.stringify(normalize(committedPath), null, 2);
const rebuilt = JSON.stringify(normalize(rebuiltPath), null, 2);

if (committed !== rebuilt) {
  console.error("runner-list drift in environment-independent fields (profile/implementation/enabled):");
  console.error("--- committed (verification template)");
  console.error(committed);
  console.error("+++ rebuilt (this build)");
  console.error(rebuilt);
  process.exit(1);
}
console.log(
  `runner-list: ${normalize(rebuiltPath).length} profiles match the committed snapshot on all environment-independent fields.`,
);
