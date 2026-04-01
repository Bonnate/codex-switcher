import type { UsageInfo } from "../types";

interface UsageBarProps {
  usage?: UsageInfo;
  loading?: boolean;
  showCredits?: boolean;
}

type RateLimitSummary = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
};

export type ExhaustedRateLimit = {
  label: string;
  windowMinutes?: number | null;
  resetsAt?: number | null;
};

function formatResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = resetAt - now;
  if (diff <= 0) return "지금";
  if (diff < 60) return `${diff}초`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분`;
  return `${Math.floor(diff / 3600)}시간 ${Math.floor((diff % 3600) / 60)}분`;
}

function formatExactResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "";

  const date = new Date(resetAt * 1000);
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
  const day = date.getDate();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = date.getHours() >= 12 ? "PM" : "AM";
  const hour12 = date.getHours() % 12 || 12;

  return `${month} ${day}, ${hour12}:${minutes} ${period}`;
}

function formatWindowDuration(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

function getRemainingPercent(usedPercent: number): number {
  return Math.max(0, 100 - usedPercent);
}

export function getExhaustedRateLimits(usage?: UsageInfo): ExhaustedRateLimit[] {
  if (!usage || usage.error) {
    return [];
  }

  const limits: RateLimitSummary[] = [];

  if (usage.primary_used_percent !== null && usage.primary_used_percent !== undefined) {
    limits.push({
      label: "5시간 제한",
      usedPercent: usage.primary_used_percent,
      remainingPercent: getRemainingPercent(usage.primary_used_percent),
      windowMinutes: usage.primary_window_minutes,
      resetsAt: usage.primary_resets_at,
    });
  }

  if (usage.secondary_used_percent !== null && usage.secondary_used_percent !== undefined) {
    limits.push({
      label: "주간 제한",
      usedPercent: usage.secondary_used_percent,
      remainingPercent: getRemainingPercent(usage.secondary_used_percent),
      windowMinutes: usage.secondary_window_minutes,
      resetsAt: usage.secondary_resets_at,
    });
  }

  return limits
    .filter((limit) => limit.remainingPercent <= 0)
    .map(({ label, windowMinutes, resetsAt }) => ({
      label,
      windowMinutes,
      resetsAt,
    }));
}

export function formatExhaustedRateLimitLine(limit: ExhaustedRateLimit): string {
  const windowLabel = formatWindowDuration(limit.windowMinutes);
  const resetLabel = formatResetTime(limit.resetsAt);
  const exactResetLabel = formatExactResetTime(limit.resetsAt);

  return [
    `${limit.label}${windowLabel ? ` (${windowLabel})` : ""}`,
    resetLabel ? `${resetLabel} 후 재사용` : "",
    resetLabel && exactResetLabel ? `(${exactResetLabel})` : "",
  ]
    .filter(Boolean)
    .join(" • ")
    .replace("후 재사용 • (", "후 재사용 (");
}

function RateLimitBar({
  label,
  usedPercent,
  windowMinutes,
  resetsAt,
}: {
  label: string;
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
}) {
  const remainingPercent = getRemainingPercent(usedPercent);
  const isExhausted = remainingPercent <= 0;
  
  // Color based on remaining (green = plenty left, red = almost none left)
  const colorClass =
    remainingPercent <= 10
      ? "bg-[linear-gradient(90deg,#ff96b2_0%,#ff789f_100%)]"
      : remainingPercent <= 30
        ? "bg-[linear-gradient(90deg,#ffd37c_0%,#ffb85b_100%)]"
        : "bg-[linear-gradient(90deg,#8fbbff_0%,#6f82ff_55%,#7f70ff_100%)]";

  const windowLabel = formatWindowDuration(windowMinutes);
  const resetLabel = formatResetTime(resetsAt);
  const exactResetLabel = formatExactResetTime(resetsAt);

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-[var(--text-body)]">
        <span>{label} {windowLabel && `(${windowLabel})`}</span>
        <span>
          {remainingPercent.toFixed(0)}% 남음
          {!isExhausted && resetLabel && ` • ${resetLabel} 후 초기화`}
          {!isExhausted && resetLabel && exactResetLabel && ` (${exactResetLabel})`}
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-[rgba(224,231,248,0.9)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.7)]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${colorClass}`}
          style={{ width: `${Math.min(remainingPercent, 100)}%` }}
        ></div>
      </div>
    </div>
  );
}

export function UsageBar({ usage, loading, showCredits = true }: UsageBarProps) {
  if (loading && !usage) {
    return (
      <div className="space-y-2">
        <div className="text-xs italic text-[var(--text-soft)] animate-pulse">
          사용량 불러오는 중...
        </div>
        <div className="h-2 rounded-full overflow-hidden bg-[rgba(224,231,248,0.86)] animate-pulse">
          <div className="h-full w-2/3 bg-[rgba(196,205,236,0.95)]"></div>
        </div>
        <div className="h-2 rounded-full overflow-hidden bg-[rgba(224,231,248,0.86)] animate-pulse">
          <div className="h-full w-1/2 bg-[rgba(196,205,236,0.95)]"></div>
        </div>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="py-1 text-xs italic text-[var(--text-soft)] animate-pulse">
        사용량 불러오는 중...
      </div>
    );
  }

  if (usage.error) {
    return (
      <div className="py-1 text-xs italic text-[var(--text-soft)]">
        {usage.error}
      </div>
    );
  }

  const hasPrimary = usage.primary_used_percent !== null && usage.primary_used_percent !== undefined;
  const hasSecondary = usage.secondary_used_percent !== null && usage.secondary_used_percent !== undefined;

  if (!hasPrimary && !hasSecondary) {
    return (
      <div className="py-1 text-xs italic text-[var(--text-soft)]">
        사용량 제한 정보를 불러오지 못했습니다
      </div>
    );
  }

  const limits: RateLimitSummary[] = [];

  if (hasPrimary) {
    limits.push({
      label: "5시간 제한",
      usedPercent: usage.primary_used_percent!,
      remainingPercent: getRemainingPercent(usage.primary_used_percent!),
      windowMinutes: usage.primary_window_minutes,
      resetsAt: usage.primary_resets_at,
    });
  }

  if (hasSecondary) {
    limits.push({
      label: "주간 제한",
      usedPercent: usage.secondary_used_percent!,
      remainingPercent: getRemainingPercent(usage.secondary_used_percent!),
      windowMinutes: usage.secondary_window_minutes,
      resetsAt: usage.secondary_resets_at,
    });
  }

  const availableLimits = limits.filter((limit) => limit.remainingPercent > 0);

  return (
    <div className="space-y-2">
      {availableLimits.map((limit) => (
        <RateLimitBar
          key={limit.label}
          label={limit.label}
          usedPercent={limit.usedPercent}
          windowMinutes={limit.windowMinutes}
          resetsAt={limit.resetsAt}
        />
      ))}
      {showCredits && usage.credits_balance && (
        <div className="text-xs text-[var(--text-body)]">
          크레딧: {usage.credits_balance}
        </div>
      )}
    </div>
  );
}
