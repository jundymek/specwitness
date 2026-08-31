# Nested fences

## Epic 7: Nested

An epic whose criterion documents a fenced block, using a longer outer fence.
A shorter inner fence must not close the outer one.

### Story 7.1: Documents a fence

As a fixture author,
I want a four-backtick fence containing a three-backtick fence,
So that a closing-fence check that ignores length is caught.

**Acceptance Criteria:**

**Given** an outer fence of four backticks
**When** it contains a shorter inner fence
**Then** everything between the outer pair stays example text:

````markdown
```
### Story 7.9: Phantom from a nested fence

## Acceptance Criteria
```
````

**Given** a second real criterion after the outer fence closes
**When** the epic is ingested
**Then** it is still found.

---
