export class AppError extends Error {
  constructor(status, code, message) { super(message); this.name = 'AppError'; this.status = status; this.code = code; }
}
export function assert(condition, status, code, message) { if (!condition) throw new AppError(status, code, message); }
export function publicError(error) {
  return error instanceof AppError
    ? { status: error.status, body: { error: { code: error.code, message: error.message } } }
    : { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'The operation could not be completed. No change was saved.' } } };
}
