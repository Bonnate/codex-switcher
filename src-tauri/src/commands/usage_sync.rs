//! Git-based encrypted usage sync commands

use crate::auth::get_config_dir;
use crate::commands::usage::{
    add_usage, build_token_report_from_sessions_root, default_token_report_timezone,
    default_token_sessions_root, format_path_preview,
};
use crate::types::{
    SyncedTokenReportCache, TokenReportDay, TokenReportSession, TokenReportSummary,
    TokenReportWindow, TokenUsageBreakdown, UsageSyncSettings, UsageSyncSnapshot,
    UsageSyncAuthMode, UsageSyncSecureSecrets, UsageSyncStatus,
};

use anyhow::{Context, Result};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use keyring::{Entry, Error as KeyringError};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const USAGE_SYNC_SETTINGS_FILE_NAME: &str = "usage-sync.json";
const USAGE_SYNC_DIR_NAME: &str = "usage-sync";
const USAGE_SYNC_REPO_DIR_NAME: &str = "repo";
const USAGE_SYNC_CACHE_FILE_NAME: &str = "cache.json";
const USAGE_SYNC_LOG_FILE_NAME: &str = "usage-sync.log";
#[cfg(windows)]
const USAGE_SYNC_ASKPASS_WINDOWS_FILE_NAME: &str = "git-askpass.cmd";
#[cfg(unix)]
const USAGE_SYNC_ASKPASS_UNIX_FILE_NAME: &str = "git-askpass.sh";
const USAGE_LEDGER_DIR_NAME: &str = "usage-ledger";
const USAGE_SYNC_BRANCH_DEFAULT: &str = "main";
const USAGE_SYNC_CACHE_VERSION: u8 = 1;
const USAGE_SYNC_SNAPSHOT_VERSION: u8 = 1;
const USAGE_SYNC_FILE_MAGIC: &[u8; 4] = b"CSUL";
const USAGE_SYNC_FILE_VERSION: u8 = 1;
const USAGE_SYNC_SALT_LEN: usize = 16;
const USAGE_SYNC_NONCE_LEN: usize = 24;
const USAGE_SYNC_KDF_ITERATIONS: u32 = 210_000;
const USAGE_SYNC_LAST_7_DAYS: i64 = 7;
const USAGE_SYNC_LAST_35_DAYS: i64 = 35;
const USAGE_SYNC_RECENT_SESSION_LIMIT: usize = 12;
const USAGE_SYNC_SECRET_SERVICE: &str = "codex-switcher-usage-sync";
const USAGE_SYNC_SECRET_PAT_ACCOUNT: &str = "git-access-token";
const USAGE_SYNC_SECRET_PASSPHRASE_ACCOUNT: &str = "sync-passphrase";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct StoredSyncedTokenReportCache {
    version: u8,
    synced_at: DateTime<Utc>,
    report: TokenReportSummary,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct UsageSyncRuntimeContext {
    passphrase: String,
    git_access_token: Option<String>,
}

#[tauri::command]
pub async fn get_usage_sync_settings() -> Result<UsageSyncSettings, String> {
    tokio::task::spawn_blocking(load_or_create_usage_sync_settings)
        .await
        .map_err(|error| format!("사용량 동기화 설정을 불러오는 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_usage_sync_settings(
    settings: UsageSyncSettings,
) -> Result<UsageSyncSettings, String> {
    tokio::task::spawn_blocking(move || save_usage_sync_settings_internal(settings))
        .await
        .map_err(|error| format!("사용량 동기화 설정을 저장하는 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_cached_synced_token_report() -> Result<SyncedTokenReportCache, String> {
    tokio::task::spawn_blocking(build_cached_synced_token_report_response)
        .await
        .map_err(|error| format!("동기화된 토큰 리포트를 읽는 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn load_usage_sync_secure_secrets() -> Result<UsageSyncSecureSecrets, String> {
    tokio::task::spawn_blocking(load_usage_sync_secure_secrets_internal)
        .await
        .map_err(|error| format!("보안 저장소에서 사용량 동기화 비밀값을 읽는 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_usage_sync_secure_secrets(
    git_access_token: Option<String>,
    sync_passphrase: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        save_usage_sync_secure_secrets_internal(
            git_access_token.as_deref(),
            sync_passphrase.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("보안 저장소에 사용량 동기화 비밀값을 저장하는 작업이 중단되었습니다: {error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn refresh_synced_usage(passphrase: String) -> Result<SyncedTokenReportCache, String> {
    refresh_synced_usage_with_git_auth(passphrase, None).await
}

#[tauri::command]
pub async fn refresh_synced_usage_with_git_auth(
    passphrase: String,
    git_access_token: Option<String>,
) -> Result<SyncedTokenReportCache, String> {
    tokio::task::spawn_blocking(move || refresh_synced_usage_internal(passphrase, git_access_token))
        .await
        .map_err(|error| format!("원격 사용량을 다시 읽는 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sync_usage_now(passphrase: String) -> Result<SyncedTokenReportCache, String> {
    sync_usage_now_with_git_auth(passphrase, None).await
}

#[tauri::command]
pub async fn sync_usage_now_with_git_auth(
    passphrase: String,
    git_access_token: Option<String>,
) -> Result<SyncedTokenReportCache, String> {
    tokio::task::spawn_blocking(move || sync_usage_now_internal(passphrase, git_access_token))
        .await
        .map_err(|error| format!("사용량 동기화 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pull_usage_sync_repo(
    passphrase: String,
    git_access_token: Option<String>,
) -> Result<SyncedTokenReportCache, String> {
    refresh_synced_usage_with_git_auth(passphrase, git_access_token).await
}

#[tauri::command]
pub async fn push_usage_sync_repo(
    passphrase: String,
    git_access_token: Option<String>,
) -> Result<SyncedTokenReportCache, String> {
    sync_usage_now_with_git_auth(passphrase, git_access_token).await
}

#[tauri::command]
pub async fn auto_pull_usage_sync() -> Result<SyncedTokenReportCache, String> {
    tokio::task::spawn_blocking(auto_pull_usage_sync_internal)
        .await
        .map_err(|error| format!("자동 사용량 Pull 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn auto_sync_usage() -> Result<SyncedTokenReportCache, String> {
    tokio::task::spawn_blocking(auto_sync_usage_internal)
        .await
        .map_err(|error| format!("자동 사용량 동기화 작업이 중단되었습니다: {error}"))?
        .map_err(|error| error.to_string())
}

pub(crate) fn load_or_create_usage_sync_settings() -> Result<UsageSyncSettings> {
    let path = get_usage_sync_settings_file()?;
    if path.exists() {
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read usage sync settings: {}", path.display()))?;
        let mut settings: UsageSyncSettings = serde_json::from_str(&raw)
            .with_context(|| format!("Failed to parse usage sync settings: {}", path.display()))?;
        let changed = normalize_usage_sync_settings(&mut settings, None)?;
        if changed {
            write_usage_sync_settings(&settings)?;
        }
        return Ok(settings);
    }

    let mut settings = UsageSyncSettings {
        repo_url: String::new(),
        branch: USAGE_SYNC_BRANCH_DEFAULT.to_string(),
        device_id: String::new(),
        device_name: default_device_name(),
        report_timezone: default_token_report_timezone(),
        git_auth_mode: UsageSyncAuthMode::System,
        git_username: String::new(),
        ssh_private_key_path: String::new(),
    };
    normalize_usage_sync_settings(&mut settings, None)?;
    write_usage_sync_settings(&settings)?;
    Ok(settings)
}

fn save_usage_sync_settings_internal(mut settings: UsageSyncSettings) -> Result<UsageSyncSettings> {
    let current = load_or_create_usage_sync_settings()?;
    normalize_usage_sync_settings(&mut settings, Some(&current))?;

    let should_reset_repo =
        current.repo_url != settings.repo_url || current.branch != settings.branch;
    let should_reset_cache = should_reset_repo
        || current.report_timezone != settings.report_timezone
        || current.device_id != settings.device_id;

    write_usage_sync_settings(&settings)?;

    if should_reset_repo {
        remove_usage_sync_repo_dir()?;
    }
    if should_reset_cache {
        remove_cached_synced_token_report_file()?;
    }

    Ok(settings)
}

fn build_cached_synced_token_report_response() -> Result<SyncedTokenReportCache> {
    let settings = load_or_create_usage_sync_settings()?;
    let git_available = check_git_available().is_ok();
    let cached = load_cached_synced_token_report()?;

    Ok(match cached {
        Some(cache) => SyncedTokenReportCache {
            status: UsageSyncStatus {
                configured: !settings.repo_url.trim().is_empty(),
                git_available,
                cache_available: true,
                device_count: cache.report.device_count,
                warning_count: cache.warnings.len(),
                last_sync_at: Some(cache.synced_at),
                last_pull_performed: false,
                last_push_performed: false,
            },
            report: Some(cache.report),
            warnings: cache.warnings,
        },
        None => SyncedTokenReportCache {
            status: UsageSyncStatus {
                configured: !settings.repo_url.trim().is_empty(),
                git_available,
                cache_available: false,
                device_count: 0,
                warning_count: 0,
                last_sync_at: None,
                last_pull_performed: false,
                last_push_performed: false,
            },
            report: None,
            warnings: Vec::new(),
        },
    })
}

fn load_usage_sync_secure_secrets_internal() -> Result<UsageSyncSecureSecrets> {
    Ok(UsageSyncSecureSecrets {
        git_access_token: read_usage_sync_secret(USAGE_SYNC_SECRET_PAT_ACCOUNT)?,
        sync_passphrase: read_usage_sync_secret(USAGE_SYNC_SECRET_PASSPHRASE_ACCOUNT)?,
    })
}

fn save_usage_sync_secure_secrets_internal(
    git_access_token: Option<&str>,
    sync_passphrase: Option<&str>,
) -> Result<()> {
    write_usage_sync_secret(USAGE_SYNC_SECRET_PAT_ACCOUNT, git_access_token)?;
    write_usage_sync_secret(USAGE_SYNC_SECRET_PASSPHRASE_ACCOUNT, sync_passphrase)?;
    Ok(())
}

fn refresh_synced_usage_internal(
    passphrase: String,
    git_access_token: Option<String>,
) -> Result<SyncedTokenReportCache> {
    let passphrase = validate_usage_sync_passphrase(&passphrase)?;
    let settings = load_or_create_usage_sync_settings()?;
    append_usage_sync_log(&format!(
        "pull start auth_mode={:?} repo_configured={} branch={} token_present={} token_len={}",
        settings.git_auth_mode,
        !settings.repo_url.trim().is_empty(),
        settings.branch,
        git_access_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        git_access_token.as_deref().map(|value| value.len()).unwrap_or(0)
    ));
    validate_git_auth_session(&settings, git_access_token.as_deref())?;
    ensure_usage_sync_configured(&settings)?;
    ensure_git_available()?;
    let pull_performed = prepare_usage_sync_repo(&settings, git_access_token.as_deref())?;
    rebuild_cached_synced_usage_from_repo(&settings, passphrase, pull_performed, false)
}

fn sync_usage_now_internal(
    passphrase: String,
    git_access_token: Option<String>,
) -> Result<SyncedTokenReportCache> {
    let passphrase = validate_usage_sync_passphrase(&passphrase)?;
    let settings = load_or_create_usage_sync_settings()?;
    append_usage_sync_log(&format!(
        "push start auth_mode={:?} repo_configured={} branch={} token_present={} token_len={}",
        settings.git_auth_mode,
        !settings.repo_url.trim().is_empty(),
        settings.branch,
        git_access_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        git_access_token.as_deref().map(|value| value.len()).unwrap_or(0)
    ));
    validate_git_auth_session(&settings, git_access_token.as_deref())?;
    ensure_usage_sync_configured(&settings)?;
    ensure_git_available()?;

    let timezone = parse_usage_sync_timezone(&settings.report_timezone)?;
    let local_report = build_token_report_from_sessions_root(
        default_token_sessions_root()?,
        &timezone,
        "local",
        "이 기기 로그",
        1,
        None,
        0,
    )?;
    let snapshot = build_usage_sync_snapshot(&settings, &local_report);

    let mut pull_performed = prepare_usage_sync_repo(&settings, git_access_token.as_deref())?;
    let mut push_performed = false;

    if write_usage_sync_snapshot_if_changed(&settings, &snapshot, passphrase)? {
        let committed = commit_device_snapshot_if_needed(&settings, git_access_token.as_deref())?;
        if committed {
            match push_usage_sync_branch(&settings, git_access_token.as_deref()) {
                Ok(()) => {
                    push_performed = true;
                }
                Err(first_error) => {
                    pull_performed |= prepare_usage_sync_repo(&settings, git_access_token.as_deref())?;
                    if write_usage_sync_snapshot_if_changed(&settings, &snapshot, passphrase)?
                        && commit_device_snapshot_if_needed(&settings, git_access_token.as_deref())?
                    {
                        push_usage_sync_branch(&settings, git_access_token.as_deref())
                            .with_context(|| {
                                format!(
                                    "원격 저장소에 사용량 스냅샷을 push하지 못했습니다. 첫 시도 오류: {first_error:#}"
                                )
                            })?;
                        push_performed = true;
                    }
                }
            }
        } else {
            append_usage_sync_log("push skipped because snapshot commit was a no-op");
        }
    } else {
        append_usage_sync_log("push skipped because snapshot content is unchanged");
    }

    rebuild_cached_synced_usage_from_repo(&settings, passphrase, pull_performed, push_performed)
}

fn auto_pull_usage_sync_internal() -> Result<SyncedTokenReportCache> {
    let Some(context) = load_saved_usage_sync_runtime_context("startup-pull")? else {
        return build_cached_synced_token_report_response();
    };

    refresh_synced_usage_internal(context.passphrase, context.git_access_token)
}

fn auto_sync_usage_internal() -> Result<SyncedTokenReportCache> {
    let Some(context) = load_saved_usage_sync_runtime_context("auto-sync")? else {
        return build_cached_synced_token_report_response();
    };

    sync_usage_now_internal(context.passphrase, context.git_access_token)
}

pub(crate) fn run_usage_sync_shutdown_push_if_needed() -> Result<()> {
    let Some(context) = load_saved_usage_sync_runtime_context("shutdown-push")? else {
        return Ok(());
    };

    let _ = sync_usage_now_internal(context.passphrase, context.git_access_token)?;
    Ok(())
}

fn load_saved_usage_sync_runtime_context(
    reason: &str,
) -> Result<Option<UsageSyncRuntimeContext>> {
    let settings = load_or_create_usage_sync_settings()?;
    if settings.repo_url.trim().is_empty() {
        append_usage_sync_log(&format!("auto sync skipped ({reason}): repo not configured"));
        return Ok(None);
    }

    if check_git_available().is_err() {
        append_usage_sync_log(&format!("auto sync skipped ({reason}): git unavailable"));
        return Ok(None);
    }

    let secrets = load_usage_sync_secure_secrets_internal()?;
    let Some(passphrase) = secrets
        .sync_passphrase
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        append_usage_sync_log(&format!("auto sync skipped ({reason}): no saved passphrase"));
        return Ok(None);
    };

    let git_access_token = match settings.git_auth_mode {
        UsageSyncAuthMode::GithubPat => {
            let Some(token) = secrets
                .git_access_token
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            else {
                append_usage_sync_log(&format!("auto sync skipped ({reason}): no saved PAT"));
                return Ok(None);
            };
            Some(token)
        }
        _ => None,
    };

    if let Err(error) = validate_git_auth_session(&settings, git_access_token.as_deref()) {
        append_usage_sync_log(&format!(
            "auto sync skipped ({reason}): invalid auth session ({})",
            sanitize_usage_sync_log_text(&error.to_string())
        ));
        return Ok(None);
    }

    Ok(Some(UsageSyncRuntimeContext {
        passphrase,
        git_access_token,
    }))
}

fn normalize_usage_sync_settings(
    settings: &mut UsageSyncSettings,
    current: Option<&UsageSyncSettings>,
) -> Result<bool> {
    let original = settings.clone();

    settings.repo_url = settings.repo_url.trim().to_string();
    settings.branch = normalize_branch_name(&settings.branch);
    settings.device_id = if settings.device_id.trim().is_empty() {
        current
            .map(|value| value.device_id.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    } else {
        settings.device_id.trim().to_string()
    };
    settings.device_name = if settings.device_name.trim().is_empty() {
        current
            .map(|value| value.device_name.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(default_device_name)
    } else {
        settings.device_name.trim().to_string()
    };
    settings.report_timezone = if settings.report_timezone.trim().is_empty() {
        current
            .map(|value| value.report_timezone.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(default_token_report_timezone)
    } else {
        settings.report_timezone.trim().to_string()
    };
    settings.git_username = settings.git_username.trim().to_string();
    settings.ssh_private_key_path = settings.ssh_private_key_path.trim().to_string();
    settings.git_auth_mode = normalize_usage_sync_auth_mode(settings, current);

    parse_usage_sync_timezone(&settings.report_timezone)?;

    Ok(original.repo_url != settings.repo_url
        || original.branch != settings.branch
        || original.device_id != settings.device_id
        || original.device_name != settings.device_name
        || original.report_timezone != settings.report_timezone
        || original.git_auth_mode != settings.git_auth_mode
        || original.git_username != settings.git_username
        || original.ssh_private_key_path != settings.ssh_private_key_path)
}

fn ensure_usage_sync_configured(settings: &UsageSyncSettings) -> Result<()> {
    if settings.repo_url.trim().is_empty() {
        anyhow::bail!("먼저 사용량 동기화 저장소 주소를 입력하세요.");
    }

    Ok(())
}

fn validate_usage_sync_passphrase(passphrase: &str) -> Result<&str> {
    let passphrase = passphrase.trim();
    if passphrase.is_empty() {
        anyhow::bail!("동기화 암호를 입력하세요.");
    }
    Ok(passphrase)
}

fn validate_git_auth_session(
    settings: &UsageSyncSettings,
    git_access_token: Option<&str>,
) -> Result<()> {
    match settings.git_auth_mode {
        UsageSyncAuthMode::System => Ok(()),
        UsageSyncAuthMode::SshKeyFile => {
            if settings.ssh_private_key_path.trim().is_empty() {
                anyhow::bail!("SSH 키 파일 경로를 입력하세요.");
            }
            Ok(())
        }
        UsageSyncAuthMode::GithubPat => {
            if settings.git_username.trim().is_empty() {
                anyhow::bail!("GitHub 사용자 이름을 입력하세요.");
            }
            if git_access_token.unwrap_or("").trim().is_empty() {
                anyhow::bail!("GitHub 액세스 토큰을 입력하세요.");
            }
            Ok(())
        }
    }
}

fn normalize_usage_sync_auth_mode(
    settings: &UsageSyncSettings,
    current: Option<&UsageSyncSettings>,
) -> UsageSyncAuthMode {
    if current.is_none()
        && !settings.ssh_private_key_path.trim().is_empty()
        && settings.git_auth_mode == UsageSyncAuthMode::System
    {
        UsageSyncAuthMode::SshKeyFile
    } else {
        settings.git_auth_mode
    }
}

fn parse_usage_sync_timezone(value: &str) -> Result<Tz> {
    value
        .parse::<Tz>()
        .with_context(|| format!("지원하지 않는 시간대입니다: {value}"))
}

fn build_usage_sync_snapshot(
    settings: &UsageSyncSettings,
    report: &TokenReportSummary,
) -> UsageSyncSnapshot {
    let recent_sessions = report
        .recent_sessions
        .iter()
        .map(|session| TokenReportSession {
            session_id: session.session_id.clone(),
            cwd: None,
            cwd_preview: session
                .cwd_preview
                .clone()
                .or_else(|| session.cwd.as_deref().map(format_path_preview)),
            model_provider: session.model_provider.clone(),
            device_name: Some(settings.device_name.clone()),
            started_at: session.started_at,
            updated_at: session.updated_at,
            total_usage: session.total_usage.clone(),
            last_usage: session.last_usage.clone(),
        })
        .collect::<Vec<_>>();

    UsageSyncSnapshot {
        version: USAGE_SYNC_SNAPSHOT_VERSION,
        device_id: settings.device_id.clone(),
        device_name: settings.device_name.clone(),
        generated_at: report.generated_at,
        report_timezone: settings.report_timezone.clone(),
        today: report.today.clone(),
        last_7_days: report.last_7_days.clone(),
        last_30_days: report.last_30_days.clone(),
        daily_last_35_days: report.daily_last_35_days.clone(),
        recent_sessions,
    }
}

fn rebuild_cached_synced_usage_from_repo(
    settings: &UsageSyncSettings,
    passphrase: &str,
    last_pull_performed: bool,
    last_push_performed: bool,
) -> Result<SyncedTokenReportCache> {
    let synced_at = Utc::now();
    let (snapshots, warnings) = read_usage_sync_snapshots(settings, passphrase)?;

    if snapshots.is_empty() {
        remove_cached_synced_token_report_file()?;
        return Ok(SyncedTokenReportCache {
            status: UsageSyncStatus {
                configured: true,
                git_available: true,
                cache_available: false,
                device_count: 0,
                warning_count: warnings.len(),
                last_sync_at: Some(synced_at),
                last_pull_performed,
                last_push_performed,
            },
            report: None,
            warnings,
        });
    }

    let report = merge_usage_sync_snapshots(settings, &snapshots, &warnings, synced_at)?;
    save_cached_synced_token_report(&report, &warnings, synced_at)?;

    Ok(SyncedTokenReportCache {
        status: UsageSyncStatus {
            configured: true,
            git_available: true,
            cache_available: true,
            device_count: report.device_count,
            warning_count: warnings.len(),
            last_sync_at: Some(synced_at),
            last_pull_performed,
            last_push_performed,
        },
        report: Some(report),
        warnings,
    })
}

fn merge_usage_sync_snapshots(
    settings: &UsageSyncSettings,
    snapshots: &[UsageSyncSnapshot],
    warnings: &[String],
    synced_at: DateTime<Utc>,
) -> Result<TokenReportSummary> {
    let timezone = parse_usage_sync_timezone(&settings.report_timezone)?;
    let today = Utc::now().with_timezone(&timezone).date_naive();
    let last_35_days_start = today - Duration::days(USAGE_SYNC_LAST_35_DAYS - 1);
    let last_7_days_start = today - Duration::days(USAGE_SYNC_LAST_7_DAYS - 1);

    let mut today_window = TokenReportWindow {
        session_count: 0,
        total_usage: TokenUsageBreakdown::default(),
    };
    let mut last_7_days_window = TokenReportWindow {
        session_count: 0,
        total_usage: TokenUsageBreakdown::default(),
    };
    let mut last_30_days_window = TokenReportWindow {
        session_count: 0,
        total_usage: TokenUsageBreakdown::default(),
    };
    let mut generated_at = snapshots[0].generated_at;
    let mut daily_usage = BTreeMap::<NaiveDate, TokenUsageBreakdown>::new();
    let mut recent_sessions = Vec::<TokenReportSession>::new();

    for snapshot in snapshots {
        today_window.session_count += snapshot.today.session_count;
        add_usage(&mut today_window.total_usage, &snapshot.today.total_usage);
        last_7_days_window.session_count += snapshot.last_7_days.session_count;
        add_usage(&mut last_7_days_window.total_usage, &snapshot.last_7_days.total_usage);
        last_30_days_window.session_count += snapshot.last_30_days.session_count;
        add_usage(&mut last_30_days_window.total_usage, &snapshot.last_30_days.total_usage);
        generated_at = generated_at.max(snapshot.generated_at);

        for day in &snapshot.daily_last_35_days {
            let parsed_date = NaiveDate::parse_from_str(&day.date, "%Y-%m-%d")
                .with_context(|| format!("잘못된 일별 사용량 날짜입니다: {}", day.date))?;
            if parsed_date < last_35_days_start || parsed_date > today {
                continue;
            }

            let entry = daily_usage.entry(parsed_date).or_default();
            add_usage(entry, &day.total_usage);
        }

        for session in &snapshot.recent_sessions {
            let mut session = session.clone();
            if session.device_name.is_none() {
                session.device_name = Some(snapshot.device_name.clone());
            }
            if session.cwd_preview.is_none() {
                session.cwd_preview = session.cwd.as_deref().map(format_path_preview);
            }
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
    recent_sessions.truncate(USAGE_SYNC_RECENT_SESSION_LIMIT);

    let mut daily_last_35_days = Vec::new();
    let mut daily_last_7_days = Vec::new();
    for offset in 0..USAGE_SYNC_LAST_35_DAYS {
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
        source_kind: "synced".to_string(),
        source_label: "모두".to_string(),
        device_count: snapshots.len(),
        last_sync_at: Some(synced_at),
        warning_count: warnings.len(),
        sessions_root: settings.repo_url.clone(),
        scanned_session_files: snapshots.len(),
        sessions_with_usage: recent_sessions.len(),
        generated_at,
        today: today_window,
        last_7_days: last_7_days_window,
        last_30_days: last_30_days_window,
        daily_last_7_days,
        daily_last_35_days,
        recent_sessions,
    })
}

fn read_usage_sync_snapshots(
    settings: &UsageSyncSettings,
    passphrase: &str,
) -> Result<(Vec<UsageSyncSnapshot>, Vec<String>)> {
    let ledger_dir = get_usage_sync_repo_dir()?.join(USAGE_LEDGER_DIR_NAME);
    if !ledger_dir.exists() {
        return Ok((Vec::new(), Vec::new()));
    }

    let mut warnings = Vec::new();
    let mut snapshots = Vec::new();
    let mut saw_files = false;

    for entry in fs::read_dir(&ledger_dir)
        .with_context(|| format!("Failed to read usage ledger directory: {}", ledger_dir.display()))?
    {
        let entry = entry.with_context(|| format!("Failed to read {}", ledger_dir.display()))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("csul") {
            continue;
        }

        saw_files = true;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown.csul")
            .to_string();
        let bytes = fs::read(&path)
            .with_context(|| format!("Failed to read usage snapshot: {}", path.display()))?;

        match decode_usage_sync_snapshot(&bytes, passphrase) {
            Ok(snapshot) => {
                if snapshot.version != USAGE_SYNC_SNAPSHOT_VERSION {
                    warnings.push(format!(
                        "{file_name}: 지원하지 않는 스냅샷 버전 {}",
                        snapshot.version
                    ));
                    continue;
                }
                if snapshot.report_timezone != settings.report_timezone {
                    warnings.push(format!(
                        "{file_name}: 시간대가 맞지 않아 건너뛰었습니다 ({})",
                        snapshot.report_timezone
                    ));
                    continue;
                }
                snapshots.push(snapshot);
            }
            Err(error) => warnings.push(format!("{file_name}: 복호화 실패 ({error:#})")),
        }
    }

    if saw_files && snapshots.is_empty() {
        anyhow::bail!("동기화된 사용량 파일을 복호화하지 못했습니다. 동기화 암호를 확인하세요.");
    }

    Ok((snapshots, warnings))
}

fn prepare_usage_sync_repo(
    settings: &UsageSyncSettings,
    git_access_token: Option<&str>,
) -> Result<bool> {
    let repo_dir = get_usage_sync_repo_dir()?;
    if repo_dir.exists() && !repo_dir.join(".git").exists() {
        fs::remove_dir_all(&repo_dir)
            .with_context(|| format!("Failed to reset usage sync repo: {}", repo_dir.display()))?;
    }

    fs::create_dir_all(&repo_dir)
        .with_context(|| format!("Failed to create usage sync repo dir: {}", repo_dir.display()))?;

    run_git(&repo_dir, settings, git_access_token, &["init"])?;
    run_git(
        &repo_dir,
        settings,
        git_access_token,
        &["checkout", "-B", &settings.branch],
    )?;
    run_git(
        &repo_dir,
        settings,
        git_access_token,
        &["config", "user.name", "Codex Switcher"],
    )?;
    run_git(
        &repo_dir,
        settings,
        git_access_token,
        &["config", "user.email", "usage-sync@local"],
    )?;
    run_git(
        &repo_dir,
        settings,
        git_access_token,
        &["config", "commit.gpgsign", "false"],
    )?;
    ensure_usage_sync_remote(settings, git_access_token)?;

    let pull_performed = if remote_branch_exists(settings, git_access_token)? {
        run_git(
            &repo_dir,
            settings,
            git_access_token,
            &["fetch", "origin", &settings.branch],
        )?;
        run_git(
            &repo_dir,
            settings,
            git_access_token,
            &["reset", "--hard", &format!("origin/{}", settings.branch)],
        )?;
        run_git(
            &repo_dir,
            settings,
            git_access_token,
            &["checkout", "-B", &settings.branch],
        )?;
        true
    } else {
        run_git(
            &repo_dir,
            settings,
            git_access_token,
            &["checkout", "-B", &settings.branch],
        )?;
        false
    };

    Ok(pull_performed)
}

fn ensure_usage_sync_remote(
    settings: &UsageSyncSettings,
    git_access_token: Option<&str>,
) -> Result<()> {
    let repo_dir = get_usage_sync_repo_dir()?;
    let remotes_output = run_git_capture(&repo_dir, settings, git_access_token, &["remote"])?;
    let remotes_stdout = String::from_utf8_lossy(&remotes_output.stdout);
    let has_origin = remotes_stdout.lines().any(|line| line.trim() == "origin");

    if has_origin {
        run_git(
            &repo_dir,
            settings,
            git_access_token,
            &["remote", "set-url", "origin", &settings.repo_url],
        )?;
    } else {
        run_git(
            &repo_dir,
            settings,
            git_access_token,
            &["remote", "add", "origin", &settings.repo_url],
        )?;
    }

    Ok(())
}

fn remote_branch_exists(
    settings: &UsageSyncSettings,
    git_access_token: Option<&str>,
) -> Result<bool> {
    let repo_dir = get_usage_sync_repo_dir()?;
    let output = run_git_capture(
        &repo_dir,
        settings,
        git_access_token,
        &["ls-remote", "--heads", "origin", &settings.branch],
    )?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn write_usage_sync_snapshot_if_changed(
    settings: &UsageSyncSettings,
    snapshot: &UsageSyncSnapshot,
    passphrase: &str,
) -> Result<bool> {
    let repo_dir = get_usage_sync_repo_dir()?;
    let ledger_dir = repo_dir.join(USAGE_LEDGER_DIR_NAME);
    fs::create_dir_all(&ledger_dir)
        .with_context(|| format!("Failed to create usage ledger dir: {}", ledger_dir.display()))?;

    let file_path = ledger_dir.join(format!("{}.csul", settings.device_id));
    if file_path.exists() {
        match fs::read(&file_path) {
            Ok(existing) => match decode_usage_sync_snapshot(&existing, passphrase) {
                Ok(existing_snapshot)
                    if usage_sync_snapshots_match_for_sync(&existing_snapshot, snapshot) =>
                {
                    return Ok(false);
                }
                Ok(_) => {}
                Err(error) => append_usage_sync_log(&format!(
                    "snapshot comparison skipped device={} reason={}",
                    settings.device_id,
                    sanitize_usage_sync_log_text(&error.to_string())
                )),
            },
            Err(error) => append_usage_sync_log(&format!(
                "snapshot comparison read failed device={} reason={}",
                settings.device_id,
                sanitize_usage_sync_log_text(&error.to_string())
            )),
        }
    }

    let encrypted = encode_usage_sync_snapshot(snapshot, passphrase)?;
    fs::write(&file_path, encrypted)
        .with_context(|| format!("Failed to write usage snapshot: {}", file_path.display()))?;
    Ok(true)
}

fn usage_sync_snapshots_match_for_sync(
    left: &UsageSyncSnapshot,
    right: &UsageSyncSnapshot,
) -> bool {
    let normalized_left = left.clone();
    let mut normalized_right = right.clone();
    normalized_right.generated_at = normalized_left.generated_at;
    normalized_left == normalized_right
}

fn commit_device_snapshot_if_needed(
    settings: &UsageSyncSettings,
    git_access_token: Option<&str>,
) -> Result<bool> {
    let repo_dir = get_usage_sync_repo_dir()?;
    let relative_path = format!("{USAGE_LEDGER_DIR_NAME}/{}.csul", settings.device_id);
    run_git(&repo_dir, settings, git_access_token, &["add", &relative_path])?;

    let status = run_git_capture(
        &repo_dir,
        settings,
        git_access_token,
        &["status", "--short", "--", &relative_path],
    )?;
    if String::from_utf8_lossy(&status.stdout).trim().is_empty() {
        return Ok(false);
    }

    run_git(
        &repo_dir,
        settings,
        git_access_token,
        &[
            "commit",
            "-m",
            &format!(
                "Sync usage snapshot for {} ({})",
                settings.device_name, settings.device_id
            ),
        ],
    )?;

    Ok(true)
}

fn push_usage_sync_branch(
    settings: &UsageSyncSettings,
    git_access_token: Option<&str>,
) -> Result<()> {
    let repo_dir = get_usage_sync_repo_dir()?;
    run_git(
        &repo_dir,
        settings,
        git_access_token,
        &["push", "-u", "origin", &settings.branch],
    )
}

fn check_git_available() -> Result<()> {
    let output = command_output(None, None, None, "git", &["--version"])?;
    if output.status.success() {
        Ok(())
    } else {
        anyhow::bail!(
            "git 명령을 찾지 못했습니다: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
}

fn ensure_git_available() -> Result<()> {
    check_git_available().context("이 PC에서 git을 실행할 수 없습니다. git 설치와 인증 상태를 확인하세요.")
}

fn run_git(
    repo_dir: &Path,
    settings: &UsageSyncSettings,
    git_access_token: Option<&str>,
    args: &[&str],
) -> Result<()> {
    append_usage_sync_log(&format!(
        "git run cwd={} args={} auth_mode={:?} token_present={}",
        repo_dir.display(),
        sanitize_git_args_for_log(args),
        settings.git_auth_mode,
        git_access_token
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    ));
    let output = command_output(
        Some(repo_dir),
        Some(settings),
        git_access_token,
        "git",
        args,
    )?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    append_usage_sync_log(&format!(
        "git failed args={} code={:?} stderr_len={} stdout_len={}",
        sanitize_git_args_for_log(args),
        output.status.code(),
        stderr.trim().len(),
        stdout.trim().len()
    ));
    anyhow::bail!(
        "git {} 실패: {}{}{}",
        args.join(" "),
        stderr.trim(),
        if stderr.trim().is_empty() || stdout.trim().is_empty() {
            ""
        } else {
            " / "
        },
        stdout.trim()
    );
}

fn run_git_capture(
    repo_dir: &Path,
    settings: &UsageSyncSettings,
    git_access_token: Option<&str>,
    args: &[&str],
) -> Result<std::process::Output> {
    append_usage_sync_log(&format!(
        "git capture cwd={} args={} auth_mode={:?} token_present={}",
        repo_dir.display(),
        sanitize_git_args_for_log(args),
        settings.git_auth_mode,
        git_access_token
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    ));
    let output = command_output(
        Some(repo_dir),
        Some(settings),
        git_access_token,
        "git",
        args,
    )?;
    if output.status.success() {
        Ok(output)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        append_usage_sync_log(&format!(
            "git capture failed args={} code={:?} stderr_len={}",
            sanitize_git_args_for_log(args),
            output.status.code(),
            stderr.trim().len()
        ));
        anyhow::bail!("git {} 실패: {}", args.join(" "), stderr.trim());
    }
}

fn command_output(
    cwd: Option<&Path>,
    settings: Option<&UsageSyncSettings>,
    git_access_token: Option<&str>,
    program: &str,
    args: &[&str],
) -> Result<std::process::Output> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    apply_git_auth_environment(&mut command, settings, git_access_token)?;
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .output()
        .with_context(|| format!("Failed to run command: {program} {}", args.join(" ")))
}

fn append_usage_sync_log(message: &str) {
    let _ = append_usage_sync_log_impl(message);
}

fn append_usage_sync_log_impl(message: &str) -> Result<()> {
    let log_file = get_usage_sync_log_file()?;
    if let Some(parent) = log_file.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create usage sync log dir: {}", parent.display()))?;
    }

    if let Ok(metadata) = fs::metadata(&log_file) {
        if metadata.len() > 512 * 1024 {
            let bytes = fs::read(&log_file)
                .with_context(|| format!("Failed to read usage sync log: {}", log_file.display()))?;
            let keep_from = bytes.len().saturating_sub(200 * 1024);
            fs::write(&log_file, &bytes[keep_from..]).with_context(|| {
                format!("Failed to rotate usage sync log: {}", log_file.display())
            })?;
        }
    }

    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{timestamp}] {message}\n");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .with_context(|| format!("Failed to open usage sync log: {}", log_file.display()))?;
    file.write_all(line.as_bytes())
        .with_context(|| format!("Failed to write usage sync log: {}", log_file.display()))?;
    Ok(())
}

fn sanitize_usage_sync_log_text(value: &str) -> String {
    let single_line = value.replace('\r', " ").replace('\n', " ");
    let trimmed = single_line.trim();
    if trimmed.len() > 240 {
        format!("{}...", &trimmed[..240])
    } else {
        trimmed.to_string()
    }
}

fn sanitize_git_args_for_log(args: &[&str]) -> String {
    args.iter()
        .map(|value| {
            let trimmed = value.trim();
            if trimmed.starts_with("http://")
                || trimmed.starts_with("https://")
                || trimmed.starts_with("git@")
            {
                "[remote-url]".to_string()
            } else {
                sanitize_usage_sync_log_text(trimmed)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn apply_git_auth_environment(
    command: &mut Command,
    settings: Option<&UsageSyncSettings>,
    git_access_token: Option<&str>,
) -> Result<()> {
    command.env("GIT_TERMINAL_PROMPT", "0");

    let Some(settings) = settings else {
        return Ok(());
    };

    command.env_remove("GIT_ASKPASS");
    command.env_remove("CODEX_GIT_USERNAME");
    command.env_remove("CODEX_GIT_PAT");
    command.env_remove("GIT_SSH_COMMAND");
    command.env_remove("GIT_SSH_VARIANT");
    command.env_remove("GIT_CONFIG_COUNT");
    command.env_remove("GIT_CONFIG_KEY_0");
    command.env_remove("GIT_CONFIG_VALUE_0");
    command.env_remove("GIT_CONFIG_KEY_1");
    command.env_remove("GIT_CONFIG_VALUE_1");

    match settings.git_auth_mode {
        UsageSyncAuthMode::System => Ok(()),
        UsageSyncAuthMode::SshKeyFile => {
            let Some(ssh_key_path) =
                resolve_usage_sync_ssh_key_path(&settings.ssh_private_key_path)?
            else {
                anyhow::bail!("SSH 키 파일 경로를 입력하세요.");
            };

            command.env("GIT_SSH_COMMAND", build_git_ssh_command(&ssh_key_path));
            command.env("GIT_SSH_VARIANT", "ssh");
            Ok(())
        }
        UsageSyncAuthMode::GithubPat => {
            let git_access_token = git_access_token.unwrap_or("").trim();
            if git_access_token.is_empty() {
                anyhow::bail!("GitHub 액세스 토큰을 입력하세요.");
            }

            let askpass_script = ensure_usage_sync_askpass_script()?;
            command.env("GIT_ASKPASS", &askpass_script);
            command.env("CODEX_GIT_USERNAME", settings.git_username.trim());
            command.env("CODEX_GIT_PAT", git_access_token);
            command.env("GCM_INTERACTIVE", "Never");
            command.env("GIT_CONFIG_COUNT", "2");
            command.env("GIT_CONFIG_KEY_0", "credential.helper");
            command.env("GIT_CONFIG_VALUE_0", "");
            command.env("GIT_CONFIG_KEY_1", "core.askPass");
            command.env("GIT_CONFIG_VALUE_1", askpass_script);
            Ok(())
        }
    }
}

fn resolve_usage_sync_ssh_key_path(value: &str) -> Result<Option<PathBuf>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let path = PathBuf::from(trimmed);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .context("현재 작업 디렉터리를 확인하지 못했습니다.")?
            .join(path)
    };

    if !path.is_file() {
        anyhow::bail!("SSH 키 파일을 찾을 수 없습니다: {}", path.display());
    }

    Ok(Some(path))
}

fn build_git_ssh_command(path: &Path) -> String {
    let normalized_path = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('"', "\\\"");

    format!(
        "ssh -i \"{normalized_path}\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    )
}

fn ensure_usage_sync_askpass_script() -> Result<PathBuf> {
    let root_dir = get_usage_sync_root_dir()?;
    fs::create_dir_all(&root_dir)
        .with_context(|| format!("Failed to create usage sync dir: {}", root_dir.display()))?;

    #[cfg(windows)]
    let script_path = root_dir.join(USAGE_SYNC_ASKPASS_WINDOWS_FILE_NAME);
    #[cfg(unix)]
    let script_path = root_dir.join(USAGE_SYNC_ASKPASS_UNIX_FILE_NAME);

    #[cfg(windows)]
    let script_contents = "@echo off\r\nset PROMPT_TEXT=%*\r\necho %PROMPT_TEXT% | findstr /I \"username\" >nul\r\nif not errorlevel 1 (\r\n  echo %CODEX_GIT_USERNAME%\r\n  exit /b 0\r\n)\r\necho %CODEX_GIT_PAT%\r\n";
    #[cfg(unix)]
    let script_contents = "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$CODEX_GIT_USERNAME\" ;;\n  *) printf '%s\\n' \"$CODEX_GIT_PAT\" ;;\nesac\n";

    let needs_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != script_contents,
        Err(_) => true,
    };

    if needs_write {
        fs::write(&script_path, script_contents)
            .with_context(|| format!("Failed to write askpass script: {}", script_path.display()))?;
    }

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&script_path)
            .with_context(|| format!("Failed to stat askpass script: {}", script_path.display()))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script_path, permissions).with_context(|| {
            format!(
                "Failed to set executable permission on askpass script: {}",
                script_path.display()
            )
        })?;
    }

    Ok(script_path)
}

fn load_cached_synced_token_report() -> Result<Option<StoredSyncedTokenReportCache>> {
    let cache_file = get_usage_sync_cache_file()?;
    if !cache_file.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&cache_file)
        .with_context(|| format!("Failed to read synced usage cache: {}", cache_file.display()))?;
    let cache: StoredSyncedTokenReportCache = serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse synced usage cache: {}", cache_file.display()))?;

    if cache.version != USAGE_SYNC_CACHE_VERSION {
        anyhow::bail!("지원하지 않는 사용량 동기화 캐시 버전입니다: {}", cache.version);
    }

    Ok(Some(cache))
}

fn save_cached_synced_token_report(
    report: &TokenReportSummary,
    warnings: &[String],
    synced_at: DateTime<Utc>,
) -> Result<()> {
    let cache = StoredSyncedTokenReportCache {
        version: USAGE_SYNC_CACHE_VERSION,
        synced_at,
        report: report.clone(),
        warnings: warnings.to_vec(),
    };

    let cache_file = get_usage_sync_cache_file()?;
    if let Some(parent) = cache_file.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create usage sync cache dir: {}", parent.display()))?;
    }

    let raw = serde_json::to_string_pretty(&cache).context("Failed to serialize synced usage cache")?;
    fs::write(&cache_file, raw)
        .with_context(|| format!("Failed to write synced usage cache: {}", cache_file.display()))?;
    Ok(())
}

fn remove_cached_synced_token_report_file() -> Result<()> {
    let cache_file = get_usage_sync_cache_file()?;
    if cache_file.exists() {
        fs::remove_file(&cache_file)
            .with_context(|| format!("Failed to remove synced usage cache: {}", cache_file.display()))?;
    }
    Ok(())
}

fn remove_usage_sync_repo_dir() -> Result<()> {
    let repo_dir = get_usage_sync_repo_dir()?;
    if repo_dir.exists() {
        fs::remove_dir_all(&repo_dir)
            .with_context(|| format!("Failed to reset usage sync repo: {}", repo_dir.display()))?;
    }
    Ok(())
}

fn encode_usage_sync_snapshot(snapshot: &UsageSyncSnapshot, passphrase: &str) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(snapshot).context("Failed to serialize usage sync snapshot")?;
    let compressed = compress_bytes(&json).context("Failed to compress usage sync snapshot")?;

    let mut salt = [0_u8; USAGE_SYNC_SALT_LEN];
    let mut nonce = [0_u8; USAGE_SYNC_NONCE_LEN];
    let mut rng = rand::rng();
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);

    let key = derive_usage_sync_key(passphrase, &salt);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), compressed.as_slice())
        .map_err(|_| anyhow::anyhow!("Failed to encrypt usage sync snapshot"))?;

    let mut output = Vec::with_capacity(
        USAGE_SYNC_FILE_MAGIC.len() + 1 + USAGE_SYNC_SALT_LEN + USAGE_SYNC_NONCE_LEN + ciphertext.len(),
    );
    output.extend_from_slice(USAGE_SYNC_FILE_MAGIC);
    output.push(USAGE_SYNC_FILE_VERSION);
    output.extend_from_slice(&salt);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

fn decode_usage_sync_snapshot(bytes: &[u8], passphrase: &str) -> Result<UsageSyncSnapshot> {
    let minimum_len =
        USAGE_SYNC_FILE_MAGIC.len() + 1 + USAGE_SYNC_SALT_LEN + USAGE_SYNC_NONCE_LEN;
    if bytes.len() < minimum_len {
        anyhow::bail!("동기화 파일이 손상되었거나 잘렸습니다.");
    }

    if &bytes[..USAGE_SYNC_FILE_MAGIC.len()] != USAGE_SYNC_FILE_MAGIC {
        anyhow::bail!("동기화 파일 형식이 올바르지 않습니다.");
    }

    let version = bytes[USAGE_SYNC_FILE_MAGIC.len()];
    if version != USAGE_SYNC_FILE_VERSION {
        anyhow::bail!("지원하지 않는 동기화 파일 버전입니다: {version}");
    }

    let salt_start = USAGE_SYNC_FILE_MAGIC.len() + 1;
    let salt_end = salt_start + USAGE_SYNC_SALT_LEN;
    let nonce_end = salt_end + USAGE_SYNC_NONCE_LEN;
    let salt = &bytes[salt_start..salt_end];
    let nonce = &bytes[salt_end..nonce_end];
    let ciphertext = &bytes[nonce_end..];

    let key = derive_usage_sync_key(passphrase, salt);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| anyhow::anyhow!("동기화 암호가 맞지 않거나 파일이 손상되었습니다."))?;

    let json = decompress_bytes(&plaintext).context("Failed to decompress usage sync snapshot")?;
    serde_json::from_slice(&json).context("Failed to parse usage sync snapshot")
}

fn derive_usage_sync_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(
        passphrase.as_bytes(),
        salt,
        USAGE_SYNC_KDF_ITERATIONS,
        &mut key,
    );
    key
}

fn compress_bytes(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes)?;
    encoder.finish().context("Failed to finish compression")
}

fn decompress_bytes(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = ZlibDecoder::new(bytes);
    let mut output = Vec::new();
    decoder
        .read_to_end(&mut output)
        .context("Failed to read decompressed payload")?;
    Ok(output)
}

fn write_usage_sync_settings(settings: &UsageSyncSettings) -> Result<()> {
    let settings_file = get_usage_sync_settings_file()?;
    if let Some(parent) = settings_file.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create usage sync dir: {}", parent.display()))?;
    }

    let raw =
        serde_json::to_string_pretty(settings).context("Failed to serialize usage sync settings")?;
    fs::write(&settings_file, raw)
        .with_context(|| format!("Failed to write usage sync settings: {}", settings_file.display()))?;
    Ok(())
}

fn read_usage_sync_secret(account: &str) -> Result<Option<String>> {
    let entry = Entry::new(USAGE_SYNC_SECRET_SERVICE, account)
        .with_context(|| format!("보안 저장소 항목을 열지 못했습니다: {account}"))?;

    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(anyhow::anyhow!("보안 저장소에서 값을 읽지 못했습니다: {error}")),
    }
}

fn write_usage_sync_secret(account: &str, value: Option<&str>) -> Result<()> {
    let entry = Entry::new(USAGE_SYNC_SECRET_SERVICE, account)
        .with_context(|| format!("보안 저장소 항목을 열지 못했습니다: {account}"))?;

    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => entry
            .set_password(value)
            .map_err(|error| anyhow::anyhow!("보안 저장소에 값을 저장하지 못했습니다: {error}")),
        None => match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(anyhow::anyhow!(
                "보안 저장소에서 기존 값을 지우지 못했습니다: {error}"
            )),
        },
    }
}

fn normalize_branch_name(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        USAGE_SYNC_BRANCH_DEFAULT.to_string()
    } else {
        value.to_string()
    }
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| "This PC".to_string())
}

fn get_usage_sync_root_dir() -> Result<PathBuf> {
    Ok(get_config_dir()?.join(USAGE_SYNC_DIR_NAME))
}

fn get_usage_sync_settings_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join(USAGE_SYNC_SETTINGS_FILE_NAME))
}

fn get_usage_sync_repo_dir() -> Result<PathBuf> {
    Ok(get_usage_sync_root_dir()?.join(USAGE_SYNC_REPO_DIR_NAME))
}

fn get_usage_sync_cache_file() -> Result<PathBuf> {
    Ok(get_usage_sync_root_dir()?.join(USAGE_SYNC_CACHE_FILE_NAME))
}

fn get_usage_sync_log_file() -> Result<PathBuf> {
    Ok(get_usage_sync_root_dir()?.join(USAGE_SYNC_LOG_FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_usage(total_tokens: u64) -> TokenUsageBreakdown {
        TokenUsageBreakdown {
            input_tokens: total_tokens.saturating_sub(10),
            cached_input_tokens: 5,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens,
        }
    }

    fn sample_snapshot(device_id: &str, device_name: &str) -> UsageSyncSnapshot {
        UsageSyncSnapshot {
            version: USAGE_SYNC_SNAPSHOT_VERSION,
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
            generated_at: Utc::now(),
            report_timezone: "Asia/Seoul".to_string(),
            today: TokenReportWindow {
                session_count: 1,
                total_usage: sample_usage(100),
            },
            last_7_days: TokenReportWindow {
                session_count: 2,
                total_usage: sample_usage(300),
            },
            last_30_days: TokenReportWindow {
                session_count: 3,
                total_usage: sample_usage(600),
            },
            daily_last_35_days: (0..USAGE_SYNC_LAST_35_DAYS)
                .map(|offset| TokenReportDay {
                    date: (Utc::now().date_naive()
                        - Duration::days(USAGE_SYNC_LAST_35_DAYS - 1 - offset))
                    .format("%Y-%m-%d")
                    .to_string(),
                    total_usage: if offset == USAGE_SYNC_LAST_35_DAYS - 1 {
                        sample_usage(100)
                    } else {
                        TokenUsageBreakdown::default()
                    },
                })
                .collect(),
            recent_sessions: vec![TokenReportSession {
                session_id: format!("session-{device_id}"),
                cwd: None,
                cwd_preview: Some(".../repo/project".to_string()),
                model_provider: Some("openai".to_string()),
                device_name: Some(device_name.to_string()),
                started_at: Some(Utc::now()),
                updated_at: Some(Utc::now()),
                total_usage: sample_usage(100),
                last_usage: Some(sample_usage(10)),
            }],
        }
    }

    #[test]
    fn usage_sync_snapshot_round_trip_preserves_payload() {
        let snapshot = sample_snapshot("device-a", "Main");
        let encoded = encode_usage_sync_snapshot(&snapshot, "secret-pass").unwrap();
        let decoded = decode_usage_sync_snapshot(&encoded, "secret-pass").unwrap();

        assert_eq!(decoded.device_id, snapshot.device_id);
        assert_eq!(decoded.device_name, snapshot.device_name);
        assert_eq!(decoded.report_timezone, snapshot.report_timezone);
        assert_eq!(decoded.today.total_usage.total_tokens, 100);
    }

    #[test]
    fn usage_sync_snapshot_match_ignores_generated_at_only() {
        let snapshot_a = sample_snapshot("device-a", "Main");
        let mut snapshot_b = snapshot_a.clone();
        snapshot_b.generated_at = snapshot_b.generated_at + Duration::minutes(5);

        assert!(usage_sync_snapshots_match_for_sync(&snapshot_a, &snapshot_b));

        snapshot_b.device_name = "Changed".to_string();
        assert!(!usage_sync_snapshots_match_for_sync(&snapshot_a, &snapshot_b));
    }

    #[test]
    fn merge_usage_sync_snapshots_sums_device_totals() {
        let settings = UsageSyncSettings {
            repo_url: "https://example.com/repo.git".to_string(),
            branch: "main".to_string(),
            device_id: "device-a".to_string(),
            device_name: "Main".to_string(),
            report_timezone: "Asia/Seoul".to_string(),
            git_auth_mode: UsageSyncAuthMode::System,
            git_username: String::new(),
            ssh_private_key_path: String::new(),
        };

        let snapshot_a = sample_snapshot("device-a", "Main");
        let snapshot_b = sample_snapshot("device-b", "Sub");
        let report = merge_usage_sync_snapshots(
            &settings,
            &[snapshot_a, snapshot_b],
            &[],
            Utc::now(),
        )
        .unwrap();

        assert_eq!(report.source_kind, "synced");
        assert_eq!(report.device_count, 2);
        assert_eq!(report.today.total_usage.total_tokens, 200);
        assert_eq!(report.last_7_days.total_usage.total_tokens, 600);
    }

    #[test]
    fn build_git_ssh_command_quotes_private_key_path() {
        let command =
            build_git_ssh_command(Path::new(r"C:\Users\SUPERCENT\.ssh\id_ed25519"));

        assert!(command.contains("ssh -i \"C:/Users/SUPERCENT/.ssh/id_ed25519\""));
        assert!(command.contains("IdentitiesOnly=yes"));
    }
}
