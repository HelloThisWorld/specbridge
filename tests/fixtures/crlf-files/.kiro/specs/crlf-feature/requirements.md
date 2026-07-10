# Requirements Document

## Introduction

This fixture was authored on Windows: CRLF line endings and a UTF-8 BOM.
SpecBridge must preserve every byte, including the trailing spaces here:   

## Requirements

### Requirement 1

**User Story:** As a Windows user, I want my files left alone, so that Kiro and git stay happy.

#### Acceptance Criteria

1. WHEN SpecBridge reads this file THEN the system SHALL reproduce it byte-identically
2. WHEN a checkbox is toggled in tasks.md THEN the system SHALL keep CRLF endings on every line
