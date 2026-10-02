import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.mjs';

const contexts = new AsyncLocalStorage();
export const CANCELLATION_MESSAGE = 'Operation cancelled locally. Previous workspace data was preserved. Upstream work may still finish and incur charges; cancellation does not confirm that the provider stopped.';
export function cancellationError() { return new AppError(409, 'OPERATION_CANCELLED', CANCELLATION_MESSAGE); }
export function runOperationContext(context, action) { return contexts.run(context, action); }
export function operationSignal() { return contexts.getStore()?.signal; }
export function assertNotCancelled(signal = operationSignal()) { if (signal?.aborted) throw cancellationError(); }
export function operationPhase(phase) {
  assertNotCancelled();
  contexts.getStore()?.onPhase?.(phase);
}
