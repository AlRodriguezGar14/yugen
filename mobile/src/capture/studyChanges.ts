const listeners = new Set<() => void>();

/** Subscribes to committed changes of saved texts, words or photos; returns the unsubscribe function. */
export function onStudyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Awaits a persistent mutation and, only once it has committed, tells subscribers (e.g. a Library that is already
 * focused because the user navigated back while it was pending). A failed mutation rejects without an event.
 */
export async function afterCommit<T>(mutation: Promise<T>): Promise<T> {
  const result = await mutation;
  for (const listener of [...listeners]) listener();
  return result;
}
