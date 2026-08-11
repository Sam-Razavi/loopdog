/**
 * Anything Claude can recover from by asking, retrying or picking different
 * arguments. These come back as tool results with is_error set rather than
 * being logged as unexpected failures — a model sending a timestamp without an
 * offset is routine, not a bug.
 */
export class ToolError extends Error {}
