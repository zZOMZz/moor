/** Host-owned records. The document policy never receives a SQL connection. */
export type CollaborationDocumentRow = {
  snapshot: string;
  peer: string;
  revision: number;
  sequence: number;
};
export interface CollaborationPersistence {
  atomic<T>(work: () => T): T;
  close(): void;
  role(workspace: string, actor: string): unknown;
  workspaceOwner(workspace: string): string | undefined;
  createWorkspace(workspace: string, owner: string): void;
  setMember(workspace: string, actor: string, role: string | null): void;
  sessions(): { scope: string; target: string }[];
  sessionTarget(scope: string): string | undefined;
  registerSession(scope: string, target: string): void;
  document(scope: string): CollaborationDocumentRow | undefined;
  insertDocument(scope: string, row: CollaborationDocumentRow): void;
  updateDocument(scope: string, snapshot: string, revision: number, sequence: number): void;
  upgradeDocument(scope: string, snapshot: string, peer: string): void;
  legacyDocument(scope: string): {
    operations: { body: string; sequence: number }[];
    executions: string[];
  };
}
