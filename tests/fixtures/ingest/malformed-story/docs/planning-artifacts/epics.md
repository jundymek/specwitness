# Malformed story headings

## Epic 7: Mixed Content

One valid story, one heading that names a different epic, and one heading that
claims to be a story but is not spelled as one. Ingestion must refuse rather
than quietly return only the story it managed to parse.

### Story 7.1: Valid

As a fixture author,
I want one perfectly good story,
So that a partial success is possible and must still be refused.

**Acceptance Criteria:**

**Given** a valid story beside a malformed one
**When** the epic is ingested
**Then** ingestion refuses rather than returning this story alone.

### Story 8.1: Wrong epic

As a fixture author,
I want a story heading naming epic 8 inside epic 7,
So that the mismatch is detected.

**Acceptance Criteria:**

**Given** a story naming another epic
**When** the epic is ingested
**Then** it is reported, not skipped.

### Story seven-two Malformed number

As a fixture author,
I want a heading that says Story but does not parse,
So that a claim SpecWitness cannot honour is never dropped in silence.

**Acceptance Criteria:**

**Given** an unparseable story heading
**When** the epic is ingested
**Then** it is reported, not skipped.

### Notes

A level-3 heading that does not claim to be a story at all. This one is
correctly ignored and must NOT be reported as a problem.

---
