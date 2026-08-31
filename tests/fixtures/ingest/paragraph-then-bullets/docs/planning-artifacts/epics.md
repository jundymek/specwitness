# Paragraph criteria followed by a bullet list

## Epic 7: Trailing Matter

An epics-file epic whose criteria are paragraph blocks and which is followed by
a bullet list — the Codex P1 case. The paragraphs are the criteria; the bullets
are trailing matter and must not replace them.

### Story 7.1: Paragraphs then bullets

As a fixture author,
I want paragraph criteria with a trailing bullet list,
So that the format decision cannot silently discard the real criteria.

**Acceptance Criteria:**

**Given** paragraph-style criteria
**When** a bullet list follows them
**Then** the paragraphs are still the criteria.

**Given** a second paragraph criterion
**When** the same section ends with bullets
**Then** this one survives too.

Notes (not criteria):

- This bullet must never become a criterion.
- Neither must this one.

---
