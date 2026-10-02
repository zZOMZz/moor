import type { AgentConfig } from '../agents/driver';
import type { ProjectSnapshot, ProjectFileTree } from '../files/model';
export interface HostEnvironment {
  uuid(): string;
  now(): number;
  yieldWork(): Promise<void>;
  hash(value: string | Uint8Array): string;
  directory(path: string): {
    path: string;
    dev: bigint;
    ino: bigint;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  };
  programFingerprint(config: AgentConfig): string;
}
export interface HostProjectFiles {
  read(
    rootPath: string,
    path: string,
  ): Promise<{
    bytes: Uint8Array;
    content: {
      version: string;
      byteLength: number;
      mediaType: 'text/plain' | 'application/octet-stream';
    };
  }>;
  capture(rootPath: string): Promise<ProjectSnapshot>;
  tree(rootPath: string): Promise<ProjectFileTree>;
}
