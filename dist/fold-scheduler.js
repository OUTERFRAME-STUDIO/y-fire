/**
 * Tab-wide fold mutex. Production mounts many shards; folding them all at
 * once saturates Firestore transactions and can hang a save past the host
 * 15s failsafe if fold stays on the save path. Folds run one at a time.
 * Waiting folds must not hold saveInFlight — enqueue after onSaving(false).
 */
let chain = Promise.resolve();
export function enqueueTabFold(task) {
    chain = chain.then(task, task);
}
export function whenTabFoldsIdle() {
    return chain.then(() => undefined, () => undefined);
}
export function resetTabFoldScheduler() {
    chain = Promise.resolve();
}
