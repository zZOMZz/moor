export type TaskLedgerRow = {
  intent: string;
  state: string;
  claim: string | null;
  command: string | null;
};
/** Finite scoped records for the Host-private queue. No SQL handle or arbitrary query. */
export interface TaskLedger {
  through(scope: string): number;
  reconciled(scope: string, through: number): void;
  intent(scope: string, id: string): string | undefined;
  insert(scope: string, id: string, sequence: number, intent: string, state: string): void;
  row(scope: string, id: string): TaskLedgerRow | undefined;
  updateState(scope: string, id: string, state: string): void;
  active(scope: string): boolean;
  queued(scope: string): () => { intent: string; state: string } | undefined;
  updateClaim(scope: string, id: string, claim: string): void;
  updateCommand(scope: string, id: string, command: string): void;
  activeRows(scope: string): { id: string; state: string }[];
}
