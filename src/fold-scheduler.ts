/**
 * Tab-wide fold mutex. Production mounts many shards; folding them all at
 * once saturates Firestore transactions and can hang a save past the host
 * 15s failsafe if fold stays on the save path. Folds run one at a time.
 * Waiting folds must not hold saveInFlight — enqueue after onSaving(false).
 */

let chain: Promise<void> = Promise.resolve();

export function enqueueTabFold(task: () => Promise<void>): void {
  chain = chain.then(task, task);
}

export function whenTabFoldsIdle(): Promise<void> {
  return chain.then(
    () => undefined,
    () => undefined,
  );
}

export function resetTabFoldScheduler(): void {
  chain = Promise.resolve();
}
