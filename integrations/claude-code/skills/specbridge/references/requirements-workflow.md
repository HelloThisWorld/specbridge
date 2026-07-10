# Requirements workflow

Use when creating or revising `requirements.md` for a spec (until
`specbridge spec new` ships, create the file by hand at
`.kiro/specs/<name>/requirements.md`).

## Structure to follow

```markdown
# Requirements Document

## Introduction

One or two paragraphs: what this feature is and why now.

## Requirements

### Requirement 1

**User Story:** As a <role>, I want <capability>, so that <benefit>.

#### Acceptance Criteria

1. WHEN <condition or event> THEN the system SHALL <expected behavior>
2. IF <precondition> THEN the system SHALL <expected behavior>
```

- Number requirements sequentially (`Requirement 1`, `Requirement 2`).
  Criterion ids become `1.1`, `1.2`, … — tasks reference them with
  `_Requirements: 1.2_`, so keep numbering stable once tasks exist.
- Use EARS phrasing (WHEN/IF … THE SYSTEM SHALL …) where it fits naturally.
  Do not force every sentence into EARS; clarity beats ceremony.
- Cover: user stories, functional and non-functional requirements, edge
  cases, error handling, and an explicit Out of Scope section when useful.

## Process

1. Draft from the user's ask plus steering context (`specbridge spec context`
   inlines steering automatically; `specbridge steering show product` for a
   single file).
2. Present the draft; iterate until the user explicitly approves.
3. Do not start design or code before that approval (quick mode excepted, at
   the user's explicit request).
4. If revising an existing file: edit only the sections that change, keep
   headings and ids stable, and run `specbridge compat check <name>` after.
