import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { isCaptureDeleted, saveCapture } from './store';
import type { CaptureRecord } from './types';

type Operation = { id: number; kind: 'import' | 'ocr' | 'save' | 'resume' | 'new' };
type Session = { capture: CaptureRecord | null; error: string | null; notice: string | null };
export type OperationContext = {
  show: (capture: CaptureRecord | null) => void;
  persist: (capture: CaptureRecord) => Promise<void>;
  error: (message: string | null) => void;
  notice: (message: string | null) => void;
};

/** Owns capture jobs and ordered, coalesced draft writes across camera and review UI. */
export function useCaptureSession() {
  const [session, setSession] = useState<Session>({ capture: null, error: null, notice: null });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [settled, setSettled] = useState(0);
  const currentCapture = useRef<CaptureRecord | null>(null);
  const activeOperation = useRef<Operation | null>(null);
  const nextOperation = useRef(0);
  const mounted = useRef(true);
  const dirtyDrafts = useRef(new Map<string, CaptureRecord>());
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushDraft = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const write = writeQueue.current.catch(() => undefined).then(async () => {
      while (dirtyDrafts.current.size) {
        for (const [id, record] of [...dirtyDrafts.current]) {
          await saveCapture(record);
          // An edit arriving during the write still needs its own save.
          if (dirtyDrafts.current.get(id) === record) dirtyDrafts.current.delete(id);
        }
      }
    });
    writeQueue.current = write;
    await write;
  }, []);

  const updateDraft = useCallback((record: CaptureRecord) => {
    if (!mounted.current || activeOperation.current || currentCapture.current?.id !== record.id || isCaptureDeleted(record.id)) return;
    currentCapture.current = record;
    setSession((state) => ({ ...state, capture: record }));
    dirtyDrafts.current.set(record.id, record);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flushDraft().catch(() => {
        if (mounted.current && currentCapture.current?.id === record.id) {
          setSession((state) => ({ ...state, error: 'The draft could not be saved. Your edits are still shown; retry saving before closing the app.' }));
        }
      });
    }, 200);
  }, [flushDraft]);

  const run = useCallback(async <T,>(kind: Operation['kind'], work: (context: OperationContext) => Promise<T>): Promise<T | undefined> => {
    // This immediate lock also covers the interval before React renders the busy state.
    if (activeOperation.current || !mounted.current) return undefined;
    const job = { id: ++nextOperation.current, kind };
    activeOperation.current = job;
    setOperation(job);
    const ownsScreen = () => mounted.current && activeOperation.current === job;
    const context: OperationContext = {
      async persist(record) {
        // Failed initial/OCR writes must also remain retryable before New or resume can discard the screen.
        dirtyDrafts.current.set(record.id, record);
        await flushDraft();
      },
      show(record) {
        if (!ownsScreen()) return;
        const capture = record && !isCaptureDeleted(record.id) ? record : null;
        currentCapture.current = capture;
        setSession((state) => ({ ...state, capture }));
      },
      error(error) { if (ownsScreen()) setSession((state) => ({ ...state, error })); },
      notice(notice) { if (ownsScreen()) setSession((state) => ({ ...state, notice })); },
    };
    try { return await work(context); }
    finally {
      if (activeOperation.current === job) {
        activeOperation.current = null;
        if (mounted.current) { setOperation(null); setSettled((value) => value + 1); }
      }
    }
  }, [flushDraft]);

  const clearNotice = useCallback(() => setSession((state) => ({ ...state, notice: null })), []);
  const clearDeletedCapture = useCallback(() => {
    const record = currentCapture.current;
    if (!record || !isCaptureDeleted(record.id)) return;
    dirtyDrafts.current.delete(record.id);
    currentCapture.current = null;
    setSession({ capture: null, notice: null, error: 'This capture was deleted from OCR Review. Start a new capture to continue.' });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void flushDraft().catch((error) => {
        console.warn('Yugen draft persistence failed', error);
        if (mounted.current) setSession((session) => ({ ...session, error: 'The draft could not be saved. Retry saving before closing the app.' }));
      });
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      // Retain committed draft edits even when navigation unmounts this screen.
      void flushDraft().catch((error) => console.warn('Yugen draft persistence failed', error));
    };
  }, [flushDraft]);

  return { ...session, busy: operation !== null, settled, currentCapture, activeOperation, run, updateDraft, flushDraft, clearNotice, clearDeletedCapture };
}
