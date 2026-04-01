import { useState, useEffect, useCallback } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauriRuntime } from "../lib/platform";

type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function UpdateChecker() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  const checkForUpdate = useCallback(async () => {
    if (!isTauriRuntime()) return;

    try {
      setStatus({ kind: "checking" });
      setDismissed(false);
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setStatus({ kind: "available", update });
      } else {
        setStatus({ kind: "idle" });
      }
    } catch (err) {
      console.error("Update check failed:", err);
      setStatus({ kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void checkForUpdate();
  }, [checkForUpdate]);

  const handleDownloadAndInstall = async () => {
    if (status.kind !== "available") return;
    const { update } = status;

    try {
      if (!isTauriRuntime()) return;
      let downloaded = 0;
      let total: number | null = null;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            setStatus({ kind: "downloading", downloaded: 0, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setStatus({ kind: "downloading", downloaded, total });
            break;
          case "Finished":
            setStatus({ kind: "ready" });
            break;
        }
      });

      setStatus({ kind: "ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Update install failed:", err);
      setStatus({ kind: "error", message });
    }
  };

  const handleRelaunch = async () => {
    try {
      if (!isTauriRuntime()) return;
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.error("Relaunch failed:", err);
    }
  };

  if (!isTauriRuntime()) {
    return null;
  }

  if (status.kind === "idle" || status.kind === "checking" || dismissed) {
    return null;
  }

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-md w-full px-4">
      <div className="modal-surface rounded-3xl p-4">
        {status.kind === "available" && (
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--text-strong)]">
                업데이트 उपलब्ध: v{status.update.version}
              </p>
              {status.update.body && (
                <p className="mt-0.5 truncate text-xs text-[var(--text-body)]">
                  {status.update.body}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setDismissed(true)}
                className="btn-base btn-secondary px-3 py-1.5 text-xs font-medium"
              >
                나중에
              </button>
              <button
                onClick={handleDownloadAndInstall}
                className="btn-base btn-primary px-3 py-1.5 text-xs font-medium"
              >
                업데이트
              </button>
            </div>
          </div>
        )}

        {status.kind === "downloading" && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-[var(--text-strong)]">업데이트 다운로드 중...</p>
              <p className="text-xs text-[var(--text-body)]">
                {formatBytes(status.downloaded)}
                {status.total ? ` / ${formatBytes(status.total)}` : ""}
              </p>
            </div>
            <div className="h-2 w-full rounded-full bg-[rgba(224,231,248,0.9)]">
              <div
                className="h-2 rounded-full bg-[linear-gradient(90deg,#8fbbff_0%,#6f82ff_55%,#7f70ff_100%)] transition-all duration-300"
                style={{
                  width:
                    status.total && status.total > 0
                      ? `${Math.min(100, (status.downloaded / status.total) * 100)}%`
                      : "50%",
                }}
              />
            </div>
          </div>
        )}

        {status.kind === "ready" && (
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-[var(--text-strong)]">
              업데이트 준비가 끝났습니다. 다시 시작해 적용하세요.
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setDismissed(true)}
                className="btn-base btn-secondary px-3 py-1.5 text-xs font-medium"
              >
                나중에
              </button>
              <button
                onClick={handleRelaunch}
                className="btn-base btn-primary px-3 py-1.5 text-xs font-medium"
              >
                다시 시작
              </button>
            </div>
          </div>
        )}

        {status.kind === "error" && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-[#c25778]">
              업데이트에 실패했습니다: {status.message}
            </p>
            <button
              onClick={() => setDismissed(true)}
              className="btn-base btn-secondary ml-2 shrink-0 px-3 py-1.5 text-xs font-medium"
            >
              닫기
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
