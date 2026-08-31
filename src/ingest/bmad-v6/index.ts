/**
 * The BMAD v6 source set.
 *
 * This module is the ONLY place that knows a BMAD project keeps its epics file
 * under one configured root and its per-story files under another, and that a
 * per-story file supersedes the epics file for the story it covers. `ingestEpic`
 * folds whatever sources it is handed, in the order it is handed them, so
 * adding a second planning format (question Q4) means adding a directory beside
 * this one and listing its sources — not editing the orchestrator or anything
 * downstream of it.
 */

import type { ResolvedSource } from '../epic-source.js';

import { epicsFileSource } from './epics-file.js';
import { storyFilesSource } from './story-files.js';

/**
 * The BMAD v6 readers, bound to the roots they read, in PRECEDENCE ORDER:
 * lowest first, so later entries supersede earlier ones story by story.
 *
 * The epics file comes first and the per-story files second, which is exactly
 * AC2's rule — per-story files win for the stories they cover, while the epics
 * file supplies the epic title and goal plus any story the per-story files do
 * not cover. Encoding it as list order rather than as branching in the merge is
 * what keeps the merge itself format-agnostic.
 */
export function bmadV6Sources(
  planningArtifacts: string,
  implementationArtifacts: string,
): readonly ResolvedSource[] {
  return [
    { source: epicsFileSource, rootLabel: planningArtifacts },
    { source: storyFilesSource, rootLabel: implementationArtifacts },
  ];
}
