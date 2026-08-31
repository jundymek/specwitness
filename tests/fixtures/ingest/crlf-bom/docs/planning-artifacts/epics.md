# CRLF + BOM specimen

## Epic 7: Windows Checkout

This file starts with a UTF-8 BOM and uses CRLF line endings throughout.

### Story 7.1: Survives a Windows checkout

As a fixture author,
I want a BOM and CRLF endings,
So that a naive heading matcher is proven to fail here.

**Acceptance Criteria:**

**Given** a BOM-prefixed CRLF file
**When** it is ingested
**Then** the epic heading is still found
**And** no criterion text ends with a stray carriage return.

---
