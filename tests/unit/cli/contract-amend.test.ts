import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runContract } from '../../../src/cli/commands/contract.js';
import { runAmend, type AmendIo } from '../../../src/cli/commands/contract-amend.js';
import type { Contract } from '../../../src/domain/contract.js';
import { InfraError, IntegrityError, UsageError } from '../../../src/domain/errors.js';
import { freeze, serializeContract } from '../../../src/schemas/contract.js';

/**
 * ADR-005 — `--amend` is the only interactive path in the product, and it has no
 * bypass.
 *
 * These tests exist to make a SECURITY control hard to remove by accident. Each
 * one fails loudly if someone later adds the convenience flag that would let a
 * coding agent script an amendment, or lets a refusal path touch the file.
 *
 * THE TTY BRANCH IS TESTED WITHOUT A TTY, by injecting the predicate — never by
 * adding a product flag "for tests". A flag that exists only for the test suite
 * still exists for everyone, including the agent the control is aimed at.
 */

const AT = new Date('2026-08-31T09:15:00.000Z');
const EPIC = 'epic-7';

function frozenContract(): Contract {
  const draft: Contract = {
    spec: {
      epic: EPIC,
      version: 1,
      criteria: [
        {
          id: 'E7-01',
          statement: 'The report lists every failing gate with its command output.',
          kind: 'behavioral',
          severity: 'critical',
          verifiability: 'automated',
        },
      ],
    },
    meta: {
      schemaVersion: 1,
      frozen: false,
      fingerprint: null,
      createdAt: '2026-08-30T00:00:00.000Z',
      frozenAt: null,
      provenance: {
        provider: 'codex',
        model: null,
        providerCliVersion: null,
        generatedAt: '2026-08-30T00:00:00.000Z',
      },
      history: [],
    },
  };
  return freeze(draft, new Date('2026-08-30T12:00:00.000Z'));
}

async function projectWith(contract: Contract | string): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-amend-'));
  const dir = join(root, '.specwitness', 'contracts');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${EPIC}.yaml`);
  await writeFile(
    file,
    typeof contract === 'string' ? contract : serializeContract(contract),
    'utf8',
  );
  return { root, file };
}

interface RecordingIo extends AmendIo {
  readonly written: string[];
  readonly asked: string[];
}

function io(options: { interactive?: boolean; answers?: string[] } = {}): RecordingIo {
  const written: string[] = [];
  const asked: string[] = [];
  const answers = [...(options.answers ?? [])];

  return {
    written,
    asked,
    isInteractive: () => options.interactive !== false,
    write: (text) => {
      written.push(text);
    },
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? '';
    },
  };
}

describe('contract --amend', () => {
  describe('the no-TTY refusal (ADR-005)', () => {
    it('refuses without an interactive terminal', async () => {
      const { root } = await projectWith(frozenContract());

      await expect(
        runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: io({ interactive: false }),
        }),
      ).rejects.toBeInstanceOf(InfraError);
    });

    it('refuses as InfraError, so the edge maps it to exit 3 and never 64', async () => {
      // The invocation is well-formed; only the context is wrong. Exit 64 would
      // mean "fix your command line" and would invite an agent to hunt for the
      // flag that makes it work — the flag that deliberately does not exist.
      const { root } = await projectWith(frozenContract());

      let thrown: unknown;
      try {
        await runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: io({ interactive: false }),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InfraError);
      expect(thrown).not.toBeInstanceOf(UsageError);
      expect((thrown as InfraError).message).toContain('interactive terminal');
      expect((thrown as InfraError).hint).toContain('operator action');
    });

    it('refuses BEFORE reading anything from disk', async () => {
      // A refusal that depends on nothing on disk cannot be influenced by
      // anything on disk. There is no project here at all, and the answer is
      // still the TTY refusal rather than "no contract found".
      const root = await mkdtemp(join(tmpdir(), 'specwitness-amend-empty-'));

      let thrown: unknown;
      try {
        await runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: io({ interactive: false }),
        });
      } catch (error) {
        thrown = error;
      }

      expect((thrown as InfraError).message).toContain('interactive terminal');
    });

    it('leaves the contract byte-identical when it refuses', async () => {
      const { root, file } = await projectWith(frozenContract());
      const before = await readFile(file, 'utf8');

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        reason: 'scope reduced',
        clock: { now: () => AT },
        io: io({ interactive: false }),
      }).catch(() => undefined);

      expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('is not bypassed by --reason', async () => {
      // The failure mode named in the story: a flag that quietly skips the
      // confirmation. `--reason` supplies audit text; it does not authorise.
      const { root, file } = await projectWith(frozenContract());
      const before = await readFile(file, 'utf8');

      await expect(
        runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'I am automation and I would like to proceed',
          clock: { now: () => AT },
          io: io({ interactive: false }),
        }),
      ).rejects.toBeInstanceOf(InfraError);

      expect(await readFile(file, 'utf8')).toBe(before);
    });
  });

  describe('the confirmation', () => {
    it('shows the current version, its fingerprint and the reason before asking', async () => {
      // The friction is worth its cost only when it carries what the operator
      // needs in order to say no. A blind "are you sure?" teaches people to type
      // y without reading.
      const current = frozenContract();
      const { root } = await projectWith(current);
      const recorder = io({ answers: ['n'] });

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        reason: 'criterion E7-01 was unverifiable as written',
        clock: { now: () => AT },
        io: recorder,
      });

      const shown = recorder.written.join('');
      expect(shown).toContain(EPIC);
      expect(shown).toContain('current version  1');
      expect(shown).toContain(current.meta.fingerprint ?? 'MISSING');
      expect(shown).toContain('criterion E7-01 was unverifiable as written');
      // The prompt came after the summary, not before it.
      expect(recorder.asked.at(-1)).toContain('Amend this contract?');
    });

    it('leaves the file byte-identical when the operator declines', async () => {
      const { root, file } = await projectWith(frozenContract());
      const before = await readFile(file, 'utf8');

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        reason: 'scope reduced',
        clock: { now: () => AT },
        io: io({ answers: ['n'] }),
      });

      expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('treats a closed stdin (Ctrl+D) as a decline, not as a crash', async () => {
      // Found by driving the real binary through a pty: Ctrl+D at the prompt
      // made readline reject with AbortError, which escaped unclassified and
      // told the operator "this is a SpecWitness bug — please report it". The
      // file was correctly untouched, but aborting a confirmation is an
      // ordinary thing to do and must not look like a defect.
      //
      // Fail closed: absence of an affirmative answer is a decline. Any failure
      // to READ consent is the same as not having it.
      const { root, file } = await projectWith(frozenContract());
      const before = await readFile(file, 'utf8');

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        reason: 'scope reduced',
        clock: { now: () => AT },
        io: {
          isInteractive: () => true,
          write: () => {},
          ask: async () => {
            throw Object.assign(new Error('Aborted with Ctrl+D'), { name: 'AbortError' });
          },
        },
      });

      expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('cancels rather than demanding a reason when the REASON prompt is aborted', async () => {
      // The same abort at the other prompt. Answering a cancellation with
      // "an amendment reason is required" would be a usage error for someone
      // who deliberately backed out.
      const { root, file } = await projectWith(frozenContract());
      const before = await readFile(file, 'utf8');
      const written: string[] = [];

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        clock: { now: () => AT },
        io: {
          isInteractive: () => true,
          write: (text) => {
            written.push(text);
          },
          ask: async () => {
            throw Object.assign(new Error('Aborted with Ctrl+D'), { name: 'AbortError' });
          },
        },
      });

      expect(await readFile(file, 'utf8')).toBe(before);
      expect(written.join('')).toContain('cancelled');
    });

    it('treats anything that is not yes as no', async () => {
      // Fail closed. A stray keypress, an empty line, or a half-typed word must
      // not authorise a change to the definition of done.
      for (const answer of ['', ' ', 'no', 'nope', 'Y E S', 'sure', 'yolo']) {
        const { root, file } = await projectWith(frozenContract());
        const before = await readFile(file, 'utf8');

        await runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: io({ answers: [answer] }),
        });

        expect(await readFile(file, 'utf8')).toBe(before);
      }
    });

    it('accepts y and yes, case-insensitively', async () => {
      for (const answer of ['y', 'Y', 'yes', 'YES', ' yes ']) {
        const { root, file } = await projectWith(frozenContract());

        await runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: io({ answers: [answer] }),
        });

        expect(await readFile(file, 'utf8')).toContain('version: 2');
      }
    });
  });

  describe('the amendment itself', () => {
    it('writes a valid draft at the next version with the history entry', async () => {
      const current = frozenContract();
      const { root, file } = await projectWith(current);

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        reason: 'criterion E7-01 was unverifiable as written',
        clock: { now: () => AT },
        io: io({ answers: ['y'] }),
      });

      const after = await readFile(file, 'utf8');
      expect(after).toContain('version: 2');
      expect(after).toContain('frozen: false');
      // The SUPERSEDED fingerprint is recorded in history, not the new one.
      expect(after).toContain(current.meta.fingerprint ?? 'MISSING');
      expect(after).toContain('criterion E7-01 was unverifiable as written');
    });

    it('records when the operator CONFIRMED, not when the command started', async () => {
      // The prompt window is unbounded — an operator may read, think, go to
      // lunch, and come back. Stamping the history entry with the instant the
      // process started would date the audit trail to a moment before the
      // decision it records. The clock is read after confirmation.
      const { root, file } = await projectWith(frozenContract());
      const started = new Date('2026-08-31T09:00:00.000Z');
      const confirmed = new Date('2026-08-31T11:30:00.000Z');
      let current = started;

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        reason: 'scope reduced',
        clock: { now: () => current },
        io: {
          isInteractive: () => true,
          write: () => {},
          ask: async () => {
            // Time passes while the operator decides.
            current = confirmed;
            return 'y';
          },
        },
      });

      const after = await readFile(file, 'utf8');
      expect(after).toContain('2026-08-31T11:30:00.000Z');
      expect(after).not.toContain('2026-08-31T09:00:00.000Z');
    });

    it('tells the operator the next step is --freeze', async () => {
      const { root } = await projectWith(frozenContract());
      const recorder = io({ answers: ['y'] });

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        reason: 'scope reduced',
        clock: { now: () => AT },
        io: recorder,
      });

      expect(recorder.written.join('')).toContain('--freeze');
    });

    it('prompts for the reason when --reason was not supplied', async () => {
      const { root, file } = await projectWith(frozenContract());
      const recorder = io({ answers: ['the gate now runs on a different command', 'y'] });

      await runAmend({ projectRoot: root, epicId: EPIC, clock: { now: () => AT }, io: recorder });

      expect(await readFile(file, 'utf8')).toContain('the gate now runs on a different command');
    });
  });

  describe('refusals that protect the audit trail', () => {
    it('refuses a TAMPERED contract, and refuses before asking anything', async () => {
      const current = frozenContract();
      const tamperedYaml = serializeContract(current).replace(
        'lists every failing gate',
        'lists at least one failing gate',
      );
      const { root, file } = await projectWith(tamperedYaml);
      const before = await readFile(file, 'utf8');
      const recorder = io({ answers: ['y'] });

      await expect(
        runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: recorder,
        }),
      ).rejects.toBeInstanceOf(IntegrityError);

      // Nothing written, and the operator was never asked to approve something
      // that could not proceed. Amending a tampered file would launder the
      // tampering into the audit trail as a legitimate change.
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(recorder.asked).toEqual([]);
    });

    it('refuses a contract belonging to a different epic', async () => {
      // A valid frozen contract for another epic, copied or moved to
      // `.specwitness/contracts/epic-7.yaml`, parses and verifies perfectly:
      // the FILENAME is not part of the fingerprint, so nothing in the document
      // objects to being misfiled. Amending it would bump its version and
      // rewrite it at this path, turning a misplaced file into an
      // internally-valid authority over the wrong epic.
      // Internally CONSISTENT: epic-3 with E3-* criterion ids, so story 2.2's
      // schema is perfectly happy with it. The only thing wrong is where it
      // lives, and no rule inside the document can see that.
      const base = frozenContract();
      const criterion = base.spec.criteria[0];
      if (criterion === undefined) {
        throw new Error('fixture is missing its criterion');
      }
      const foreign = freeze(
        {
          spec: {
            epic: 'epic-3',
            version: 1,
            criteria: [{ ...criterion, id: 'E3-01' }],
          },
          meta: { ...base.meta, frozen: false, fingerprint: null, frozenAt: null },
        },
        new Date('2026-08-30T12:00:00.000Z'),
      );
      const { root, file } = await projectWith(foreign);
      const before = await readFile(file, 'utf8');
      const recorder = io({ answers: ['y'] });

      await expect(
        runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: recorder,
        }),
      ).rejects.toBeInstanceOf(IntegrityError);

      expect(await readFile(file, 'utf8')).toBe(before);
      // Refused before the operator was asked to approve anything.
      expect(recorder.asked).toEqual([]);
    });

    it('refuses when there is no contract to amend', async () => {
      const root = await mkdtemp(join(tmpdir(), 'specwitness-amend-none-'));

      await expect(
        runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: io({ answers: ['y'] }),
        }),
      ).rejects.toBeInstanceOf(InfraError);
    });

    it('refuses when the file changed while the operator was deciding', async () => {
      // TIME OF CHECK, TIME OF USE. The prompt window is however long a human
      // takes to read and type, which is forever in filesystem terms. Integrity
      // was verified against the bytes read BEFORE the prompt; writing
      // afterwards without re-checking would overwrite whatever arrived in the
      // meantime — and if what arrived was a tamper, the amendment would launder
      // it, which is the exact thing integrity-first exists to prevent.
      const { root, file } = await projectWith(frozenContract());

      const meddling: AmendIo = {
        isInteractive: () => true,
        write: () => {},
        ask: async () => {
          // Someone edits the contract while the prompt is open.
          await writeFile(file, `${await readFile(file, 'utf8')}\n# edited during the prompt\n`);
          return 'y';
        },
      };

      const changed = await readFile(file, 'utf8').then(async () => {
        await expect(
          runAmend({
            projectRoot: root,
            epicId: EPIC,
            reason: 'scope reduced',
            clock: { now: () => AT },
            io: meddling,
          }),
        ).rejects.toBeInstanceOf(IntegrityError);
        return await readFile(file, 'utf8');
      });

      // The newer content survives untouched: an amendment must never silently
      // discard an edit it never saw.
      expect(changed).toContain('# edited during the prompt');
      expect(changed).not.toContain('version: 2');
    });

    it('refuses a blank reason without writing anything', async () => {
      const { root, file } = await projectWith(frozenContract());
      const before = await readFile(file, 'utf8');

      await expect(
        runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: '   ',
          clock: { now: () => AT },
          io: io({ answers: ['y'] }),
        }),
      ).rejects.toBeInstanceOf(UsageError);

      expect(await readFile(file, 'utf8')).toBe(before);
    });
  });

  describe('no bypass exists in the source', () => {
    const SOURCES = [
      join(process.cwd(), 'src', 'cli', 'commands', 'contract-amend.ts'),
      join(process.cwd(), 'src', 'cli', 'commands', 'contract.ts'),
      join(process.cwd(), 'src', 'authoring', 'amend.ts'),
    ];

    it('defines no flag or environment variable that skips the confirmation', () => {
      // A source scan, because the property is "no such door exists" and a
      // behavioural test can only prove that the doors we thought of are shut.
      // ADR-005: "There is deliberately no non-interactive escape hatch (no
      // --yes/--confirm bypass) — amendments cannot be scripted, by anyone."
      //
      // Matches option REGISTRATIONS and env READS only: prose in a comment
      // naming the flags we refuse to add is exactly what should survive.
      //
      // `--force` is deliberately NOT in this list, and that is not a softening.
      // Story 2.6 registers it, and it overrides exactly one refusal — an
      // existing DRAFT during generation. It never reaches a frozen contract,
      // and `assertCoherentOptions` refuses it outright alongside any mode flag,
      // so it cannot even be typed next to `--amend`. Both facts are asserted
      // behaviourally rather than by this regex — by 2.6's "--force on a frozen
      // contract refuses identically" test, and by the `--force` case below.
      // Banning the string here would flag a legitimate flag and pressure a
      // later reader into deleting a guard rather than understanding it.
      for (const file of SOURCES) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toMatch(/option\(\s*['"`]--(yes|confirm|no-confirm|non-interactive)/);
        expect(source).not.toMatch(/process\.env\[?['"`]?(SPECWITNESS_|CI['"`\]])/);
      }
    });

    it('refuses on the real command path before the project is even checked', async () => {
      // The no-TTY policy is absolute, so it must not depend on filesystem
      // state. `runAmend` checks the TTY first — but on the COMMAND path story
      // 2.6's `assertProjectInitialised` ran before the amend branch, so in an
      // uninitialised directory an agent got "run init" instead of the ADR-005
      // refusal. Same invocation, different answer depending on where you stood:
      // a policy with an environmental exception is not a policy.
      const empty = await mkdtemp(join(tmpdir(), 'specwitness-amend-uninit-'));
      const cwd = process.cwd();
      process.chdir(empty);
      try {
        let thrown: unknown;
        try {
          await runContract('7', { amend: true, reason: 'x' }, { now: () => AT });
        } catch (error) {
          thrown = error;
        }
        expect((thrown as InfraError).message).toContain('interactive terminal');
      } finally {
        process.chdir(cwd);
      }
    });

    it('refuses --force regeneration over a draft carrying amendment history', async () => {
      // THE HOLE THE TWO-STEP FLOW OPENS. Between --amend and --freeze the
      // contract is a DRAFT, and generation treats every draft as replaceable
      // with --force — non-interactively. An agent that cannot amend could
      // therefore erase the record that an amendment happened and reset to a
      // fresh version 1 with empty history, which defeats the TTY gate by
      // deleting its output rather than by bypassing it.
      const { root, file } = await projectWith(frozenContract());
      const cwd = process.cwd();
      process.chdir(root);
      try {
        await runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          clock: { now: () => AT },
          io: io({ answers: ['y'] }),
        });
        const amended = await readFile(file, 'utf8');
        expect(amended).toContain('version: 2');

        await expect(
          runContract('7', { force: true }, { now: () => AT }),
        ).rejects.toBeInstanceOf(IntegrityError);

        // The audit trail survives untouched.
        expect(await readFile(file, 'utf8')).toBe(amended);
      } finally {
        process.chdir(cwd);
      }
    });

    it('refuses --reason without --amend rather than silently ignoring it', async () => {
      // Story 2.6 refuses `--json` without `--status` for exactly this reason:
      // "an invocation shaped like a question must never mutate the project by
      // surprise". `contract 7 --reason "..."` reads like an amendment and
      // would otherwise GENERATE A DRAFT while the operator believed they were
      // amending a frozen contract — the same harm, through my option.
      const fixedClock = { now: () => AT };

      await expect(
        runContract('7', { reason: 'scope reduced' }, fixedClock),
      ).rejects.toBeInstanceOf(UsageError);
    });

    it('refuses --reason alongside --status or --freeze', async () => {
      const fixedClock = { now: () => AT };

      await expect(
        runContract('7', { status: true, reason: 'x' }, fixedClock),
      ).rejects.toBeInstanceOf(UsageError);
      await expect(
        runContract('7', { freeze: true, reason: 'x' }, fixedClock),
      ).rejects.toBeInstanceOf(UsageError);
    });

    it('refuses --force alongside --amend instead of honouring it', async () => {
      const fixedClock = { now: () => AT };
      // The bypass an agent would actually reach for. `--force` is the only
      // override flag in the command, so someone blocked by the TTY refusal
      // would try it next. It is refused as an incoherent combination — not
      // silently ignored, which would leave them believing they forced
      // something.
      await expect(
        runContract('7', { amend: true, force: true }, fixedClock),
      ).rejects.toBeInstanceOf(UsageError);
    });

    it('reads no credential store and no harness role marker', () => {
      for (const file of SOURCES) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toMatch(/CLAUDE_CONFIG_DIR|CODEX_HOME|\.netrc/);
        // The PRD addendum floated SPECWITNESS_ROLE=agent as a way to detect an
        // agent caller; ADR-005 settled on the TTY rule instead. A marker the
        // agent itself controls is not a control.
        expect(source).not.toMatch(/SPECWITNESS_ROLE/);
      }
    });
  });
});
