import '../styles/utilities.css';
import '../../public/style.css';
import '../features/sessions/workspace-navigation.css';
import '../features/sessions/session-timeline.css';
import '../features/sessions/composer-input.css';
import '../styles/desktop-workspace.css';
import '../features/files/project-content-ui.css';
import '../../public/startup.js';

declare const __MOOR_DEV_PERFORMANCE__: boolean;
if (typeof __MOOR_DEV_PERFORMANCE__ !== 'undefined' && __MOOR_DEV_PERFORMANCE__) {
  void import('../features/performance/performance-panel').then(({ installPerformancePanel }) => {
    const bridge = (
      window as unknown as {
        moorDevPerformance?: {
          version: number;
          sample(): Promise<{ rendererCpuPercent: number | null }>;
        };
      }
    ).moorDevPerformance;
    const dispose = installPerformancePanel({
      sampleCpu: bridge?.version === 1 ? () => bridge.sample() : undefined,
    });
    window.addEventListener('pagehide', dispose, { once: true });
  });
}
