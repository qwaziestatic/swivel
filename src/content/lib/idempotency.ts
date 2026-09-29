export interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, string>): Promise<void>;
}

export class IdempotencyUnavailableError extends Error {
  readonly code = "IDEMPOTENCY_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "IdempotencyUnavailableError";
  }
}

export function createRunGuard(storage: SessionStorage, prefix = "swivel:run:") {
  const keyFor = (runId: string) => `${prefix}${runId}`;

  return {
    async has(runId: string): Promise<boolean> {
      try {
        const key = keyFor(runId);
        const values = await storage.get(key);
        return values[key] !== undefined;
      } catch {
        throw new IdempotencyUnavailableError(
          "Persistent run guard is unavailable; refusing to risk a duplicate submission"
        );
      }
    },
    async mark(runId: string, status: string): Promise<void> {
      try {
        await storage.set({ [keyFor(runId)]: status });
      } catch {
        throw new IdempotencyUnavailableError(
          "Persistent run guard could not be updated; refusing to continue"
        );
      }
    },
  };
}
