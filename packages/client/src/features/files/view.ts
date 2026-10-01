import type {
  ProjectDiffFileResult,
  ProjectDiffReference,
  ProjectTreeResult,
  ProjectTurnDiffResult,
} from '@moor/protocol/project-content-protocol';
import type { FileContentView } from './file-content';
import type { ProjectContentView } from './project-content';

export type ProjectTurnChoice = { id: string; label: string; reference?: ProjectDiffReference };
export type ProjectContentViewState = {
  title: string;
  mode: 'tree' | 'changes';
  busy?: boolean;
  error?: string;
  tree?: ProjectContentView<ProjectTreeResult>;
  currentFile?: Omit<FileContentView, 'bytes'>;
  currentUnavailable?: { path: string; message: string };
  turns: ProjectTurnChoice[];
  turnId?: string;
  diff?: ProjectContentView<ProjectTurnDiffResult>;
  diffFile?: ProjectContentView<ProjectDiffFileResult>;
};
