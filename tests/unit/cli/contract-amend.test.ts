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
          now: AT,
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
          now: AT,
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
          now: AT,
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
        now: AT,
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
          now: AT,
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
        now: AT,
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
        now: AT,
        io: io({ answers: ['n'] }),
      });

      expect(await readFile(file, 'utf8')).toBe(before);
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
          now: AT,
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
          now: AT,
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
        now: AT,
        io: io({ answers: ['y'] }),
      });

      const after = await readFile(file, 'utf8');
      expect(after).toContain('version: 2');
      expect(after).toContain('frozen: false');
      // The SUPERSEDED fingerprint is recorded in history, not the new one.
      expect(after).toContain(current.meta.fingerprint ?? 'MISSING');
      expect(after).toContain('criterion E7-01 was unverifiable as written');
    });

    it('tells the operator the next step is --freeze', async () => {
      const { root } = await projectWith(frozenContract());
      const recorder = io({ answers: ['y'] });

      await runAmend({
        projectRoot: root,
        epicId: EPIC,
        reason: 'scope reduced',
        now: AT,
        io: recorder,
      });

      expect(recorder.written.join('')).toContain('--freeze');
    });

    it('prompts for the reason when --reason was not supplied', async () => {
      const { root, file } = await projectWith(frozenContract());
      const recorder = io({ answers: ['the gate now runs on a different command', 'y'] });

      await runAmend({ projectRoot: root, epicId: EPIC, now: AT, io: recorder });

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
          now: AT,
          io: recorder,
        }),
      ).rejects.toBeInstanceOf(IntegrityError);

      // Nothing written, and the operator was never asked to approve something
      // that could not proceed. Amending a tampered file would launder the
      // tampering into the audit trail as a legitimate change.
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(recorder.asked).toEqual([]);
    });

    it('refuses when there is no contract to amend', async () => {
      const root = await mkdtemp(join(tmpdir(), 'specwitness-amend-none-'));

      await expect(
        runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: 'scope reduced',
          now: AT,
          io: io({ answers: ['y'] }),
        }),
      ).rejects.toBeInstanceOf(InfraError);
    });

    it('refuses a blank reason without writing anything', async () => {
      const { root, file } = await projectWith(frozenContract());
      const before = await readFile(file, 'utf8');

      await expect(
        runAmend({
          projectRoot: root,
          epicId: EPIC,
          reason: '   ',
          now: AT,
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
