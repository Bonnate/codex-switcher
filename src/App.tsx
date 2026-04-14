import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAccounts } from "./hooks/useAccounts";
import { AccountCard, AddAccountModal, UpdateChecker } from "./components";
import type {
  CodexProcessInfo,
  LoadBalancerSettings,
  LoadBalancerStatus,
} from "./types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  invokeBackend,
  sendSystemNotification,
} from "./lib/platform";
import "./App.css";

const APP_VERSION = __APP_VERSION__;

function parseLocalDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatAccountExpirationBadge(value: string | null | undefined): string | null {
  const targetDate = parseLocalDateOnly(value);
  if (!targetDate) return null;

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffMs = targetDate.getTime() - todayStart.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays > 0) return `${diffDays}일 후 만료`;
  if (diffDays === 0) return "오늘 만료";
  return "만료됨";
}

function isEligibleForLoadBalancer(
  usage:
    | {
        error?: string | null;
        primary_used_percent?: number | null;
        secondary_used_percent?: number | null;
      }
    | null
    | undefined
): boolean {
  if (!usage || usage.error) return false;

  const primaryUsed = usage.primary_used_percent;
  if (primaryUsed === null || primaryUsed === undefined) return false;

  const primaryRemaining = Math.max(0, 100 - primaryUsed);
  if (primaryRemaining <= 5) return false;

  const secondaryUsed = usage.secondary_used_percent;
  if (secondaryUsed !== null && secondaryUsed !== undefined) {
    const secondaryRemaining = Math.max(0, 100 - secondaryUsed);
    if (secondaryRemaining <= 0) return false;
  }

  return true;
}

function defaultLoadBalancerSettings(): LoadBalancerSettings {
  return {
    enabled: false,
    host: "127.0.0.1",
    port: 2461,
    strategy: "highest_remaining",
    apply_codex_config: true,
  };
}

function normalizeLoadBalancerSettings(settings: LoadBalancerSettings): LoadBalancerSettings {
  const parsedPort = Number(settings.port);
  const safePort = Number.isFinite(parsedPort)
    ? Math.min(65535, Math.max(1, Math.round(parsedPort)))
    : 2461;

  return {
    enabled: Boolean(settings.enabled),
    host: settings.host?.trim() || "127.0.0.1",
    port: safePort,
    strategy: settings.strategy ?? "highest_remaining",
    apply_codex_config:
      typeof settings.apply_codex_config === "boolean" ? settings.apply_codex_config : true,
  };
}

function App() {
  const {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    setAccountExpiration,
    setAccountLoadBalancerPriority,
    importFromFile,
    exportAccountsSlimText,
    importAccountsSlimText,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  } = useAccounts();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [isLoadBalancerModalOpen, setIsLoadBalancerModalOpen] = useState(false);
  const [isAccountManagerOpen, setIsAccountManagerOpen] = useState(false);
  const [configModalMode, setConfigModalMode] = useState<"slim_export" | "slim_import">(
    "slim_export"
  );
  const [configPayload, setConfigPayload] = useState("");
  const [configModalError, setConfigModalError] = useState<string | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [draftLoadBalancerSettings, setDraftLoadBalancerSettings] = useState<LoadBalancerSettings>(
    defaultLoadBalancerSettings()
  );
  const [loadBalancerStatus, setLoadBalancerStatus] = useState<LoadBalancerStatus | null>(null);
  const [isLoadBalancerSaving, setIsLoadBalancerSaving] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [processInfo, setProcessInfo] = useState<CodexProcessInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExportingSlim, setIsExportingSlim] = useState(false);
  const [isImportingSlim, setIsImportingSlim] = useState(false);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isWarmingAll, setIsWarmingAll] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [warmupToast, setWarmupToast] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [otherAccountsSort, setOtherAccountsSort] = useState<
    "deadline_asc" | "deadline_desc" | "remaining_desc" | "remaining_asc"
  >("deadline_asc");
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [manageDeleteConfirmId, setManageDeleteConfirmId] = useState<string | null>(null);
  const [manageDeleteBusyId, setManageDeleteBusyId] = useState<string | null>(null);
  const [manageRenameEditId, setManageRenameEditId] = useState<string | null>(null);
  const [manageRenameDraft, setManageRenameDraft] = useState("");
  const [manageRenameBusyId, setManageRenameBusyId] = useState<string | null>(null);
  const [manageExpirationEditId, setManageExpirationEditId] = useState<string | null>(null);
  const [manageExpirationDraft, setManageExpirationDraft] = useState("");
  const [manageExpirationBusyId, setManageExpirationBusyId] = useState<string | null>(null);
  const [managePriorityEditId, setManagePriorityEditId] = useState<string | null>(null);
  const [managePriorityDraft, setManagePriorityDraft] = useState("0");
  const [managePriorityBusyId, setManagePriorityBusyId] = useState<string | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const previousLoadBalancerPriorityRef = useRef<number | null | undefined>(undefined);
  const previousLoadBalancerRunningRef = useRef<boolean | undefined>(undefined);

  const showWarmupToast = useCallback((message: string, isError = false) => {
    setWarmupToast({ message, isError });
    window.setTimeout(() => setWarmupToast(null), 2500);
  }, []);

  const toggleMask = (accountId: string) => {
    setMaskedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const allMasked =
    accounts.length > 0 && accounts.every((account) => maskedAccounts.has(account.id));

  const toggleMaskAll = () => {
    setMaskedAccounts((prev) => {
      const shouldMaskAll = !accounts.every((account) => prev.has(account.id));
      const next = shouldMaskAll
        ? new Set(accounts.map((account) => account.id))
        : new Set<string>();
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const checkProcesses = useCallback(async () => {
    try {
      const info = await invokeBackend<CodexProcessInfo>("check_codex_processes");
      setProcessInfo(info);
    } catch (err) {
      console.error("Failed to check processes:", err);
    }
  }, []);

  const loadLoadBalancerStatus = useCallback(async () => {
    try {
      const status = await invokeBackend<LoadBalancerStatus>("get_load_balancer_status");
      setLoadBalancerStatus(status);
      setDraftLoadBalancerSettings(normalizeLoadBalancerSettings(status.settings));
      return status;
    } catch (err) {
      console.error("Failed to load load balancer status:", err);
      throw err;
    }
  }, []);

  const persistLoadBalancerSettings = useCallback(async () => {
    try {
      setIsLoadBalancerSaving(true);
      const normalized = normalizeLoadBalancerSettings(draftLoadBalancerSettings);
      const status = await invokeBackend<LoadBalancerStatus>("save_load_balancer_settings", {
        settings: normalized,
      });
      setLoadBalancerStatus(status);
      setDraftLoadBalancerSettings(normalizeLoadBalancerSettings(status.settings));
      setIsLoadBalancerModalOpen(false);
      showWarmupToast(
        status.running
          ? `로드밸런서를 시작했습니다. ${status.eligible_account_count}개 계정이 풀에 포함됩니다.`
          : "로드밸런서를 중지했습니다."
      );
    } catch (err) {
      console.error("Failed to save load balancer settings:", err);
      showWarmupToast(
        `로드밸런서 설정 저장 실패: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      setIsLoadBalancerSaving(false);
    }
  }, [draftLoadBalancerSettings, showWarmupToast]);

  useEffect(() => {
    checkProcesses();
    const interval = setInterval(checkProcesses, 3000);
    return () => clearInterval(interval);
  }, [checkProcesses]);

  useEffect(() => {
    void loadLoadBalancerStatus().catch(() => {});
    const interval = window.setInterval(() => {
      void loadLoadBalancerStatus().catch(() => {});
    }, 5000);
    return () => window.clearInterval(interval);
  }, [loadLoadBalancerStatus]);

  useEffect(() => {
    loadMaskedAccountIds().then((ids) => {
      if (ids.length > 0) {
        setMaskedAccounts(new Set(ids));
      }
    });
  }, [loadMaskedAccountIds]);

  useEffect(() => {
    if (!isActionsMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!actionsMenuRef.current) return;
      if (!actionsMenuRef.current.contains(event.target as Node)) {
        setIsActionsMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isActionsMenuOpen]);

  useEffect(() => {
    const previousRunning = previousLoadBalancerRunningRef.current;
    const previousPriority = previousLoadBalancerPriorityRef.current;
    const nextRunning = Boolean(loadBalancerStatus?.running);
    const nextPriority = loadBalancerStatus?.active_priority ?? null;

    if (previousRunning === undefined) {
      previousLoadBalancerRunningRef.current = nextRunning;
      previousLoadBalancerPriorityRef.current = nextPriority;
      return;
    }

    const priorityChanged = previousPriority !== nextPriority;
    const shouldNotify = previousRunning && nextRunning && priorityChanged;

    if (shouldNotify) {
      let body = `로드밸런서가 우선순위 P${nextPriority ?? 0} 그룹으로 전환되었습니다.`;

      if (previousPriority !== undefined && previousPriority !== null && nextPriority !== null) {
        body =
          nextPriority > previousPriority
            ? `우선순위 P${previousPriority} 그룹이 모두 제외되어 P${nextPriority} 그룹으로 전환되었습니다.`
            : `상위 우선순위 P${nextPriority} 그룹이 다시 사용 가능해져 자동 복귀했습니다.`;
      }

      void sendSystemNotification("Codex Switcher 로드밸런서", body).then((delivered) => {
        if (!delivered) {
          showWarmupToast(body);
        }
      });
    }

    previousLoadBalancerRunningRef.current = nextRunning;
    previousLoadBalancerPriorityRef.current = nextPriority;
  }, [loadBalancerStatus, showWarmupToast]);

  const handleSwitch = async (accountId: string) => {
    await checkProcesses();
    if (processInfo && !processInfo.can_switch) {
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
      void loadLoadBalancerStatus().catch(() => {});
    } catch (err) {
      console.error("Failed to switch account:", err);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleDelete = async (accountId: string) => {
    if (deleteConfirmId !== accountId) {
      setDeleteConfirmId(accountId);
      window.setTimeout(() => setDeleteConfirmId(null), 3000);
      return;
    }

    try {
      await deleteAccount(accountId);
      setDeleteConfirmId(null);
      void loadLoadBalancerStatus().catch(() => {});
    } catch (err) {
      console.error("Failed to delete account:", err);
    }
  };

  const handleManagedDelete = async (accountId: string) => {
    try {
      setManageDeleteBusyId(accountId);
      await deleteAccount(accountId);
      setManageDeleteConfirmId(null);
      showWarmupToast("계정을 제거했습니다.");
      void loadLoadBalancerStatus().catch(() => {});
    } catch (err) {
      console.error("Failed to delete account from manager:", err);
      showWarmupToast(
        `계정 제거 실패: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      setManageDeleteBusyId(null);
    }
  };

  const openManageRenameEditor = (accountId: string, currentName: string) => {
    setManageDeleteConfirmId(null);
    closeManageExpirationEditor();
    closeManagePriorityEditor();
    setManageRenameEditId(accountId);
    setManageRenameDraft(currentName);
  };

  const closeManageRenameEditor = () => {
    setManageRenameEditId(null);
    setManageRenameDraft("");
  };

  const openManageExpirationEditor = (accountId: string, expiresOn: string | null) => {
    setManageDeleteConfirmId(null);
    closeManageRenameEditor();
    closeManagePriorityEditor();
    setManageExpirationEditId(accountId);
    setManageExpirationDraft(expiresOn ?? "");
  };

  const closeManageExpirationEditor = () => {
    setManageExpirationEditId(null);
    setManageExpirationDraft("");
  };

  const openManagePriorityEditor = (accountId: string, priority: number) => {
    setManageDeleteConfirmId(null);
    closeManageRenameEditor();
    closeManageExpirationEditor();
    setManagePriorityEditId(accountId);
    setManagePriorityDraft(String(priority));
  };

  const closeManagePriorityEditor = () => {
    setManagePriorityEditId(null);
    setManagePriorityDraft("0");
  };

  const handleSaveAccountExpiration = async (
    accountId: string,
    nextExpiration: string | null = manageExpirationDraft.trim() || null
  ) => {
    try {
      setManageExpirationBusyId(accountId);
      await setAccountExpiration(accountId, nextExpiration);
      closeManageExpirationEditor();
      showWarmupToast(nextExpiration ? "만료일자를 저장했습니다." : "만료일자를 지웠습니다.");
    } catch (err) {
      console.error("Failed to save account expiration:", err);
      showWarmupToast(
        `만료일자 저장 실패: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      setManageExpirationBusyId(null);
    }
  };

  const handleSaveAccountRename = async (accountId: string, currentName: string) => {
    const trimmedName = manageRenameDraft.trim();
    if (!trimmedName) {
      showWarmupToast("계정 이름은 비워둘 수 없습니다.", true);
      return;
    }

    if (trimmedName === currentName) {
      closeManageRenameEditor();
      return;
    }

    try {
      setManageRenameBusyId(accountId);
      await renameAccount(accountId, trimmedName);
      closeManageRenameEditor();
      showWarmupToast("계정 이름을 수정했습니다.");
      void loadLoadBalancerStatus().catch(() => {});
    } catch (err) {
      console.error("Failed to rename account from manager:", err);
      showWarmupToast(
        `이름 수정 실패: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      setManageRenameBusyId(null);
    }
  };

  const handleSaveAccountPriority = async (accountId: string) => {
    const parsed = Number(managePriorityDraft);
    const nextPriority = Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;

    try {
      setManagePriorityBusyId(accountId);
      await setAccountLoadBalancerPriority(accountId, nextPriority);
      closeManagePriorityEditor();
      showWarmupToast(`로드밸런서 우선순위를 ${nextPriority}로 저장했습니다.`);
      void loadLoadBalancerStatus().catch(() => {});
    } catch (err) {
      console.error("Failed to save account load balancer priority:", err);
      showWarmupToast(
        `우선순위 저장 실패: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      setManagePriorityBusyId(null);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshSuccess(false);
    try {
      await refreshUsage();
      setRefreshSuccess(true);
      window.setTimeout(() => setRefreshSuccess(false), 2000);
    } finally {
      setIsRefreshing(false);
    }
  };

  const formatWarmupError = (err: unknown) => {
    if (!err) return "Unknown error";
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  };

  const handleWarmupAccount = async (accountId: string, accountName: string) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
      showWarmupToast(`Warm-up sent for ${accountName}`);
    } catch (err) {
      console.error("Failed to warm up account:", err);
      showWarmupToast(`Warm-up failed for ${accountName}: ${formatWarmupError(err)}`, true);
    } finally {
      setWarmingUpId(null);
    }
  };

  const handleWarmupAll = async () => {
    try {
      setIsWarmingAll(true);
      const summary = await warmupAllAccounts();
      if (summary.total_accounts === 0) {
        showWarmupToast("No accounts available for warm-up", true);
        return;
      }

      if (summary.failed_account_ids.length === 0) {
        showWarmupToast(
          `Warm-up sent for all ${summary.warmed_accounts} account${
            summary.warmed_accounts === 1 ? "" : "s"
          }`
        );
      } else {
        showWarmupToast(
          `Warmed ${summary.warmed_accounts}/${summary.total_accounts}. Failed: ${summary.failed_account_ids.length}`,
          true
        );
      }
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      showWarmupToast(`Warm-up all failed: ${formatWarmupError(err)}`, true);
    } finally {
      setIsWarmingAll(false);
    }
  };

  const handleExportSlimText = async () => {
    setConfigModalMode("slim_export");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);

    try {
      setIsExportingSlim(true);
      const payload = await exportAccountsSlimText();
      setConfigPayload(payload);
      showWarmupToast(`Slim text exported (${accounts.length} accounts).`);
    } catch (err) {
      console.error("Failed to export slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("Slim export failed", true);
    } finally {
      setIsExportingSlim(false);
    }
  };

  const openImportSlimTextModal = () => {
    setConfigModalMode("slim_import");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);
  };

  const handleImportSlimText = async () => {
    if (!configPayload.trim()) {
      setConfigModalError("Please paste the slim text string first.");
      return;
    }

    try {
      setIsImportingSlim(true);
      setConfigModalError(null);
      const summary = await importAccountsSlimText(configPayload);
      setMaskedAccounts(new Set());
      setIsConfigModalOpen(false);
      void loadLoadBalancerStatus().catch(() => {});
      showWarmupToast(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count} (total ${summary.total_in_payload})`
      );
    } catch (err) {
      console.error("Failed to import slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("Slim import failed", true);
    } finally {
      setIsImportingSlim(false);
    }
  };

  const handleExportFullFile = async () => {
    try {
      setIsExportingFull(true);
      const exported = await exportFullBackupFile();
      if (!exported) return;
      showWarmupToast("Full encrypted file exported.");
    } catch (err) {
      console.error("Failed to export full encrypted file:", err);
      showWarmupToast("Full export failed", true);
    } finally {
      setIsExportingFull(false);
    }
  };

  const handleImportFullFile = async () => {
    try {
      setIsImportingFull(true);
      const summary = await importFullBackupFile();
      if (!summary) return;
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      const maskedIds = await loadMaskedAccountIds();
      setMaskedAccounts(new Set(maskedIds));
      void loadLoadBalancerStatus().catch(() => {});
      showWarmupToast(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count} (total ${summary.total_in_payload})`
      );
    } catch (err) {
      console.error("Failed to import full encrypted file:", err);
      showWarmupToast("Full import failed", true);
    } finally {
      setIsImportingFull(false);
    }
  };

  const activeAccount = accounts.find((a) => a.is_active);
  const otherAccounts = accounts.filter((a) => !a.is_active);
  const hasRunningProcesses = processInfo && processInfo.count > 0;
  const isLoadBalancerRunning = Boolean(loadBalancerStatus?.running);
  const loadBalancerAccountPreview = loadBalancerStatus?.eligible_account_names
    ?.slice(0, 3)
    .join(", ");

  const sortedOtherAccounts = useMemo(() => {
    const getResetDeadline = (resetAt: number | null | undefined) =>
      resetAt ?? Number.POSITIVE_INFINITY;

    const getRemainingPercent = (usedPercent: number | null | undefined) => {
      if (usedPercent === null || usedPercent === undefined) {
        return Number.NEGATIVE_INFINITY;
      }
      return Math.max(0, 100 - usedPercent);
    };

    return [...otherAccounts].sort((a, b) => {
      if (otherAccountsSort === "deadline_asc" || otherAccountsSort === "deadline_desc") {
        const deadlineDiff =
          getResetDeadline(a.usage?.primary_resets_at) -
          getResetDeadline(b.usage?.primary_resets_at);
        if (deadlineDiff !== 0) {
          return otherAccountsSort === "deadline_asc" ? deadlineDiff : -deadlineDiff;
        }
      } else {
        const remainingDiff =
          getRemainingPercent(b.usage?.primary_used_percent) -
          getRemainingPercent(a.usage?.primary_used_percent);
        if (remainingDiff !== 0) {
          return otherAccountsSort === "remaining_desc" ? remainingDiff : -remainingDiff;
        }
      }

      return a.name.localeCompare(b.name);
    });
  }, [otherAccounts, otherAccountsSort]);

  const loadBalancedLiveAccounts = useMemo(
    () =>
      accounts
        .filter((account) => isEligibleForLoadBalancer(account.usage))
        .sort((a, b) => {
          const priorityDiff = a.load_balancer_priority - b.load_balancer_priority;
          if (priorityDiff !== 0) return priorityDiff;
          return a.name.localeCompare(b.name);
        }),
    [accounts]
  );

  const loadBalancedDeadAccounts = useMemo(
    () =>
      accounts
        .filter((account) => !isEligibleForLoadBalancer(account.usage))
        .sort((a, b) => {
          const priorityDiff = a.load_balancer_priority - b.load_balancer_priority;
          if (priorityDiff !== 0) return priorityDiff;
          return a.name.localeCompare(b.name);
        }),
    [accounts]
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_max-content] md:items-center md:gap-4">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="h-10 w-10 rounded-xl bg-gray-900 flex items-center justify-center text-white font-bold text-lg">
                C
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl font-bold text-gray-900 tracking-tight">
                    Codex Switcher
                  </h1>
                  <span
                    className="inline-flex items-center rounded-full border border-[rgba(181,193,231,0.54)] bg-white/80 px-3 py-1 text-xs font-semibold text-[var(--text-soft)] shadow-sm"
                    title={`현재 버전 v${APP_VERSION}`}
                  >
                    v{APP_VERSION}
                  </span>
                  {processInfo && (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border ${
                        hasRunningProcesses
                          ? "bg-amber-50 text-amber-700 border-amber-200"
                          : "bg-green-50 text-green-700 border-green-200"
                      }`}
                    >
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${
                          hasRunningProcesses ? "bg-amber-500" : "bg-green-500"
                        }`}
                      ></span>
                      <span>
                        {hasRunningProcesses
                          ? `${processInfo.count} Codex running`
                          : "0 Codex running"}
                      </span>
                    </span>
                  )}
                  {loadBalancerStatus && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium shadow-sm ${
                        isLoadBalancerRunning
                          ? "bg-[rgba(103,119,255,0.12)] text-[var(--primary-strong)] border-[rgba(103,119,255,0.24)]"
                          : "bg-[rgba(255,255,255,0.78)] text-[var(--text-soft)] border-[rgba(126,138,188,0.2)]"
                      }`}
                      title={
                        isLoadBalancerRunning
                          ? `${loadBalancerStatus.endpoint_url}\n우선순위 ${loadBalancerStatus.active_priority ?? 0} 그룹 ${loadBalancerStatus.eligible_account_count}개 계정 중 잔여량이 가장 높은 계정을 우선 사용 중`
                          : "내장 로드밸런서는 현재 멈춰 있습니다."
                      }
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          isLoadBalancerRunning
                            ? "bg-[var(--primary)]"
                            : "bg-[rgba(126,138,188,0.45)]"
                        }`}
                      ></span>
                      <span>
                        {isLoadBalancerRunning
                          ? `로드밸런서 P${loadBalancerStatus.active_priority ?? 0} · ${loadBalancerStatus.eligible_account_count}계정`
                          : "로드밸런서 꺼짐"}
                      </span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500">Multi-account manager for Codex CLI</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0 md:ml-4 md:w-max md:flex-nowrap md:justify-end">
              <button
                onClick={toggleMaskAll}
                className="h-10 px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors shrink-0 whitespace-nowrap"
                title={allMasked ? "Show all account names and emails" : "Hide all account names and emails"}
              >
                {allMasked ? "Show All" : "Hide All"}
              </button>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="h-10 px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors disabled:opacity-50 shrink-0 whitespace-nowrap"
              >
                {isRefreshing ? "↻ Refreshing..." : "↻ Refresh All"}
              </button>
              <button
                onClick={handleWarmupAll}
                disabled={isWarmingAll || accounts.length === 0}
                className="h-10 px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors disabled:opacity-50 shrink-0 whitespace-nowrap"
                title="Send minimal traffic using all accounts"
              >
                {isWarmingAll ? "⚡ Warming..." : "⚡ Warm-up All"}
              </button>

              <div className="relative" ref={actionsMenuRef}>
                <button
                  onClick={() => setIsActionsMenuOpen((prev) => !prev)}
                  className="h-10 px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 text-white transition-colors shrink-0 whitespace-nowrap"
                >
                  Account ▾
                </button>
                {isActionsMenuOpen && (
                  <div className="absolute right-0 mt-2 w-64 rounded-xl border border-gray-200 bg-white shadow-xl p-2 z-50">
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        setIsAddModalOpen(true);
                      }}
                      className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 text-gray-700"
                    >
                      + Add Account
                    </button>
                    <button
                      onClick={() => {
                        setManageDeleteConfirmId(null);
                        closeManageRenameEditor();
                        closeManageExpirationEditor();
                        closeManagePriorityEditor();
                        setIsActionsMenuOpen(false);
                        setIsAccountManagerOpen(true);
                      }}
                      className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 text-gray-700"
                    >
                      Account Manager
                    </button>
                    <button
                      onClick={() => {
                        setDraftLoadBalancerSettings(
                          normalizeLoadBalancerSettings(
                            loadBalancerStatus?.settings ?? defaultLoadBalancerSettings()
                          )
                        );
                        setIsActionsMenuOpen(false);
                        setIsLoadBalancerModalOpen(true);
                      }}
                      className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 text-gray-700"
                    >
                      Load Balancer
                    </button>
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        void handleExportSlimText();
                      }}
                      disabled={isExportingSlim}
                      className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 text-gray-700 disabled:opacity-50"
                    >
                      {isExportingSlim ? "Exporting..." : "Export Slim Text"}
                    </button>
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        openImportSlimTextModal();
                      }}
                      disabled={isImportingSlim}
                      className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 text-gray-700 disabled:opacity-50"
                    >
                      {isImportingSlim ? "Importing..." : "Import Slim Text"}
                    </button>
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        void handleExportFullFile();
                      }}
                      disabled={isExportingFull}
                      className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 text-gray-700 disabled:opacity-50"
                    >
                      {isExportingFull ? "Exporting..." : "Export Full Encrypted File"}
                    </button>
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        void handleImportFullFile();
                      }}
                      disabled={isImportingFull}
                      className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 text-gray-700 disabled:opacity-50"
                    >
                      {isImportingFull ? "Importing..." : "Import Full Encrypted File"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-6">
          <UpdateChecker />
        </div>

        {loading && accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="animate-spin h-10 w-10 border-2 border-gray-900 border-t-transparent rounded-full mb-4"></div>
            <p className="text-gray-500">Loading accounts...</p>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <div className="text-red-600 mb-2">Failed to load accounts</div>
            <p className="text-sm text-gray-500">{error}</p>
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-20">
            <div className="h-16 w-16 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">👤</span>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">No accounts yet</h2>
            <p className="text-gray-500 mb-6">Add your first Codex account to get started</p>
            <button
              onClick={() => setIsAddModalOpen(true)}
              className="px-6 py-3 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 text-white transition-colors"
            >
              Add Account
            </button>
          </div>
        ) : (
          <div className="space-y-8">
            {!isLoadBalancerRunning && activeAccount && (
              <section>
                <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-4">
                  Active Account
                </h2>
                <AccountCard
                  account={activeAccount}
                  onSwitch={() => {}}
                  onWarmup={() => handleWarmupAccount(activeAccount.id, activeAccount.name)}
                  onDelete={() => handleDelete(activeAccount.id)}
                  onRefresh={() => refreshSingleUsage(activeAccount.id)}
                  onRename={(newName) => renameAccount(activeAccount.id, newName)}
                  switching={switchingId === activeAccount.id}
                  switchDisabled={hasRunningProcesses ?? false}
                  warmingUp={isWarmingAll || warmingUpId === activeAccount.id}
                  masked={maskedAccounts.has(activeAccount.id)}
                  onToggleMask={() => toggleMask(activeAccount.id)}
                />
              </section>
            )}

            {isLoadBalancerRunning ? (
              <>
                {loadBalancedLiveAccounts.length > 0 && (
                  <section>
                    <div className="mb-4">
                      <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                        Load Balancer Pool ({loadBalancedLiveAccounts.length})
                      </h2>
                      <p className="mt-1 text-sm text-gray-500">
                        활성 계정 대신 전체 계정 풀 상태를 보여줍니다. 5% 이하 계정은 자동 제외됩니다.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {loadBalancedLiveAccounts.map((account) => (
                        <AccountCard
                          key={account.id}
                          account={account}
                          onSwitch={() => handleSwitch(account.id)}
                          onWarmup={() => handleWarmupAccount(account.id, account.name)}
                          onDelete={() => handleDelete(account.id)}
                          onRefresh={() => refreshSingleUsage(account.id)}
                          onRename={(newName) => renameAccount(account.id, newName)}
                          switching={false}
                          switchDisabled
                          warmingUp={isWarmingAll || warmingUpId === account.id}
                          masked={maskedAccounts.has(account.id)}
                          onToggleMask={() => toggleMask(account.id)}
                          loadBalancerMode
                        />
                      ))}
                    </div>
                  </section>
                )}

                {loadBalancedDeadAccounts.length > 0 && (
                  <section>
                    <div className="mb-4">
                      <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                        Deferred / Inactive Pool ({loadBalancedDeadAccounts.length})
                      </h2>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {loadBalancedDeadAccounts.map((account) => (
                        <AccountCard
                          key={account.id}
                          account={account}
                          onSwitch={() => handleSwitch(account.id)}
                          onWarmup={() => handleWarmupAccount(account.id, account.name)}
                          onDelete={() => handleDelete(account.id)}
                          onRefresh={() => refreshSingleUsage(account.id)}
                          onRename={(newName) => renameAccount(account.id, newName)}
                          switching={false}
                          switchDisabled
                          warmingUp={isWarmingAll || warmingUpId === account.id}
                          masked={maskedAccounts.has(account.id)}
                          onToggleMask={() => toggleMask(account.id)}
                          loadBalancerMode
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            ) : (
              otherAccounts.length > 0 && (
                <section>
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                      Other Accounts ({otherAccounts.length})
                    </h2>
                    <div className="flex items-center gap-2">
                      <label htmlFor="other-accounts-sort" className="text-xs text-gray-500">
                        Sort
                      </label>
                      <div className="relative">
                        <select
                          id="other-accounts-sort"
                          value={otherAccountsSort}
                          onChange={(e) =>
                            setOtherAccountsSort(
                              e.target.value as
                                | "deadline_asc"
                                | "deadline_desc"
                                | "remaining_desc"
                                | "remaining_asc"
                            )
                          }
                          className="appearance-none font-sans text-xs sm:text-sm font-medium pl-3 pr-9 py-2 rounded-xl border border-gray-300 bg-gradient-to-b from-white to-gray-50 text-gray-700 shadow-sm hover:border-gray-400 hover:shadow focus:outline-none focus:ring-2 focus:ring-gray-300 focus:border-gray-400 transition-all"
                        >
                          <option value="deadline_asc">Reset: earliest to latest</option>
                          <option value="deadline_desc">Reset: latest to earliest</option>
                          <option value="remaining_desc">% remaining: highest to lowest</option>
                          <option value="remaining_asc">% remaining: lowest to highest</option>
                        </select>
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-gray-500">
                          <svg
                            className="h-4 w-4"
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {sortedOtherAccounts.map((account) => (
                      <AccountCard
                        key={account.id}
                        account={account}
                        onSwitch={() => handleSwitch(account.id)}
                        onWarmup={() => handleWarmupAccount(account.id, account.name)}
                        onDelete={() => handleDelete(account.id)}
                        onRefresh={() => refreshSingleUsage(account.id)}
                        onRename={(newName) => renameAccount(account.id, newName)}
                        switching={switchingId === account.id}
                        switchDisabled={hasRunningProcesses ?? false}
                        warmingUp={isWarmingAll || warmingUpId === account.id}
                        masked={maskedAccounts.has(account.id)}
                        onToggleMask={() => toggleMask(account.id)}
                      />
                    ))}
                  </div>
                </section>
              )
            )}
          </div>
        )}
      </main>

      {refreshSuccess && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-3 bg-green-600 text-white rounded-lg shadow-lg text-sm flex items-center gap-2">
          <span>✓</span> Usage refreshed successfully
        </div>
      )}

      {warmupToast && (
        <div
          className={`fixed bottom-20 left-1/2 -translate-x-1/2 px-4 py-3 rounded-lg shadow-lg text-sm ${
            warmupToast.isError
              ? "bg-red-600 text-white"
              : "bg-amber-100 text-amber-900 border border-amber-300"
          }`}
        >
          {warmupToast.message}
        </div>
      )}

      {deleteConfirmId && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-3 bg-red-600 text-white rounded-lg shadow-lg text-sm">
          Click delete again to confirm removal
        </div>
      )}

      <AddAccountModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onImportFile={importFromFile}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={completeOAuthLogin}
        onCancelOAuth={cancelOAuthLogin}
      />

      {isAccountManagerOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-2xl mx-4 shadow-xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">계정 관리</h2>
                <p className="mt-1 text-sm text-gray-500">이름 수정, 만료일, 우선순위를 여기서 관리합니다.</p>
              </div>
              <button
                onClick={() => {
                  setManageDeleteConfirmId(null);
                  closeManageRenameEditor();
                  closeManageExpirationEditor();
                  closeManagePriorityEditor();
                  setIsAccountManagerOpen(false);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
              {accounts.map((account) => {
                const isConfirming = manageDeleteConfirmId === account.id;
                const isDeleting = manageDeleteBusyId === account.id;
                const isEditingRename = manageRenameEditId === account.id;
                const isSavingRename = manageRenameBusyId === account.id;
                const isEditingExpiration = manageExpirationEditId === account.id;
                const isSavingExpiration = manageExpirationBusyId === account.id;
                const isEditingPriority = managePriorityEditId === account.id;
                const isSavingPriority = managePriorityBusyId === account.id;
                const expirationBadge = formatAccountExpirationBadge(account.expires_on);

                return (
                  <div
                    key={account.id}
                    className="flex items-start justify-between gap-4 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isEditingRename ? (
                          <input
                            type="text"
                            value={manageRenameDraft}
                            onChange={(e) => setManageRenameDraft(e.target.value)}
                            className="min-w-[220px] max-w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900"
                          />
                        ) : (
                          <p className="truncate text-sm font-medium text-gray-900">{account.name}</p>
                        )}
                        {expirationBadge && (
                          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                            [{expirationBadge}]
                          </span>
                        )}
                        {account.is_active && !isLoadBalancerRunning && (
                          <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                            현재 사용 중
                          </span>
                        )}
                      </div>
                      {account.email && (
                        <p className="truncate text-sm text-gray-500 mt-1">{account.email}</p>
                      )}
                      <p className="mt-1 text-xs text-gray-500">
                        로드밸런서 우선순위: {account.load_balancer_priority}
                      </p>
                      {account.expires_on && (
                        <p className="mt-1 text-xs text-gray-500">만료일: {account.expires_on}</p>
                      )}

                      {isEditingRename && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => {
                              void handleSaveAccountRename(account.id, account.name);
                            }}
                            disabled={isSavingRename}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-900 hover:bg-gray-800 text-white disabled:opacity-50"
                          >
                            {isSavingRename ? "저장 중..." : "저장"}
                          </button>
                          <button
                            onClick={closeManageRenameEditor}
                            disabled={isSavingRename}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                          >
                            취소
                          </button>
                        </div>
                      )}

                      {isEditingExpiration && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <input
                            type="date"
                            value={manageExpirationDraft}
                            onChange={(e) => setManageExpirationDraft(e.target.value)}
                            className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                          />
                          <button
                            onClick={() => {
                              void handleSaveAccountExpiration(account.id);
                            }}
                            disabled={isSavingExpiration}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-900 hover:bg-gray-800 text-white disabled:opacity-50"
                          >
                            {isSavingExpiration ? "저장 중..." : "저장"}
                          </button>
                          <button
                            onClick={closeManageExpirationEditor}
                            disabled={isSavingExpiration}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                          >
                            취소
                          </button>
                          {account.expires_on && (
                            <button
                              onClick={() => {
                                void handleSaveAccountExpiration(account.id, null);
                              }}
                              disabled={isSavingExpiration}
                              className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                            >
                              지우기
                            </button>
                          )}
                        </div>
                      )}

                      {isEditingPriority && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={managePriorityDraft}
                            onChange={(e) => setManagePriorityDraft(e.target.value)}
                            className="w-28 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                          />
                          <button
                            onClick={() => {
                              void handleSaveAccountPriority(account.id);
                            }}
                            disabled={isSavingPriority}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-900 hover:bg-gray-800 text-white disabled:opacity-50"
                          >
                            {isSavingPriority ? "저장 중..." : "저장"}
                          </button>
                          <button
                            onClick={closeManagePriorityEditor}
                            disabled={isSavingPriority}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                          >
                            취소
                          </button>
                          <p className="text-xs text-gray-500">숫자가 낮을수록 먼저 사용됩니다.</p>
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 flex items-center gap-2 flex-wrap justify-end">
                      {isConfirming ? (
                        <>
                          <button
                            onClick={() => setManageDeleteConfirmId(null)}
                            disabled={isDeleting}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                          >
                            취소
                          </button>
                          <button
                            onClick={() => {
                              void handleManagedDelete(account.id);
                            }}
                            disabled={isDeleting}
                            className="px-3 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                          >
                            {isDeleting ? "제거 중..." : "정말 제거"}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => openManageRenameEditor(account.id, account.name)}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700"
                          >
                            이름수정
                          </button>
                          <button
                            onClick={() => openManagePriorityEditor(account.id, account.load_balancer_priority)}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700"
                          >
                            우선순위
                          </button>
                          <button
                            onClick={() => openManageExpirationEditor(account.id, account.expires_on)}
                            className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700"
                          >
                            만료일자
                          </button>
                          <button
                            onClick={() => {
                              closeManageRenameEditor();
                              closeManageExpirationEditor();
                              closeManagePriorityEditor();
                              setManageDeleteConfirmId(account.id);
                            }}
                            className="px-3 py-2 text-sm rounded-lg bg-red-50 hover:bg-red-100 text-red-600"
                          >
                            제거
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {isLoadBalancerModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-2xl mx-4 shadow-xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">로드밸런서</h2>
                <p className="mt-1 text-sm text-gray-500">
                  Codex 요청을 로컬 프록시로 받아 등록된 ChatGPT 계정 중 잔여량이 가장 높은 계정을 우선 사용합니다.
                </p>
              </div>
              <button
                onClick={() => setIsLoadBalancerModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="space-y-5 p-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-900">호스트</span>
                  <input
                    value={draftLoadBalancerSettings.host}
                    onChange={(e) =>
                      setDraftLoadBalancerSettings((prev) => ({
                        ...prev,
                        host: e.target.value,
                      }))
                    }
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-gray-500"
                    placeholder="127.0.0.1"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-900">포트</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={draftLoadBalancerSettings.port}
                    onChange={(e) =>
                      setDraftLoadBalancerSettings((prev) => ({
                        ...prev,
                        port: Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-gray-500"
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex items-center justify-between rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-gray-900">로드밸런서 활성화</div>
                    <div className="mt-1 text-xs text-gray-500">저장하면 바로 시작하거나 중지합니다.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={draftLoadBalancerSettings.enabled}
                    onChange={(e) =>
                      setDraftLoadBalancerSettings((prev) => ({
                        ...prev,
                        enabled: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 accent-gray-900"
                  />
                </label>
                <label className="flex items-center justify-between rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-gray-900">Codex 설정 자동 연결</div>
                    <div className="mt-1 text-xs text-gray-500">`config.toml`의 provider를 이 프록시로 맞춥니다.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={draftLoadBalancerSettings.apply_codex_config}
                    onChange={(e) =>
                      setDraftLoadBalancerSettings((prev) => ({
                        ...prev,
                        apply_codex_config: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 accent-gray-900"
                  />
                </label>
              </div>

              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium ${
                      isLoadBalancerRunning
                        ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                        : "border-gray-200 bg-white text-gray-500"
                    }`}
                  >
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        isLoadBalancerRunning ? "bg-indigo-500" : "bg-gray-400"
                      }`}
                    ></span>
                    {isLoadBalancerRunning ? "실행 중" : "중지됨"}
                  </span>
                  <span className="text-xs text-gray-500">
                    엔드포인트: {loadBalancerStatus?.endpoint_url ?? "저장 후 생성"}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">풀 계정 수</div>
                    <div className="mt-1 text-2xl font-semibold text-gray-900">
                      {loadBalancerStatus?.eligible_account_count ?? 0}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {loadBalancerAccountPreview
                        ? `${loadBalancerAccountPreview}${
                            (loadBalancerStatus?.eligible_account_count ?? 0) > 3 ? "..." : ""
                          }`
                        : "현재 우선순위 그룹에 포함된 ChatGPT 계정이 아직 없습니다."}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      현재 우선순위: {loadBalancerStatus?.active_priority ?? 0}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">누적 프록시 요청</div>
                    <div className="mt-1 text-2xl font-semibold text-gray-900">
                      {loadBalancerStatus?.requests_proxied ?? 0}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      마지막 계정: {loadBalancerStatus?.last_account_name ?? "아직 없음"}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      후순위 대기 계정: {loadBalancerStatus?.deferred_account_count ?? 0}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-xl bg-white px-4 py-3 text-sm text-gray-700 border border-gray-200">
                  Codex 설정 반영: <span className="font-medium text-gray-900">
                    {loadBalancerStatus?.codex_config_applied ? "적용됨" : "미적용"}
                  </span>
                </div>

                {loadBalancerStatus?.last_error && (
                  <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    최근 오류: {loadBalancerStatus.last_error}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                현재는 등록된 계정 중 ChatGPT OAuth 계정만 로드밸런싱 풀에 포함됩니다. 우선순위 숫자가 낮은 계정 그룹을 먼저 모두 사용하고, 그 안에서는 5시간 제한 잔여량이 가장 높은 계정을 우선 사용합니다. 5% 이하 계정은 자동 제외됩니다.
              </div>
            </div>

            <div className="flex justify-end gap-3 p-5 border-t border-gray-100">
              <button
                onClick={() => setIsLoadBalancerModalOpen(false)}
                className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700"
              >
                취소
              </button>
              <button
                onClick={() => {
                  void persistLoadBalancerSettings();
                }}
                disabled={isLoadBalancerSaving}
                className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 text-white disabled:opacity-50"
              >
                {isLoadBalancerSaving ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isConfigModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-2xl mx-4 shadow-xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">
                {configModalMode === "slim_export" ? "Export Slim Text" : "Import Slim Text"}
              </h2>
              <button
                onClick={() => setIsConfigModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-4">
              {configModalMode === "slim_import" ? (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Existing accounts are kept. Only missing accounts are imported.
                </p>
              ) : (
                <p className="text-sm text-gray-500">
                  This slim string contains account secrets. Keep it private.
                </p>
              )}
              <textarea
                value={configPayload}
                onChange={(e) => setConfigPayload(e.target.value)}
                readOnly={configModalMode === "slim_export"}
                placeholder={
                  configModalMode === "slim_export"
                    ? isExportingSlim
                      ? "Generating..."
                      : "Export string will appear here"
                    : "Paste config string here"
                }
                className="w-full h-48 px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400 font-mono"
              />
              {configModalError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  {configModalError}
                </div>
              )}
            </div>
            <div className="flex gap-3 p-5 border-t border-gray-100">
              <button
                onClick={() => setIsConfigModalOpen(false)}
                className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
              >
                Close
              </button>
              {configModalMode === "slim_export" ? (
                <button
                  onClick={async () => {
                    if (!configPayload) return;
                    try {
                      await navigator.clipboard.writeText(configPayload);
                      setConfigCopied(true);
                      setTimeout(() => setConfigCopied(false), 1500);
                    } catch {
                      setConfigModalError("Clipboard unavailable. Please copy manually.");
                    }
                  }}
                  disabled={!configPayload || isExportingSlim}
                  className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 text-white transition-colors disabled:opacity-50"
                >
                  {configCopied ? "Copied" : "Copy String"}
                </button>
              ) : (
                <button
                  onClick={handleImportSlimText}
                  disabled={isImportingSlim}
                  className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 text-white transition-colors disabled:opacity-50"
                >
                  {isImportingSlim ? "Importing..." : "Import Missing Accounts"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
