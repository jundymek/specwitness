# Duplicate story ids

## Epic 7: Ambiguous

An epic declaring the same story twice. Keeping the last would make the
contract depend on document order.

### Story 7.1: First declaration

As a fixture author,
I want story 7.1 declared once,
So that the second declaration is detected.

**Acceptance Criteria:**

**Given** the first declaration
**When** the epic is ingested
**Then** these criteria belong to 7.1.

### Story 7.1: Second declaration

As a fixture author,
I want story 7.1 declared again,
So that the ambiguity is refused.

**Acceptance Criteria:**

**Given** a second declaration of the same id
**When** the epic is ingested
**Then** ingestion refuses rather than silently keeping one.

---
