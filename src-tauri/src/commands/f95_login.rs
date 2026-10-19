//! "Sign in with the F95Zone page": a normal browser window on F95Zone's own
//! login page. A real browser gets through Cloudflare's check and through
//! two-step verification, which the app's built-in HTTP login cannot. Once
//! the window reaches a logged-in page, its cookies (and the user agent
//! they were issued to) are handed to the sidecar, which then uses that
//! session for everything else.

use super::state::{ensure_sidecar, AppState};
use crate::error::AppError;
use reqwest::Url;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "f95-login";
const LOGIN_URL: &str = "https://f95zone.to/login/";
/// XenForo's "stay logged in" cookie: present only once the user is in.
const LOGGED_IN_COOKIE: &str = "xf_user";

/// Ticks "Stay logged in" on F95Zone's login form, so the session the app
/// keeps lasts like a normal remembered browser login.
const INIT_SCRIPT: &str = r#"
(function () {
  function tick() {
    document.querySelectorAll('input[name="remember"]').forEach(function (el) {
      if (!el.checked) el.click();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
})();
"#;

fn is_f95(url: &Url) -> bool {
    url.host_str()
        .map(|h| h == "f95zone.to" || h.ends_with(".f95zone.to"))
        .unwrap_or(false)
}

/// Every F95Zone cookie the window holds, in the shape the sidecar expects.
fn collect_cookies(window: &tauri::WebviewWindow) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(all) = window.cookies() else {
        return out;
    };
    for c in all {
        let domain = c.domain().unwrap_or("").to_string();
        let bare = domain.trim_start_matches('.');
        if bare != "f95zone.to" && !bare.ends_with(".f95zone.to") {
            continue;
        }
        out.push(json!({
            "name": c.name(),
            "value": c.value(),
            "domain": domain,
            "path": c.path().unwrap_or("/"),
            "expires": c.expires_datetime().map(|d| d.unix_timestamp()),
            "secure": c.secure().unwrap_or(true),
            "httpOnly": c.http_only().unwrap_or(false),
        }));
    }
    out
}

/// Hand the window's session to the sidecar, then tell the login screen.
async fn finish(app: AppHandle, window: tauri::WebviewWindow, user_agent: String, done: Arc<AtomicBool>) {
    // Cookie access must stay off the main thread on Windows.
    let cookies = collect_cookies(&window);
    let logged_in = cookies
        .iter()
        .any(|c| c.get("name").and_then(Value::as_str) == Some(LOGGED_IN_COOKIE));
    if !logged_in {
        return; // Still on the way (a check page, 2FA, or a guest page).
    }
    if done.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let result = async {
        let client = ensure_sidecar(&state).await?;
        let ua = Some(user_agent.as_str()).filter(|s| !s.is_empty());
        client.import_browser_session(Value::Array(cookies), ua).await
    }
    .await;
    match result {
        Ok(()) => {
            let _ = app.emit("f95-login:done", ());
            let _ = window.close();
        }
        Err(err) => {
            done.store(false, Ordering::SeqCst);
            let _ = app.emit("f95-login:error", err.to_string());
        }
    }
}

/// Open (or focus) the F95Zone login window. `user_agent` is the app's own
/// webview user agent, which this window shares; the sidecar adopts it so
/// Cloudflare keeps accepting the session.
#[tauri::command]
pub async fn open_f95_login_window(app: AppHandle, user_agent: String) -> Result<(), AppError> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = Url::parse(LOGIN_URL).map_err(|e| AppError::Other(format!("URL: {e}")))?;
    let done = Arc::new(AtomicBool::new(false));
    let load_app = app.clone();

    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("Sign in to F95Zone")
        .inner_size(560.0, 760.0)
        .min_inner_size(420.0, 520.0)
        .center()
        .resizable(true)
        .initialization_script(INIT_SCRIPT)
        // Ads open pop-ups; signing in never needs a second window.
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let url = payload.url().clone();
            if !is_f95(&url) || url.path().starts_with("/login") {
                return;
            }
            let (app, done, ua) = (load_app.clone(), done.clone(), user_agent.clone());
            tauri::async_runtime::spawn(finish(app, window, ua, done));
        })
        .build()
        .map_err(|e| AppError::Other(format!("open login window: {e}")))?;

    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}
