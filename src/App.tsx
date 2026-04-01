import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { USAGE_AUTO_REFRESH_INTERVAL_MS, useAccounts } from "./hooks/useAccounts";
import { AccountCard, AddAccountModal, UpdateChecker } from "./components";
import { getExhaustedRateLimits } from "./components/UsageBar";
import type { CodexProcessInfo } from "./types";
import {
  exportFullBackupFile,
  hideWindowToTray,
  importFullBackupFile,
  isTauriRuntime,
  invokeBackend,
  sendSystemNotification,
} from "./lib/platform";
import "./App.css";

const USAGE_ALERT_SETTINGS_KEY = "codex-switcher-usage-alert-settings";
const PRIVACY_SETTINGS_KEY = "codex-switcher-privacy-settings";

type UsageAlertSettings = {
  enabled: boolean;
  thresholdPercent: number;
};

type PrivacyMode = "full" | "blur" | "prefix3";
type PrivacySettings = {
  mode: PrivacyMode;
  showCredits: boolean;
  showMaskToggle: boolean;
  showPlanBadge: boolean;
};

const DEFAULT_USAGE_ALERT_SETTINGS: UsageAlertSettings = {
  enabled: false,
  thresholdPercent: 20,
};

function clampUsageAlertThreshold(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_USAGE_ALERT_SETTINGS.thresholdPercent;
  return Math.min(100, Math.max(1, Math.round(value)));
}

function isPrivacyMode(value: unknown): value is PrivacyMode {
  return value === "full" || value === "blur" || value === "prefix3";
}

function App() {
  const {
    accounts,
    loading,
    error,
    nextAutoRefreshAt,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
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
  const [configModalMode, setConfigModalMode] = useState<"slim_export" | "slim_import">(
    "slim_export"
  );
  const [configPayload, setConfigPayload] = useState("");
  const [configModalError, setConfigModalError] = useState<string | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [isUsageAlertModalOpen, setIsUsageAlertModalOpen] = useState(false);
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState(false);
  const [usageAlertSettings, setUsageAlertSettings] = useState<UsageAlertSettings>(
    DEFAULT_USAGE_ALERT_SETTINGS
  );
  const [draftUsageAlertSettings, setDraftUsageAlertSettings] = useState<UsageAlertSettings>(
    DEFAULT_USAGE_ALERT_SETTINGS
  );
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>("full");
  const [draftPrivacyMode, setDraftPrivacyMode] = useState<PrivacyMode>("full");
  const [showCredits, setShowCredits] = useState(true);
  const [draftShowCredits, setDraftShowCredits] = useState(true);
  const [showMaskToggle, setShowMaskToggle] = useState(true);
  const [draftShowMaskToggle, setDraftShowMaskToggle] = useState(true);
  const [showPlanBadge, setShowPlanBadge] = useState(true);
  const [draftShowPlanBadge, setDraftShowPlanBadge] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [processInfo, setProcessInfo] = useState<CodexProcessInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExportingSlim, setIsExportingSlim] = useState(false);
  const [isImportingSlim, setIsImportingSlim] = useState(false);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isWarmingAll, setIsWarmingAll] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [refreshCountdownNow, setRefreshCountdownNow] = useState(() => Date.now());
  const [warmupToast, setWarmupToast] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [otherAccountsSort, setOtherAccountsSort] = useState<
    "recommended_queue" | "deadline_asc" | "deadline_desc" | "remaining_desc" | "remaining_asc"
  >("recommended_queue");
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
  const [isAccountManagerOpen, setIsAccountManagerOpen] = useState(false);
  const [manageDeleteConfirmId, setManageDeleteConfirmId] = useState<string | null>(null);
  const [manageDeleteBusyId, setManageDeleteBusyId] = useState<string | null>(null);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const notifiedUsageAlertKeysRef = useRef<Set<string>>(new Set());

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

  const checkProcesses = useCallback(async () => {
    try {
      const info = await invokeBackend<CodexProcessInfo>("check_codex_processes");
      setProcessInfo(info);
    } catch (err) {
      console.error("Failed to check processes:", err);
    }
  }, []);

  // Check processes on mount and periodically
  useEffect(() => {
    checkProcesses();
    const interval = setInterval(checkProcesses, 3000); // Check every 3 seconds
    return () => clearInterval(interval);
  }, [checkProcesses]);

  // Load masked accounts from storage on mount
  useEffect(() => {
    loadMaskedAccountIds().then((ids) => {
      if (ids.length > 0) {
        setMaskedAccounts(new Set(ids));
      }
    });
  }, [loadMaskedAccountIds]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(USAGE_ALERT_SETTINGS_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as Partial<UsageAlertSettings>;
      const nextSettings: UsageAlertSettings = {
        enabled: Boolean(parsed.enabled),
        thresholdPercent: clampUsageAlertThreshold(parsed.thresholdPercent),
      };
      setUsageAlertSettings(nextSettings);
      setDraftUsageAlertSettings(nextSettings);
    } catch (err) {
      console.error("Failed to load usage alert settings:", err);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(PRIVACY_SETTINGS_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as {
        mode?: unknown;
        showCredits?: unknown;
        showMaskToggle?: unknown;
        showPlanBadge?: unknown;
      };
      const nextMode = isPrivacyMode(parsed.mode) ? parsed.mode : "full";
      const nextShowCredits =
        typeof parsed.showCredits === "boolean" ? parsed.showCredits : true;
      const nextShowMaskToggle =
        typeof parsed.showMaskToggle === "boolean" ? parsed.showMaskToggle : true;
      const nextShowPlanBadge =
        typeof parsed.showPlanBadge === "boolean" ? parsed.showPlanBadge : true;

      setPrivacyMode(nextMode);
      setDraftPrivacyMode(nextMode);
      setShowCredits(nextShowCredits);
      setDraftShowCredits(nextShowCredits);
      setShowMaskToggle(nextShowMaskToggle);
      setDraftShowMaskToggle(nextShowMaskToggle);
      setShowPlanBadge(nextShowPlanBadge);
      setDraftShowPlanBadge(nextShowPlanBadge);
    } catch (err) {
      console.error("Failed to load privacy settings:", err);
    }
  }, []);

  useEffect(() => {
    if (!isOptionsMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedOptionsMenu = optionsMenuRef.current?.contains(target);
      if (!clickedOptionsMenu) {
        setIsOptionsMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOptionsMenuOpen]);

  const handleSwitch = async (accountId: string) => {
    // Check processes before switching
    await checkProcesses();
    if (processInfo && !processInfo.can_switch) {
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
    } catch (err) {
      console.error("Failed to switch account:", err);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleManagedDelete = async (accountId: string) => {
    try {
      setManageDeleteBusyId(accountId);
      await deleteAccount(accountId);
      setManageDeleteConfirmId((current) => (current === accountId ? null : current));
    } catch (err) {
      console.error("Failed to delete account:", err);
    } finally {
      setManageDeleteBusyId(null);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshSuccess(false);
    try {
      await refreshUsage();
      setRefreshSuccess(true);
      setTimeout(() => setRefreshSuccess(false), 2000);
    } finally {
      setIsRefreshing(false);
    }
  };

  const showWarmupToast = (message: string, isError = false) => {
    setWarmupToast({ message, isError });
    setTimeout(() => setWarmupToast(null), 2500);
  };

  const saveUsageAlertSettings = () => {
    const nextSettings: UsageAlertSettings = {
      enabled: draftUsageAlertSettings.enabled,
      thresholdPercent: clampUsageAlertThreshold(draftUsageAlertSettings.thresholdPercent),
    };

    setUsageAlertSettings(nextSettings);
    setDraftUsageAlertSettings(nextSettings);
    notifiedUsageAlertKeysRef.current.clear();

    if (typeof window !== "undefined") {
      window.localStorage.setItem(USAGE_ALERT_SETTINGS_KEY, JSON.stringify(nextSettings));
    }

    setIsUsageAlertModalOpen(false);
    showWarmupToast("사용량 알림 설정을 저장했습니다.");
  };

  const testUsageAlert = async () => {
    const threshold = clampUsageAlertThreshold(draftUsageAlertSettings.thresholdPercent);
    const body = activeAccount
      ? `${activeAccount.name} 계정의 5시간 제한이 ${threshold}% 남았다고 가정한 테스트 알림입니다.`
      : `5시간 제한이 ${threshold}% 남았다고 가정한 테스트 알림입니다.`;
    const delivered = await sendSystemNotification("Codex Switcher 테스트 알림", body);
    if (!delivered) {
      showWarmupToast("시스템 알림 권한이 없어 테스트 알림을 보낼 수 없습니다.", true);
    }
  };

  const savePrivacySettings = () => {
    setPrivacyMode(draftPrivacyMode);
    setShowCredits(draftShowCredits);
    setShowMaskToggle(draftShowMaskToggle);
    setShowPlanBadge(draftShowPlanBadge);
    if (typeof window !== "undefined") {
      const nextSettings: PrivacySettings = {
        mode: draftPrivacyMode,
        showCredits: draftShowCredits,
        showMaskToggle: draftShowMaskToggle,
        showPlanBadge: draftShowPlanBadge,
      };
      window.localStorage.setItem(PRIVACY_SETTINGS_KEY, JSON.stringify(nextSettings));
    }
    setIsPrivacyModalOpen(false);
    showWarmupToast("표시 설정을 저장했습니다.");
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
      showWarmupToast(
        `Warm-up failed for ${accountName}: ${formatWarmupError(err)}`,
        true
      );
    } finally {
      setWarmingUpId(null);
    }
  };

  const handleWarmupAll = async () => {
    try {
      setIsWarmingAll(true);
      const summary = await warmupAllAccounts();
      if (summary.total_accounts === 0) {
        showWarmupToast("워밍업할 계정이 없습니다", true);
        return;
      }

      if (summary.failed_account_ids.length === 0) {
        showWarmupToast(
          `총 ${summary.warmed_accounts}개 계정에 워밍업 요청을 보냈습니다`
        );
      } else {
        showWarmupToast(
          `워밍업 성공 ${summary.warmed_accounts}/${summary.total_accounts}, 실패 ${summary.failed_account_ids.length}개`,
          true
        );
      }
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      showWarmupToast(`전체 워밍업 실패: ${formatWarmupError(err)}`, true);
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
      showWarmupToast(`간편 문자열 내보내기 완료 (${accounts.length}개 계정)`);
    } catch (err) {
      console.error("Failed to export slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("간편 문자열 내보내기에 실패했습니다", true);
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
      setConfigModalError("먼저 간편 문자열을 붙여넣으세요.");
      return;
    }

    try {
      setIsImportingSlim(true);
      setConfigModalError(null);
      const summary = await importAccountsSlimText(configPayload);
      setMaskedAccounts(new Set());
      setIsConfigModalOpen(false);
      showWarmupToast(
        `가져오기 완료: ${summary.imported_count}개 추가, ${summary.skipped_count}개 건너뜀 (총 ${summary.total_in_payload}개)`
      );
    } catch (err) {
      console.error("Failed to import slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("간편 문자열 가져오기에 실패했습니다", true);
    } finally {
      setIsImportingSlim(false);
    }
  };

  const handleExportFullFile = async () => {
    try {
      setIsExportingFull(true);
      const exported = await exportFullBackupFile();
      if (!exported) return;
      showWarmupToast("백업 파일을 만들었습니다.");
    } catch (err) {
      console.error("Failed to export full encrypted file:", err);
      showWarmupToast("백업 파일 생성에 실패했습니다", true);
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
      showWarmupToast(
        `복원 완료: ${summary.imported_count}개 추가, ${summary.skipped_count}개 건너뜀 (총 ${summary.total_in_payload}개)`
      );
    } catch (err) {
      console.error("Failed to import full encrypted file:", err);
      showWarmupToast("백업 복원에 실패했습니다", true);
    } finally {
      setIsImportingFull(false);
    }
  };

  const activeAccount = accounts.find((a) => a.is_active);
  const otherAccounts = accounts.filter((a) => !a.is_active);
  const hasRunningProcesses = processInfo && processInfo.count > 0;
  const hasAccounts = accounts.length > 0;

  useEffect(() => {
    if (!usageAlertSettings.enabled || !activeAccount?.usage || activeAccount.usage.error) {
      return;
    }

    const limitCandidates = [
      { key: "primary", label: "5시간 제한", usedPercent: activeAccount.usage.primary_used_percent },
      { key: "secondary", label: "주간 제한", usedPercent: activeAccount.usage.secondary_used_percent },
    ]
      .map((entry) => ({
        ...entry,
        remainingPercent:
          entry.usedPercent === null || entry.usedPercent === undefined
            ? null
            : Math.max(0, 100 - entry.usedPercent),
      }))
      .filter(
        (entry): entry is typeof entry & { remainingPercent: number } =>
          entry.remainingPercent !== null
      );

    for (const candidate of limitCandidates) {
      const alertKey = `${activeAccount.id}:${candidate.key}`;

      if (candidate.remainingPercent <= usageAlertSettings.thresholdPercent) {
        if (!notifiedUsageAlertKeysRef.current.has(alertKey)) {
          notifiedUsageAlertKeysRef.current.add(alertKey);
            void sendSystemNotification(
              "Codex Switcher 사용량 알림",
              `현재 계정의 ${candidate.label}이 ${candidate.remainingPercent.toFixed(0)}% 남았습니다.`
            ).then((delivered) => {
              if (!delivered) {
                showWarmupToast(
                  `사용량 알림: 현재 계정의 ${candidate.label}이 ${candidate.remainingPercent.toFixed(0)}% 남았습니다.`,
                  true
                );
              }
            });
          }
        } else {
          notifiedUsageAlertKeysRef.current.delete(alertKey);
        }
    }
  }, [
    activeAccount?.id,
    activeAccount?.usage?.error,
    activeAccount?.usage?.primary_used_percent,
    activeAccount?.usage?.secondary_used_percent,
    usageAlertSettings.enabled,
    usageAlertSettings.thresholdPercent,
  ]);

  const sortedOtherAccounts = useMemo(() => {
    const getResetDeadline = (resetAt: number | null | undefined) =>
      resetAt ?? Number.POSITIVE_INFINITY;

    const getRemainingPercent = (usedPercent: number | null | undefined) => {
      if (usedPercent === null || usedPercent === undefined) {
        return Number.NEGATIVE_INFINITY;
      }
      return Math.max(0, 100 - usedPercent);
    };

    const compareRecommendedQueue = (a: typeof otherAccounts[number], b: typeof otherAccounts[number]) => {
      const aPrimary = getRemainingPercent(a.usage?.primary_used_percent);
      const bPrimary = getRemainingPercent(b.usage?.primary_used_percent);
      const aSecondary = getRemainingPercent(a.usage?.secondary_used_percent);
      const bSecondary = getRemainingPercent(b.usage?.secondary_used_percent);
      const aDeadline = getResetDeadline(a.usage?.primary_resets_at);
      const bDeadline = getResetDeadline(b.usage?.primary_resets_at);

      const aHasLiveBudget = aPrimary > 0 ? 1 : 0;
      const bHasLiveBudget = bPrimary > 0 ? 1 : 0;
      if (aHasLiveBudget !== bHasLiveBudget) {
        return bHasLiveBudget - aHasLiveBudget;
      }

      // Prefer accounts that can take more work right now.
      if (aPrimary !== bPrimary) {
        return bPrimary - aPrimary;
      }

      // If the short window is tied, prefer the account with more weekly headroom.
      if (aSecondary !== bSecondary) {
        return bSecondary - aSecondary;
      }

      // For near-equivalent accounts, consume the one that resets sooner first.
      if (aDeadline !== bDeadline) {
        return aDeadline - bDeadline;
      }

      return a.name.localeCompare(b.name);
    };

    return [...otherAccounts].sort((a, b) => {
      if (otherAccountsSort === "recommended_queue") {
        return compareRecommendedQueue(a, b);
      }

      if (otherAccountsSort === "deadline_asc" || otherAccountsSort === "deadline_desc") {
        const deadlineDiff =
          getResetDeadline(a.usage?.primary_resets_at) -
          getResetDeadline(b.usage?.primary_resets_at);
        if (deadlineDiff !== 0) {
          return otherAccountsSort === "deadline_asc" ? deadlineDiff : -deadlineDiff;
        }
        const remainingDiff =
          getRemainingPercent(b.usage?.primary_used_percent) -
          getRemainingPercent(a.usage?.primary_used_percent);
        if (remainingDiff !== 0) return remainingDiff;
        return a.name.localeCompare(b.name);
      }

      const remainingDiff =
        getRemainingPercent(b.usage?.primary_used_percent) -
        getRemainingPercent(a.usage?.primary_used_percent);
      if (otherAccountsSort === "remaining_desc" && remainingDiff !== 0) {
        return remainingDiff;
      }
      if (otherAccountsSort === "remaining_asc" && remainingDiff !== 0) {
        return -remainingDiff;
      }
      const deadlineDiff =
        getResetDeadline(a.usage?.primary_resets_at) -
        getResetDeadline(b.usage?.primary_resets_at);
      if (deadlineDiff !== 0) return deadlineDiff;
      return a.name.localeCompare(b.name);
    });
  }, [otherAccounts, otherAccountsSort]);

  const deadOtherAccounts = useMemo(() => {
    const getDeadResetDeadline = (account: typeof otherAccounts[number]) => {
      const exhaustedLimits = getExhaustedRateLimits(account.usage);
      const resetTimes = exhaustedLimits
        .map((limit) => limit.resetsAt ?? Number.POSITIVE_INFINITY);

      return resetTimes.length > 0
        ? Math.min(...resetTimes)
        : Number.POSITIVE_INFINITY;
    };

    return sortedOtherAccounts
      .filter((account) => getExhaustedRateLimits(account.usage).length > 0)
      .sort((a, b) => {
        const deadlineDiff = getDeadResetDeadline(a) - getDeadResetDeadline(b);
        if (deadlineDiff !== 0) return deadlineDiff;
        return a.name.localeCompare(b.name);
      });
  }, [otherAccounts, sortedOtherAccounts]);

  const liveOtherAccounts = useMemo(
    () =>
      sortedOtherAccounts.filter(
        (account) => getExhaustedRateLimits(account.usage).length === 0
      ),
    [sortedOtherAccounts]
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRefreshCountdownNow(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  const nextRefreshInSeconds = useMemo(() => {
    if (!nextAutoRefreshAt) {
      return Math.ceil(USAGE_AUTO_REFRESH_INTERVAL_MS / 1000);
    }

    return Math.max(0, Math.ceil((nextAutoRefreshAt - refreshCountdownNow) / 1000));
  }, [nextAutoRefreshAt, refreshCountdownNow]);

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="app-header sticky top-0 z-40">
        <div className="app-content mx-auto max-w-6xl px-6 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_max-content] md:items-center md:gap-4">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="brand-mark">
                <span>{">_"}</span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-[1.95rem] font-bold tracking-[-0.05em] text-[var(--text-strong)]">
                    Codex Switcher
                  </h1>
                  {processInfo && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium shadow-sm ${hasRunningProcesses
                          ? "bg-[rgba(255,240,210,0.92)] text-[#97622a] border-[rgba(255,205,131,0.44)]"
                          : "bg-[rgba(132,223,194,0.2)] text-[#2f8d76] border-[rgba(132,223,194,0.34)]"
                        }`}
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${hasRunningProcesses ? "bg-[#ffbf66]" : "bg-[var(--mint)]"
                          }`}
                      ></span>
                      <span>
                        {hasRunningProcesses
                          ? `Codex ${processInfo.count}개 실행 중`
                          : "Codex 실행 중 아님"}
                      </span>
                    </span>
                  )}
                </div>
                <p className="text-sm text-[var(--text-body)]">
                  Codex CLI 멀티 계정 관리자
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-start gap-2 shrink-0 md:ml-4 md:w-max md:flex-nowrap md:justify-end">
              <div className="flex flex-col items-center gap-1 shrink-0">
                <button
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="btn-base btn-secondary h-11 shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium"
                  title="등록된 모든 계정의 사용량 정보를 다시 조회합니다.
5시간 제한, 주간 제한, 크레딧 정보가 최신 값으로 갱신됩니다."
                >
                  {isRefreshing ? "↻ 새로고침 중..." : "↻ 전체 새로고침"}
                </button>
                <p className="text-[11px] font-medium text-[var(--text-soft)] whitespace-nowrap">
                  {nextRefreshInSeconds}초 후 새로고침 예정
                </p>
              </div>
              <button
                onClick={handleWarmupAll}
                disabled={isWarmingAll || accounts.length === 0}
                className="btn-base btn-secondary h-11 shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium"
                title="모든 계정으로 아주 작은 워밍업 요청을 보냅니다.
계정 상태를 한 번 깨우거나 점검할 때 쓰는 보조 기능입니다.
계정 전환에 꼭 필요한 기능은 아닙니다."
              >
                {isWarmingAll ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-pulse">⚡</span> 워밍업 중...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <span>⚡</span> 전체 워밍업
                  </span>
                )}
              </button>

              <div className="relative" ref={optionsMenuRef}>
                <button
                  onClick={() => {
                    setIsOptionsMenuOpen((prev) => !prev);
                  }}
                  className="btn-base btn-primary h-11 shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium"
                  title="계정 추가, 표시 설정, 백업, 텍스트 이동, 알림 설정을 한 곳에서 엽니다."
                >
                  옵션 ▾
                </button>
                {isOptionsMenuOpen && (
                  <div className="menu-surface absolute right-0 z-50 mt-2 w-60 rounded-2xl p-2">
                    <button
                      onClick={() => {
                        setIsOptionsMenuOpen(false);
                        setIsAddModalOpen(true);
                      }}
                      className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm"
                      title="새 ChatGPT 계정을 로그인으로 추가하거나
기존 auth.json 파일에서 계정을 가져옵니다."
                    >
                      + 계정 추가
                    </button>
                    <button
                      onClick={() => {
                        setManageDeleteConfirmId(null);
                        setIsOptionsMenuOpen(false);
                        setIsAccountManagerOpen(true);
                      }}
                      className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm"
                      title="등록된 계정을 확인하고 이 메뉴에서만 계정을 제거합니다."
                    >
                      계정 관리
                    </button>
                    {isTauriRuntime() && (
                      <button
                        onClick={() => {
                          setIsOptionsMenuOpen(false);
                          void hideWindowToTray();
                        }}
                        className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm"
                        title="현재 창을 숨기고 macOS 상단 트레이 아이콘에서 다시 열 수 있습니다."
                      >
                        트레이로 숨기기
                      </button>
                    )}
                      <button
                        onClick={() => {
                          setDraftPrivacyMode(privacyMode);
                          setDraftShowCredits(showCredits);
                          setDraftShowMaskToggle(showMaskToggle);
                          setDraftShowPlanBadge(showPlanBadge);
                          setIsOptionsMenuOpen(false);
                          setIsPrivacyModalOpen(true);
                        }}
                      className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm"
                      title="계정 이름과 이메일을 화면에 어떻게 표시할지 정합니다.
전체 표시, 흐리게 숨기기, 앞 3글자만 표시 중에서 고를 수 있습니다."
                    >
                      표시 설정
                    </button>
                    <button
                      onClick={() => {
                        setDraftUsageAlertSettings(usageAlertSettings);
                        setIsOptionsMenuOpen(false);
                        setIsUsageAlertModalOpen(true);
                        }}
                        className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm"
                        title="현재 사용 중인 계정의 사용량이 일정 수준 이하로 내려갔을 때
Windows/macOS 시스템 알림을 띄우는 기준을 설정합니다."
                      >
                        사용량 알림 설정
                      </button>
                    <button
                      onClick={() => {
                        setIsOptionsMenuOpen(false);
                        void handleExportSlimText();
                      }}
                      disabled={isExportingSlim}
                      className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm disabled:opacity-50"
                      title="등록된 계정을 긴 텍스트 형태로 내보냅니다.
파일 없이 다른 기기로 옮길 때 쓸 수 있지만 민감 정보가 포함되므로 주의가 필요합니다."
                    >
                      {isExportingSlim ? "문자열 만드는 중..." : "텍스트로 계정 내보내기"}
                    </button>
                    <button
                      onClick={() => {
                        setIsOptionsMenuOpen(false);
                        openImportSlimTextModal();
                      }}
                      disabled={isImportingSlim}
                      className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm disabled:opacity-50"
                      title="다른 기기에서 내보낸 계정 텍스트를 붙여넣어 가져옵니다.
기존 계정은 유지하고, 없는 계정만 추가합니다."
                    >
                      {isImportingSlim ? "불러오는 중..." : "텍스트로 계정 가져오기"}
                    </button>
                    <button
                      onClick={() => {
                        setIsOptionsMenuOpen(false);
                        void handleExportFullFile();
                      }}
                      disabled={isExportingFull || !hasAccounts}
                      className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm disabled:opacity-50"
                      title="현재 등록된 계정 목록과 활성 계정 상태를
.cswf 백업 파일로 저장합니다.
다른 PC로 옮길 때 가장 권장되는 방식입니다."
                    >
                      {isExportingFull ? "백업 만드는 중..." : "백업 파일 만들기"}
                    </button>
                    <button
                      onClick={() => {
                        setIsOptionsMenuOpen(false);
                        void handleImportFullFile();
                      }}
                      disabled={isImportingFull}
                      className="menu-item w-full rounded-xl px-3 py-2 text-left text-sm disabled:opacity-50"
                      title=".cswf 백업 파일을 읽어 현재 기기에 계정을 복원합니다.
이미 있는 계정은 유지하고, 없는 계정만 병합해서 추가합니다."
                    >
                      {isImportingFull ? "복원 중..." : "백업 파일 복원"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="app-content mx-auto max-w-6xl px-6 py-8">
        {loading && accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="mb-4 h-10 w-10 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent"></div>
            <p className="text-[var(--text-body)]">계정을 불러오는 중...</p>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <div className="mb-2 text-[#d85978]">계정을 불러오지 못했습니다</div>
            <p className="text-sm text-[var(--text-body)]">{error}</p>
          </div>
        ) : accounts.length === 0 ? (
          <div className="glass-panel-strong mx-auto max-w-2xl text-center py-16 px-8">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-[24px] bg-[linear-gradient(155deg,#c6c1ff_0%,#8caeff_46%,#5b68ff_100%)] text-white shadow-[0_16px_30px_rgba(106,124,234,0.2)]">
              <span className="text-3xl">👤</span>
            </div>
            <h2 className="mb-2 text-xl font-semibold text-[var(--text-strong)]">
              아직 등록된 계정이 없습니다
            </h2>
            <p className="mb-6 text-[var(--text-body)]">
              첫 Codex 계정을 추가하거나 백업 파일을 복원하세요
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => setIsAddModalOpen(true)}
                className="btn-base btn-primary px-6 py-3 text-sm font-medium"
              >
                계정 추가
              </button>
              <button
                onClick={() => {
                  void handleImportFullFile();
                }}
                disabled={isImportingFull}
                className="btn-base btn-secondary px-6 py-3 text-sm font-medium disabled:opacity-50"
              >
                {isImportingFull ? "복원 중..." : "백업 복원"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Active Account */}
            {activeAccount && (
              <section>
                <h2 className="section-label mb-4">
                  현재 사용 중인 계정
                </h2>
                <AccountCard
                  account={activeAccount}
                  onSwitch={() => { }}
                  onWarmup={() =>
                    handleWarmupAccount(activeAccount.id, activeAccount.name)
                  }
                  onRefresh={() => refreshSingleUsage(activeAccount.id)}
                      onRename={(newName) => renameAccount(activeAccount.id, newName)}
                      switching={switchingId === activeAccount.id}
                      switchDisabled={hasRunningProcesses ?? false}
                      warmingUp={isWarmingAll || warmingUpId === activeAccount.id}
                      masked={maskedAccounts.has(activeAccount.id)}
                      privacyMode={privacyMode}
                      showCredits={showCredits}
                      showMaskToggle={showMaskToggle}
                      showPlanBadge={showPlanBadge}
                      onToggleMask={() => toggleMask(activeAccount.id)}
                    />
              </section>
            )}

            {/* Other Accounts */}
            {liveOtherAccounts.length > 0 && (
              <section>
                <div className="flex items-center justify-between gap-3 mb-4">
                  <h2 className="section-label">
                    다른 계정 ({liveOtherAccounts.length})
                  </h2>
                  <div className="flex items-center gap-2">
                    <label htmlFor="other-accounts-sort" className="text-xs text-[var(--text-body)]">
                      정렬
                    </label>
                    <div className="relative">
                      <select
                        id="other-accounts-sort"
                        value={otherAccountsSort}
                        onChange={(e) =>
                          setOtherAccountsSort(
                            e.target.value as
                              | "recommended_queue"
                              | "deadline_asc"
                              | "deadline_desc"
                              | "remaining_desc"
                              | "remaining_asc"
                          )
                        }
                        className="select-shell appearance-none font-sans text-xs sm:text-sm font-medium pl-3 pr-9 py-2 rounded-xl shadow-sm transition-all"
                      >
                        <option value="recommended_queue">추천 대기열 순</option>
                        <option value="deadline_asc">리셋 빠른 순</option>
                        <option value="deadline_desc">리셋 늦은 순</option>
                        <option value="remaining_desc">
                          남은 비율 높은 순
                        </option>
                        <option value="remaining_asc">
                          남은 비율 낮은 순
                        </option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[var(--text-body)]">
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
      <UpdateChecker />

    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {liveOtherAccounts.map((account) => (
                    <AccountCard
                      key={account.id}
                      account={account}
                      onSwitch={() => handleSwitch(account.id)}
                      onWarmup={() => handleWarmupAccount(account.id, account.name)}
                      onRefresh={() => refreshSingleUsage(account.id)}
                      onRename={(newName) => renameAccount(account.id, newName)}
                      switching={switchingId === account.id}
                      switchDisabled={hasRunningProcesses ?? false}
                      warmingUp={isWarmingAll || warmingUpId === account.id}
                      masked={maskedAccounts.has(account.id)}
                      privacyMode={privacyMode}
                      showCredits={showCredits}
                      showMaskToggle={showMaskToggle}
                      showPlanBadge={showPlanBadge}
                      onToggleMask={() => toggleMask(account.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {deadOtherAccounts.length > 0 && (
              <section>
                <div className="mb-4">
                  <h2 className="section-label">
                    재사용 대기 중 ({deadOtherAccounts.length})
                  </h2>
                </div>
                <div className="dead-panel p-4 md:p-5">
                  <div className="grid grid-cols-1 gap-4">
                    {deadOtherAccounts.map((account) => (
                      <AccountCard
                        key={account.id}
                        account={account}
                        onSwitch={() => handleSwitch(account.id)}
                        onWarmup={() => handleWarmupAccount(account.id, account.name)}
                        onRefresh={() => refreshSingleUsage(account.id)}
                        onRename={(newName) => renameAccount(account.id, newName)}
                        switching={switchingId === account.id}
                        switchDisabled={hasRunningProcesses ?? false}
                        warmingUp={isWarmingAll || warmingUpId === account.id}
                        masked={maskedAccounts.has(account.id)}
                        privacyMode={privacyMode}
                        showCredits={showCredits}
                        showMaskToggle={showMaskToggle}
                        showPlanBadge={showPlanBadge}
                        onToggleMask={() => toggleMask(account.id)}
                      />
                    ))}
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
      </main>

        {/* Refresh Success Toast */}
        {refreshSuccess && (
          <div className="toast-success fixed bottom-6 left-1/2 z-[80] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-2xl px-4 py-3 text-center text-sm">
            <span>✓</span> 사용량을 새로고침했습니다
          </div>
        )}

        {/* Warm-up Toast */}
        {warmupToast && (
          <div
            className={`fixed bottom-6 left-1/2 z-[80] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl px-4 py-3 text-center text-sm ${
              warmupToast.isError
                ? "toast-error"
                : "toast-warning"
            }`}
          >
          {warmupToast.message}
        </div>
      )}

      {/* Add Account Modal */}
      <AddAccountModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onImportFile={importFromFile}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={completeOAuthLogin}
        onCancelOAuth={cancelOAuthLogin}
      />

      {isAccountManagerOpen && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center">
          <div className="modal-surface mx-4 w-full max-w-2xl rounded-[28px]">
            <div className="soft-divider flex items-center justify-between border-b p-5">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-strong)]">계정 관리</h2>
                <p className="mt-1 text-sm text-[var(--text-body)]">
                  계정 제거는 이 메뉴에서만 할 수 있습니다.
                </p>
              </div>
              <button
                onClick={() => {
                  setManageDeleteConfirmId(null);
                  setIsAccountManagerOpen(false);
                }}
                className="text-[var(--text-soft)] transition-colors hover:text-[var(--primary-strong)]"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
              {accounts.map((account) => {
                const isConfirming = manageDeleteConfirmId === account.id;
                const isDeleting = manageDeleteBusyId === account.id;

                return (
                  <div
                    key={account.id}
                    className="option-card flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-[var(--text-strong)]">
                          {account.name}
                        </p>
                        {account.is_active && (
                          <span className="inline-flex items-center rounded-full border border-[rgba(132,223,194,0.34)] bg-[rgba(132,223,194,0.2)] px-2 py-0.5 text-[11px] font-medium text-[#2f8d76]">
                            현재 사용 중
                          </span>
                        )}
                      </div>
                      {account.email && (
                        <p className="truncate text-sm text-[var(--text-body)]">{account.email}</p>
                      )}
                    </div>

                    <div className="shrink-0 flex items-center gap-2">
                      {isConfirming ? (
                        <>
                          <button
                            onClick={() => setManageDeleteConfirmId(null)}
                            disabled={isDeleting}
                            className="btn-base btn-secondary px-3 py-2 text-sm disabled:opacity-50"
                          >
                            취소
                          </button>
                          <button
                            onClick={() => {
                              void handleManagedDelete(account.id);
                            }}
                            disabled={isDeleting}
                            className="btn-base btn-danger px-3 py-2 text-sm disabled:opacity-50"
                          >
                            {isDeleting ? "제거 중..." : "정말 제거"}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setManageDeleteConfirmId(account.id)}
                          className="btn-base btn-danger px-3 py-2 text-sm"
                        >
                          제거
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {isPrivacyModalOpen && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center">
          <div className="modal-surface mx-4 w-full max-w-md rounded-[28px]">
            <div className="soft-divider flex items-center justify-between border-b p-5">
              <h2 className="text-lg font-semibold text-[var(--text-strong)]">표시 설정</h2>
              <button
                onClick={() => setIsPrivacyModalOpen(false)}
                className="text-[var(--text-soft)] transition-colors hover:text-[var(--primary-strong)]"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-sm text-[var(--text-body)]">
                모든 계정 카드에 공통으로 적용되는 이름/이메일 표시 방식입니다.
              </p>

              <label className="option-card flex cursor-pointer items-start gap-3 rounded-2xl p-4">
                <input
                  type="radio"
                  name="privacy-mode"
                  checked={draftPrivacyMode === "full"}
                  onChange={() => setDraftPrivacyMode("full")}
                  className="mt-1"
                />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--text-strong)]">전체 표시</p>
                  <p className="text-sm text-[var(--text-body)]">
                    계정 이름과 이메일을 원래대로 모두 표시합니다.
                  </p>
                </div>
              </label>

              <label className="option-card flex cursor-pointer items-start gap-3 rounded-2xl p-4">
                <input
                  type="radio"
                  name="privacy-mode"
                  checked={draftPrivacyMode === "blur"}
                  onChange={() => setDraftPrivacyMode("blur")}
                  className="mt-1"
                />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--text-strong)]">흐리게 숨기기</p>
                  <p className="text-sm text-[var(--text-body)]">
                    정보는 남겨 두되 바로 읽기 어렵게 흐리게 표시합니다.
                  </p>
                </div>
              </label>

              <label className="option-card flex cursor-pointer items-start gap-3 rounded-2xl p-4">
                <input
                  type="radio"
                  name="privacy-mode"
                  checked={draftPrivacyMode === "prefix3"}
                  onChange={() => setDraftPrivacyMode("prefix3")}
                  className="mt-1"
                />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--text-strong)]">앞 3글자만 표시</p>
                  <p className="text-sm text-[var(--text-body)]">
                    이름과 이메일의 앞 3글자만 보여주고 나머지는 `***`로 가립니다.
                  </p>
                </div>
              </label>

              <div className="option-card flex items-start justify-between gap-4 rounded-2xl p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--text-strong)]">크레딧 표시</p>
                  <p className="text-sm text-[var(--text-body)]">
                    계정 카드 아래의 `크레딧: ...` 표시를 보이거나 숨깁니다.
                  </p>
                </div>
                <label className="inline-flex items-center cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={draftShowCredits}
                    onChange={(e) => setDraftShowCredits(e.target.checked)}
                  />
                    <span className="toggle-track relative h-6 w-11 rounded-full">
                      <span className="toggle-thumb absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white peer-checked:translate-x-5" />
                    </span>
                </label>
              </div>

              <div className="option-card flex items-start justify-between gap-4 rounded-2xl p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--text-strong)]">눈 아이콘 표시</p>
                  <p className="text-sm text-[var(--text-body)]">
                    계정 카드 우측 상단의 눈 아이콘을 보이거나 숨깁니다.
                  </p>
                </div>
                <label className="inline-flex items-center cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={draftShowMaskToggle}
                    onChange={(e) => setDraftShowMaskToggle(e.target.checked)}
                  />
                    <span className="toggle-track relative h-6 w-11 rounded-full">
                      <span className="toggle-thumb absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white peer-checked:translate-x-5" />
                    </span>
                </label>
              </div>

              <div className="option-card flex items-start justify-between gap-4 rounded-2xl p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--text-strong)]">플랜 배지 표시</p>
                  <p className="text-sm text-[var(--text-body)]">
                    계정 카드 우측 상단의 `Team`, `Plus`, `Pro` 같은 플랜 표시를 보이거나 숨깁니다.
                  </p>
                </div>
                <label className="inline-flex items-center cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={draftShowPlanBadge}
                    onChange={(e) => setDraftShowPlanBadge(e.target.checked)}
                  />
                    <span className="toggle-track relative h-6 w-11 rounded-full">
                      <span className="toggle-thumb absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white peer-checked:translate-x-5" />
                    </span>
                </label>
              </div>
            </div>

            <div className="soft-divider flex gap-3 border-t p-5">
              <button
                onClick={() => setIsPrivacyModalOpen(false)}
                className="btn-base btn-secondary px-4 py-2.5 text-sm font-medium"
              >
                취소
              </button>
              <button
                onClick={savePrivacySettings}
                className="btn-base btn-primary px-4 py-2.5 text-sm font-medium"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}

      {isUsageAlertModalOpen && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center">
          <div className="modal-surface mx-4 w-full max-w-md rounded-[28px]">
            <div className="soft-divider flex items-center justify-between border-b p-5">
              <h2 className="text-lg font-semibold text-[var(--text-strong)]">사용량 알림 설정</h2>
              <button
                onClick={() => setIsUsageAlertModalOpen(false)}
                className="text-[var(--text-soft)] transition-colors hover:text-[var(--primary-strong)]"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-[var(--text-strong)]">현재 사용 중인 계정 알림</p>
                    <p className="text-sm text-[var(--text-body)]">
                      활성 계정의 5시간 제한 또는 주간 제한이 기준 이하로 내려가면 Windows/macOS 시스템 알림을 표시합니다.
                    </p>
                  </div>
                <label className="inline-flex items-center cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={draftUsageAlertSettings.enabled}
                    onChange={(e) =>
                      setDraftUsageAlertSettings((prev) => ({
                        ...prev,
                        enabled: e.target.checked,
                      }))
                    }
                  />
                    <span className="toggle-track relative h-6 w-11 rounded-full">
                      <span className="toggle-thumb absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white peer-checked:translate-x-5" />
                    </span>
                </label>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-[var(--text-strong)]">
                  알림 기준
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={100}
                    step={1}
                    value={draftUsageAlertSettings.thresholdPercent}
                    onChange={(e) =>
                      setDraftUsageAlertSettings((prev) => ({
                        ...prev,
                        thresholdPercent: clampUsageAlertThreshold(Number(e.target.value)),
                      }))
                    }
                    disabled={!draftUsageAlertSettings.enabled}
                    className="flex-1"
                  />
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={draftUsageAlertSettings.thresholdPercent}
                    onChange={(e) =>
                      setDraftUsageAlertSettings((prev) => ({
                        ...prev,
                        thresholdPercent: clampUsageAlertThreshold(Number(e.target.value)),
                      }))
                    }
                    disabled={!draftUsageAlertSettings.enabled}
                    className="field-shell w-20 rounded-lg px-3 py-2 text-sm disabled:bg-[rgba(230,235,247,0.84)] disabled:text-[var(--text-soft)]"
                  />
                  <span className="text-sm text-[var(--text-body)]">%</span>
                  </div>
                  <p className="text-xs text-[var(--text-body)]">
                    예: `20%`로 설정하면 남은 사용량이 20% 이하가 되는 순간 시스템 알림을 표시합니다.
                  </p>
                </div>
            </div>

              <div className="soft-divider flex gap-3 border-t p-5">
                <button
                  onClick={() => setIsUsageAlertModalOpen(false)}
                  className="btn-base btn-secondary px-4 py-2.5 text-sm font-medium"
                >
                  취소
                </button>
                <button
                  onClick={testUsageAlert}
                  className="btn-base btn-secondary px-4 py-2.5 text-sm font-medium"
                >
                  테스트 알림
                </button>
                <button
                  onClick={saveUsageAlertSettings}
                  className="btn-base btn-primary px-4 py-2.5 text-sm font-medium"
                >
                  저장
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import/Export Config Modal */}
      {isConfigModalOpen && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center">
          <div className="modal-surface mx-4 w-full max-w-2xl rounded-[28px]">
            <div className="soft-divider flex items-center justify-between border-b p-5">
              <h2 className="text-lg font-semibold text-[var(--text-strong)]">
                {configModalMode === "slim_export" ? "텍스트로 계정 내보내기" : "텍스트로 계정 가져오기"}
              </h2>
              <button
                onClick={() => setIsConfigModalOpen(false)}
                className="text-[var(--text-soft)] transition-colors hover:text-[var(--primary-strong)]"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-4">
              {configModalMode === "slim_import" ? (
                <p className="rounded-xl border border-[rgba(255,205,131,0.45)] bg-[rgba(255,243,218,0.9)] px-3 py-2 text-sm text-[#8a5c23]">
                  기존 계정은 그대로 두고, 없는 계정만 텍스트에서 추가로 가져옵니다.
                </p>
              ) : (
                <p className="text-sm text-[var(--text-body)]">
                  이 텍스트에는 계정 인증 정보가 들어 있습니다. 메신저나 메모장에 남기지 말고 바로 옮기는 용도로만 사용하세요.
                </p>
              )}
              <textarea
                value={configPayload}
                onChange={(e) => setConfigPayload(e.target.value)}
                readOnly={configModalMode === "slim_export"}
                placeholder={
                  configModalMode === "slim_export"
                    ? isExportingSlim
                      ? "생성 중..."
                      : "내보낸 계정 텍스트가 여기에 표시됩니다"
                    : "가져올 계정 텍스트를 여기에 붙여넣으세요"
                }
                className="textarea-shell h-48 w-full rounded-2xl px-4 py-3 font-mono text-sm"
              />
              {configModalError && (
                <div className="rounded-xl border border-[rgba(255,159,184,0.42)] bg-[rgba(255,236,242,0.9)] p-3 text-sm text-[#c25778]">
                  {configModalError}
                </div>
              )}
            </div>
            <div className="soft-divider flex gap-3 border-t p-5">
              <button
                onClick={() => setIsConfigModalOpen(false)}
                className="btn-base btn-secondary px-4 py-2.5 text-sm font-medium"
              >
                닫기
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
                      setConfigModalError("클립보드를 사용할 수 없습니다. 직접 복사하세요.");
                    }
                  }}
                  disabled={!configPayload || isExportingSlim}
                  className="btn-base btn-primary px-4 py-2.5 text-sm font-medium disabled:opacity-50"
                >
                  {configCopied ? "복사됨" : "텍스트 복사"}
                </button>
              ) : (
                <button
                  onClick={handleImportSlimText}
                  disabled={isImportingSlim}
                  className="btn-base btn-primary px-4 py-2.5 text-sm font-medium disabled:opacity-50"
                >
                  {isImportingSlim ? "불러오는 중..." : "없는 계정만 추가"}
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
