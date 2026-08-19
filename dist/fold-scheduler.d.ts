/**
 * Tab-wide fold mutex. Production mounts many shards; folding them all at
 * once saturates Firestore transactions and can hang a save past the host
 * 15s failsafe if fold stays on the save path. Folds run one at a time.
 * Waiting folds must not hold saveInFlight — enqueue after onSaving(false).
 */
export declare function enqueueTabFold(task: () => Promise<void>): void;
export declare function whenTabFoldsIdle(): Promise<void>;
export declare function resetTabFoldScheduler(): void;
//# sourceMappingURL=fold-scheduler.d.ts.map