/** Optional development observer. No message bodies or credentials are collected. */
export type SessionPerformanceMark = (owner: object, sessionId: string, version: string) => void;

export interface PerformanceSignals {
  inputChanged(target: HTMLTextAreaElement, timestamp: number): void;
  inputCommitted(target: HTMLTextAreaElement): void;
  sessionReceived(): SessionPerformanceMark | undefined;
  sessionCommitted(
    owner: object,
    sessionId: string | undefined,
    version: string | undefined,
    visible: boolean,
  ): void;
}

let observer: PerformanceSignals | undefined;

export function observePerformanceSignals(value: PerformanceSignals) {
  observer = value;
  return () => {
    if (observer === value) observer = undefined;
  };
}

export function inputPerformanceChanged(target: HTMLTextAreaElement, timestamp: number) {
  observer?.inputChanged(target, timestamp);
}

export function inputPerformanceCommitted(target: HTMLTextAreaElement | null) {
  if (target) observer?.inputCommitted(target);
}

/** Starts after a host response is validated; excludes transport and notification batching. */
export function beginSessionPerformanceRead() {
  return observer?.sessionReceived();
}

export function sessionPerformanceCommitted(
  owner: object,
  sessionId: string | undefined,
  version: string | undefined,
  target: HTMLTextAreaElement | null,
) {
  if (observer)
    observer.sessionCommitted(
      owner,
      sessionId,
      version,
      Boolean(target?.isConnected && !target.closest('[hidden]')),
    );
}
