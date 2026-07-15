# Command-Line Tool template

A feature spec template for adding or changing a command-line tool or
command.

It pre-structures the spec around the questions CLI changes always raise:
the command surface (subcommands, arguments, options), exit codes,
stdout/stderr discipline, machine-readable output, non-interactive and
scripted use, platform compatibility, error handling, and tests.

## Usage

```bash
specbridge template preview cli-tool \
  --name my-tool \
  --var commandName=mycli

specbridge template apply cli-tool \
  --name my-tool \
  --var commandName=mycli
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `commandName` | string | `mycli` | Name of the command the spec covers. |
| `actor` | string | `developer` | Primary user of the command. |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. The template gives structure;
the engineering judgment stays with you.
