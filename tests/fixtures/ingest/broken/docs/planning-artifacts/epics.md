# Broken specimen — Epic Breakdown

## Epic 7: Story With No Criteria

Epic 7 has one story whose `**Acceptance Criteria:**` block is empty — the AC3
"zero criteria is an error, not an empty array" case.

### Story 7.1: No criteria at all

As a fixture author,
I want a story whose criteria section is immediately followed by the next
heading,
So that the empty-section case is exercised.

**Acceptance Criteria:**

### Story 7.2: Has criteria

As a fixture author,
I want a sibling story that is fine,
So that the error names the broken story specifically.

**Acceptance Criteria:**

**Given** a healthy story beside a broken one
**When** ingestion fails
**Then** the error names the broken story, not this one.

---

## Epic 8: No Stories

An epic with a goal and no `### Story` headings at all.

---
