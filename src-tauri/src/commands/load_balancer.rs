use crate::load_balancer::{
    apply_load_balancer_codex_config as apply_codex_load_balancer_config,
    get_load_balancer_status as fetch_load_balancer_status,
    load_load_balancer_settings,
    save_load_balancer_settings as persist_load_balancer_settings, start_load_balancer_with_settings,
    stop_load_balancer_with_settings,
};
use crate::types::{LoadBalancerSettings, LoadBalancerStatus};
use tokio::task;

#[tauri::command]
pub async fn get_load_balancer_status() -> Result<LoadBalancerStatus, String> {
    task::spawn_blocking(fetch_load_balancer_status)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_load_balancer_settings(
    settings: LoadBalancerSettings,
) -> Result<LoadBalancerStatus, String> {
    task::spawn_blocking(move || {
        let existing = load_load_balancer_settings().map_err(|error| error.to_string())?;
        let mut merged = settings;
        merged.previous_model_provider = existing.previous_model_provider;

        let status = if merged.enabled {
            start_load_balancer_with_settings(merged).map_err(|error| error.to_string())?
        } else {
            stop_load_balancer_with_settings(merged).map_err(|error| error.to_string())?
        };

        persist_load_balancer_settings(&status.settings).map_err(|error| error.to_string())?;
        Ok(status)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn apply_load_balancer_codex_config() -> Result<LoadBalancerStatus, String> {
    task::spawn_blocking(move || {
        let mut settings = load_load_balancer_settings().map_err(|error| error.to_string())?;
        apply_codex_load_balancer_config(&mut settings).map_err(|error| error.to_string())?;
        persist_load_balancer_settings(&settings).map_err(|error| error.to_string())?;
        fetch_load_balancer_status().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
