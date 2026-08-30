/**
 * The zod model of `.specwitness/config.yaml` (FR-2, FR-4).
 *
 * Two rules govern every line below:
 *
 * 1. STRICT AT EVERY LEVEL. Objects are `z.strictObject`, so an unknown key —
 *    `setupp:` at the root, or a nested typo like `readyness:` — is an error
 *    naming its YAML path rather than silently doing nothing. A misspelled
 *    readiness block that validated would mean a service SpecWitness never
 *    waits for.
 *
 * 2. DELIBERATE DEFAULTS ONLY. zod defaults silently materialise values the user
 *    did not write, so the complete list lives here and nowhere else:
 *
 *      planning.format                  = 'bmad-v6'
 *      planning.planningArtifacts       = 'docs/planning-artifacts'
 *      planning.implementationArtifacts = 'docs/implementation-artifacts'
 *      planning | setup | services | data | observations | ai = {}  (whole block)
 *      gates                            = []
 *      services.<name>.ready.timeoutSec = 60   (addendum section D example value)
 *
 *    `project.baseBranch` deliberately has NO default: addendum section D
 *    annotates it "never assumed", and defaulting it is exactly the assumption
 *    the brief forbids. It plus `version` are the entire required surface, which
 *    is what lets story 1.4's `init` skeleton stay tiny.
 *
 * Key names are camelCase per the spine, EXCEPT the three `ai.roles` keys, which
 * the story spec and addendum section D both spell kebab-case. Spec wins; the
 * divergence is recorded in DECISIONS.md.
 */

import { z } from 'zod';

import { declaredCommandSchema } from './declared-command.js';

const DEFAULT_PLANNING_ARTIFACTS = 'docs/planning-artifacts';
const DEFAULT_IMPLEMENTATION_ARTIFACTS = 'docs/implementation-artifacts';
const DEFAULT_READY_TIMEOUT_SEC = 60;

const nonEmptyString = z.string().min(1);

const projectSchema = z.strictObject({
  /** No default: the base branch is never assumed (addendum section D). */
  baseBranch: nonEmptyString,
  epicBranchPattern: nonEmptyString.optional(),
});

const planningSchema = z.strictObject({
  format: z.literal('bmad-v6').default('bmad-v6'),
  planningArtifacts: nonEmptyString.default(DEFAULT_PLANNING_ARTIFACTS),
  implementationArtifacts: nonEmptyString.default(DEFAULT_IMPLEMENTATION_ARTIFACTS),
});

const setupSchema = z.strictObject({
  install: declaredCommandSchema.optional(),
});

const gateSchema = z.strictObject({
  id: nonEmptyString,
  run: declaredCommandSchema,
});

/**
 * A service is ready when a URL answers OR when a probe command succeeds —
 * exactly one, enforced by the refinement below.
 *
 * This is deliberately one strict object rather than a `z.union` of a url arm and
 * a command arm. Under a union, a bad `timeoutSec` fails both arms and zod reports
 * a single `invalid_union` issue whose path stops at `services.<name>.ready`, so
 * the user is told the block is wrong without being told which key. AC2 requires
 * naming the offending path, so the shape follows the error quality:
 * `services.backend.ready.timeoutSec: expected number, received string`.
 */
const readinessSchema = z
  .strictObject({
    url: nonEmptyString.optional(),
    command: declaredCommandSchema.optional(),
    timeoutSec: z.number().int().positive().default(DEFAULT_READY_TIMEOUT_SEC),
  })
  .superRefine((ready, ctx) => {
    const hasUrl = ready.url !== undefined;
    const hasCommand = ready.command !== undefined;
    if (hasUrl === hasCommand) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: hasUrl
          ? "declare exactly one of 'url' or 'command', not both"
          : "declare exactly one of 'url' or 'command'",
      });
    }
  });

const serviceSchema = z.strictObject({
  run: declaredCommandSchema,
  /** Explicit per-service ports; V0 does not auto-allocate (questions doc Q26). */
  port: z.number().int().min(1).max(65535).optional(),
  ready: readinessSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const providerSchema = z.strictObject({
  adapter: z.enum(['claude-code-cli', 'codex-cli']),
  mode: nonEmptyString,
});

/** Kebab-case by spec + addendum section D; see the header note. */
export const AI_ROLES = ['contract-author', 'plan-author', 'explainer'] as const;

const aiSchema = z.strictObject({
  providers: z.record(nonEmptyString, providerSchema).optional(),
  roles: z
    .strictObject({
      'contract-author': nonEmptyString.optional(),
      'plan-author': nonEmptyString.optional(),
      explainer: nonEmptyString.optional(),
    })
    .optional(),
});

const observationSchema = z.strictObject({
  run: declaredCommandSchema,
});

const baseConfigSchema = z.strictObject({
  version: z.literal(1),
  project: projectSchema,
  /**
   * `prefault`, not `default`: zod returns a `default` value AS-IS without
   * parsing it, so `.default({})` would yield a bare `{}` and silently skip the
   * three inner field defaults below. `prefault` runs the fallback through the
   * schema, so an omitted `planning:` block gets the documented values and an
   * unknown key inside a partial block is still rejected. Verified against the
   * pinned zod 4.5 before relying on it.
   */
  planning: planningSchema.prefault({}),
  setup: setupSchema.default({}),
  /** Order is significant: gates run in YAML declaration order with early stop. */
  gates: z.array(gateSchema).default([]),
  services: z.record(nonEmptyString, serviceSchema).default({}),
  /** Free-form command map keyed by name; `reset` is the conventional key. */
  data: z.record(nonEmptyString, declaredCommandSchema).default({}),
  observations: z.record(nonEmptyString, observationSchema).default({}),
  ai: aiSchema.default({}),
});

/**
 * Cross-field rules a per-field schema cannot express. Each issue carries an
 * explicit `path` so the loader can render the offending YAML path.
 */
export const configSchema = baseConfigSchema.superRefine((config, ctx) => {
  const firstSeenAt = new Map<string, number>();
  config.gates.forEach((gate, index) => {
    const earlier = firstSeenAt.get(gate.id);
    if (earlier === undefined) {
      firstSeenAt.set(gate.id, index);
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['gates', index, 'id'],
      message: `duplicate gate id "${gate.id}" (already declared at gates[${earlier}]); gate ids must be unique`,
    });
  });

  const declaredProviders = Object.keys(config.ai.providers ?? {});
  for (const role of AI_ROLES) {
    const assigned = config.ai.roles?.[role];
    if (assigned === undefined) {
      continue;
    }
    if (declaredProviders.includes(assigned)) {
      continue;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['ai', 'roles', role],
      message:
        `role "${role}" references undeclared provider "${assigned}"; ` +
        (declaredProviders.length > 0
          ? `declared providers are: ${declaredProviders.join(', ')}`
          : 'no providers are declared under ai.providers'),
    });
  }
});
