import type { SkillSource, SkillSummary, SkillIssue } from '@moor/protocol/skills-protocol';
import type { ExecutionLease } from '../git/execution-model';
export type SkillsSourceBinding = {
  id: string;
  label: string;
  rootPath: string;
  rootIdentity: string;
  version: string;
};
export type SkillsReadLease = { sources: SkillsSourceBinding[]; assertCurrent(): void };
export interface SkillsRegistry {
  getSources(lease: ExecutionLease): SkillsSourceBinding[];
  createReadLease(lease: ExecutionLease): SkillsReadLease;
}
export type DiscoveredSkills = {
  sources: SkillSource[];
  skills: SkillSummary[];
  issues: SkillIssue[];
  truncated: boolean;
  documents: Map<string, { skill: SkillSummary; text: string }>;
};
export type SkillDirectory = { source: SkillSource; rootPath: string };
export interface SkillsFiles {
  projectSources(lease: ExecutionLease): SkillDirectory[];
  discover(
    sources: SkillDirectory[],
    options: { assertCurrent(): void },
  ): Promise<DiscoveredSkills>;
  hash(value: string): string;
}
