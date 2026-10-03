// React hooks over the live, shell-managed query cache.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { keys } from "@realtime/store";
import type { Message, Profile, Project, StateEntry, Task } from "@realtime/events";
import { getConnState, onConnState } from "@shell/index";
import { listMessages } from "@/lib/api/sync";

const live = { staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
// Data for these keys is written by the shell; the queryFn never runs network.
const fromCache = <T,>(qc: ReturnType<typeof useQueryClient>, key: readonly unknown[], fallback: T) => () => qc.getQueryData<T>(key) ?? fallback;

export function useProjects() {
  const qc = useQueryClient();
  return useQuery<Project[]>({ queryKey: keys.projects, queryFn: fromCache(qc, keys.projects, []), ...live }).data;
}
export function useTasks(projectId: string | undefined) {
  const qc = useQueryClient();
  const all = useQuery<Task[]>({ queryKey: keys.tasks, queryFn: fromCache(qc, keys.tasks, []), ...live }).data;
  return all?.filter((t) => t.projectId === projectId) ?? [];
}
export function useProfile() {
  const qc = useQueryClient();
  return useQuery<Profile | null>({ queryKey: keys.profile, queryFn: fromCache<Profile | null>(qc, keys.profile, null), ...live }).data ?? null;
}
export function useAppState<T>(key: string, fallback: T): T {
  const qc = useQueryClient();
  const all = useQuery<StateEntry[]>({ queryKey: keys.state, queryFn: fromCache(qc, keys.state, []), ...live }).data;
  const hit = all?.find((s) => s.key === key);
  return hit ? (hit.value as T) : fallback;
}
export function useMessages(projectId: string | undefined) {
  const fetchMessages = listMessages;
  return useQuery<Message[]>({
    queryKey: keys.messages(projectId ?? "none"),
    queryFn: () => fetchMessages({ data: { projectId: projectId! } }),
    enabled: !!projectId,
    ...live,
  }).data ?? [];
}
export function useConnectionState() {
  const [s, setS] = useState(getConnState);
  useEffect(() => { const off = onConnState(setS); return () => { off(); }; }, []);
  return s;
}
