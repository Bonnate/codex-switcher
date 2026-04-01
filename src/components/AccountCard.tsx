import { useState, useRef, useEffect } from "react";
import type { AccountWithUsage } from "../types";
import {
  UsageBar,
  formatExhaustedRateLimitLine,
  getExhaustedRateLimits,
} from "./UsageBar";

interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onWarmup: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onRename: (newName: string) => Promise<void>;
  switching?: boolean;
  switchDisabled?: boolean;
  warmingUp?: boolean;
  masked?: boolean;
  privacyMode?: "full" | "blur" | "prefix3";
  showCredits?: boolean;
  showMaskToggle?: boolean;
  showPlanBadge?: boolean;
  onToggleMask?: () => void;
}

function formatLastRefresh(date: Date | null): string {
  if (!date) return "없음";
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 5) return "방금 전";
  if (diff < 60) return `${diff}초 전`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return date.toLocaleDateString();
}

function protectText(value: string, mode: "full" | "blur" | "prefix3"): string {
  if (mode !== "prefix3") return value;
  if (value.length <= 3) return value;
  return `${value.slice(0, 3)}***`;
}

function ProtectedText({
  value,
  mode,
}: {
  value: string;
  mode: "full" | "blur" | "prefix3";
}) {
  return (
    <span
      className={`transition-all duration-200 select-none ${mode === "blur" ? "blur-sm" : ""}`}
      style={mode === "blur" ? { userSelect: "none" } : undefined}
    >
      {protectText(value, mode)}
    </span>
  );
}

export function AccountCard({
  account,
  onSwitch,
  onWarmup,
  onRefresh,
  onRename,
  switching,
  switchDisabled,
  warmingUp,
  masked = false,
  privacyMode = "full",
  showCredits = true,
  showMaskToggle = true,
  showPlanBadge = true,
  onToggleMask,
}: AccountCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(
    account.usage && !account.usage.error ? new Date() : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
      setLastRefresh(new Date());
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== account.name) {
      try {
        await onRename(trimmed);
      } catch {
        setEditName(account.name);
      }
    } else {
      setEditName(account.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRename();
    } else if (e.key === "Escape") {
      setEditName(account.name);
      setIsEditing(false);
    }
  };

  const planDisplay = account.plan_type
    ? account.plan_type.charAt(0).toUpperCase() + account.plan_type.slice(1)
    : account.auth_mode === "api_key"
      ? "API Key"
      : "알 수 없음";

  const planColors: Record<string, string> = {
    pro: "bg-[rgba(145,140,255,0.14)] text-[var(--primary-strong)] border-[rgba(145,140,255,0.3)]",
    plus: "bg-[rgba(132,223,194,0.18)] text-[#2f8d76] border-[rgba(132,223,194,0.34)]",
    team: "bg-[rgba(146,216,255,0.18)] text-[#4466d8] border-[rgba(146,216,255,0.34)]",
    enterprise: "bg-[rgba(255,203,123,0.2)] text-[#946326] border-[rgba(255,203,123,0.34)]",
    free: "bg-[rgba(226,231,248,0.75)] text-[var(--text-body)] border-[rgba(186,195,233,0.4)]",
    api_key: "bg-[rgba(255,221,194,0.28)] text-[#ad6a3a] border-[rgba(255,191,143,0.42)]",
  };

  const planKey = account.plan_type?.toLowerCase() || "api_key";
  const planColorClass = planColors[planKey] || planColors.free;
  const effectivePrivacyMode: "full" | "blur" | "prefix3" = masked ? "blur" : privacyMode;
  const isPrivacyHidden = effectivePrivacyMode !== "full";
  const exhaustedLimits = getExhaustedRateLimits(account.usage);
  const isExhausted = exhaustedLimits.length > 0;

  return (
    <div
      className={`relative overflow-hidden rounded-[28px] border transition-all duration-200 backdrop-blur-xl ${
        account.is_active
          ? "glass-panel-strong border-[rgba(118,145,255,0.44)] shadow-[0_24px_56px_rgba(102,120,208,0.16)]"
          : isExhausted
            ? "bg-[rgba(243,246,255,0.8)] border-[rgba(187,196,228,0.38)] shadow-[0_16px_36px_rgba(131,146,204,0.09)]"
            : "glass-panel border-[rgba(177,190,236,0.44)] hover:border-[rgba(133,150,237,0.58)]"
      }`}
    >
      <div className={`card-header-surface px-5 ${isExhausted ? "pb-4 pt-5" : "pb-5 pt-5"}`}>
        <div className="relative flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {account.is_active && (
                <span className="flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-[var(--mint)] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--primary)]"></span>
                </span>
              )}
              {isEditing ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={handleRename}
                  onKeyDown={handleKeyDown}
                  className="field-shell w-full rounded-lg px-2 py-0.5 font-semibold text-[var(--text-strong)]"
                />
              ) : (
                <h3
                  className="cursor-pointer truncate text-[1.15rem] font-semibold tracking-[-0.03em] text-[var(--text-strong)] hover:text-[var(--primary-strong)]"
                  onClick={() => {
                    if (isPrivacyHidden) return;
                    setEditName(account.name);
                    setIsEditing(true);
                  }}
                  title={
                    isPrivacyHidden
                      ? undefined
                      : "클릭해서 이 계정의 표시 이름을 바꿉니다.\n실제 OpenAI 계정 정보가 바뀌는 것은 아니고,\n이 앱 안에서만 보이는 이름이 변경됩니다."
                  }
                >
                  <ProtectedText value={account.name} mode={effectivePrivacyMode} />
                </h3>
              )}
            </div>
            {account.email && (
              <p className="truncate text-sm text-[var(--text-body)]">
                <ProtectedText value={account.email} mode={effectivePrivacyMode} />
              </p>
            )}
          </div>

          {(showMaskToggle || showPlanBadge) && (
            <div className="flex items-center gap-2 rounded-full border border-[rgba(176,188,235,0.42)] bg-[rgba(255,255,255,0.68)] px-2 py-1 shadow-[0_8px_18px_rgba(126,141,204,0.08)] backdrop-blur-md">
            {showMaskToggle && onToggleMask && (
              <button
                onClick={onToggleMask}
                className="rounded-full p-1 text-[var(--text-soft)] transition-colors hover:bg-[rgba(236,241,255,0.82)] hover:text-[var(--primary-strong)]"
                title={
                  masked
                    ? "이 계정의 이름과 이메일을 다시 보이게 합니다."
                    : "이 계정의 이름과 이메일을 흐리게 숨깁니다.\n화면에는 남아 있지만 바로 읽기 어렵게 표시됩니다."
                }
              >
                {masked ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            )}
            {showPlanBadge && (
              <span
                className={`rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm ${planColorClass}`}
              >
                {planDisplay}
              </span>
            )}
          </div>
          )}
        </div>
      </div>

      <div className={`${isExhausted ? "card-body-surface-dead px-5 pb-4 pt-3" : "card-body-surface px-5 pb-5 pt-4"}`}>
        {!isExhausted && (
          <div className="mb-3">
            <UsageBar
              usage={account.usage}
              loading={isRefreshing || account.usageLoading}
              showCredits={showCredits}
            />
          </div>
        )}

        {!isExhausted ? (
          <>
            <div className="mb-3 text-xs text-[var(--text-soft)]">
              마지막 갱신: {formatLastRefresh(lastRefresh)}
            </div>

            <div className="flex gap-2">
            {account.is_active ? (
              <button
                disabled
                className="btn-base btn-secondary flex-1 cursor-default px-4 py-2 text-sm font-medium text-[var(--text-body)]"
              >
                ✓ 사용 중
              </button>
            ) : (
              <button
                onClick={onSwitch}
                disabled={switching || switchDisabled}
                className="btn-base btn-primary flex-1 px-4 py-2 text-sm font-medium disabled:opacity-50"
                title={
                  switchDisabled
                    ? "Codex가 실행 중이라 지금은 계정을 전환할 수 없습니다."
                    : "이 계정을 현재 활성 계정으로 전환합니다.\n전환되면 Codex CLI가 읽는 auth.json도 이 계정 기준으로 바뀝니다."
                }
              >
                {switching ? "전환 중..." : "전환"}
              </button>
            )}
            <button
              onClick={() => {
                void onWarmup();
              }}
              disabled={warmingUp}
              className={`btn-base px-3 py-2 text-sm ${
                warmingUp
                  ? "btn-accent opacity-70"
                  : "border border-[rgba(255,205,131,0.4)] bg-[rgba(255,245,223,0.92)] text-[#946326]"
              }`}
              title={
                warmingUp
                  ? "이 계정으로 워밍업 요청을 보내는 중입니다."
                  : "이 계정으로 아주 작은 워밍업 요청을 보냅니다.\n사용량 점검이나 상태 확인용 보조 기능입니다."
              }
            >
              ⚡
            </button>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className={`btn-base px-3 py-2 text-sm ${
                isRefreshing
                  ? "border border-[rgba(190,198,232,0.4)] bg-[rgba(226,231,248,0.95)] text-[var(--text-soft)]"
                  : "btn-secondary"
              }`}
              title="이 계정의 사용량 정보를 다시 조회합니다.
5시간 제한, 주간 제한, 크레딧 표시를 최신 상태로 갱신합니다."
            >
              <span className={isRefreshing ? "animate-spin inline-block" : ""}>↻</span>
            </button>
          </div>
          </>
        ) : (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-[rgba(186,195,233,0.34)] bg-[rgba(248,250,255,0.58)] px-3 py-2">
            <div className="min-w-0 text-xs text-[var(--text-soft)]">
              마지막 갱신: {formatLastRefresh(lastRefresh)}
            </div>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className={`btn-base shrink-0 px-3 py-2 text-sm ${
                isRefreshing
                  ? "border border-[rgba(190,198,232,0.4)] bg-[rgba(226,231,248,0.95)] text-[var(--text-soft)]"
                  : "btn-secondary"
              }`}
              title="이 계정의 사용량 정보를 다시 조회합니다.
5시간 제한, 주간 제한, 크레딧 표시를 최신 상태로 갱신합니다."
            >
              <span className={isRefreshing ? "animate-spin inline-block" : ""}>↻</span>
            </button>
          </div>
        )}

        {exhaustedLimits.length > 0 && (
          <div className="mt-3 border-t soft-divider pt-3">
            <div className="rounded-2xl border border-[rgba(186,195,233,0.48)] bg-[rgba(238,241,250,0.9)] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]">
              <div className="mb-2 text-[11px] font-semibold tracking-tight text-[var(--text-soft)]">
                재사용까지 남음
              </div>
              <div className="space-y-1.5">
                {exhaustedLimits.map((limit) => (
                  <div key={limit.label} className="text-xs font-medium text-[var(--text-body)]">
                    {formatExhaustedRateLimitLine(limit)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
