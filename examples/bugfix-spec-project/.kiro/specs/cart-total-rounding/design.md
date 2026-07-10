# Fix Design

## Root Cause

`CartSummary` rounds each line subtotal to cents before summing; the invoice
service sums exact decimals and rounds once at the end.

## Proposed Fix

Move cart summation to the shared `Money.sumExact` helper used by invoicing,
rounding once at display time.

## Regression Risks

- Cart badge values can shift by one cent for existing sessions (acceptable;
  they were wrong before)

## Validation Strategy

- Property-based test: cart total === invoice total for random carts
