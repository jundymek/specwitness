# Duplicate epic declarations

## Epic 7: First declaration

Goal of the first declaration.

### Story 7.1: In the first declaration

As a fixture author,
I want a story here,
So that the first declaration is non-empty.

**Acceptance Criteria:**

**Given** the first declaration
**When** the epic is ingested
**Then** it is not silently preferred over the second.

---

## Epic 7: Second declaration

Goal of the second declaration.

### Story 7.2: In the second declaration

As a fixture author,
I want a story that would be dropped entirely,
So that the silent omission is detectable.

**Acceptance Criteria:**

**Given** the second declaration
**When** the epic is ingested
**Then** its stories are not silently discarded.

---
