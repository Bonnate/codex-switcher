// Types matching the Rust backend

export type AuthMode = "api_key" | "chat_gpt";

export interface AccountInfo {
  id: string;
  name: string;
  email: string | null;
  plan_type: string | null;
  auth_mode: AuthMode;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface UsageInfo {
  account_id: string;
  plan_type: string | null;
  primary_used_percent: number | null;
  primary_window_minutes: number | null;
  primary_resets_at: number | null;
  secondary_used_percent: number | null;
  secondary_window_minutes: number | null;
  secondary_resets_at: number | null;
  has_credits: boolean | null;
  unlimited_credits: boolean | null;
  credits_balance: string | null;
  error: string | null;
}

export interface OAuthLoginInfo {
  auth_url: string;
  callback_port: number;
}

export interface AccountWithUsage extends AccountInfo {
  usage?: UsageInfo;
  usageLoading?: boolean;
}

export interface CodexProcessInfo {
  count: number;
  background_count: number;
  can_switch: boolean;
  pids: number[];
}

export interface WarmupSummary {
  total_accounts: number;
  warmed_accounts: number;
  failed_account_ids: string[];
}

export interface TokenUsageBreakdown {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface TokenReportWindow {
  session_count: number;
  total_usage: TokenUsageBreakdown;
}

export interface TokenReportDay {
  date: string;
  total_usage: TokenUsageBreakdown;
}

export interface TokenReportSession {
  session_id: string;
  cwd: string | null;
  cwd_preview: string | null;
  model_provider: string | null;
  device_name: string | null;
  started_at: string | null;
  updated_at: string | null;
  total_usage: TokenUsageBreakdown;
  last_usage: TokenUsageBreakdown | null;
}

export interface TokenReportSummary {
  source_kind: "local" | "synced";
  source_label: string;
  device_count: number;
  last_sync_at: string | null;
  warning_count: number;
  sessions_root: string;
  scanned_session_files: number;
  sessions_with_usage: number;
  generated_at: string;
  today: TokenReportWindow;
  last_7_days: TokenReportWindow;
  last_30_days: TokenReportWindow;
  daily_last_7_days: TokenReportDay[];
  daily_last_35_days: TokenReportDay[];
  recent_sessions: TokenReportSession[];
}

export type UsageSyncAuthMode = "system" | "ssh_key_file" | "github_pat";

export interface UsageSyncSettings {
  repo_url: string;
  branch: string;
  device_id: string;
  device_name: string;
  report_timezone: string;
  git_auth_mode: UsageSyncAuthMode;
  git_username: string;
  ssh_private_key_path: string;
}

export interface UsageSyncStatus {
  configured: boolean;
  git_available: boolean;
  cache_available: boolean;
  device_count: number;
  warning_count: number;
  last_sync_at: string | null;
}

export interface SyncedTokenReportCache {
  status: UsageSyncStatus;
  report: TokenReportSummary | null;
  warnings: string[];
}

export interface UsageSyncSecureSecrets {
  git_access_token: string | null;
  sync_passphrase: string | null;
}

export interface ImportAccountsSummary {
  total_in_payload: number;
  imported_count: number;
  skipped_count: number;
}
