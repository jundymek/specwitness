# Merge specimen — Epic Breakdown

## Epic 7: Merge Precedence

The epics file supplies the epic title and goal, plus any story the per-story
files do not cover.

### Story 7.1: Title from the epics file

As a fixture author,
I want story 7.1 present in BOTH layouts,
So that per-story precedence is observable.

**Acceptance Criteria:**

**Given** only the epics file
**When** story 7.1 is read from it
**Then** this criterion — and only this one — is present.

### Story 7.2: Also in both layouts

As a fixture author,
I want a second overlapping story,
So that precedence is not provable by a single lucky case.

**Acceptance Criteria:**

**Given** only the epics file
**When** story 7.2 is read from it
**Then** this epics-file criterion is present.

### Story 7.3: Only in the epics file

As a fixture author,
I want a story the per-story files do not cover,
So that the epics file is shown to supply the remainder.

**Acceptance Criteria:**

**Given** no per-story file covers story 7.3
**When** the epic is ingested
**Then** story 7.3 still appears, sourced from the epics file.

---
