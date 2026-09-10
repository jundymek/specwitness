// A module that does it right: it reads the handle through HANDLE_KEY, and spells the
// key only in COMMENTS — in all three quote styles, which a census must not count:
// never write "__handle", '__handle' or `__handle` here.
/* The same three in a block comment: "__handle", '__handle', `__handle` */
import { HANDLE_KEY } from './handle.js';

export const read = (target: Record<string, unknown>): unknown => target[HANDLE_KEY];
