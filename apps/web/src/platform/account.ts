export type Account = {
  origin: string;
  owner: string | null;
  needsSetup: boolean;
  google: { enabled: boolean };
};
export type AccountResult =
  | { ok: true; value: Account | { loggedOut: true } | AccountManagementValue }
  | { ok: false; error: { message: string } };
export type AccountApi = (
  request: { action: 'status' } | { action: 'logout'; owner: string } | AccountManagementRequest,
) => Promise<AccountResult>;
import type {
  AccountManagementRequest,
  AccountManagementValue,
} from '@moor/protocol/account-management';
