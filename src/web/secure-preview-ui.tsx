import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SecureCliTarget } from '../cli/secure-operation';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { ProjectPreviewPanel } from './project-preview-ui';
import type { PreviewAnnotation } from './project-preview';
import { SecurePreviewController, type SecurePreviewDependencies } from './secure-preview';

export type SecurePreviewUiHandle = {
  open(target: SecureCliTarget): Promise<void>;
  close(): Promise<void>;
};
export type SecurePreviewUiProps = SecurePreviewDependencies & {
  busy?: boolean;
  screenshotReason?: string;
  reason?: string;
};

export const SecurePreviewUI = forwardRef<SecurePreviewUiHandle, SecurePreviewUiProps>(
  function SecurePreviewUI(props, ref) {
    const latest = useRef(props);
    latest.current = props;
    const controller = useMemo(
      () =>
        new SecurePreviewController({
          context: () => latest.current.context(),
          storage: props.storage,
          annotations: props.annotations,
          request: (...args) => latest.current.request(...args),
          addImage: (...args) => latest.current.addImage(...args),
          changedAnnotations: (...args) => latest.current.changedAnnotations?.(...args),
          ...(props.schedule ? { schedule: props.schedule } : {}),
        }),
      [props.storage, props.annotations],
    );
    const [, render] = useState(0);
    useLayoutEffect(() => controller.subscribe(() => render((value) => value + 1)), [controller]);
    const context = productCanonicalJson(props.context());
    useLayoutEffect(() => controller.sync(), [controller, context]);
    useEffect(() => () => controller.dispose(), [controller]);
    useImperativeHandle(
      ref,
      () => ({ open: (target) => controller.open(target), close: () => controller.dismiss() }),
      [controller],
    );
    const state = controller.state;
    if (!state) return null;
    const review = state.review;
    const run = (work: () => Promise<void>) => {
      void work().catch(() => {});
    };
    return (
      <ProjectPreviewPanel
        key={productCanonicalJson([state.target, review.panel])}
        controller={state.controller}
        annotations={state.annotations}
        location={state.target.hostDeviceId}
        reason={
          !state.online
            ? '执行电脑离线。标注草稿保留，重新连接后请手动打开预览。'
            : state.working
              ? '正在完成预览操作，请稍候。'
              : props.reason
        }
        annotationLocked={!!props.busy || state.working}
        screenshotReason={props.screenshotReason}
        onDismiss={() => run(() => controller.dismiss())}
        onOptions={() => run(() => controller.action(review, 'options'))}
        onConnect={(connect, viewport) =>
          run(() => controller.action(review, { connect, viewport }))
        }
        onClose={() => run(() => controller.action(review, 'close'))}
        onCapture={() => run(() => controller.action(review, 'capture'))}
        onInspect={() => run(() => controller.action(review, 'inspect'))}
        onLocate={(x, y) => run(() => controller.action(review, { locate: { x, y } }))}
        onInteract={(interact) => run(() => controller.action(review, { interact }))}
        onSave={(note, includeImage) => controller.save(review, note, includeImage)}
        onSelect={(id, selected) => run(() => controller.select(review, id, selected))}
        onRemove={(id) => run(() => controller.remove(review, id))}
        onEdit={(id, note) => run(() => controller.edit(review, id, note))}
        onImage={(id) => run(() => controller.image(review, id))}
      >
        {state.error && state.error !== state.controller.error && <p role="alert">{state.error}</p>}
        {!!state.recoveries.length && (
          <section aria-label="旧映射原预览记录">
            <h3>旧映射原预览记录</h3>
            <p>项目映射已改变。可核查或关闭原连接；这些记录不会重新打开页面。</p>
            {state.recoveries.map((record) => (
              <article key={productCanonicalJson(record.target)}>
                <p>
                  映射版本 {record.target.product!.revision} · 原操作{' '}
                  {record.pending?.operationId ?? record.open?.operationId}
                </p>
                {record.receipt && <p>{record.receipt.message}</p>}
                {record.pending && (
                  <button
                    type="button"
                    disabled={!state.online || props.busy || state.working}
                    onClick={() => run(() => controller.recover(review, record, 'inspect'))}
                  >
                    核查旧映射原操作
                  </button>
                )}
                {record.open && (
                  <button
                    type="button"
                    disabled={!state.online || props.busy || state.working}
                    onClick={() => run(() => controller.recover(review, record, 'close'))}
                  >
                    关闭旧映射原连接
                  </button>
                )}
              </article>
            ))}
          </section>
        )}
      </ProjectPreviewPanel>
    );
  },
);

export function SecurePreviewDraftCards(props: {
  items: readonly PreviewAnnotation[];
  disabled?: boolean;
  onOpen(): void;
  onRemove(item: PreviewAnnotation): void;
}) {
  const selected = props.items.filter((item) => item.selectionId);
  if (!selected.length) return null;
  return (
    <section className="preview-composer-cards" aria-label="本次指令的网页标注">
      {selected.map((item) => (
        <div key={item.id + '/' + item.version + '/' + item.selectionId}>
          <span>
            {item.snapshot.serviceLabel} · {item.snapshot.pagePath}
          </span>
          <p>{item.snapshot.note}</p>
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onRemove(structuredClone(item))}
          >
            移除本次标注
          </button>
        </div>
      ))}
      <button type="button" disabled={props.disabled} onClick={props.onOpen}>
        查看标注草稿
      </button>
    </section>
  );
}
