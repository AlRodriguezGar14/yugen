type StudyChange = 'entries' | 'capture';
const listeners = new Set<(change: StudyChange) => void>();

/** Subscribes to committed changes of saved texts, words or photos; returns the unsubscribe function. */
export function onStudyChange(listener: (change: StudyChange) => void, scope: StudyChange | 'all' = 'entries'): () => void {
  const subscriber = (change: StudyChange) => { if (scope === 'all' || scope === change) listener(change); };
  listeners.add(subscriber);
  return () => { listeners.delete(subscriber); };
}

/**
 * Awaits a persistent mutation and, only once it has committed, tells subscribers (e.g. a Library that is already
 * focused because the user navigated back while it was pending). A failed mutation rejects without an event.
 */
export async function afterCommit<T>(mutation: Promise<T>, change: StudyChange = 'entries'): Promise<T> {
  const result = await mutation;
  for (const listener of [...listeners]) {
    try { listener(change); } catch (error) {
      // Refresh failures must not turn an already committed write into an apparent failed save.
      console.warn('Yugen collection refresh failed', error);
    }
  }
  return result;
}
