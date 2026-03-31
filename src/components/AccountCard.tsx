import { useState, useRef, useEffect } from "react";
import type { AccountWithUsage } from "../types";
import { UsageBar } from "./UsageBar";

interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onWarmup: () => Promise<void>;
  onDelete: () => void;
  onRefresh: () => Promise<void>;
  onRename: (newName: string) => Promise<void>;
  switching?: boolean;
  switchDisabled?: boolean;
  warmingUp?: boolean;
  masked?: boolean;
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

function BlurredText({ children, blur }: { children: React.ReactNode; blur: boolean }) {
  return (
    <span
      className={`transition-all duration-200 select-none ${blur ? "blur-sm" : ""}`}
      style={blur ? { userSelect: "none" } : undefined}
    >
      {children}
    </span>
  );
}

export function AccountCard({
  account,
  onSwitch,
  onWarmup,
  onDelete,
  onRefresh,
  onRename,
  switching,
  switchDisabled,
  warmingUp,
  masked = false,
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
    pro: "bg-indigo-50 text-indigo-700 border-indigo-200",
    plus: "bg-emerald-50 text-emerald-700 border-emerald-200",
    team: "bg-blue-50 text-blue-700 border-blue-200",
    enterprise: "bg-amber-50 text-amber-700 border-amber-200",
    free: "bg-gray-50 text-gray-600 border-gray-200",
    api_key: "bg-orange-50 text-orange-700 border-orange-200",
  };

  const planKey = account.plan_type?.toLowerCase() || "api_key";
  const planColorClass = planColors[planKey] || planColors.free;


  return (
    <div
      className={`relative rounded-xl border p-5 transition-all duration-200 ${
        account.is_active
          ? "bg-white border-emerald-400 shadow-sm"
          : "bg-white border-gray-200 hover:border-gray-300"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {account.is_active && (
              <span className="flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
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
                className="font-semibold text-gray-900 bg-gray-100 px-2 py-0.5 rounded border border-gray-300 focus:outline-none focus:border-gray-500 w-full"
              />
            ) : (
              <h3
                className="font-semibold text-gray-900 truncate cursor-pointer hover:text-gray-600"
                onClick={() => {
                  if (masked) return;
                  setEditName(account.name);
                  setIsEditing(true);
                }}
                title={
                  masked
                    ? undefined
                    : "클릭해서 이 계정의 표시 이름을 바꿉니다.\n실제 OpenAI 계정 정보가 바뀌는 것은 아니고,\n이 앱 안에서만 보이는 이름이 변경됩니다."
                }
              >
                <BlurredText blur={masked}>{account.name}</BlurredText>
              </h3>
            )}
          </div>
          {account.email && (
            <p className="text-sm text-gray-500 truncate">
              <BlurredText blur={masked}>{account.email}</BlurredText>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Eye toggle */}
          {onToggleMask && (
            <button
              onClick={onToggleMask}
              className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
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
          {/* Plan badge */}
          <span
            className={`px-2.5 py-1 text-xs font-medium rounded-full border ${planColorClass}`}
          >
            {planDisplay}
          </span>
        </div>
      </div>

      {/* Usage */}
      <div className="mb-3">
        <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} />
      </div>

      {/* Last refresh time */}
      <div className="text-xs text-gray-400 mb-3">
        마지막 갱신: {formatLastRefresh(lastRefresh)}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {account.is_active ? (
          <button
            disabled
            className="flex-1 px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-500 border border-gray-200 cursor-default"
          >
            ✓ 사용 중
          </button>
        ) : (
          <button
            onClick={onSwitch}
            disabled={switching || switchDisabled}
            className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
              switchDisabled
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-gray-900 hover:bg-gray-800 text-white"
            }`}
            title={
              switchDisabled
                ? "현재 Codex 프로세스가 실행 중이라 전환할 수 없습니다.\n먼저 실행 중인 Codex 세션을 종료한 뒤 다시 시도하세요."
                : "이 계정을 현재 활성 계정으로 전환합니다.\n전환되면 Codex CLI가 읽는 auth.json도 이 계정 기준으로 바뀝니다."
            }
          >
            {switching ? "전환 중..." : switchDisabled ? "Codex 실행 중" : "전환"}
          </button>
        )}
        <button
          onClick={() => {
            void onWarmup();
          }}
          disabled={warmingUp}
          className={`px-3 py-2 text-sm rounded-lg transition-colors ${
            warmingUp
              ? "bg-amber-100 text-amber-500"
              : "bg-amber-50 hover:bg-amber-100 text-amber-700"
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
          className={`px-3 py-2 text-sm rounded-lg transition-colors ${
            isRefreshing
              ? "bg-gray-200 text-gray-400"
              : "bg-gray-100 hover:bg-gray-200 text-gray-600"
          }`}
          title="이 계정의 사용량 정보를 다시 조회합니다.
5시간 제한, 주간 제한, 크레딧 표시를 최신 상태로 갱신합니다."
        >
          <span className={isRefreshing ? "animate-spin inline-block" : ""}>↻</span>
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-2 text-sm rounded-lg bg-red-50 hover:bg-red-100 text-red-600 transition-colors"
          title="이 계정을 Codex Switcher 목록에서 삭제합니다.
실제 OpenAI 계정이 삭제되는 것은 아닙니다.
삭제 확인을 위해 한 번 더 눌러야 적용됩니다."
        >
          ✕
        </button>
      </div>
    </div>
  );
}
