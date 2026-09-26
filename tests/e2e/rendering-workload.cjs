// Test-only renderer workload and instrumentation. No production counters or accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderingFixtureSource = `
import { ClientSessionReplica as BenchmarkReplica } from '@moor/client/session-client';
import { LoroDoc as BenchmarkDoc, Flock as BenchmarkFlock, mirror as benchmarkMirror, delta as benchmarkDelta, putMeta as benchmarkPutMeta, vv as benchmarkVersion } from '@moor/session/model';
import { appendSessionText as benchmarkAppend } from '@moor/session/session-output';
window.__benchCounters={};
window.__benchCount=(name,amount=1)=>{window.__benchCounters[name]=(window.__benchCounters[name]||0)+amount;};
window.__benchLoad=()=>{
 const fence=String.fromCharCode(96).repeat(3);
 const settled=Array.from({length:300},(_,i)=>({id:'settled-'+i,role:i%2?'assistant':'user',finished:true,items:i%2?[
 {type:'text',text:'SETTLED assistant '+i+'\\n\\n'+('Synthetic **review** prose with a link [docs](https://example.invalid/docs). ').repeat(12)},
 {type:'tool_call',toolCallId:'settled-tool-'+i,title:'Read synthetic project '+i,status:'completed',content:[{type:'content',content:{type:'text',text:('Synthetic tool output line '+i+'\\n').repeat(32)}}]},
 {type:'text',text:fence+'ts\\n// SETTLED code '+i+'\\n'+Array.from({length:20},(_,n)=>'export const value'+n+' = '+n+';').join('\\n')+'\\n'+fence}
 ]:[{type:'text',text:'SETTLED user '+i+' '+('Inspect this synthetic project and report useful changes. ').repeat(6)}]}));
 state.session={...state.session,version:'bench-0',history:[...settled,{id:'active-benchmark',role:'assistant',finished:false,items:[
 {type:'text',text:'ACTIVE synthetic assistant output'},
 {type:'tool_call',toolCallId:'active-tool',title:'Active synthetic tool',status:'in_progress',content:[{type:'content',content:{type:'text',text:'ACTIVE tool output'}}]}
 ]}]};
 emit();
};
window.__benchUpdate=(index)=>{
 const next=structuredClone(state.session);
 const active=next.history.at(-1);
 if(index%2===0) active.items[0].text+='\\nACTIVE chunk '+index+': small incremental assistant output';
 else active.items[1].content[0].content.text+='\\nACTIVE tool result '+index;
 next.version='bench-'+(index+1);state.session=next;emit();
};
window.__benchFocus=(turnId)=>{state.focusedTurnId=turnId;emit();};
window.__benchPanelUpdate=index=>{
 const turns=state.session.history;
 state.session={...state.session,version:'panel-'+index,history:turns.map((turn,i)=>i===turns.length-1?{...turn,items:[...turn.items,{type:'text',text:'Panel concurrent update '+index}]}:turn)};emit();
};
const benchmarkFreeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))benchmarkFreeze(child);Object.freeze(value);}return value;};
let benchmarkPermissionTool;
const benchmarkPermissionToolFor=index=>benchmarkFreeze({type:'tool_call',toolCallId:'approval-tool-'+index,title:'Approval display '+index,status:'pending',rawInput:{content:'PERMISSION_PAYLOAD_'+index+' '+('x'.repeat(128*1024))},permissionRequest:{requestId:'approval-request-'+index,options:[{optionId:'allow-'+index,name:'允许本次合成操作 '+index,kind:'allow_once'}]}});
window.__benchPermissionLoad=()=>{
 benchmarkPermissionTool=benchmarkPermissionToolFor(1);
 state.offline=false;state.sessionLoad={status:'ready',source:'host'};
 state.session={...state.session,version:'approval-0',online:true,synced:true,persisted:true,meta:{...state.session.meta,id:state.sessionId,userId:target.userId,machineId:target.machineId,project:{kind:'local',localProjectId:target.localProjectId},latestUserMsgId:'approval-user',lastHandledUserMsgId:'approval-user',status:{type:'working'}},history:[benchmarkFreeze({id:'approval-user',role:'user',finished:true,items:[{type:'text',text:'Review synthetic permission'}]}),{id:'approval-assistant',role:'assistant',userTurnId:'approval-user',finished:false,items:[{type:'text',text:'Approval concurrent stream'},benchmarkPermissionTool]}]};emit();
};
window.__benchPermissionUpdate=index=>{const turns=state.session.history;state.session={...state.session,version:'approval-stream-'+index,history:[turns[0],{...turns[1],items:[{type:'text',text:turns[1].items[0].text+' next '+index},benchmarkPermissionTool]}]};emit();};
window.__benchPermissionOffline=value=>{state.offline=value;state.sessionLoad={status:'ready',source:value?'cache':'host'};state.session={...state.session,online:!value};emit();};
window.__benchPermissionReplace=()=>{benchmarkPermissionTool=benchmarkPermissionToolFor(2);window.__benchPermissionUpdate('replacement');};
controller.respondPermission=async(review,outcome)=>{calls.push('permission:'+review.requestId+':'+outcome.optionId);};
let benchmarkReplica, benchmarkDoc, benchmarkHost, benchmarkResponse;
window.__benchReplicaLoad=()=>{
 window.__benchLoad();state.focusedTurnId=undefined;
 benchmarkDoc=new BenchmarkDoc();benchmarkHost=benchmarkMirror(benchmarkDoc,state.sessionId);
 const history=state.session.history.map(turn=>({...turn,timestamp:'2026-09-26T00:00:00.000Z',userId:undefined,userTurnId:undefined,status:undefined,read:undefined,inputConfig:undefined,fileDiff:null}));
 benchmarkHost.setState(s=>{s.session.id=state.sessionId;s.history=history;});benchmarkDoc.commit();
 const flock=new BenchmarkFlock();benchmarkPutMeta(flock,'session-'+state.sessionId,state.session.meta);
 const base={meta:state.session.meta,metaBundle:flock.exportJson(),agent,synced:true,online:true,persisted:true};
 benchmarkResponse=from=>({...base,update:benchmarkDelta(benchmarkDoc,from)});
 benchmarkReplica=new BenchmarkReplica({...target,sessionId:state.sessionId});
 const response=benchmarkResponse();
 state.session=benchmarkReplica.read(response);emit();
 return {checkpointBytes:new TextEncoder().encode(JSON.stringify(response)).byteLength};
};
window.__benchReplicaUpdate=index=>{
 const before=benchmarkVersion(benchmarkDoc), previous=benchmarkReplica.view;
 benchmarkAppend(benchmarkDoc,state.sessionId,'active-benchmark','text',' REPLICA chunk '+index);
 const response=benchmarkResponse(before),start=performance.now();
 const next=benchmarkReplica.read(response),readMs=performance.now()-start;
 const reused=previous.history.slice(0,300).filter((turn,i)=>turn===next.history[i]).length;
 state.session=next;emit();
 return {readMs,reused,deltaBytes:new TextEncoder().encode(JSON.stringify(response)).byteLength};
};
window.__benchReplicaDispose=()=>{benchmarkReplica.dispose();benchmarkHost.dispose();benchmarkDoc.free();};
window.__benchBehavior=()=>{
 state.focusedTurnId=undefined;
 state.session={...state.session,version:'behavior',history:[{id:'behavior-turn',role:'assistant',finished:false,items:[
  {type:'text',text:'BEFORE operational entries'},
  {type:'tool_call',toolCallId:'closed-first',title:'CLOSED first tool',status:'completed',content:'BODY_TOKEN_FIRST'},
  {type:'thought',text:'BODY_TOKEN_THOUGHT'},
  {type:'text',text:'BETWEEN completed and live entries'},
  {type:'tool_call',toolCallId:'live-tool',title:'RUNNING tool',status:'in_progress',content:'BODY_TOKEN_RUNNING'},
  {type:'tool_call',toolCallId:'failed-tool',title:'FAILED tool',status:'failed',content:'BODY_TOKEN_FAILED'},
  {type:'tool_call',toolCallId:'approval-tool',title:'APPROVAL tool',status:'pending',permissionRequest:{},content:'BODY_TOKEN_APPROVAL'},
  {type:'text',text:'AFTER operational entries'}
 ]}]};emit();
};
`;

const renderingInstrumentation = {
  name: 'synthetic-render-work-counters',
  setup(b) {
    b.onLoad(
      {
        filter:
          /\/(?:content\.ts|project-content\.ts|permission-review\.ts|streaming-markdown\.tsx|workspace-app\.tsx|composer-input\.tsx|client-session-replica\.ts)$/,
      },
      ({ path: file }) => {
        let code = fs.readFileSync(file, 'utf8');
        const inject = (needle, replacement) => {
          if (!code.includes(needle))
            throw Error('Instrumentation anchor changed: ' + file + ' ' + needle);
          code = code.replace(needle, replacement);
        };
        if (file.endsWith('/components/content.ts')) {
          inject(
            'export function markdown(text: string): string {',
            `export function markdown(text: string): string { globalThis.__benchCount?.('markdownCalls');globalThis.__benchCount?.('markdownChars',text.length);if(text.includes('SETTLED')){globalThis.__benchCount?.('settledMarkdownCalls');globalThis.__benchCount?.('settledMarkdownChars',text.length);}`,
          );
          inject(
            "export function codeBlock(text: string, label = '代码'): string {",
            `export function codeBlock(text: string, label = '代码'): string {globalThis.__benchCount?.('codeBlockCalls');`,
          );
          if (code.includes('export function plainCode(text: string): string {'))
            inject(
              'export function plainCode(text: string): string {',
              `export function plainCode(text: string): string {globalThis.__benchCount?.('plainCodeCalls');globalThis.__benchCount?.('plainCodeChars',text.length);`,
            );
        }
        if (file.endsWith('/streaming-markdown.tsx')) {
          inject(
            'function line(state: Cursor, text: string): Cursor {',
            `function line(state: Cursor, text: string): Cursor {globalThis.__benchCount?.('parsedLines');globalThis.__benchCount?.('parsedLineChars',text.length);`,
          );
          inject(
            'function update(previous: Document | undefined, source: string): Document {',
            `function update(previous: Document | undefined, source: string): Document {globalThis.__benchCount?.('streamingUpdates');if(source.includes('SETTLED'))globalThis.__benchCount?.('settledStreamingUpdates');`,
          );
        }
        if (file.endsWith('/project-content.ts'))
          inject(
            'export function compareTextLines(before: string, after: string): DiffLine[] | undefined {',
            `export function compareTextLines(before: string, after: string): DiffLine[] | undefined {globalThis.__benchCount?.('fileDiffComparisons');`,
          );
        if (file.endsWith('/permission-review.ts'))
          inject(
            'const result = JSON.stringify(visit(input, 0));',
            `globalThis.__benchCount?.('permissionItemSerializations'); const result = JSON.stringify(visit(input, 0));`,
          );
        if (file.endsWith('/workspace-app.tsx')) {
          inject(
            'function readable(value: unknown) {',
            `function readable(value: unknown) {if(value && typeof value==='object' && value.type==='tool_call'){globalThis.__benchCount?.('toolSerializations'); if(String(value.toolCallId).startsWith('settled')) globalThis.__benchCount?.('settledToolSerializations');}`,
          );
          inject(
            '    sessionPerformanceCommitted(',
            `    globalThis.__benchSessionCommit?.(); sessionPerformanceCommitted(`,
          );
        }
        if (file.endsWith('/composer-input.tsx'))
          inject(
            'inputPerformanceCommitted(input.current);',
            `inputPerformanceCommitted(input.current);globalThis.__benchInputCommit?.();`,
          );
        if (file.endsWith('/client-session-replica.ts')) {
          inject(
            'const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};',
            `globalThis.__benchCount?.('projectedObjects'); const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};`,
          );
          inject(
            'exportSnapshot(): ReturnType<typeof readClientSession> {',
            `exportSnapshot(): ReturnType<typeof readClientSession> { globalThis.__benchCount?.('fullExports');`,
          );
        }
        return { contents: code, loader: file.endsWith('.tsx') ? 'tsx' : 'ts' };
      },
    );
  },
};

async function runRenderingWorkload(win, output) {
  const read = (expression) => win.webContents.executeJavaScript(expression);
  // document.hidden can be false with backgroundThrottling disabled even when
  // the native window is hidden. Both must be visible for compositor frame waits.
  assert.equal(win.isVisible(), true, 'rendering workload requires a visible native window');
  assert.equal(
    await read('document.hidden'),
    false,
    'rendering workload requires foreground frames',
  );
  const frames = () =>
    read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const commit = (kind, index) =>
    read(`new Promise(resolve => {
    const started = performance.now();
    window.__bench${kind === 'input' ? 'Input' : 'Session'}Commit = () => {
      window.__bench${kind === 'input' ? 'Input' : 'Session'}Commit = undefined;
      resolve(performance.now() - started);
    };
    ${
      kind === 'input'
        ? `
      const field = document.querySelector('[aria-label="消息"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Synthetic draft ' + ${index});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    `
        : `window.__bench${kind === 'panel' ? 'PanelUpdate' : kind === 'permission' ? 'PermissionUpdate' : 'Update'}(${JSON.stringify(index)});`
    }
  })`);
  let guard;
  const result = await Promise.race([
    (async () => {
      await read('window.__benchCounters = {}; window.__benchLoad()');
      await frames();
      const initial = await read('window.__benchCounters');
      assert(
        (initial.markdownCalls > 0 && initial.codeBlockCalls > 0) ||
          (initial.parsedLines > 0 && initial.plainCodeCalls > 0),
        'instrumentation must observe actual initial text and code rendering',
      );
      await commit('input', -1);
      await frames();
      const report = {
        environment: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          build: 'minified production React, synthetic controller',
          browser: await read(
            '({dpr: devicePixelRatio, hidden: document.hidden, width: innerWidth, height: innerHeight})',
          ),
        },
        workload: {
          settledTurns: 300,
          activeTurns: 1,
          inputEvents: 30,
          updates: 30,
          cloneSnapshotOnUpdate: true,
        },
        stages: {},
      };
      for (const kind of ['input', 'stream']) {
        await read('window.__benchCounters = {}');
        const samples = [];
        for (let index = 0; index < 30; index++) {
          samples.push(await commit(kind, index));
          await frames();
        }
        const sorted = [...samples].sort((a, b) => a - b);
        const counts = await read('window.__benchCounters');
        report.stages[kind] = {
          counts,
          commitObservedMs: {
            p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
            p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
            samples,
          },
        };
        // Stable operation counts are regression guards. Wall-clock timings are
        // observations only and never decide whether this test passes.
        assert.equal(
          counts.settledMarkdownCalls ?? 0,
          0,
          `${kind} must not reparse settled messages`,
        );
        assert.equal(
          counts.settledToolSerializations ?? 0,
          0,
          `${kind} must not serialize closed settled tool results`,
        );
        assert.equal(counts.codeBlockCalls ?? 0, 0, `${kind} must not rebuild settled code blocks`);
        assert.equal(
          counts.settledStreamingUpdates ?? 0,
          0,
          `${kind} must not revisit settled streaming Markdown`,
        );
        assert.equal(counts.plainCodeCalls ?? 0, 0, `${kind} must not reconvert settled code`);
      }
      report.final = await read(`({
        turns: document.querySelectorAll('.workspace-turn').length,
        activeText: document.querySelector('[data-turn-id="active-benchmark"]').textContent,
        input: document.querySelector('[aria-label="消息"]').value
      })`);
      assert.equal(report.final.turns, 301);
      assert.match(report.final.activeText, /ACTIVE chunk 28/);
      assert.match(report.final.activeText, /Active synthetic tool/);
      await read(
        `document.querySelector('[data-turn-id="active-benchmark"] details > summary').click()`,
      );
      await frames();
      assert.match(
        await read(`document.querySelector('[data-turn-id="active-benchmark"]').textContent`),
        /ACTIVE tool result 29/,
      );
      assert.equal(report.final.input, 'Synthetic draft 29');
      fs.writeFileSync(
        path.join(output, 'rendering-comparison.json'),
        JSON.stringify(report, null, 2),
      );
      fs.writeFileSync(
        path.join(output, 'rendering-workload.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      const until = (expression) =>
        read(`new Promise(resolve => {
        const check = () => ${expression} ? resolve() : requestAnimationFrame(check); check();
      })`);
      await read(`window.__benchFocus('settled-100')`);
      await until(`document.activeElement?.dataset.turnId === 'settled-100'`);
      await frames();
      const readingTop = await read(`document.querySelector('.workspace-history').scrollTop`);
      await read(`window.__benchUpdate(30)`);
      await frames();
      assert.equal(
        await read(`document.querySelector('.workspace-history').scrollTop`),
        readingTop,
        'an incremental update preserves the focused historical turn',
      );
      await read(`document.querySelector('.session-jump-latest').click()`);
      await until(
        `(() => { const node=document.querySelector('.workspace-history'); return node.scrollHeight-node.scrollTop-node.clientHeight < 2; })()`,
      );
      const replicaInitial = await read('window.__benchReplicaLoad()');
      await frames();
      await read('window.__benchCounters = {}');
      const replicaSamples = [];
      for (let index = 0; index < 30; index++) {
        replicaSamples.push(
          await read(`new Promise(resolve => {
          const start=performance.now();let result;
          window.__benchSessionCommit=()=>{window.__benchSessionCommit=undefined;resolve({...result,commitObservedMs:performance.now()-start});};
          result=window.__benchReplicaUpdate(${index});
        })`),
        );
        await frames();
      }
      const replicaCounts = await read('window.__benchCounters');
      assert.equal(replicaCounts.settledMarkdownCalls ?? 0, 0);
      assert.equal(replicaCounts.settledToolSerializations ?? 0, 0);
      assert.equal(replicaCounts.codeBlockCalls ?? 0, 0);
      assert.equal(replicaCounts.settledStreamingUpdates ?? 0, 0);
      assert.equal(replicaCounts.plainCodeCalls ?? 0, 0);
      assert.equal(
        replicaCounts.fullExports ?? 0,
        0,
        'streaming imports never export a full snapshot',
      );
      assert.ok(replicaCounts.projectedObjects > 0, 'actual replica projection is instrumented');
      for (const sample of replicaSamples) {
        assert.equal(sample.reused, 300, 'every settled turn preserves its frozen object identity');
        assert.ok(
          sample.deltaBytes < replicaInitial.checkpointBytes / 10,
          'the actual wire update is incremental',
        );
      }
      assert.match(
        await read(`document.querySelector('[data-turn-id="active-benchmark"]').textContent`),
        /REPLICA chunk 29/,
      );
      const percentile = (key, fraction) =>
        replicaSamples.map((sample) => sample[key]).sort((a, b) => a - b)[
          Math.ceil(replicaSamples.length * fraction) - 1
        ];
      report.stages.replicaStream = {
        checkpointBytes: replicaInitial.checkpointBytes,
        counts: replicaCounts,
        readMs: { p50: percentile('readMs', 0.5), p95: percentile('readMs', 0.95) },
        commitObservedMs: {
          p50: percentile('commitObservedMs', 0.5),
          p95: percentile('commitObservedMs', 0.95),
        },
        samples: replicaSamples,
      };
      fs.writeFileSync(
        path.join(output, 'rendering-comparison.json'),
        JSON.stringify(report, null, 2),
      );
      await read('window.__benchReplicaDispose()');
      if (initial.parsedLines) {
        await read('window.__moorFixture.fileChanges(1)');
        await frames();
        for (const mode of ['markdown', 'diff']) {
          await read(
            `document.querySelector('[aria-label="${mode === 'markdown' ? '项目文件' : '查看文件变更'}"]').click()`,
          );
          if (mode === 'markdown') {
            await until(`document.querySelector('[aria-label="查看文件：README.md"]')`);
            await read(`document.querySelector('[aria-label="查看文件：README.md"]').click()`);
          }
          await until(
            `document.querySelector('${mode === 'markdown' ? '.project-markdown' : '.project-lines'}') && !document.querySelector('.project-loading')`,
          );
          await frames();
          const initialPanel = await read('window.__benchCounters');
          assert(
            (mode === 'markdown' ? initialPanel.markdownCalls : initialPanel.fileDiffComparisons) >
              0,
            'panel instrumentation observes initial ' + mode,
          );
          await read('window.__benchCounters = {}');
          for (let index = 0; index < 10; index++) {
            await commit('input', index);
            await commit('panel', mode + '-' + index);
            await frames();
          }
          const counts = await read('window.__benchCounters');
          assert.equal(
            counts.markdownCalls ?? 0,
            0,
            'concurrent draft/stream does not rebuild a stable file preview',
          );
          assert.equal(
            counts.fileDiffComparisons ?? 0,
            0,
            'concurrent draft/stream does not recompute a stable diff',
          );
          report.stages[mode + 'Panel'] = { counts, inputEvents: 10, updates: 10 };
          await read(`document.querySelector('[aria-label="关闭文件与变更"]').click()`);
          await until(`!document.querySelector('.project-content-docked')`);
        }
        fs.writeFileSync(
          path.join(output, 'rendering-comparison.json'),
          JSON.stringify(report, null, 2),
        );
      }
      await read('window.__benchCounters = {}; window.__benchPermissionLoad()');
      await until(
        `document.querySelector('.workspace-permission pre')?.textContent.includes('PERMISSION_PAYLOAD_1')`,
      );
      const permissionInitial = await read('window.__benchCounters');
      assert.equal(
        permissionInitial.permissionItemSerializations,
        1,
        'deeply frozen permission contents serialize once across both approval consumers',
      );
      assert.equal(
        permissionInitial.toolSerializations,
        1,
        'display formats the initial approval once',
      );
      await read('window.__benchCounters = {}');
      for (let index = 0; index < 10; index++) {
        await commit('input', index);
        await commit('permission', index);
        await frames();
      }
      const permissionCounts = await read('window.__benchCounters');
      assert.equal(
        permissionCounts.permissionItemSerializations ?? 0,
        0,
        'unchanged frozen permission contents do not serialize on concurrent updates',
      );
      assert.equal(
        permissionCounts.toolSerializations ?? 0,
        0,
        'unchanged permission display does not parse and pretty-print on concurrent updates',
      );
      const approvalButton = `[...document.querySelectorAll('.workspace-permission button')].find(node=>node.textContent==='允许本次合成操作 1')`;
      assert.equal(await read(`${approvalButton}.disabled`), false);
      await read('window.__benchPermissionOffline(true)');
      await frames();
      assert.equal(
        await read(`${approvalButton}.disabled`),
        true,
        'offline approval remains disabled despite cached display',
      );
      await read('window.__benchPermissionOffline(false)');
      await frames();
      assert.equal(await read(`${approvalButton}.disabled`), false);
      await read('window.__benchPermissionReplace()');
      await until(
        `document.querySelector('.workspace-permission pre')?.textContent.includes('PERMISSION_PAYLOAD_2')`,
      );
      assert.equal(
        await read(`!!${approvalButton}`),
        false,
        'a new request replaces the old choices',
      );
      await read(
        `[...document.querySelectorAll('.workspace-permission button')].find(node=>node.textContent==='允许本次合成操作 2').click()`,
      );
      await until(`window.__moorFixture.calls.includes('permission:approval-request-2:allow-2')`);
      report.stages.permissionDisplay = {
        initialCounts: permissionInitial,
        counts: permissionCounts,
        inputEvents: 10,
        updates: 10,
        payloadBytes: 128 * 1024,
      };
      fs.writeFileSync(
        path.join(output, 'rendering-comparison.json'),
        JSON.stringify(report, null, 2),
      );
      await read('window.__benchBehavior()');
      await frames();
      const article = `document.querySelector('[data-turn-id="behavior-turn"]')`;
      assert.equal(await read(`${article}.querySelectorAll('.session-tool-details').length`), 1);
      assert.equal(
        await read(`!!${article}.querySelector('.session-tool-content')`),
        false,
        'closed completed tools do not mount their body',
      );
      for (const title of ['RUNNING tool', 'FAILED tool', 'APPROVAL tool']) {
        assert.equal(
          await read(
            `(() => {const node=[...${article}.querySelectorAll('summary')].find(node=>node.textContent===${JSON.stringify(title)});return !!node && !node.closest('.session-tool-details') && node.getBoundingClientRect().height>0;})()`,
          ),
          true,
          title + ' stays outside the collapsed group',
        );
      }
      await read(`${article}.querySelector('.session-tool-details > summary').click()`);
      await until(`${article}.querySelector('.session-tool-content details > summary')`);
      assert.equal(
        await read(`${article}.textContent.includes('BODY_TOKEN_FIRST')`),
        false,
        'outer group expansion keeps individual payloads lazy',
      );
      await read(
        `[...${article}.querySelectorAll('.session-tool-content details > summary')].forEach(node=>node.click())`,
      );
      await until(`${article}.textContent.includes('BODY_TOKEN_FIRST')`);
      const order = await read(`${article}.textContent`);
      assert(order.indexOf('BEFORE') < order.indexOf('BODY_TOKEN_FIRST'));
      assert(order.indexOf('BODY_TOKEN_FIRST') < order.indexOf('BETWEEN'));
      assert(order.indexOf('BETWEEN') < order.indexOf('AFTER'));
      assert.match(order, /BODY_TOKEN_THOUGHT/);
      await read(`${article}.querySelector('.session-tool-details > summary').click()`);
      await until(`!${article}.querySelector('.session-tool-content')`);
      assert.equal(
        await read(`${article}.textContent.includes('BODY_TOKEN_FIRST')`),
        false,
        'collapsing unmounts the expensive tool body',
      );
      return report;
    })(),
    new Promise((_, reject) => {
      guard = setTimeout(() => reject(Error('Synthetic rendering workload did not commit')), 30000);
    }),
  ]).finally(() => clearTimeout(guard));
  return result;
}

module.exports = { renderingFixtureSource, renderingInstrumentation, runRenderingWorkload };
