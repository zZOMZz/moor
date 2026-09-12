import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Monitor, X } from 'lucide-react';
import { paint } from './ui';
import { PREVIEW_LIMITS, type PreviewViewport } from '../preview-protocol';
import {
  previewAnnotationKey,
  type ProjectPreviewController,
  type PreviewAnnotation,
  type PreviewAnnotationStore,
  type PreviewInteraction,
} from './project-preview';

export type ProjectPreviewPanelProps = {
  controller?: ProjectPreviewController;
  annotations?: PreviewAnnotationStore;
  reason?: string;
  location?: string;
  annotationLocked?: boolean;
  screenshotReason?: string;
  onDismiss(): void;
  onOptions(): void;
  onConnect(serviceId: string, viewport: PreviewViewport): void;
  onClose(): void;
  onCapture(): void;
  onInspect(): void;
  onLocate(x: number, y: number): void;
  onInteract(action: PreviewInteraction): void;
  onSave(note: string, includeImage: boolean): Promise<void>;
  onSelect(id: string, selected: boolean): void;
  onRemove(id: string): void;
  onEdit(id: string, note: string): void;
  onImage(id: string): void;
};
function AnnotationCard(p: {
  item: PreviewAnnotation;
  disabled: boolean;
  screenshotReason?: string;
  onSelect(): void;
  onRemove(): void;
  onEdit(note: string): void;
  onImage(): void;
}) {
  const a = p.item,
    value = a.snapshot,
    [note, setNote] = useState(value.note),
    [editing, setEditing] = useState(false);
  return (
    <article className="preview-annotation-card">
      <strong>
        {value.serviceLabel} · {value.pagePath}
      </strong>
      <small>
        {value.viewport.width} × {value.viewport.height} · {value.capturedAt}
      </small>
      <p>
        {value.element.tagName} · {value.element.name || value.element.role || '未命名元素'}
      </p>
      {editing ? (
        <>
          <label>
            标注说明
            <textarea
              value={note}
              maxLength={PREVIEW_LIMITS.text}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            disabled={p.disabled || !note.trim()}
            onClick={() => {
              p.onEdit(note);
              setEditing(false);
            }}
          >
            保存说明
          </button>
        </>
      ) : (
        <>
          <pre>{value.note}</pre>
          <button disabled={p.disabled} onClick={() => setEditing(true)}>
            编辑说明
          </button>
        </>
      )}
      <button disabled={p.disabled} onClick={p.onSelect}>
        {a.selectionId ? '从本次指令移除标注' : '加入原会话草稿'}
      </button>
      <button disabled={p.disabled} onClick={p.onRemove}>
        删除保存的标注
      </button>
      {value.image && (
        <>
          <details>
            <summary>查看冻结截图</summary>
            <img src={'data:image/png;base64,' + value.image.data} alt="标注保存时的冻结画面" />
          </details>
          <button disabled={p.disabled || !!p.screenshotReason} onClick={p.onImage}>
            将截图作为附件
          </button>
          {p.screenshotReason && <small>{p.screenshotReason}</small>}
        </>
      )}
    </article>
  );
}
export function ProjectPreviewPanel(p: ProjectPreviewPanelProps) {
  const c = p.controller,
    frame = c?.frame,
    element = c?.element,
    [serviceId, setServiceId] = useState(''),
    [viewport, setViewport] = useState<PreviewViewport>({ width: 1280, height: 800 }),
    [path, setPath] = useState('/'),
    [text, setText] = useState(''),
    [replace, setReplace] = useState(true),
    [key, setKey] = useState<Extract<PreviewInteraction, { action: 'key' }>['key']>('Enter'),
    [note, setNote] = useState(''),
    [includeImage, setIncludeImage] = useState(false);
  const blocked = !!(p.reason || !c?.loaded || c.busy || c.loadError),
    canInteract = !blocked && c?.canInteract,
    selectedService = serviceId || c?.options?.services[0]?.id || '',
    annotationBlocked = !!(
      p.annotationLocked ||
      p.annotations?.busy ||
      p.annotations?.loadError ||
      !p.annotations?.loaded
    );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onDismiss()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog project-preview-panel">
          <div className="github-heading">
            <Dialog.Title>项目网页预览</Dialog.Title>
            <button aria-label="关闭网页预览面板" onClick={p.onDismiss}>
              <X size={18} />
            </button>
          </div>
          <Dialog.Description>
            只连接本机为当前目录登记的服务。页面由执行电脑渲染；操作可能改变页面状态，重新连接不会重放操作或运行
            Agent。
          </Dialog.Description>
          {p.location && <p>执行电脑：{p.location}</p>}
          <p>响应式视口不等同于真实手机浏览器。</p>
          {p.reason && <p role="status">{p.reason}</p>}
          {c?.loadError && <p role="alert">{c.loadError}</p>}
          {c?.error && <p role="alert">{c.error}</p>}
          {c?.receipt && (
            <p role="status">
              {c.receipt.closed
                ? '主机已确认连接关闭'
                : c.pending
                  ? '原页面操作等待核查'
                  : c.active
                    ? '预览连接可用'
                    : '连接记录已恢复；请手动读取画面或关闭原连接'}{' '}
              · {c.receipt.message}
            </p>
          )}
          {c?.closing && <p role="status">关闭尚待确认；画面已清除，不会继续交互。</p>}
          {c?.uncertainClosed && (
            <p role="status">此前页面操作的结果仍未知。关闭连接不表示撤销了该操作。</p>
          )}
          <div className="preview-toolbar">
            <button disabled={blocked} onClick={p.onOptions}>
              读取登记的预览服务
            </button>
            <label>
              预览服务
              <select
                value={selectedService}
                disabled={blocked || !!c?.openRequest}
                onChange={(e) => setServiceId(e.target.value)}
              >
                <option value="">选择服务</option>
                {c?.options?.services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              视口
              <select
                value={JSON.stringify(viewport)}
                disabled={blocked}
                onChange={(e) => setViewport(JSON.parse(e.target.value))}
              >
                <option value={JSON.stringify({ width: 1280, height: 800 })}>
                  桌面 1280 × 800
                </option>
                <option value={JSON.stringify({ width: 768, height: 1024 })}>
                  平板 768 × 1024
                </option>
                <option value={JSON.stringify({ width: 390, height: 844 })}>手机 390 × 844</option>
              </select>
            </label>
            <button
              disabled={
                blocked ||
                !!c?.openRequest ||
                !!c?.pending ||
                !selectedService ||
                !c?.options?.available
              }
              onClick={() => p.onConnect(selectedService, viewport)}
            >
              连接预览
            </button>
            <button
              disabled={!canInteract}
              onClick={() => p.onInteract({ action: 'resize', viewport })}
            >
              应用视口
            </button>
            <button disabled={!c?.openRequest} onClick={p.onClose}>
              关闭连接
            </button>
          </div>
          {c?.options?.reason && <p>{c.options.reason}</p>}
          {c?.options && !c.options.services.length && (
            <p>当前目录未登记预览服务，请在执行电脑的 Moor 设置中登记。</p>
          )}
          {c?.pending && (
            <div className="preview-pending">
              <p>原操作已在本地保存。核查只查询结果，不重新执行页面操作。</p>
              <button disabled={blocked} onClick={p.onInspect}>
                核查原预览操作
              </button>
            </div>
          )}
          <div className="preview-toolbar">
            <button
              disabled={
                blocked || !c?.previewId || !c.openRequest || c.closing || c.receipt?.closed
              }
              onClick={p.onCapture}
            >
              重新截图
            </button>
            <button disabled={!canInteract} onClick={() => p.onInteract({ action: 'reload' })}>
              重新载入页面
            </button>
            <label>
              当前服务内路径
              <input
                value={path}
                maxLength={2048}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/"
              />
            </label>
            <button
              disabled={!canInteract}
              onClick={() => p.onInteract({ action: 'navigate', path })}
            >
              前往路径
            </button>
          </div>
          {frame ? (
            <>
              <p>
                {frame.title || '未命名页面'} · {frame.path} · 实际视口 {frame.viewport.width} ×{' '}
                {frame.viewport.height}
                <small>截图时间 {frame.capturedAt}</small>
              </p>
              <p>点击画面定位元素；定位不会点击网页。滚动、输入或点击网页后会读取新的画面。</p>
              <button
                className="preview-frame"
                style={{ width: frame.viewport.width }}
                disabled={blocked || !!c?.pending}
                aria-label="在预览画面定位元素"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (!rect.width || !rect.height) return;
                  p.onLocate(
                    Math.max(
                      0,
                      Math.min(
                        frame.viewport.width - 1,
                        ((e.clientX - rect.left) * frame.viewport.width) / rect.width,
                      ),
                    ),
                    Math.max(
                      0,
                      Math.min(
                        frame.viewport.height - 1,
                        ((e.clientY - rect.top) * frame.viewport.height) / rect.height,
                      ),
                    ),
                  );
                }}
              >
                <img
                  src={'data:image/png;base64,' + frame.image.data}
                  alt="执行电脑的当前网页截图"
                  draggable={false}
                />
                {element && (
                  <span
                    className="preview-element-outline"
                    style={{
                      left: (element.rect.x / frame.viewport.width) * 100 + '%',
                      top: (element.rect.y / frame.viewport.height) * 100 + '%',
                      width: (element.rect.width / frame.viewport.width) * 100 + '%',
                      height: (element.rect.height / frame.viewport.height) * 100 + '%',
                    }}
                  />
                )}
              </button>
              <div className="preview-toolbar">
                <button
                  disabled={!canInteract}
                  onClick={() => p.onLocate(frame.viewport.width / 2, frame.viewport.height / 2)}
                >
                  定位画面中心元素
                </button>
                <button
                  disabled={!canInteract}
                  onClick={() => p.onInteract({ action: 'scroll', deltaX: 0, deltaY: -500 })}
                >
                  向上滚动
                </button>
                <button
                  disabled={!canInteract}
                  onClick={() => p.onInteract({ action: 'scroll', deltaX: 0, deltaY: 500 })}
                >
                  向下滚动
                </button>
                <button
                  disabled={!canInteract}
                  onClick={() => p.onInteract({ action: 'scroll', deltaX: -400, deltaY: 0 })}
                >
                  向左滚动
                </button>
                <button
                  disabled={!canInteract}
                  onClick={() => p.onInteract({ action: 'scroll', deltaX: 400, deltaY: 0 })}
                >
                  向右滚动
                </button>
              </div>
            </>
          ) : (
            <p className="preview-empty">当前没有可交互画面。刷新页面不会自动连接预览。</p>
          )}
          {element && (
            <section className="preview-element">
              <h3>已定位元素</h3>
              <p>
                {element.tag} · {element.role} · {element.name}
              </p>
              <pre>{element.text}</pre>
              <button disabled={!canInteract} onClick={() => p.onInteract({ action: 'click' })}>
                点击所选网页元素
              </button>
              <label>
                输入到网页
                <textarea
                  value={text}
                  maxLength={PREVIEW_LIMITS.text}
                  disabled={!element.editable || element.password}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              {element.password && <p>密码输入框不支持远程文字输入。</p>}
              <label>
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                替换原文字
              </label>
              <button
                disabled={!canInteract || !element.editable || element.password}
                onClick={() => {
                  p.onInteract({ action: 'input', text, replace });
                  setText('');
                }}
              >
                将文字输入网页
              </button>
              <label>
                标注说明
                <textarea
                  value={note}
                  maxLength={PREVIEW_LIMITS.text}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={includeImage}
                  onChange={(e) => setIncludeImage(e.target.checked)}
                />
                在本地标注中保存当前 PNG 截图
              </label>
              <button
                disabled={blocked || annotationBlocked || !!c?.pending || !note.trim()}
                onClick={() =>
                  void p
                    .onSave(note, includeImage)
                    .then(() => setNote((current) => (current === note ? '' : current)))
                    .catch(() => {})
                }
              >
                保存冻结标注
              </button>
            </section>
          )}
          <div className="preview-toolbar">
            <label>
              网页按键
              <select value={key} onChange={(e) => setKey(e.target.value as typeof key)}>
                {[
                  'Enter',
                  'Tab',
                  'Escape',
                  'ArrowUp',
                  'ArrowDown',
                  'ArrowLeft',
                  'ArrowRight',
                  'Backspace',
                  'Delete',
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button disabled={!canInteract} onClick={() => p.onInteract({ action: 'key', key })}>
              发送所选按键
            </button>
          </div>
          <section>
            <h3>原会话的标注草稿</h3>
            <p>
              加入后会显示在输入区卡片中；由你点击普通发送才会交给 Agent。截图附件需要单独添加。
            </p>
            {p.annotations?.loadError && <p role="alert">{p.annotations.loadError}</p>}
            {!p.annotations?.items.length && <p>尚未保存标注。</p>}
            {p.annotations?.items.map((item) => (
              <AnnotationCard
                key={item.id + '/' + item.version}
                item={item}
                disabled={annotationBlocked}
                screenshotReason={p.screenshotReason}
                onSelect={() => p.onSelect(item.id, !item.selectionId)}
                onRemove={() => p.onRemove(item.id)}
                onEdit={(note) => p.onEdit(item.id, note)}
                onImage={() => p.onImage(item.id)}
              />
            ))}
          </section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showProjectPreviewControl(props?: { onOpen(): void; disabled: boolean }) {
  paint(
    '#project-preview-control',
    props ? (
      <button disabled={props.disabled} onClick={props.onOpen}>
        <Monitor size={15} />
        网页预览
      </button>
    ) : null,
  );
}
export function showProjectPreviewPanel(props?: ProjectPreviewPanelProps) {
  paint(
    '#project-preview-view',
    props ? (
      <ProjectPreviewPanel
        key={props.controller ? previewAnnotationKey(props.controller.target) : 'none'}
        {...props}
      />
    ) : null,
  );
}
export function showPreviewAnnotationCards(props?: {
  store: PreviewAnnotationStore;
  disabled: boolean;
  onOpen(): void;
  onRemove(id: string): void;
}) {
  paint(
    '#preview-annotation-cards',
    props?.store.selected.length ? (
      <div className="preview-composer-cards" aria-label="本次指令的网页标注">
        {props.store.selected.map((item) => (
          <div key={item.id}>
            <span>
              {item.snapshot.serviceLabel} · {item.snapshot.pagePath}
            </span>
            <p>{item.snapshot.note}</p>
            <button type="button" disabled={props.disabled} onClick={() => props.onRemove(item.id)}>
              移除本次标注
            </button>
          </div>
        ))}
        <button type="button" onClick={props.onOpen}>
          查看标注草稿
        </button>
      </div>
    ) : null,
  );
}
