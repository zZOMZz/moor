import type { DatabaseSync } from 'node:sqlite';
import { Accounts } from '../../features/accounts/service';
import { WorkspaceCatalog } from '../../features/catalog/service';
import { nodeCredentials } from '../crypto/credentials';
import { SqliteAccountRecords } from '../persistence/accounts';
import { SqliteCatalogRecords } from '../persistence/catalog';
/** Node root: all account/catalog transactions use this one operator-owned connection. */
export class SqliteAccounts extends Accounts {
  readonly database: DatabaseSync;
  declare readonly catalog: WorkspaceCatalog;
  constructor(file: string, now: () => number = Date.now) {
    const records = new SqliteAccountRecords(file);
    try {
      const catalog = new WorkspaceCatalog(
        new SqliteCatalogRecords(records.database),
        nodeCredentials,
      );
      super(records, nodeCredentials, catalog, records.authorityId, now);
      this.database = records.database;
    } catch (error) {
      records.close();
      throw error;
    }
  }
}
