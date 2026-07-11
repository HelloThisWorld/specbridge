# Search Filters — Requirements

## Background

Written by hand, with custom section names and bullet criteria. SpecBridge
must read this without complaining about structure it does not require.

## Requirements

### Requirement 1: Filter persistence

**User story:** As a shopper, I want my filters to survive navigation, so that I do not re-enter them on every page.

#### Acceptance criteria

- WHEN a shopper applies a filter and opens a product, THE SYSTEM SHALL restore the filter on return to the list.
- IF the stored filter references a removed category, THEN THE SYSTEM SHALL drop only that filter and keep the rest.

### Requirement 2: Shareable filter URLs

**User story:** As a shopper, I want to share filtered views, so that friends see the same results.

#### Acceptance criteria

- WHEN filters change, THE SYSTEM SHALL encode them in the URL query string.

## Deliberately unusual section

Kept to prove unknown sections survive analysis.

## Not in scope

- Saved-search notifications.

## Quality attributes

- Performance: filter restoration must not add a visible delay.
