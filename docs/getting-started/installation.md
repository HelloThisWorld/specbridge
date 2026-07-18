# Installation

Four supported ways to install SpecBridge, all serving the same CLI. Pick
one; nothing else is required. Node.js 20+ is needed for every option
except the standalone archives (which carry their own runtime notes below).

> Honesty note: the v1.0.0 release assets (standalone archives, portable
> Node distribution, plugin ZIP, checksums) exist on the Releases page only
> once the v1.0.0 GitHub Release is published. Until then, install from npm
> or build from source.

## npm (recommended)

The package is `specbridge-cli`; the installed command remains
`specbridge`:

```bash
npm install -g specbridge-cli
specbridge doctor
```

One-off use without a global install (note the `-p` form — the package
name and the binary name differ):

```bash
npx -p specbridge-cli specbridge doctor
```

## Standalone archives (GitHub Releases)

Each release on the
[Releases page](https://github.com/HelloThisWorld/specbridge/releases)
ships prebuilt archives per platform:

| Asset | Platform |
| --- | --- |
| `windows-x64` | Windows 10/11, x64 |
| `linux-x64` | Linux, x64 |
| `macos-x64` | macOS (Intel) |
| `macos-arm64` | macOS (Apple Silicon) |
| portable Node distribution | any platform with your own Node.js 20+ |

Every release includes a `SHA256SUMS` file and a release manifest — verify
the checksum of anything you download. The binaries are **not
code-signed**: Windows SmartScreen and macOS Gatekeeper may warn, and
checksums prove integrity, not publisher identity (see the
[threat model](../security/threat-model.md)).

## Claude Code plugin

The plugin bundles the CLI, the local MCP server, and eleven skills — no
npm install needed. Inside Claude Code:

```text
/plugin marketplace add HelloThisWorld/specbridge
/plugin install specbridge@specbridge-plugins
/reload-plugins
```

A release-attached plugin ZIP exists too. Details, verification steps, and
the ZIP workflow: [plugin installation](../plugin-installation.md), and the
short overview at [Claude Code plugin](claude-code-plugin.md).

## From source

```bash
git clone https://github.com/HelloThisWorld/specbridge.git
cd specbridge
pnpm install
pnpm build
node packages/cli/dist/index.js doctor
```

## Next

- [Quickstart](quickstart.md) — 30 seconds in an existing Kiro project.
- [Using an existing Kiro project](existing-kiro-project.md) — the
  zero-migration story.
