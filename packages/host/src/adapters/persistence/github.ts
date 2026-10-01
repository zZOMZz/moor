import { githubBindingSchema, type GithubBinding } from '@moor/protocol/github-protocol';
import { assert } from '@moor/protocol/protocol';
import type { DatabaseSync } from 'node:sqlite';
import type { AttachmentScope } from '../../features/attachments/model';
import type { GithubBindingPersistence } from '../../features/persistence/github';
const key = (scope: AttachmentScope) =>
  JSON.stringify([
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
  ]);
export class SessionGithubStore implements GithubBindingPersistence {
  constructor(private db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS session_github(session_id TEXT PRIMARY KEY,scope TEXT NOT NULL,binding TEXT NOT NULL)',
    );
  }
  get(scope: AttachmentScope): GithubBinding {
    const row = this.db
      .prepare('SELECT scope,binding FROM session_github WHERE session_id=?')
      .get(scope.sessionId);
    if (!row) return { revision: 0 };
    assert(row.scope === key(scope), 409, 'GitHub 会话绑定属于另一执行范围');
    return githubBindingSchema.parse(JSON.parse(String(row.binding)));
  }
  put(scope: AttachmentScope, binding: GithubBinding) {
    this.get(scope);
    this.db
      .prepare(
        'INSERT INTO session_github VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET binding=excluded.binding',
      )
      .run(scope.sessionId, key(scope), JSON.stringify(githubBindingSchema.parse(binding)));
  }
}
