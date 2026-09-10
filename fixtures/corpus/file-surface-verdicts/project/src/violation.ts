// A module that violates the convention in CODE, in exactly the two quote styles a census
// counting only the double-quoted spelling would miss.
export const byIndex = (target: Record<string, unknown>): unknown => target['__handle'];
export const byTemplate = (): string => `__handle`;
