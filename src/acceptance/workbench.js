(() => {
  'use strict';

  const api = window.moorAcceptance;
  const byId = (id) => document.getElementById(id);
  const elements = {
    rail: document.querySelector('.control-rail'),
    sceneList: byId('scene-list'),
    prepare: byId('prepare-button'),
    reset: byId('reset-button'),
    stop: byId('stop-button'),
    accept: byId('accept-button'),
    feedback: byId('feedback-button'),
    input: byId('feedback-input'),
    status: byId('run-status'),
    stage: byId('run-stage'),
    buildId: byId('build-id'),
    runId: byId('run-id'),
    checks: byId('check-list'),
    decision: byId('decision-status'),
    saved: byId('feedback-saved'),
    error: byId('command-error'),
    announcement: byId('action-announcement'),
    previewHeading: byId('preview-heading'),
    caption: byId('preview-caption'),
    slot: byId('preview-slot'),
    overlay: byId('preview-overlay'),
    overlayHeading: byId('overlay-heading'),
    overlayDescription: byId('overlay-description'),
    overlayStatus: byId('overlay-status'),
    viewport: byId('viewport-size'),
  };
  const statusLabels = {
    preparing: '准备中',
    ready: '可验收',
    failed: '准备失败',
    stopped: '已停止',
  };
  let snapshot = { scenes: [] };
  const feedbackDrafts = new Map();
  let selectedSceneId = null;
  let pendingCommand = null;
  let stopping = false;
  let localError = '';
  let sceneSignature = '';
  let boundsFrame = 0;
  let lastBounds = '';

  function selectedScene() {
    return snapshot.scenes.find((scene) => scene.id === selectedSceneId);
  }

  function activeScene() {
    return snapshot.scenes.find((scene) => scene.id === snapshot.run?.sceneId);
  }

  function text(element, value) {
    element.textContent = value == null ? '' : String(value);
  }

  function reportBounds(force = false) {
    if (!api) return;
    const rect = elements.slot.getBoundingClientRect();
    const bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const encoded = JSON.stringify(bounds);
    if (force || encoded !== lastBounds) {
      lastBounds = encoded;
      api.bounds(bounds);
    }
  }

  function scheduleBounds() {
    if (boundsFrame) return;
    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = 0;
      reportBounds(true);
    });
  }

  function renderScenes() {
    const signature = JSON.stringify(snapshot.scenes);
    if (signature !== sceneSignature) {
      sceneSignature = signature;
      elements.sceneList.replaceChildren();
      snapshot.scenes.forEach((scene, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scene-button';
        button.dataset.sceneId = scene.id;
        button.title = scene.description;
        const number = document.createElement('span');
        number.className = 'scene-number';
        number.setAttribute('aria-hidden', 'true');
        text(number, String(index + 1).padStart(2, '0'));
        const copy = document.createElement('span');
        copy.className = 'scene-copy';
        const title = document.createElement('span');
        title.className = 'scene-title';
        text(title, scene.title);
        const description = document.createElement('span');
        description.className = 'scene-description';
        text(description, scene.description);
        copy.append(title, description);
        const marker = document.createElement('span');
        marker.className = 'scene-selected';
        marker.setAttribute('aria-hidden', 'true');
        button.append(number, copy, marker);
        button.addEventListener('click', () => {
          selectedSceneId = scene.id;
          localError = '';
          render();
        });
        elements.sceneList.append(button);
      });
    }
    for (const button of elements.sceneList.children) {
      button.setAttribute('aria-pressed', String(button.dataset.sceneId === selectedSceneId));
      button.disabled = Boolean(pendingCommand) || snapshot.run?.status === 'preparing';
    }
  }

  function render() {
    renderScenes();
    const run = snapshot.run;
    const scene = selectedScene();
    const displayedScene = activeScene() || scene;
    const preparing = run?.status === 'preparing';
    const ready = run?.status === 'ready';
    const busy = Boolean(pendingCommand) || stopping;
    elements.rail.dataset.hasRun = String(Boolean(run));
    elements.rail.dataset.runState = run?.status || 'idle';
    elements.prepare.disabled = !api || !scene || busy || preparing;
    elements.reset.disabled = !run || busy || preparing;
    elements.stop.disabled = !run || stopping || !['preparing', 'ready'].includes(run.status);
    elements.accept.disabled = !ready || busy || run?.decision === 'accepted';
    elements.feedback.disabled = !ready || busy || !elements.input.value.trim();
    text(elements.prepare, preparing ? '正在准备场景…' : run ? '开始新的验收' : '开始验收');
    text(elements.stop, stopping ? '正在停止…' : '停止运行');
    text(elements.status, statusLabels[run?.status] || '尚未开始');
    elements.status.dataset.status = run?.status || 'idle';
    text(elements.stage, run?.stage || '准备好后，点击开始验收。');
    text(elements.buildId, run?.buildId ? run.buildId.replace(/^sha256:/, '').slice(0, 12) : '—');
    elements.buildId.title = run?.buildId || '';
    text(elements.runId, run?.id ? run.id.slice(0, 8) : '—');
    elements.runId.title = run?.id || '';

    const checkScene = activeScene() || scene;
    elements.checks.replaceChildren();
    for (const check of checkScene?.checks || []) {
      const item = document.createElement('li');
      text(item, check);
      elements.checks.append(item);
    }
    text(
      elements.decision,
      run?.decision === 'accepted'
        ? '已接受'
        : run?.decision === 'changes_requested'
          ? '待修改'
          : '',
    );
    elements.saved.hidden = !run?.feedback;
    text(elements.saved, run?.feedback ? `已记录：${run.feedback}` : '');
    const error = localError || run?.error || snapshot.error || '';
    elements.error.hidden = !error;
    text(elements.error, error);

    const width = Number.isFinite(displayedScene?.width) ? displayedScene.width : 390;
    const height = Number.isFinite(displayedScene?.height) ? displayedScene.height : 740;
    document.documentElement.style.setProperty('--preview-width', `${width}px`);
    document.documentElement.style.setProperty('--preview-height', `${height}px`);
    text(elements.viewport, `${width} × ${height}`);
    text(elements.previewHeading, activeScene()?.title || '场景预览');
    text(elements.caption, run ? statusLabels[run.status] || '' : '等待手动启动');
    elements.overlay.hidden = ready;
    elements.overlay.dataset.status = run?.status || 'idle';
    if (preparing) {
      text(elements.overlayHeading, '正在准备这次验收');
      text(elements.overlayDescription, run.stage || '正在创建本机合成场景。');
      text(elements.overlayStatus, '准备完成后显示界面');
    } else if (run?.status === 'failed') {
      text(elements.overlayHeading, '这次场景没有准备好');
      text(elements.overlayDescription, run.error || run.stage || '可以手动重置场景后再次尝试。');
      text(elements.overlayStatus, '等待手动重试');
    } else if (run?.status === 'stopped') {
      text(elements.overlayHeading, '本次运行已停止');
      text(
        elements.overlayDescription,
        '已有验收结论保留在本机。\n重置场景或开始新的验收后，可以继续操作。',
      );
      text(elements.overlayStatus, '已停止');
    } else {
      text(elements.overlayHeading, '给成果一个确认的时刻');
      text(
        elements.overlayDescription,
        '选择左侧场景并开始验收。\n在这里操作界面，再留下你的判断。',
      );
      text(elements.overlayStatus, '等待开始');
    }
    scheduleBounds();
  }

  function receive(next) {
    if (!next || !Array.isArray(next.scenes)) return;
    const previousRunId = snapshot.run?.id ?? null;
    const nextRunId = next.run?.id ?? null;
    if (previousRunId !== nextRunId) {
      feedbackDrafts.set(previousRunId, elements.input.value);
      elements.input.value = feedbackDrafts.get(nextRunId) ?? '';
    }
    snapshot = next;
    if (!next.scenes.some((scene) => scene.id === selectedSceneId)) {
      selectedSceneId = next.run?.sceneId || next.scenes[0]?.id || null;
    }
    render();
  }

  async function command(input) {
    if (!api || (pendingCommand && input.type !== 'stop') || stopping) return;
    if (input.type === 'stop') stopping = true;
    else pendingCommand = input.type;
    localError = '';
    render();
    try {
      const next = await api.command(input);
      receive(next);
      const hasError = Boolean(next?.error);
      if (!hasError && input.type === 'feedback') {
        text(elements.announcement, '修改意见已记录在本机。');
      } else if (!hasError && input.type === 'accept') {
        text(elements.announcement, '已接受本次运行的版本。');
      }
    } catch (error) {
      localError = error instanceof Error ? error.message : String(error);
    } finally {
      if (input.type === 'stop') stopping = false;
      else pendingCommand = null;
      render();
    }
  }

  elements.prepare.addEventListener('click', () => {
    if (selectedSceneId) void command({ type: 'prepare', sceneId: selectedSceneId });
  });
  elements.reset.addEventListener('click', () => {
    if (snapshot.run) void command({ type: 'reset', runId: snapshot.run.id });
  });
  elements.stop.addEventListener('click', () => {
    if (snapshot.run) void command({ type: 'stop', runId: snapshot.run.id });
  });
  elements.accept.addEventListener('click', () => {
    if (snapshot.run) void command({ type: 'accept', runId: snapshot.run.id });
  });
  elements.feedback.addEventListener('click', () => {
    if (snapshot.run && elements.input.value.trim()) {
      void command({ type: 'feedback', runId: snapshot.run.id, text: elements.input.value.trim() });
    }
  });
  elements.input.addEventListener('input', () => {
    feedbackDrafts.set(snapshot.run?.id ?? null, elements.input.value);
    render();
  });

  if (!api) {
    localError = '验收接口不可用，请从本机 Moor 验收工作台启动。';
    render();
    return;
  }

  const unsubscribe = api.subscribe(receive);
  const observer = new ResizeObserver(scheduleBounds);
  observer.observe(elements.slot);
  observer.observe(document.body);
  window.addEventListener('resize', scheduleBounds);
  document.addEventListener('scroll', scheduleBounds, true);
  window.addEventListener('beforeunload', () => {
    unsubscribe();
    observer.disconnect();
    if (boundsFrame) cancelAnimationFrame(boundsFrame);
  });
  void api
    .snapshot()
    .then(receive)
    .catch((error) => {
      localError = error instanceof Error ? error.message : String(error);
      render();
    });
  render();
})();
