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
import { SkillsPanel } from './skills-ui';
import { SecureSkillsController, type SecureSkillsDependencies } from './secure-skills';

export type SecureSkillsUiHandle = {
  open(expectedTarget: SecureCliTarget): Promise<void>;
  close(): void;
};

/** This component owns only ephemeral Skills content, with no storage or legacy HTTP transport. */
export const SecureSkillsUI = forwardRef<SecureSkillsUiHandle, SecureSkillsDependencies>(
  function SecureSkillsUI(props, ref) {
    const latest = useRef(props);
    latest.current = props;
    const controller = useMemo(
      () =>
        new SecureSkillsController({
          context: () => latest.current.context(),
          request: (...args) => latest.current.request(...args),
          appendInstruction: (...args) => latest.current.appendInstruction(...args),
        }),
      [],
    );
    const [, render] = useState(0);
    useLayoutEffect(() => controller.subscribe(() => render((value) => value + 1)), [controller]);
    const contextKey = productCanonicalJson(props.context());
    useLayoutEffect(() => controller.sync(), [controller, contextKey]);
    useEffect(() => () => controller.dispose(), [controller]);
    useImperativeHandle(
      ref,
      () => ({ open: (target) => controller.open(target), close: () => controller.close() }),
      [controller],
    );
    const state = controller.state;
    if (!state) return null;
    // Capture exactly what this render presents; old button callbacks cannot select a newer body.
    const catalog = structuredClone(state.controller.list),
      detail = structuredClone(state.controller.detail);
    const run = (operation: () => Promise<void>) => {
      void operation().catch(() => {
        // The scoped controller owns the error; stale work has no visible destination.
      });
    };
    return (
      <SkillsPanel
        key={productCanonicalJson(state.target)}
        controller={state.controller}
        canAdd={!!detail}
        adding={state.adding}
        onClose={() => controller.close()}
        onRefresh={() => run(() => controller.refresh())}
        onSelect={(id) => catalog && run(() => controller.select(id, catalog, state.review))}
        onAdd={() => detail && run(() => controller.add(detail, state.review))}
      />
    );
  },
);
