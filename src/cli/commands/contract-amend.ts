/**
 * `specwitness contract <epic> --amend` — the operator-only amendment flow
 * (FR-10, UJ-5, ADR-005).
 *
 * THIS IS A SECURITY CONTROL, NOT A UX PREFERENCE. ADR-005 is explicit that V0's
 * contract freeze is tamper-EVIDENT, not tamper-PROOF: nothing stops a
 * determined local agent from editing the file and re-running the freeze. What
 * this command does is make the one *sanctioned* change path require a human at
 * a terminal, so that "the agent weakened the criterion" and "the operator
 * changed their mind" stop looking alike in git history.
 *
 * THERE IS NO BYPASS AND THERE MUST NEVER BE ONE. No `--yes`. No `--confirm`.
 * No `--force`. No environment variable. No config key. No hidden flag. Not for
 * CI, not for the harness, not for tests — the TTY branch is tested by injecting
 * the predicate below, never by adding a product flag. ADR-005: "amendments
 * cannot be scripted, by anyone." If you are reading this because you need to
 * amend a contract from automation: that is the case the control exists to stop.
 *
 * `--reason` IS NOT A BYPASS. It supplies the audit-trail text that would
 * otherwise be typed at the prompt; it does not skip the confirmation, and a
 * test asserts that the flag combination creates no shortcut. Supplying the
 * reason up front is a convenience for the operator who already knows what they
 * are going to write, not a way to run the flow unattended.
 *
 * WHY EXIT 3 AND NOT 64. A no-TTY invocation is well-formed: the command is
 * spelled correctly and would be accepted verbatim from a terminal. Only the
 * CONTEXT is wrong, which is the environment/policy class (ADR-002). Exit 64
 * means "fix your command line", and there is nothing to fix — worse, it would
 * invite an agent to go hunting for the flag that makes it work, which is
 * precisely the bypass that does not exist.
 *
 * THE TTY CHECK READS THE STREAMS THE FLOW ACTUALLY USES. Testing
 * `stdout.isTTY` while prompting on stdin would be a hole big enough to drive
 * a pipeline through; a confirmation the operator cannot see is not a
 * confirmation either. So both the input stream and the stream the prompt is
 * written to must be interactive.
 *
 * THE CONFIRMATION CARRIES INFORMATION. It shows the epic, the current version,
 * its fingerprint and the reason about to be recorded, BEFORE accepting. The
 * friction is the point only when it carries what the operator needs in order to
 * say no; a blind "are you sure? [y/N]" is friction that teaches people to type
 * y without reading.
 *
 * WHAT IT LEAVES BEHIND. A valid DRAFT at version N+1 with the history entry
 * recorded — not a re-frozen contract. AC1 asks for a version that is
 * "re-reviewed and re-frozen", so the operator edits the criteria and then runs
 * `--freeze`. Freezing here would close that window and produce a new version
 * identical to the old one: an audit trail recording a change that never
 * happened. See DECISIONS.md D1.
 *
 * Every path is fail-closed: a tampered contract, an absent one, a declined
 * confirmation and an empty reason each leave the file byte-identical.
 */

import { createInterface } from 'node:readline/promises';

import { amend, assertAmendable, normalizeReason } from '../../authoring/amend.js';
import {
  contractRelativePath,
  readContractFile,
  writeContractFileAtomically,
} from '../../authoring/contract-file.js';
import { InfraError, IntegrityError } from '../../domain/errors.js';
import { parseContract, serializeContract } from '../../schemas/contract.js';

/**
 * The interactive surface, injected so both branches are unit-testable without
 * a pty — and so that testing never requires a product flag that weakens the
 * control.
 */
export interface AmendIo {
  /** True only when the streams this flow reads and writes are both a terminal. */
  isInteractive(): boolean;
  /** Writes operator-facing text. Never stdout: `--json` consumers parse that. */
  write(text: string): void;
  /** Reads one line of operator input. */
  ask(question: string): Promise<string>;
}

export interface AmendCommandOptions {
  readonly projectRoot: string;
  readonly epicId: string;
  /** Supplied by `--reason`; prompted for when absent. Never a bypass. */
  readonly reason?: string;
  /** Injected instant (AD-9). */
  readonly now: Date;
  readonly io: AmendIo;
}

/** The real predicate. Both streams, because the flow uses both. */
export function processIsInteractive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

const AFFIRMATIVE = new Set(['y', 'yes']);

export async function runAmend(options: AmendCommandOptions): Promise<void> {
  const { io, epicId, projectRoot, now } = options;

  // FIRST, before touching the filesystem. A refusal that depends on nothing on
  // disk cannot be influenced by anything on disk, and the operator gets the
  // same answer whether or not the contract exists.
  if (!io.isInteractive()) {
    throw new InfraError(
      'amending a contract requires an interactive terminal',
      'amendment is an operator action: run it yourself in a terminal. There is deliberately no non-interactive flag — see ADR-005',
    );
  }

  const text = await readContractFile(projectRoot, epicId);
  if (text === undefined) {
    throw new InfraError(
      `no contract found at ${contractRelativePath(epicId)}`,
      "generate one with 'specwitness contract <epic>' before amending it",
    );
  }

  // A tampered contract PARSES fine — 2.2's parser is structural and never
  // compares fingerprints, which is what lets `--status` report a mismatch as a
  // field rather than crash. So integrity is a separate question, asked next.
  const current = parseContract(text, contractRelativePath(epicId));

  // Integrity BEFORE the operator is asked for anything. A tampered contract is
  // reported the moment it is recognised, rather than after someone has typed a
  // paragraph of rationale for an operation that was never going to proceed.
  // The returned fingerprint is the one about to be superseded, and only a valid
  // frozen contract has one — so it cannot be shown or recorded unless the
  // check passed.
  const supersededFingerprint = assertAmendable(current);

  const reason = normalizeReason(options.reason ?? (await askForReason(io)));

  io.write(
    [
      '',
      `About to amend the contract for ${current.spec.epic}:`,
      `  current version  ${current.spec.version}`,
      `  fingerprint      ${supersededFingerprint}`,
      `  reason recorded  ${reason}`,
      '',
      `This supersedes version ${current.spec.version} and leaves version ${
        current.spec.version + 1
      } as an editable draft.`,
      '',
    ].join('\n'),
  );

  const answer = (await io.ask('Amend this contract? [y/N] ')).trim().toLowerCase();
  if (!AFFIRMATIVE.has(answer)) {
    // Nothing is written. The contract is byte-identical to what it was.
    io.write('Amendment cancelled; the contract is unchanged.\n');
    return;
  }

  // TIME OF CHECK, TIME OF USE. Integrity was verified against the bytes read
  // BEFORE the prompt, and the prompt window is however long a human takes to
  // read and type — forever, in filesystem terms. Writing now without looking
  // again would overwrite whatever arrived in the meantime; and if what arrived
  // was a tamper, the amendment would launder it into the audit trail as
  // legitimate, which is the exact thing checking integrity first exists to
  // prevent. So: re-read, and refuse unless the bytes are the ones the operator
  // actually confirmed.
  //
  // Compared as BYTES rather than by re-parsing. The question is not "is the
  // new content also valid?" but "is this still the thing you agreed to?", and
  // only the original bytes answer that.
  const nowOnDisk = await readContractFile(projectRoot, epicId);
  if (nowOnDisk !== text) {
    throw new IntegrityError(
      `the contract at ${contractRelativePath(epicId)} changed while the amendment was being confirmed`,
      'nothing was written — re-read the file and run the amendment again if you still want it',
    );
  }

  // `amend` re-checks both preconditions rather than trusting this module: it
  // is the function that writes the audit trail, and the cost of asking twice
  // is nothing next to the cost of a caller that forgot.
  const amended = amend({ contract: current, reason, at: now });

  await writeContractFileAtomically(projectRoot, epicId, serializeContract(amended));

  io.write(
    [
      '',
      `Amended: version ${current.spec.version} superseded by version ${amended.spec.version}.`,
      `The contract is now an editable draft at ${contractRelativePath(epicId)}.`,
      '',
      'Next: edit the criteria, then re-freeze with',
      `  specwitness contract ${current.spec.epic} --freeze`,
      '',
    ].join('\n'),
  );
}

async function askForReason(io: AmendIo): Promise<string> {
  io.write(
    'An amendment is recorded in the contract history. Describe why the expected behaviour is changing.\n',
  );
  return await io.ask('Reason: ');
}

/**
 * The real interactive surface.
 *
 * Prompts and progress go to STDERR, never stdout. `contract --status --json`
 * puts a JSON document on stdout and nothing else, and a command that sometimes
 * writes prose there would break `jq` for the harness. Amend writes no machine
 * output at all, so stderr is where all of its text belongs.
 *
 * `readline` is created and closed per question rather than held open: an
 * interface left listening keeps the process alive after the flow returns, and
 * a CLI that does not exit is a worse bug than one that exits wrongly.
 */
export function processAmendIo(): AmendIo {
  return {
    isInteractive: processIsInteractive,
    write: (text) => {
      process.stderr.write(text);
    },
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}
