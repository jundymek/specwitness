import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  InfraError,
  IngestError,
  IntegrityError,
  ProviderError,
  SpecWitnessError,
  UsageError,
  isSpecWitnessError,
} from '../../src/domain/errors.js';

/**
 * AD-7: exactly six classes. Story 1.2 builds on these and must not redefine
 * them, so the shape asserted here is a cross-story contract, not an internal
 * detail. Gate failure is deliberately absent (AD-6/AD-7) — it is a stage
 * result, never an exception.
 */
const AD7_CLASSES = [
  UsageError,
  ConfigError,
  IngestError,
  IntegrityError,
  ProviderError,
  InfraError,
] as const;

describe('AD-7 error hierarchy', () => {
  it.each(AD7_CLASSES)('$name is an Error and a SpecWitnessError', (Klass) => {
    const err = new Klass('something went wrong');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SpecWitnessError);
    expect(err).toBeInstanceOf(Klass);
  });

  it.each(AD7_CLASSES)('$name carries the message and no hint by default', (Klass) => {
    const err = new Klass('something went wrong');

    expect(err.message).toBe('something went wrong');
    expect(err.hint).toBeUndefined();
  });

  it.each(AD7_CLASSES)('$name accepts a positional optional hint', (Klass) => {
    const err = new Klass('something went wrong', 'try turning it off and on again');

    expect(err.hint).toBe('try turning it off and on again');
  });

  it.each(AD7_CLASSES)('$name sets name to its own class name', (Klass) => {
    const err = new Klass('boom');

    expect(err.name).toBe(Klass.name);
    // The class name is what shows up in an unhandled stack trace.
    expect(String(err)).toBe(`${Klass.name}: boom`);
  });

  it.each(AD7_CLASSES)('$name captures a stack trace', (Klass) => {
    const err = new Klass('boom');

    expect(err.stack).toBeTypeOf('string');
    expect(err.stack).toContain(Klass.name);
  });

  it('keeps the classes distinct from one another', () => {
    expect(new UsageError('x')).not.toBeInstanceOf(ConfigError);
    expect(new ConfigError('x')).not.toBeInstanceOf(UsageError);
    expect(new InfraError('x')).not.toBeInstanceOf(ProviderError);
  });
});

describe('isSpecWitnessError', () => {
  it.each(AD7_CLASSES)('recognises $name', (Klass) => {
    expect(isSpecWitnessError(new Klass('x'))).toBe(true);
  });

  it('recognises a subclass of an AD-7 class', () => {
    // Story 1.3 may refine ConfigError; refinements must still classify.
    class MissingConfigError extends ConfigError {}

    expect(isSpecWitnessError(new MissingConfigError('x'))).toBe(true);
  });

  it.each([
    ['a plain Error', new Error('nope')],
    ['a TypeError', new TypeError('nope')],
    ['a string', 'nope'],
    ['null', null],
    ['undefined', undefined],
    ['a duck-typed impostor', { message: 'nope', hint: 'nope', name: 'UsageError' }],
  ])('rejects %s', (_label, value) => {
    expect(isSpecWitnessError(value)).toBe(false);
  });
});
