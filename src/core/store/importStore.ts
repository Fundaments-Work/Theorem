import { create } from "zustand";

export type ImportStage = "checking" | "copying" | "preparing" | "metadata" | "saving";
export interface NativeImportSnapshot {
    id: string | null;
    active: boolean;
    resumable: boolean;
    total: number;
    completed: number;
    imported: number;
    duplicates: number;
    errors: { source: string; message: string }[];
    current: { name: string; stage: ImportStage | null; completedBytes: number; totalBytes: number | null };
}
interface ImportState {
    snapshot: NativeImportSnapshot | null;
    error: string | null;
    dismissedJobId: string | null;
    setSnapshot: (snapshot: NativeImportSnapshot) => void;
    setError: (error: string | null) => void;
    dismissJob: (jobId: string | null) => void;
}
export const useImportStore = create<ImportState>()((set) => ({
    snapshot: null,
    error: null,
    dismissedJobId: null,
    setSnapshot: (snapshot) => set((state) => ({
        snapshot,
        error: null,
        dismissedJobId:
            snapshot?.id && (snapshot.id !== state.dismissedJobId || snapshot.active)
                ? null
                : state.dismissedJobId,
    })),
    setError: (error) => set({ error }),
    dismissJob: (jobId) => set({ dismissedJobId: jobId }),
}));
