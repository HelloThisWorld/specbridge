# Cart Total Rounding Bug

## Current Behavior

Cart totals with three or more items sometimes differ from the invoice total
by one cent. Line items are rounded before summing.

## Expected Behavior

The cart total always equals the invoice total: sum first, round once.

## Unchanged Behavior

- Per-line display prices keep their current rounding
- Tax calculation is untouched

## Reproduction

1. Add items priced 0.10, 0.10, 0.35 with 7.7% tax
2. Compare the cart badge total with the checkout invoice total

## Constraints

- The fix must not change any stored historical invoice
