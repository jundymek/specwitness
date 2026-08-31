# Sample — Epic Breakdown

## Overview

A hand-written specimen of the epics-file layout. Epics 7 and 10 both exist so
that prefix collision (`Epic 1` vs `Epic 10`, `Epic 7` vs `Epic 70`) is a
structural property of the fixture rather than a hypothetical.

## Epic 7: Ingestion Sample

Prove that the epics-file reader finds an epic by its full number, keeps its
goal paragraph, and preserves every acceptance criterion verbatim.

### Story 7.1: First story

As a fixture author,
I want a story with two criteria,
So that ordering and count are both observable.

**Acceptance Criteria:**

**Given** the epics file exists
**When** epic 7 is ingested
**Then** story 7.1 carries exactly two criteria.

**Given** a criterion spanning several lines
**When** its text is read
**Then** the line breaks survive
**And** a trailing `**And**` line is part of the same criterion.

### Story 7.2: Second story

As a fixture author,
I want a second story,
So that story ordering is observable.

**Acceptance Criteria:**

**Given** two stories exist
**When** the epic is ingested
**Then** they appear in file order.

---

## Epic 10: Prefix Collision Guard

This epic exists only so that a request for epic 1 cannot match it and a request
for epic 10 cannot match epic 1.

### Story 10.1: Only story

As a fixture author,
I want epic 10 to hold exactly one story,
So that a mismatched epic lookup is detectable by count alone.

**Acceptance Criteria:**

**Given** epic 10 is requested
**When** ingestion runs
**Then** exactly one story is returned.

---

## Epic 11: Zero Stories

An epic heading with a goal and no stories at all — the AC3 "no empty EpicSpec"
case.

---
