// Fixed, local recipes for the first acceptance prototype. No renderer-authored
// command, selector, URL or script is executable by the host.
export const scenes = [
  {
    id: 'narrow-dialog',
    title: '窄屏弹窗',
    description: '管理工作区已打开，直接检查窄屏下的内容、滚动和按钮。',
    width: 390,
    height: 740,
    checks: ['弹窗内容没有横向溢出', '可以滚动到下方的操作按钮', '点击“完成”后能回到会话'],
  },
  {
    id: 'settings-save',
    title: '设置保存',
    description: '工作区名称已填好，点击保存，再重新打开确认结果。',
    width: 820,
    height: 720,
    checks: [
      '保存名称后，工作区名称随之更新',
      '重新加载后，保存的名称仍然保留',
      '重置现场后恢复初始演示数据',
    ],
  },
  {
    id: 'session-drawer',
    title: '会话抽屉',
    description: '会话抽屉已展开，直接切换会话、搜索，再回到当前任务。',
    width: 390,
    height: 740,
    checks: [
      '会话列表可以滚动和搜索',
      '选择会话后抽屉收起，显示对应内容',
      '再次展开后，选中的会话保持一致',
    ],
  },
] as const;
export type Scene = (typeof scenes)[number];
export type SceneId = Scene['id'];
