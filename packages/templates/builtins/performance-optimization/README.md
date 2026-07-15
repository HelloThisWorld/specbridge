# Performance Optimization template

A feature spec template for a measurable performance improvement.

It pre-structures the spec around the questions performance work always
raises: the numeric baseline, the numeric target, the measurement method,
the workload definition, evidence for the bottleneck, constraints,
regression risks, before/after validation, and rollback. "Make it faster"
never appears — every goal is a number measured the same way twice.

## Usage

```bash
specbridge template preview performance-optimization \
  --name checkout-latency \
  --var targetMetric="p95 latency"

specbridge template apply performance-optimization \
  --name checkout-latency \
  --var targetMetric="p95 latency"
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `targetMetric` | string | `p95 latency` | The single metric the optimization is judged by. |
| `workload` | string | `steady-state production traffic` | The workload under which the metric is measured. |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. The template gives structure;
the engineering judgment stays with you.
