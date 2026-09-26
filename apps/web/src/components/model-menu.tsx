import { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Check, ChevronDown, ChevronRight, ChevronLeft, Cpu } from 'lucide-react';
import type { RunCapabilities, RunSelection } from '@moor/protocol/run-config';
const effortNames: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};
const effortName = (id: string) => effortNames[id] ?? id;

export function ModelMenu({
  capabilities,
  selection,
  existing,
  disabled,
  loading,
  onChange,
  onSaveDefault,
  id,
  compact = false,
}: {
  capabilities?: RunCapabilities;
  selection: RunSelection;
  existing: boolean;
  disabled: boolean;
  loading: boolean;
  onChange(key: keyof RunSelection, value: string): void;
  onSaveDefault?(selection: RunSelection): Promise<unknown>;
  id: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<'modelId' | 'reasoningEffort' | null>(null),
    [defaultState, setDefaultState] = useState<'idle' | 'saving' | 'saved'>('idle'),
    [defaultError, setDefaultError] = useState('');
  const list = useRef<HTMLDivElement>(null),
    parent = useRef<HTMLButtonElement>(null),
    effortParent = useRef<HTMLButtonElement>(null),
    returning = useRef<'modelId' | 'reasoningEffort' | null>(null);
  const models = capabilities?.models ?? [];
  const modelId =
    selection.modelId ||
    (existing
      ? capabilities?.sessionKind === 'loaded'
        ? capabilities.currentModelId
        : undefined
      : capabilities?.defaultModelId);
  const model = models.find((m) => m.id === modelId);
  const effort =
    selection.reasoningEffort ||
    (modelId === capabilities?.currentModelId ? capabilities?.currentReasoningEffort : undefined) ||
    model?.defaultEffort;
  const modelLabel =
    model?.name ??
    (modelId ? modelId + '（不可用）' : undefined) ??
    (loading ? '读取模型…' : compact ? '模型未获取' : '选择模型');
  const effortLabel =
    (effort ? effortName(effort) : undefined) ??
    (model?.efforts.length ? '选择强度' : model ? '不支持推理设置' : '先选模型');
  const items =
    page === 'modelId'
      ? models
      : (model?.efforts ?? []).map((id) => ({ id, name: effortName(id), description: undefined }));
  const back = () => {
    returning.current = page;
    setPage(null);
  };
  useEffect(() => {
    if (!page && returning.current) {
      (returning.current === 'modelId' ? parent : effortParent).current?.focus();
      returning.current = null;
    }
    if (page)
      (
        list.current?.querySelector<HTMLButtonElement>(
          'button[data-choice][aria-pressed="true"]',
        ) ?? list.current?.querySelector<HTMLButtonElement>('button[data-choice]')
      )?.focus();
  }, [page]);
  const choose = (value: string) => {
    if (page) onChange(page, value);
    setOpen(false);
    setPage(null);
  };
  useEffect(() => {
    setDefaultState('idle');
    setDefaultError('');
  }, [modelId, effort]);
  const saveDefault = () => {
    if (!onSaveDefault || !modelId || defaultState === 'saving') return;
    setDefaultState('saving');
    setDefaultError('');
    void onSaveDefault({
      ...selection,
      modelId,
      ...(effort ? { reasoningEffort: effort } : {}),
    })
      .then(() => setDefaultState('saved'))
      .catch((error: unknown) => {
        setDefaultState('idle');
        setDefaultError(error instanceof Error ? error.message : '模型默认值保存失败');
      });
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setPage(null);
      }}
    >
      <Popover.Trigger
        id={id}
        className="picker-trigger model-menu-trigger"
        aria-label="模型与推理强度"
        title={[modelLabel, effort ? effortName(effort) : undefined].filter(Boolean).join(' · ')}
        disabled={disabled}
      >
        <Cpu size={15} />
        <span>
          {modelLabel}
          {effort ? ' · ' + effortName(effort) : ''}
        </span>
        <ChevronDown size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="popup-positioner">
          <Popover.Popup className="menu-popup model-menu" data-page={page ?? 'root'}>
            <div className="model-menu-root">
              <Popover.Title className="menu-label">模型与推理强度</Popover.Title>
              <button
                type="button"
                ref={parent}
                className="model-menu-row"
                aria-expanded={page === 'modelId'}
                onClick={() => setPage('modelId')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    setPage('modelId');
                  }
                }}
              >
                <span>模型</span>
                <span>{modelLabel}</span>
                <ChevronRight size={14} />
              </button>
              <button
                type="button"
                ref={effortParent}
                className="model-menu-row"
                aria-expanded={page === 'reasoningEffort'}
                disabled={!model?.efforts.length}
                onClick={() => setPage('reasoningEffort')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    setPage('reasoningEffort');
                  }
                }}
              >
                <span>推理强度</span>
                <span>{effortLabel}</span>
                <ChevronRight size={14} />
              </button>
              {onSaveDefault && (
                <button
                  type="button"
                  className="model-menu-save"
                  disabled={!model || defaultState === 'saving'}
                  onClick={saveDefault}
                >
                  {defaultState === 'saving'
                    ? '正在保存…'
                    : defaultState === 'saved'
                      ? '已设为新会话默认'
                      : '设为新会话默认'}
                </button>
              )}
              {defaultError && (
                <p className="model-menu-error" role="alert">
                  {defaultError}
                </p>
              )}
            </div>
            {page && (
              <div
                className="model-menu-list"
                ref={list}
                role="group"
                aria-label={page === 'modelId' ? '模型列表' : '推理强度列表'}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    back();
                  }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const buttons = [
                      ...list.current!.querySelectorAll<HTMLButtonElement>('button[data-choice]'),
                    ];
                    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                    buttons[
                      (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
                    ]?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  className="model-menu-back"
                  onClick={() => {
                    back();
                  }}
                >
                  <ChevronLeft size={14} />
                  返回
                </button>
                {!items.length && <p className="muted">暂无可用选项，请在设置中刷新。</p>}
                {items.map((item) => (
                  <button
                    type="button"
                    data-choice
                    key={item.id}
                    className="model-menu-choice"
                    aria-pressed={item.id === (page === 'modelId' ? modelId : effort)}
                    onClick={() => choose(item.id)}
                  >
                    <span>
                      <span>{item.name}</span>
                      {item.description && <small>{item.description}</small>}
                    </span>
                    {item.id === (page === 'modelId' ? modelId : effort) && <Check size={15} />}
                  </button>
                ))}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
