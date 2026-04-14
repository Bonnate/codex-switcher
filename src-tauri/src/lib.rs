//! Codex Switcher - Multi-account manager for Codex CLI

pub mod api;
pub mod auth;
pub mod commands;
pub mod load_balancer;
pub mod types;
pub mod web;

use std::sync::atomic::{AtomicBool, Ordering};

use commands::{
    add_account_from_file, cancel_login, check_codex_processes, complete_login, delete_account,
    apply_load_balancer_codex_config, export_accounts_full_encrypted_file,
    export_accounts_slim_text, get_active_account_info, get_load_balancer_status,
    get_masked_account_ids, get_usage, import_accounts_full_encrypted_file,
    import_accounts_slim_text, list_accounts, refresh_all_accounts_usage, rename_account,
    save_load_balancer_settings, set_account_expiration,
    set_account_load_balancer_priority, set_masked_account_ids, start_login, switch_account,
    warmup_account, warmup_all_accounts,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewWindow, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_MENU_SHOW: &str = "tray_show";
const TRAY_MENU_HIDE: &str = "tray_hide";
const TRAY_MENU_QUIT: &str = "tray_quit";
const TRAY_ID: &str = "main-tray";
static SHUTDOWN_LOAD_BALANCER_RECOVERY_ATTEMPTED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
use tauri::image::Image;

#[tauri::command]
fn hide_main_window_to_tray(app: AppHandle) -> Result<(), String> {
    hide_main_window(&app).map_err(|error| error.to_string())
}

fn main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or(tauri::Error::WindowNotFound)
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = main_window(app)?;
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn hide_main_window(app: &AppHandle) -> tauri::Result<()> {
    main_window(app)?.hide()
}

fn toggle_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = main_window(app)?;
    if window.is_visible()? {
        window.hide()?;
    } else {
        if window.is_minimized()? {
            window.unminimize()?;
        }
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn build_macos_tray_icon() -> Image<'static> {
    const WIDTH: usize = 18;
    const HEIGHT: usize = 18;
    let mut rgba = vec![0_u8; WIDTH * HEIGHT * 4];

    let mut fill_rect = |x0: usize, y0: usize, x1: usize, y1: usize| {
        for y in y0..=y1 {
            for x in x0..=x1 {
                let index = (y * WIDTH + x) * 4;
                rgba[index] = 0;
                rgba[index + 1] = 0;
                rgba[index + 2] = 0;
                rgba[index + 3] = 255;
            }
        }
    };

    fill_rect(4, 3, 13, 5);
    fill_rect(4, 12, 13, 14);
    fill_rect(4, 3, 6, 14);
    fill_rect(4, 6, 10, 8);
    fill_rect(4, 9, 10, 11);

    Image::new_owned(rgba, WIDTH as u32, HEIGHT as u32)
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_MENU_SHOW, "Open Codex Switcher", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, TRAY_MENU_HIDE, "Hide Window", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_MENU_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Codex Switcher");

    #[cfg(target_os = "macos")]
    {
        tray = tray.icon(build_macos_tray_icon()).icon_as_template(true);
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = show_main_window(app);
        }))
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW => {
                let _ = show_main_window(app);
            }
            TRAY_MENU_HIDE => {
                let _ = hide_main_window(app);
            }
            TRAY_MENU_QUIT => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|app, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = app.tray_by_id(TRAY_ID);
                let _ = toggle_main_window(app);
            }
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            #[cfg(desktop)]
            setup_tray(app)?;
            if let Err(error) = crate::load_balancer::autostart_load_balancer_if_enabled() {
                eprintln!("[load-balancer] autostart failed: {error:#}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Account management
            list_accounts,
            get_active_account_info,
            add_account_from_file,
            switch_account,
            delete_account,
            rename_account,
            set_account_expiration,
            set_account_load_balancer_priority,
            export_accounts_slim_text,
            import_accounts_slim_text,
            export_accounts_full_encrypted_file,
            import_accounts_full_encrypted_file,
            // Load balancer
            get_load_balancer_status,
            save_load_balancer_settings,
            apply_load_balancer_codex_config,
            // Masked accounts
            get_masked_account_ids,
            set_masked_account_ids,
            // OAuth
            start_login,
            complete_login,
            cancel_login,
            // Usage
            get_usage,
            refresh_all_accounts_usage,
            warmup_account,
            warmup_all_accounts,
            // Process detection
            check_codex_processes,
                // Window / tray control
                hide_main_window_to_tray,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (&app, &event);
        }

        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            let _ = show_main_window(app);
        }

        if let RunEvent::ExitRequested { .. } = event {
            if !SHUTDOWN_LOAD_BALANCER_RECOVERY_ATTEMPTED.swap(true, Ordering::SeqCst) {
                if let Err(error) = crate::load_balancer::cleanup_load_balancer_for_exit() {
                    eprintln!("[load-balancer] shutdown cleanup failed: {error:#}");
                }
            }
        }
    });
}
