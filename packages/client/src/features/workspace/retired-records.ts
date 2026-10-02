export type RetiredRecord = { key: string; value: unknown };
export type RetiredRecordExport = {
  format: 'moor-retired-secure-v1' | 'moor-retired-web-v1';
  records: RetiredRecord[];
};
export interface RetiredRecordsPort {
  read(format: RetiredRecordExport['format']): Promise<RetiredRecord[]>;
  export(
    value: RetiredRecordExport,
    current: () => boolean,
  ): Promise<{
    status: 'saved' | 'cancelled' | 'handed-off';
  }>;
}
