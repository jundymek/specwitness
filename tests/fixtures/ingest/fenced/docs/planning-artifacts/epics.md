# Fenced examples must not be read as structure

## Epic 7: Fences

An epic whose story contains a fenced example that itself contains markdown
headings and a thematic break. None of them are document structure.

### Story 7.1: Contains an example

As a fixture author,
I want a fenced block containing heading-shaped lines,
So that a scanner without fence tracking is caught.

**Acceptance Criteria:**

**Given** a criterion containing a fenced example
**When** it is ingested
**Then** the fence content stays inside the criterion text:

```markdown
## Acceptance Criteria

### Story 7.2: A phantom story

---
```

**Given** a second real criterion after the fence
**When** the epic is ingested
**Then** it is still found.

---
