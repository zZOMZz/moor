import type { AttachmentReference } from '@moor/protocol/content-protocol';
export type AttachmentSaveResult = { status: 'saved' | 'cancelled' | 'handed-off' };
export type AttachmentExport = {
  scope: {
    owner: string;
    deviceId: string;
    workspaceId: string;
    localProjectId: string;
    sessionId: string;
  };
  reference: AttachmentReference;
  data: string;
  bytes: Uint8Array<ArrayBuffer>;
};
export interface AttachmentExportPort {
  save(input: AttachmentExport, current: () => boolean): Promise<AttachmentSaveResult>;
  cancel(): Promise<void>;
}
