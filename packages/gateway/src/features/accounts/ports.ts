import type { RuntimeWorkspace } from '@moor/protocol/protocol';
export type Device = {
  id: string;
  owner: string;
  name: string;
  revoked: number;
  machine_id: string | null;
  catalog: string;
  name_revision?: number;
};
export type Account = {
  id: string;
  email: string;
  salt: string | null;
  password: Uint8Array | null;
};
export type ExternalIdentity = {
  issuer: 'https://accounts.google.com';
  subject: string;
  email: string;
  emailVerified: true;
};
export interface CredentialPort {
  token(bytes?: number): string;
  uuid(): string;
  hash(value: string): string;
  derive(password: string, salt: string): Promise<Uint8Array>;
  equal(a: Uint8Array, b: Uint8Array): boolean;
}
export interface AccountsRecords {
  atomic<T>(work: () => T): T;
  snapshot<T>(name: 'replica' | 'catalog' | 'logout', work: () => T): T;
  close(): void;
  anyAccount(): boolean;
  account(owner: string): Account | undefined;
  accountByEmail(email: string): Account | undefined;
  firstAccounts(): Account[];
  insertAccount(row: Account): void;
  password(owner: string, email: string, salt: string, password: Uint8Array): void;
  pruneInvitations(now: number): void;
  invitationCount(owner: string): number;
  invite(hash: string, creator: string, expires: number): void;
  invitation(hash: string, now: number): { creator: string } | undefined;
  removeInvitation(hash: string): void;
  google(owner: string): { email: string } | undefined;
  googleOwner(issuer: string, subject: string): string | undefined;
  insertGoogle(owner: string, identity: ExternalIdentity, now: number): void;
  updateGoogle(owner: string, email: string, now: number): void;
  unlinkGoogle(owner: string): void;
  login(hash: string, owner: string, expires: number): void;
  loginOwner(hash: string, now: number): string | undefined;
  removeLogin(hash: string): void;
  clearLogins(): void;
  clearPairs(): void;
  pair(hash: string, owner: string, expires: number, workspaceId: string | null): void;
  pairing(hash: string, now: number): { owner: string; workspace_id: string | null } | undefined;
  removePair(hash: string): void;
  insertDevice(
    id: string,
    owner: string,
    name: string,
    hash: string,
    workspaceId: string | null,
  ): void;
  deviceByToken(hash: string): Device | undefined;
  device(owner: string, id: string): Device | undefined;
  devices(owner: string): Pick<Device, 'id' | 'name' | 'machine_id' | 'catalog'>[];
  revokeDevice(id: string): void;
  localDevice(id: string, owner: string, name: string, hash: string): void;
  renameDevice(id: string, name: string, revision: number): void;
  bindDevice(id: string, machineId: string): void;
}
export interface AccountsCatalog {
  workspace(owner: string, id: string): { id: string };
  discover(owner: string, deviceId: string, workspaces: RuntimeWorkspace[]): void;
}
