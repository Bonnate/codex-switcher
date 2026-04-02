//! Usage query Tauri commands

use crate::api::usage::{get_account_usage, refresh_all_usage, warmup_account as send_warmup};
use crate::auth::{get_account, load_accounts};
use crate::commands::usage_sync::load_or_create_usage_sync_settings;
use crate::types::{
    TokenReportDay, TokenReportSession, TokenReportSummary, TokenReportWindow,
    TokenUsageBreakdown, UsageInfo, WarmupSummary,
};

use anyhow::Context;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use futures::{stream, StreamExt};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const TOKEN_REPORT_RECENT_SESSION_LIMIT: usize = 12;
const TOKEN_REPORT_LAST_7_DAYS: i64 = 7;
const TOKEN_REPORT_LAST_30_DAYS: i64 = 30;
const TOKEN_REPORT_LAST_35_DAYS: i64 = 35;

#[derive(Debug)]
struct TokenDeltaEvent {
    session_key: String,
    date: NaiveDate,
    usage: TokenUsageBreakdown,
}

#[derive(Debug)]
struct ParsedSession {
    session: Option<TokenReportSession>,
    delta_events: Vec<TokenDeltaEvent>,
}

/// Get usage info for a specific account
#[tauri::command]
pub async fn get_usage(account_id: String) -> Result<UsageInfo, String> {
    let account = get_account(&account_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Account not found: {account_id}"))?;

    get_account_usage(&account).await.map_err(|e| e.to_string())
}

/// Refresh usage info for all accounts
#[tauri::command]
pub async fn refresh_all_accounts_usage() -> Result<Vec<UsageInfo>, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    Ok(refresh_all_usage(&store.accounts).await)
}

/// Read local Codex session logs and summarize token usage
#[tauri::command]
pub async fn get_token_report() -> Result<TokenReportSummary, String> {
    let sessions_root = default_token_sessions_root().map_err(|e| e.to_string())?;
    let report_timezone = load_or_create_usage_sync_settings()
        .map(|settings| settings.report_timezone)
        .unwrap_or_else(|_| default_token_report_timezone());
    let timezone = report_timezone
        .parse::<Tz>()
        .unwrap_or(chrono_tz::UTC);

    tokio::task::spawn_blocking(move || {
        build_token_report_from_sessions_root(
            sessions_root,
            &timezone,
            "local",
            "이 기기 로그",
            1,
            None,
            0,
        )
    })
        .await
        .map_err(|error| format!("토큰 리포트를 읽는 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

/// Send a minimal warm-up request for one account
#[tauri::command]
pub async fn warmup_account(account_id: String) -> Result<(), String> {
    let account = get_account(&account_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Account not found: {account_id}"))?;

    send_warmup(&account).await.map_err(|e| e.to_string())
}

/// Send minimal warm-up requests for all accounts
#[tauri::command]
pub async fn warmup_all_accounts() -> Result<WarmupSummary, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    let total_accounts = store.accounts.len();
    let concurrency = total_accounts.min(10).max(1);

    let results: Vec<(String, bool)> = stream::iter(store.accounts.into_iter())
        .map(|account| async move {
            let account_id = account.id.clone();
            let failed = send_warmup(&account).await.is_err();
            (account_id, failed)
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    let failed_account_ids = results
        .into_iter()
        .filter_map(|(account_id, failed)| failed.then_some(account_id))
        .collect::<Vec<_>>();

    let warmed_accounts = total_accounts.saturating_sub(failed_account_ids.len());
    Ok(WarmupSummary {
        total_accounts,
        warmed_accounts,
        failed_account_ids,
    })
}

pub(crate) fn default_token_sessions_root() -> anyhow::Result<PathBuf> {
    dirs::home_dir()
        .map(|path| path.join(".codex").join("sessions"))
        .ok_or_else(|| anyhow::anyhow!("사용자 홈 디렉터리를 찾을 수 없습니다."))
}

pub(crate) fn default_token_report_timezone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

pub(crate) fn format_path_preview(value: &str) -> String {
    let parts = value
        .split(['\\', '/'])
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    if parts.len() <= 3 {
        return value.to_string();
    }

    format!(".../{}", parts[parts.len() - 3..].join("/"))
}

pub(crate) fn build_token_report_from_sessions_root(
    sessions_root: PathBuf,
    report_timezone: &Tz,
    source_kind: &str,
    source_label: &str,
    device_count: usize,
    last_sync_at: Option<DateTime<Utc>>,
    warning_count: usize,
) -> anyhow::Result<TokenReportSummary> {
    let generated_at = Utc::now();
    let today = generated_at.with_timezone(report_timezone).date_naive();
    let last_7_days_start = today - Duration::days(TOKEN_REPORT_LAST_7_DAYS - 1);
    let last_30_days_start = today - Duration::days(TOKEN_REPORT_LAST_30_DAYS - 1);
    let last_35_days_start = today - Duration::days(TOKEN_REPORT_LAST_35_DAYS - 1);

    if !sessions_root.exists() {
        return Ok(empty_token_report(
            sessions_root,
            generated_at,
            last_7_days_start,
            last_35_days_start,
            source_kind,
            source_label,
            device_count,
            last_sync_at,
            warning_count,
        ));
    }

    let mut today_usage = TokenUsageBreakdown::default();
    let mut last_7_days_usage = TokenUsageBreakdown::default();
    let mut last_30_days_usage = TokenUsageBreakdown::default();
    let mut today_sessions = HashSet::new();
    let mut last_7_days_sessions = HashSet::new();
    let mut last_30_days_sessions = HashSet::new();
    let mut daily_usage = BTreeMap::<NaiveDate, TokenUsageBreakdown>::new();
    let mut recent_sessions = Vec::new();

    let session_files = collect_session_files(&sessions_root)?;
    let scanned_session_files = session_files.len();

    for session_file in session_files {
        let parsed = parse_session_file(&session_file, report_timezone)
            .with_context(|| format!("Failed to parse {}", session_file.display()))?;

        for event in parsed.delta_events {
            if event.date == today {
                add_usage(&mut today_usage, &event.usage);
                today_sessions.insert(event.session_key.clone());
            }

            if event.date >= last_7_days_start {
                add_usage(&mut last_7_days_usage, &event.usage);
                last_7_days_sessions.insert(event.session_key.clone());
            }

            if event.date >= last_30_days_start {
                add_usage(&mut last_30_days_usage, &event.usage);
                last_30_days_sessions.insert(event.session_key.clone());
            }

            let entry = daily_usage.entry(event.date).or_default();
            add_usage(entry, &event.usage);
        }

        if let Some(session) = parsed.session {
            recent_sessions.push(session);
        }
    }

    recent_sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.started_at.cmp(&left.started_at))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    let sessions_with_usage = recent_sessions.len();
    recent_sessions.truncate(TOKEN_REPORT_RECENT_SESSION_LIMIT);

    let mut daily_last_7_days = Vec::new();
    let mut daily_last_35_days = Vec::new();
    for offset in 0..TOKEN_REPORT_LAST_35_DAYS {
        let date = last_35_days_start + Duration::days(offset);
        let day = TokenReportDay {
            date: date.format("%Y-%m-%d").to_string(),
            total_usage: daily_usage.get(&date).cloned().unwrap_or_default(),
        };
        if date >= last_7_days_start {
            daily_last_7_days.push(day.clone());
        }
        daily_last_35_days.push(day);
    }

    Ok(TokenReportSummary {
        source_kind: source_kind.to_string(),
        source_label: source_label.to_string(),
        device_count,
        last_sync_at,
        warning_count,
        sessions_root: sessions_root.display().to_string(),
        scanned_session_files,
        sessions_with_usage,
        generated_at,
        today: TokenReportWindow {
            session_count: today_sessions.len(),
            total_usage: today_usage,
        },
        last_7_days: TokenReportWindow {
            session_count: last_7_days_sessions.len(),
            total_usage: last_7_days_usage,
        },
        last_30_days: TokenReportWindow {
            session_count: last_30_days_sessions.len(),
            total_usage: last_30_days_usage,
        },
        daily_last_7_days,
        daily_last_35_days,
        recent_sessions,
    })
}

fn empty_token_report(
    sessions_root: PathBuf,
    generated_at: DateTime<Utc>,
    last_7_days_start: NaiveDate,
    last_35_days_start: NaiveDate,
    source_kind: &str,
    source_label: &str,
    device_count: usize,
    last_sync_at: Option<DateTime<Utc>>,
    warning_count: usize,
) -> TokenReportSummary {
    let mut daily_last_7_days = Vec::new();
    let mut daily_last_35_days = Vec::new();
    for offset in 0..TOKEN_REPORT_LAST_35_DAYS {
        let date = last_35_days_start + Duration::days(offset);
        let day = TokenReportDay {
            date: date.format("%Y-%m-%d").to_string(),
            total_usage: TokenUsageBreakdown::default(),
        };
        if date >= last_7_days_start {
            daily_last_7_days.push(day.clone());
        }
        daily_last_35_days.push(day);
    }

    TokenReportSummary {
        source_kind: source_kind.to_string(),
        source_label: source_label.to_string(),
        device_count,
        last_sync_at,
        warning_count,
        sessions_root: sessions_root.display().to_string(),
        scanned_session_files: 0,
        sessions_with_usage: 0,
        generated_at,
        today: TokenReportWindow {
            session_count: 0,
            total_usage: TokenUsageBreakdown::default(),
        },
        last_7_days: TokenReportWindow {
            session_count: 0,
            total_usage: TokenUsageBreakdown::default(),
        },
        last_30_days: TokenReportWindow {
            session_count: 0,
            total_usage: TokenUsageBreakdown::default(),
        },
        daily_last_7_days,
        daily_last_35_days,
        recent_sessions: Vec::new(),
    }
}

fn collect_session_files(sessions_root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut pending = vec![sessions_root.to_path_buf()];

    while let Some(path) = pending.pop() {
        let entries = fs::read_dir(&path)
            .with_context(|| format!("Failed to read directory {}", path.display()))?;

        for entry in entries {
            let entry = entry.with_context(|| format!("Failed to read {}", path.display()))?;
            let candidate = entry.path();
            if candidate.is_dir() {
                pending.push(candidate);
                continue;
            }

            if candidate
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("jsonl"))
            {
                files.push(candidate);
            }
        }
    }

    Ok(files)
}

fn parse_session_file(path: &Path, report_timezone: &Tz) -> anyhow::Result<ParsedSession> {
    let file = File::open(path).with_context(|| format!("Failed to open {}", path.display()))?;
    let reader = BufReader::new(file);

    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut model_provider: Option<String> = None;
    let mut started_at: Option<DateTime<Utc>> = None;
    let mut updated_at: Option<DateTime<Utc>> = None;
    let mut total_usage: Option<TokenUsageBreakdown> = None;
    let mut last_usage: Option<TokenUsageBreakdown> = None;
    let mut previous_total = None::<TokenUsageBreakdown>;
    let mut pending_delta_events = Vec::<(NaiveDate, TokenUsageBreakdown)>::new();

    for line in reader.lines() {
        let line = line.with_context(|| format!("Failed to read {}", path.display()))?;
        if line.trim().is_empty() {
            continue;
        }

        let payload: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let line_timestamp = payload
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp);

        match payload.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                let Some(meta) = payload.get("payload") else {
                    continue;
                };

                if session_id.is_none() {
                    session_id = meta
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                }

                if cwd.is_none() {
                    cwd = meta
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                }

                if model_provider.is_none() {
                    model_provider = meta
                        .get("model_provider")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                }

                if started_at.is_none() {
                    started_at = meta
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .and_then(parse_timestamp)
                        .or(line_timestamp);
                }
            }
            Some("event_msg") => {
                let Some(event_payload) = payload.get("payload") else {
                    continue;
                };

                if event_payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }

                let Some(info) = event_payload.get("info") else {
                    continue;
                };

                if info.is_null() {
                    continue;
                }

                let Some(current_total) = info
                    .get("total_token_usage")
                    .and_then(parse_usage_breakdown)
                else {
                    continue;
                };

                let delta_usage = previous_total
                    .as_ref()
                    .map(|previous| diff_usage(&current_total, previous))
                    .unwrap_or_else(|| current_total.clone());

                previous_total = Some(current_total.clone());
                total_usage = Some(current_total);
                last_usage = info.get("last_token_usage").and_then(parse_usage_breakdown);

                if let Some(timestamp) = line_timestamp {
                    updated_at = Some(
                        updated_at
                            .map(|current| current.max(timestamp))
                            .unwrap_or(timestamp),
                    );

                    if has_tokens(&delta_usage) {
                        pending_delta_events.push((
                            timestamp.with_timezone(report_timezone).date_naive(),
                            delta_usage,
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    let fallback_session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown-session")
        .to_string();
    let session_key = session_id.clone().unwrap_or(fallback_session_id);

    let delta_events = pending_delta_events
        .into_iter()
        .map(|(date, usage)| TokenDeltaEvent {
            session_key: session_key.clone(),
            date,
            usage,
        })
        .collect::<Vec<_>>();

    let cwd_preview = cwd.as_deref().map(format_path_preview);
    let session = total_usage.map(|usage| TokenReportSession {
        session_id: session_key,
        cwd,
        cwd_preview,
        model_provider,
        device_name: None,
        started_at,
        updated_at,
        total_usage: usage,
        last_usage,
    });

    Ok(ParsedSession {
        session,
        delta_events,
    })
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn parse_usage_breakdown(value: &Value) -> Option<TokenUsageBreakdown> {
    let object = value.as_object()?;
    Some(TokenUsageBreakdown {
        input_tokens: object.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
        cached_input_tokens: object
            .get("cached_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: object.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        reasoning_output_tokens: object
            .get("reasoning_output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        total_tokens: object.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn diff_usage(current: &TokenUsageBreakdown, previous: &TokenUsageBreakdown) -> TokenUsageBreakdown {
    TokenUsageBreakdown {
        input_tokens: current.input_tokens.saturating_sub(previous.input_tokens),
        cached_input_tokens: current
            .cached_input_tokens
            .saturating_sub(previous.cached_input_tokens),
        output_tokens: current.output_tokens.saturating_sub(previous.output_tokens),
        reasoning_output_tokens: current
            .reasoning_output_tokens
            .saturating_sub(previous.reasoning_output_tokens),
        total_tokens: current.total_tokens.saturating_sub(previous.total_tokens),
    }
}

pub(crate) fn add_usage(target: &mut TokenUsageBreakdown, value: &TokenUsageBreakdown) {
    target.input_tokens = target.input_tokens.saturating_add(value.input_tokens);
    target.cached_input_tokens = target
        .cached_input_tokens
        .saturating_add(value.cached_input_tokens);
    target.output_tokens = target.output_tokens.saturating_add(value.output_tokens);
    target.reasoning_output_tokens = target
        .reasoning_output_tokens
        .saturating_add(value.reasoning_output_tokens);
    target.total_tokens = target.total_tokens.saturating_add(value.total_tokens);
}

fn has_tokens(value: &TokenUsageBreakdown) -> bool {
    value.total_tokens > 0
        || value.input_tokens > 0
        || value.cached_input_tokens > 0
        || value.output_tokens > 0
        || value.reasoning_output_tokens > 0
}
