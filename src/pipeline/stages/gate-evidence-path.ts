/**
 * Where a gate's FULL captured output lands inside the run directory (AD-8, Q48).
 *
 * `RunStore` is the sole writer under `.specwitness/runs/` and the only module
 * permitted to construct a path there. This file does not construct one: it
 * derives the RELATIVE name handed to `RunStore.writeEvidenceFile`, which
 * returns the relative path that goes into the evidence record. The string
 * `.specwitness/runs` appears nowhere in `src/pipeline/`, so AD-8's grep-level
 * rule holds by construction rather than by review.
 *
 * WHY THE NAME IS DERIVED RATHER THAN THE GATE ID USED DIRECTLY.
 *
 * A gate id is only `nonEmptyString` in the merged config schema — there is no
 * charset constraint and no length constraint. Two schema-VALID ids would
 * therefore reach the filesystem as broken names:
 *
 *   - an id containing `..` hits `RunStore`'s containment rule, which correctly
 *     raises `InfraError`;
 *   - an id longer than a filesystem component limit (255 bytes on APFS and
 *     ext4) raises `ENAMETOOLONG`, which also arrives as `InfraError`.
 *
 * Both mean **exit 3 for a perfectly good verification run**, telling an
 * operator their environment is broken when in fact their gate id merely
 * contains a dot or is long. That is infrastructure being blamed for something
 * that is not infrastructure — the exact failure class this story exists to
 * prevent (AC3), arriving from the side nobody was watching. So the derivation
 * below is TOTAL: every string maps to one safe path component.
 *
 * DIVISION OF LABOUR, stated because this is precisely where two owners of one
 * guardrail would come from: `RunStore`'s containment rule is unchanged and
 * remains THE guarantee that escape is impossible. Nothing here validates on its
 * behalf and nothing here asks it to relax. This module simply ensures its own
 * call sites never need that guarantee to fire.
 *
 * WHAT IS NOT DERIVED: the real gate id, which is carried unchanged in
 * `GateResult.gateId`, in `RunOutcome.gateFailed` and inside the evidence
 * record. Only the filename is normalised.
 *
 * AD-1: pure. No I/O, total for every input.
 */

/** The run-directory subfolder every evidence file lives in (Q50). */
export const GATE_EVIDENCE_DIR = 'evidence';

/**
 * Characters allowed to survive into a filename.
 *
 * Deliberately narrow — portable across APFS, ext4 and NTFS, and free of every
 * character a shell, a URL or a Markdown link would treat specially. Gate ids
 * are the operator's own text, but a run directory is read by hand, pasted into
 * issues and referenced from reports.
 */
const UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * Budget for the id-derived portion, in characters.
 *
 * Generous next to a real gate id (`typecheck`, `unit`, `build`) and far inside
 * the 255-BYTE component limit even when every surviving character is
 * multi-byte, once the `gate-`, index and `.txt` overhead is counted.
 */
const SLUG_MAX_CHARS = 64;

/** Minimum width of the declaration index, so a listing sorts naturally. */
const INDEX_WIDTH = 2;

/**
 * Normalise a gate id into at most one safe path component.
 *
 * Returns `''` when nothing survives — `'...'`, `'///'` and `'-'` all do — in
 * which case the caller drops the segment entirely rather than emitting
 * `gate-03-.txt`, the kind of filename somebody opens an issue about. Nothing
 * is lost: the declaration index alone is already unique.
 */
function slugify(gateId: string): string {
  const substituted = gateId
    // Substitute rather than delete: deleting would collapse two visibly
    // different ids into one name, and a reader should be able to tell them
    // apart by eye even though the index already guarantees uniqueness.
    .replace(UNSAFE, '-')
    // Collapse runs so `a///b` reads `a-b` rather than `a---b`.
    .replace(/-{2,}/g, '-')
    // Collapse runs of dots so the literal sequence `..` can never appear
    // ANYWHERE in the result, not merely at the edges. `gate-01-..-etc.txt` is
    // a perfectly safe single path component, but a downstream containment
    // check written as `name.includes('..')` rather than as a path-segment test
    // would reject it — and that rejection arrives as an InfraError, i.e. exit
    // 3, for a schema-valid config. Not depending on which way that check is
    // implemented costs one regex.
    .replace(/\.{2,}/g, '.');

  const trimmed = substituted
    // One class, both edges: this is what makes `.`, `..` and `...` impossible
    // to produce, so the result can never BE a traversal segment or a dotfile.
    // Trimming dots and dashes together matters — `./rel` normalises to `.-rel`,
    // which two separate passes would leave starting with a dot.
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');

  if (trimmed.length <= SLUG_MAX_CHARS) {
    return trimmed;
  }

  // Truncation can strand a separator at the edge; trim again rather than emit
  // `gate-06-aaa-.txt`.
  return trimmed.slice(0, SLUG_MAX_CHARS).replace(/[-.]+$/, '');
}

/**
 * The relative path of one gate's full-output file.
 *
 *   `evidence/gate-00-lint.txt`
 *   `evidence/gate-03.txt`        (id normalised to nothing)
 *
 * @param gateId The gate's declared id, verbatim from the Project Config.
 * @param index  Its position in the declared gate list. Zero-based.
 *
 * The index is not decoration. It does three things, and the third is the one
 * that is easy to miss: it keeps a run directory sorting in execution order for
 * anyone reading it by hand; it keeps two ids that slugify identically apart;
 * and it keeps two ids that become identical AFTER truncation apart. Gate ids
 * are unique by schema (cross-field uniqueness enforced at load), so a unique
 * index makes the whole name unique by construction — no collision handling,
 * no counter, no second pass.
 */
export function gateEvidenceRelativePath(gateId: string, index: number): string {
  const ordinal = String(index).padStart(INDEX_WIDTH, '0');
  const slug = slugify(gateId);
  const stem = slug === '' ? `gate-${ordinal}` : `gate-${ordinal}-${slug}`;

  return `${GATE_EVIDENCE_DIR}/${stem}.txt`;
}
