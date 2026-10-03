import type { FileStore } from "./filesystem";
export type WorkspaceId = string;
export interface WorkspaceInfo { id: WorkspaceId; projectId: string; root: ".local"; files: FileStore }
export interface WorkspaceSessionInfo { id: string; workspaceId: WorkspaceId; userId: string; openedAt: number; closedAt?: number }
