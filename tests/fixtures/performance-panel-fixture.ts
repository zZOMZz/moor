import './workspace-layout-fixture';
import { installPerformancePanel } from '../../apps/web/src/features/performance/performance-panel';
import { beginSessionPerformanceRead } from '../../apps/web/src/features/performance/performance-signals';

type SessionMark = ReturnType<typeof beginSessionPerformanceRead>;
const replay = window as unknown as {
  __moorPerformanceReplay(mark: SessionMark): void;
  __moorPerformanceVersion(mark: SessionMark, version: string, expectedVersion: string): void;
};
let cpuReads = 0;
const dispose = installPerformancePanel({
  sampleCpu: async () => {
    cpuReads++;
    return { rendererCpuPercent: 21 };
  },
});
Object.assign(window, {
  __moorPerformanceFixture: {
    cpuReads: () => cpuReads,
    sampling: () => beginSessionPerformanceRead() !== undefined,
    stream() {
      const mark = beginSessionPerformanceRead();
      replay.__moorPerformanceReplay(mark);
      return mark !== undefined;
    },
    version(version: string, received = false, expectedVersion = version) {
      const mark = received ? beginSessionPerformanceRead() : undefined;
      replay.__moorPerformanceVersion(mark, version, expectedVersion);
    },
    dispose,
  },
});
