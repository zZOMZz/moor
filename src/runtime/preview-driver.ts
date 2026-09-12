import type {
  PreviewAction,
  PreviewElement,
  PreviewFrame,
  PreviewViewport,
} from '../preview-protocol';

/** Private host-to-renderer boundary. Never serialized as relay RPC input. */
export type PreviewRendererBinding = {
  previewId: string;
  origin: string;
  startPath: string;
  viewport: PreviewViewport;
};
export type PreviewCheckpoint = {
  assertCurrent(): void;
  /** Called after validation, immediately before dispatch; throws to prevent dispatch. */
  beforeDispatch?(): void;
};
export type PreviewInteraction = Exclude<PreviewAction, { action: 'open' }>;
export interface PreviewDriver {
  available(): Promise<{ available: boolean; reason?: string }>;
  open(binding: PreviewRendererBinding, check: PreviewCheckpoint): Promise<PreviewFrame>;
  capture(previewId: string, check: PreviewCheckpoint): Promise<PreviewFrame>;
  locate(
    previewId: string,
    frameId: string,
    point: { x: number; y: number },
    check: PreviewCheckpoint,
  ): Promise<PreviewElement | null>;
  interact(request: PreviewInteraction, check: PreviewCheckpoint): Promise<PreviewFrame>;
  /** Idempotent, also tombstones a pending open. Kills only the dedicated renderer. */
  close(previewId: string): Promise<void>;
  closeAll(): Promise<void>;
}
