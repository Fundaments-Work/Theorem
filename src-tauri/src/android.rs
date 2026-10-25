//! Android bridges: saving to MediaStore, content URIs, system insets, the
//! reading reminder, the device fingerprint and the NDK context. Elsewhere
//! these do nothing or report that they are Android-only.

#[tauri::command]
pub(crate) async fn save_share_image_mobile(
    app: tauri::AppHandle,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::save_image(&app, &filename, &base64_data)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, filename, base64_data);
        Err("Mobile image saving is only available on Android.".to_string())
    }
}

#[tauri::command]
pub(crate) async fn save_file_mobile(
    app: tauri::AppHandle,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::save_file(&app, &filename, &base64_data)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, filename, base64_data);
        Err("Mobile file saving is only available on Android.".to_string())
    }
}

#[tauri::command]
pub(crate) async fn materialize_android_content_uri(
    app: tauri::AppHandle,
    uri: String,
    file_name: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::materialize_content_uri(&app, &uri, &file_name)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, uri, file_name);
        Err("Content URI materialization is only available on Android.".to_string())
    }
}

/// The system bars' and cutout's size at each edge (Android). Elsewhere the webview's own
/// `env(safe-area-inset-*)` is right, so this reports nothing.
#[tauri::command]
pub(crate) fn system_insets(
    app: tauri::AppHandle,
) -> Result<tauri_plugin_mobile_folder_scan::SystemInsets, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::system_insets(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(tauri_plugin_mobile_folder_scan::SystemInsets::default())
    }
}

/// Whether daily reading reminders fire at the exact minute (Android "Alarms & reminders").
/// Elsewhere there is nothing to grant.
#[tauri::command]
pub(crate) fn reminder_status(
    app: tauri::AppHandle,
) -> Result<tauri_plugin_mobile_folder_scan::ReminderStatus, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::reminder_status(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(tauri_plugin_mobile_folder_scan::ReminderStatus {
            exact_alarms: true,
            can_request_exact_alarms: false,
            next_reminder_at: None,
        })
    }
}

/// Hands the daily reminder settings to Android, which schedules and re-arms the reminder
/// itself. Desktop reminds from the running app instead, so this does nothing there.
#[tauri::command]
pub(crate) fn configure_reading_reminder(
    app: tauri::AppHandle,
    config: tauri_plugin_mobile_folder_scan::ReminderConfig,
) -> Result<(), String> {
    if config.hour > 23 || config.minute > 59 {
        return Err("Invalid reminder time".into());
    }
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::configure_reminder(&app, &config)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &config);
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn open_exact_alarm_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::open_exact_alarm_settings(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn open_notification_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::open_notification_settings(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn set_android_fingerprint(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        match tauri_plugin_mobile_folder_scan::get_android_id(&app) {
            Ok(android_id) if !android_id.is_empty() => {
                theorem_sync_core::sync_crypto::set_fingerprint_from_frontend(&android_id);
                log::info!("[sync] Android fingerprint set from ANDROID_ID");
            }
            _ => {
                theorem_sync_core::sync_crypto::set_fingerprint_from_frontend("android:unknown");
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
    }
    Ok(())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_work_fundamentals_theorem_MainActivity_initNdkContext<'caller>(
    mut unowned_env: jni::EnvUnowned<'caller>,
    _class: jni::objects::JClass<'caller>,
    context: jni::objects::JObject<'caller>,
) {
    // jni 0.22: work inside `with_env` (catches panics so they never unwind
    // into the JVM). The global ref is leaked on purpose: ndk-context keeps
    // the application context for the life of the process.
    let outcome = unowned_env
        .with_env(|env| -> jni::errors::Result<_> {
            let jvm = env.get_java_vm()?;
            let global_ref = env.new_global_ref(&context)?;
            Ok((
                jvm.get_raw() as *mut std::ffi::c_void,
                global_ref.into_raw() as *mut std::ffi::c_void,
            ))
        })
        .into_outcome();
    let (jvm_ptr, raw_ptr) = match outcome {
        jni::Outcome::Ok(ptrs) => ptrs,
        jni::Outcome::Err(e) => {
            log::error!("[ndk-context] Failed to initialize: {e}");
            return;
        }
        jni::Outcome::Panic(_) => {
            log::error!("[ndk-context] Panicked while initializing");
            return;
        }
    };

    unsafe {
        ndk_context::initialize_android_context(jvm_ptr, raw_ptr);
    }
    log::info!("[ndk-context] Initialized via applicationContext");
}
