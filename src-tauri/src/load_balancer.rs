use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, USER_AGENT};
use tiny_http::{Header, Request, Response as TinyResponse, Server, StatusCode};

use crate::api::usage::get_account_usage;
use crate::auth::{ensure_chatgpt_tokens_fresh, get_codex_home, load_accounts};
use crate::types::{
    AuthData, LoadBalancerSettings, LoadBalancerStatus, LoadBalancingStrategy, StoredAccount,
    UsageInfo,
};

const CHATGPT_BASE_URL: &str = "https://chatgpt.com";
const CODEX_PROXY_PREFIX: &str = "/backend-api/codex";
const CODEX_USER_AGENT: &str = "codex-cli/1.0.0";
const PROVIDER_KEY: &str = "codex-switcher-lb";
const SETTINGS_FILE_NAME: &str = "load-balancer.json";
const LOAD_BALANCER_USAGE_CACHE_TTL: Duration = Duration::from_secs(60);
const LOAD_BALANCER_USAGE_FETCH_TIMEOUT: Duration = Duration::from_secs(12);
const LOAD_BALANCER_UPSTREAM_TIMEOUT: Duration = Duration::from_secs(20);
const PRIMARY_WINDOW_MIN_REMAINING_PERCENT: f64 = 5.0;

struct RunningLoadBalancer {
    settings: LoadBalancerSettings,
    server: Arc<Server>,
    shutdown: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
struct LoadBalancerStats {
    requests_proxied: AtomicU64,
    last_account_name: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Clone)]
struct CachedUsageSnapshot {
    fetched_at: Instant,
    usage: UsageInfo,
}

#[derive(Clone)]
struct RoutedAccountCandidate {
    account: StoredAccount,
    priority: u32,
    primary_remaining_percent: f64,
    secondary_remaining_percent: f64,
}

static MANAGER: OnceLock<Mutex<Option<RunningLoadBalancer>>> = OnceLock::new();
static NEXT_ACCOUNT_INDEX: AtomicUsize = AtomicUsize::new(0);
static STATS: OnceLock<LoadBalancerStats> = OnceLock::new();
static USAGE_CACHE: OnceLock<Mutex<HashMap<String, CachedUsageSnapshot>>> = OnceLock::new();

fn manager() -> &'static Mutex<Option<RunningLoadBalancer>> {
    MANAGER.get_or_init(|| Mutex::new(None))
}

fn stats() -> &'static LoadBalancerStats {
    STATS.get_or_init(LoadBalancerStats::default)
}

fn usage_cache() -> &'static Mutex<HashMap<String, CachedUsageSnapshot>> {
    USAGE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_balancer_settings_file() -> Result<PathBuf> {
    Ok(crate::auth::get_config_dir()?.join(SETTINGS_FILE_NAME))
}

pub fn load_load_balancer_settings() -> Result<LoadBalancerSettings> {
    let path = load_balancer_settings_file()?;
    if !path.exists() {
        return Ok(LoadBalancerSettings::default());
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read load balancer settings: {}", path.display()))?;
    let mut settings: LoadBalancerSettings = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse load balancer settings: {}", path.display()))?;
    if settings.strategy == LoadBalancingStrategy::RoundRobin {
        settings.strategy = LoadBalancingStrategy::HighestRemaining;
    }
    Ok(settings)
}

pub fn save_load_balancer_settings(settings: &LoadBalancerSettings) -> Result<()> {
    let path = load_balancer_settings_file()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create config directory: {}", parent.display()))?;
    }

    let content = serde_json::to_string_pretty(settings)
        .context("Failed to serialize load balancer settings")?;
    fs::write(&path, content)
        .with_context(|| format!("Failed to write load balancer settings: {}", path.display()))?;
    Ok(())
}

pub fn get_load_balancer_status() -> Result<LoadBalancerStatus> {
    let settings = load_load_balancer_settings()?;
    let running = manager()
        .lock()
        .map_err(|_| anyhow::anyhow!("Load balancer state lock poisoned"))?
        .as_ref()
        .is_some_and(|state| state.settings.host == settings.host && state.settings.port == settings.port);

    build_status(settings, running)
}

pub fn autostart_load_balancer_if_enabled() -> Result<()> {
    let settings = load_load_balancer_settings()?;
    if settings.enabled {
        start_load_balancer_with_settings(settings)?;
    }
    Ok(())
}

pub fn start_load_balancer_with_settings(
    mut settings: LoadBalancerSettings,
) -> Result<LoadBalancerStatus> {
    let runtime = build_runtime()?;
    let eligible = eligible_accounts_for_routing(&runtime, &settings)?;
    if eligible.is_empty() {
        anyhow::bail!(
            "로드밸런싱 가능한 ChatGPT 계정이 없습니다. 5시간 제한이 5% 이하이거나, 주간 제한이 소진됐거나, 사용량 조회에 실패한 계정은 자동 제외됩니다"
        );
    }

    stop_load_balancer_inner()?;
    reset_stats();

    let address = format!("{}:{}", settings.host, settings.port);
    let server = Arc::new(Server::http(&address).map_err(|error| {
        anyhow::anyhow!("Failed to bind load balancer on {address}: {error}")
    })?);
    let thread_server = Arc::clone(&server);
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);
    let thread = thread::Builder::new()
        .name("codex-switcher-load-balancer".to_string())
        .spawn(move || run_server_loop(thread_server, thread_shutdown))
        .context("Failed to start load balancer thread")?;

    if settings.apply_codex_config {
        if let Err(error) = apply_load_balancer_codex_config(&mut settings) {
            shutdown.store(true, Ordering::Relaxed);
            server.unblock();
            let _ = thread.join();
            return Err(error);
        }
    }

    {
        let mut guard = manager()
            .lock()
            .map_err(|_| anyhow::anyhow!("Load balancer state lock poisoned"))?;
        *guard = Some(RunningLoadBalancer {
            settings: settings.clone(),
            server,
            shutdown,
            thread,
        });
    }

    build_status(settings, true)
}

pub fn stop_load_balancer() -> Result<LoadBalancerStatus> {
    let settings = load_load_balancer_settings()?;
    stop_load_balancer_with_settings(settings)
}

pub fn cleanup_load_balancer_for_exit() -> Result<()> {
    let settings = load_load_balancer_settings()?;
    stop_load_balancer_inner()?;

    if is_load_balancer_provider_selected()? {
        remove_load_balancer_codex_config(settings.previous_model_provider.as_deref())?;
    }

    Ok(())
}

pub fn stop_load_balancer_with_settings(
    mut settings: LoadBalancerSettings,
) -> Result<LoadBalancerStatus> {
    stop_load_balancer_inner()?;

    if is_load_balancer_provider_selected()? {
        remove_load_balancer_codex_config(settings.previous_model_provider.as_deref())?;
        settings.previous_model_provider = None;
    }

    build_status(settings, false)
}

fn stop_load_balancer_inner() -> Result<()> {
    let running = {
        let mut guard = manager()
            .lock()
            .map_err(|_| anyhow::anyhow!("Load balancer state lock poisoned"))?;
        guard.take()
    };

    if let Some(state) = running {
        state.shutdown.store(true, Ordering::Relaxed);
        state.server.unblock();
        let _ = state.thread.join();
    }

    Ok(())
}

fn build_status(settings: LoadBalancerSettings, running: bool) -> Result<LoadBalancerStatus> {
    let runtime = build_runtime()?;
    let all_eligible = collect_eligible_accounts(&runtime)?;
    let active_priority = all_eligible.first().map(|candidate| candidate.priority);
    let active_candidates: Vec<RoutedAccountCandidate> = all_eligible
        .iter()
        .filter(|candidate| Some(candidate.priority) == active_priority)
        .cloned()
        .collect();
    let deferred_account_count = all_eligible
        .iter()
        .filter(|candidate| Some(candidate.priority) != active_priority)
        .count();
    let last_account_name = stats()
        .last_account_name
        .lock()
        .map_err(|_| anyhow::anyhow!("Load balancer stats lock poisoned"))?
        .clone();
    let last_error = stats()
        .last_error
        .lock()
        .map_err(|_| anyhow::anyhow!("Load balancer stats lock poisoned"))?
        .clone();

    Ok(LoadBalancerStatus {
        endpoint_url: format!(
            "http://{}:{}{}",
            settings.host, settings.port, CODEX_PROXY_PREFIX
        ),
        eligible_account_count: active_candidates.len(),
        eligible_account_names: active_candidates
            .into_iter()
            .map(|candidate| candidate.account.name)
            .collect(),
        active_priority,
        deferred_account_count,
        codex_config_applied: is_load_balancer_codex_config_applied(&settings)?,
        requests_proxied: stats().requests_proxied.load(Ordering::Relaxed),
        last_account_name,
        last_error,
        settings,
        running,
    })
}

fn reset_stats() {
    stats().requests_proxied.store(0, Ordering::Relaxed);
    if let Ok(mut last_account_name) = stats().last_account_name.lock() {
        *last_account_name = None;
    }
    if let Ok(mut last_error) = stats().last_error.lock() {
        *last_error = None;
    }
}

fn set_last_error(message: impl Into<String>) {
    if let Ok(mut last_error) = stats().last_error.lock() {
        *last_error = Some(message.into());
    }
}

fn build_runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Failed to build load balancer runtime")
}

fn run_server_loop(server: Arc<Server>, shutdown: Arc<AtomicBool>) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            set_last_error(format!("Failed to start async runtime: {error}"));
            return;
        }
    };
    let client = match Client::builder()
        .connect_timeout(LOAD_BALANCER_UPSTREAM_TIMEOUT)
        .timeout(LOAD_BALANCER_UPSTREAM_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            set_last_error(format!("Failed to build HTTP client: {error}"));
            return;
        }
    };

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(request)) => {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(error) = handle_proxy_request(request, &client, &runtime) {
                    set_last_error(format!("{error:#}"));
                }
            }
            Ok(None) => {}
            Err(error) => {
                if error.kind() == std::io::ErrorKind::Other {
                    break;
                }
                set_last_error(format!("Load balancer receive loop failed: {error}"));
            }
        }
    }
}

fn handle_proxy_request(
    mut request: Request,
    client: &Client,
    runtime: &tokio::runtime::Runtime,
) -> Result<()> {
    let url = request.url().to_string();

    if request.method().as_str() == "GET" && url == "/health" {
        let body = serde_json::to_string(&serde_json::json!({ "ok": true }))
            .context("Failed to serialize health payload")?;
        let response = TinyResponse::from_string(body)
            .with_status_code(StatusCode(200))
            .with_header(build_header("Content-Type", "application/json; charset=utf-8")?);
        request.respond(response)?;
        return Ok(());
    }

    let upstream_path = normalize_upstream_path(&url);
    let upstream_url = format!("{CHATGPT_BASE_URL}{upstream_path}");
    let mut body = Vec::new();
    request
        .as_reader()
        .read_to_end(&mut body)
        .context("Failed to read proxy request body")?;

    let settings = current_running_settings()?;
    let fresh_account = select_next_account(runtime, &settings)?;
    let (access_token, account_id) = extract_chatgpt_auth(&fresh_account)?;

    let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
        .with_context(|| format!("Unsupported HTTP method: {}", request.method().as_str()))?;
    let mut builder = client.request(method, upstream_url);

    for header in request.headers() {
        let name = header.field.as_str().as_str();
        if should_skip_request_header(name) {
            continue;
        }
        builder = builder.header(name, header.value.as_str());
    }

    builder = builder
        .header(USER_AGENT, CODEX_USER_AGENT)
        .header(AUTHORIZATION, format!("Bearer {access_token}"));

    if let Some(chatgpt_account_id) = account_id {
        builder = builder.header("chatgpt-account-id", chatgpt_account_id);
    }

    let upstream_response = match builder.body(body).send() {
        Ok(response) => response,
        Err(error) => {
            let message = format!("Upstream request failed for {}: {error}", fresh_account.name);
            let response = TinyResponse::from_string(message.clone())
                .with_status_code(StatusCode(502))
                .with_header(build_header("Content-Type", "text/plain; charset=utf-8")?);
            request.respond(response)?;
            anyhow::bail!(message);
        }
    };

    stats().requests_proxied.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut last_account_name) = stats().last_account_name.lock() {
        *last_account_name = Some(fresh_account.name.clone());
    }
    if let Ok(mut last_error) = stats().last_error.lock() {
        *last_error = None;
    }

    let status_code = StatusCode(upstream_response.status().as_u16());
    let data_length = upstream_response
        .content_length()
        .and_then(|length| usize::try_from(length).ok());
    let headers = convert_response_headers(&upstream_response);
    let response = TinyResponse::new(status_code, headers, upstream_response, data_length, None).boxed();
    request.respond(response)?;
    Ok(())
}

fn normalize_upstream_path(url: &str) -> String {
    if url.starts_with(CODEX_PROXY_PREFIX) {
        return url.to_string();
    }

    if url.starts_with('/') {
        format!("{CODEX_PROXY_PREFIX}{url}")
    } else {
        format!("{CODEX_PROXY_PREFIX}/{url}")
    }
}

fn should_skip_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "host" | "connection" | "content-length"
    )
}

fn convert_response_headers(response: &reqwest::blocking::Response) -> Vec<Header> {
    response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            if matches!(
                name.as_str().to_ascii_lowercase().as_str(),
                "connection" | "content-length" | "transfer-encoding"
            ) {
                return None;
            }

            Header::from_bytes(name.as_str().as_bytes(), value.as_bytes()).ok()
        })
        .collect()
}

fn eligible_accounts() -> Result<Vec<StoredAccount>> {
    let store = load_accounts()?;
    Ok(store
        .accounts
        .into_iter()
        .filter(|account| matches!(account.auth_data, AuthData::ChatGPT { .. }))
        .collect())
}

fn eligible_accounts_for_routing(
    runtime: &tokio::runtime::Runtime,
    settings: &LoadBalancerSettings,
) -> Result<Vec<RoutedAccountCandidate>> {
    let mut eligible = collect_eligible_accounts(runtime)?;

    let active_priority = eligible.iter().map(|candidate| candidate.priority).min();
    if let Some(priority) = active_priority {
        eligible.retain(|candidate| candidate.priority == priority);
    }

    if settings.strategy == LoadBalancingStrategy::HighestRemaining {
        eligible.sort_by(|left, right| {
            left
                .priority
                .cmp(&right.priority)
                .then_with(|| {
                    right
                .primary_remaining_percent
                .total_cmp(&left.primary_remaining_percent)
                })
                .then_with(|| {
                    right
                        .secondary_remaining_percent
                        .total_cmp(&left.secondary_remaining_percent)
                })
                .then_with(|| left.account.name.cmp(&right.account.name))
        });
    }

    Ok(eligible)
}

fn collect_eligible_accounts(runtime: &tokio::runtime::Runtime) -> Result<Vec<RoutedAccountCandidate>> {
    let accounts = eligible_accounts()?;
    let mut eligible = Vec::new();

    for account in accounts {
        let usage = load_cached_or_fresh_usage(runtime, &account);
        if let Some(candidate) = to_routed_account_candidate(account, &usage) {
            eligible.push(candidate);
        }
    }

    eligible.sort_by(|left, right| {
        left
            .priority
            .cmp(&right.priority)
            .then_with(|| left.account.name.cmp(&right.account.name))
    });

    Ok(eligible)
}

fn load_cached_or_fresh_usage(
    runtime: &tokio::runtime::Runtime,
    account: &StoredAccount,
) -> UsageInfo {
    if let Ok(cache) = usage_cache().lock() {
        if let Some(snapshot) = cache.get(&account.id) {
            if snapshot.fetched_at.elapsed() <= LOAD_BALANCER_USAGE_CACHE_TTL {
                return snapshot.usage.clone();
            }
        }
    }

    let usage = match runtime.block_on(async {
        tokio::time::timeout(LOAD_BALANCER_USAGE_FETCH_TIMEOUT, get_account_usage(account)).await
    }) {
        Ok(Ok(usage)) => usage,
        Ok(Err(error)) => UsageInfo::error(account.id.clone(), error.to_string()),
        Err(_) => UsageInfo::error(
            account.id.clone(),
            format!(
                "Load balancer usage fetch timed out after {}s",
                LOAD_BALANCER_USAGE_FETCH_TIMEOUT.as_secs()
            ),
        ),
    };

    if let Ok(mut cache) = usage_cache().lock() {
        cache.insert(
            account.id.clone(),
            CachedUsageSnapshot {
                fetched_at: Instant::now(),
                usage: usage.clone(),
            },
        );
    }

    usage
}

fn to_routed_account_candidate(
    account: StoredAccount,
    usage: &UsageInfo,
) -> Option<RoutedAccountCandidate> {
    if usage.error.is_some() {
        return None;
    }

    let Some(primary_used_percent) = usage.primary_used_percent else {
        return None;
    };
    let primary_remaining_percent = remaining_percent(primary_used_percent);

    if primary_remaining_percent <= PRIMARY_WINDOW_MIN_REMAINING_PERCENT {
        return None;
    }

    let mut secondary_remaining_percent = 100.0;
    if let Some(secondary_used_percent) = usage.secondary_used_percent {
        secondary_remaining_percent = remaining_percent(secondary_used_percent);
        if secondary_remaining_percent <= 0.0 {
            return None;
        }
    }

    let priority = account.load_balancer_priority;

    Some(RoutedAccountCandidate {
        account,
        priority,
        primary_remaining_percent,
        secondary_remaining_percent,
    })
}

fn remaining_percent(used_percent: f64) -> f64 {
    (100.0 - used_percent).clamp(0.0, 100.0)
}

fn select_next_account(
    runtime: &tokio::runtime::Runtime,
    settings: &LoadBalancerSettings,
) -> Result<StoredAccount> {
    let accounts = eligible_accounts_for_routing(runtime, settings)?;
    if accounts.is_empty() {
        anyhow::bail!(
            "로드밸런싱 가능한 ChatGPT 계정이 없습니다. 5시간 제한이 5% 이하이거나, 주간 제한이 소진됐거나, 사용량 조회에 실패한 계정은 자동 제외됩니다"
        );
    }

    let selected = match settings.strategy {
        LoadBalancingStrategy::HighestRemaining => accounts[0].account.clone(),
        LoadBalancingStrategy::RoundRobin => {
            let index = NEXT_ACCOUNT_INDEX.fetch_add(1, Ordering::Relaxed);
            accounts[index % accounts.len()].account.clone()
        }
    };
    runtime
        .block_on(ensure_chatgpt_tokens_fresh(&selected))
        .with_context(|| format!("Failed to refresh tokens for {}", selected.name))
}

fn extract_chatgpt_auth(account: &StoredAccount) -> Result<(&str, Option<&str>)> {
    match &account.auth_data {
        AuthData::ChatGPT {
            access_token,
            account_id,
            ..
        } => Ok((access_token.as_str(), account_id.as_deref())),
        AuthData::ApiKey { .. } => anyhow::bail!("API key accounts are not supported by the built-in load balancer"),
    }
}

pub fn apply_load_balancer_codex_config(settings: &mut LoadBalancerSettings) -> Result<()> {
    let path = get_codex_home()?.join("config.toml");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create Codex config directory: {}", parent.display()))?;
    }

    let mut value = if path.exists() {
        let content = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read Codex config: {}", path.display()))?;
        if content.trim().is_empty() {
            toml::Value::Table(toml::Table::new())
        } else {
            toml::from_str(&content).context("Failed to parse Codex config TOML")?
        }
    } else {
        toml::Value::Table(toml::Table::new())
    };

    let root = ensure_table(&mut value);
    let current_provider = root
        .get("model_provider")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned);
    let previous_provider = if current_provider.as_deref() == Some(PROVIDER_KEY) {
        settings.previous_model_provider.clone()
    } else {
        current_provider
    };
    settings.previous_model_provider = previous_provider;
    root.insert(
        "model_provider".to_string(),
        toml::Value::String(PROVIDER_KEY.to_string()),
    );

    let providers = ensure_nested_table(root, "model_providers");
    let provider = ensure_nested_table(providers, PROVIDER_KEY);
    provider.insert("name".to_string(), toml::Value::String("OpenAI".to_string()));
    provider.insert(
        "base_url".to_string(),
        toml::Value::String(format!(
            "http://{}:{}{}",
            settings.host, settings.port, CODEX_PROXY_PREFIX
        )),
    );
    provider.insert(
        "wire_api".to_string(),
        toml::Value::String("responses".to_string()),
    );
    provider.insert("supports_websockets".to_string(), toml::Value::Boolean(false));
    provider.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(false),
    );

    let serialized = toml::to_string_pretty(&value).context("Failed to serialize Codex config")?;
    fs::write(&path, serialized)
        .with_context(|| format!("Failed to write Codex config: {}", path.display()))?;
    Ok(())
}

pub fn remove_load_balancer_codex_config(previous_model_provider: Option<&str>) -> Result<()> {
    let path = get_codex_home()?.join("config.toml");
    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read Codex config: {}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(());
    }

    let mut value: toml::Value =
        toml::from_str(&content).context("Failed to parse Codex config TOML")?;
    let root = ensure_table(&mut value);

    if root
        .get("model_provider")
        .and_then(|value| value.as_str())
        .is_some_and(|provider| provider == PROVIDER_KEY)
    {
        if let Some(previous_provider) = previous_model_provider {
            root.insert(
                "model_provider".to_string(),
                toml::Value::String(previous_provider.to_string()),
            );
        } else {
            root.remove("model_provider");
        }
    }

    if let Some(model_providers) = root
        .get_mut("model_providers")
        .and_then(toml::Value::as_table_mut)
    {
        model_providers.remove(PROVIDER_KEY);
    }

    let serialized = toml::to_string_pretty(&value).context("Failed to serialize Codex config")?;
    fs::write(&path, serialized)
        .with_context(|| format!("Failed to write Codex config: {}", path.display()))?;
    Ok(())
}

fn is_load_balancer_provider_selected() -> Result<bool> {
    let path = get_codex_home()?.join("config.toml");
    if !path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read Codex config: {}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(false);
    }

    let value: toml::Value =
        toml::from_str(&content).context("Failed to parse Codex config TOML")?;
    let root = value
        .as_table()
        .context("Codex config root is not a TOML table")?;

    Ok(root
        .get("model_provider")
        .and_then(|value| value.as_str())
        .is_some_and(|provider| provider == PROVIDER_KEY))
}

fn is_load_balancer_codex_config_applied(settings: &LoadBalancerSettings) -> Result<bool> {
    let path = get_codex_home()?.join("config.toml");
    if !path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read Codex config: {}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(false);
    }

    let value: toml::Value =
        toml::from_str(&content).context("Failed to parse Codex config TOML")?;
    let root = value
        .as_table()
        .context("Codex config root is not a TOML table")?;

    let provider_matches = root
        .get("model_provider")
        .and_then(|value| value.as_str())
        .is_some_and(|provider| provider == PROVIDER_KEY);
    let base_url_matches = root
        .get("model_providers")
        .and_then(|value| value.as_table())
        .and_then(|providers| providers.get(PROVIDER_KEY))
        .and_then(|provider| provider.as_table())
        .and_then(|provider| provider.get("base_url"))
        .and_then(|value| value.as_str())
        .is_some_and(|value| {
            value == format!(
                "http://{}:{}{}",
                settings.host, settings.port, CODEX_PROXY_PREFIX
            )
        });

    Ok(provider_matches && base_url_matches)
}

fn ensure_table(value: &mut toml::Value) -> &mut toml::Table {
    if !value.is_table() {
        *value = toml::Value::Table(toml::Table::new());
    }
    value.as_table_mut().expect("table just created")
}

fn ensure_nested_table<'a>(table: &'a mut toml::Table, key: &str) -> &'a mut toml::Table {
    let value = table
        .entry(key.to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    if !value.is_table() {
        *value = toml::Value::Table(toml::Table::new());
    }
    value.as_table_mut().expect("nested table just created")
}

fn build_header(name: &str, value: &str) -> Result<Header> {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .map_err(|_| anyhow::anyhow!("Invalid header {name}: {value}"))
}

fn current_running_settings() -> Result<LoadBalancerSettings> {
    manager()
        .lock()
        .map_err(|_| anyhow::anyhow!("Load balancer state lock poisoned"))?
        .as_ref()
        .map(|state| state.settings.clone())
        .ok_or_else(|| anyhow::anyhow!("Load balancer is not running"))
}
