import { type GithubBinding } from '@moor/protocol/github-protocol';
import type { AttachmentScope } from '../attachments/model';

/** Capabilities consumed by Host session policies; no storage implementation is imported. */
export interface GithubBindingPersistence {
  get(scope: AttachmentScope): GithubBinding;
  put(scope: AttachmentScope, binding: GithubBinding): void;
}
