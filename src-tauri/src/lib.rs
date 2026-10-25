#![allow(unknown_lints)]
#![allow(clippy::chunks_exact_to_as_chunks)]

#[cfg(not(target_os = "android"))]
pub mod app_lock;
pub mod article_epub;
pub mod article_extractor;
pub mod audio_player;
pub mod audiobook;
pub mod audiobook_gen;
pub mod batch_ingest;
mod book_import;
pub mod book_search;
pub mod cbr;
#[cfg(not(target_os = "android"))]
pub mod cli;
#[cfg(not(target_os = "android"))]
mod cli_text;
#[cfg(not(target_os = "android"))]
pub mod cli_tui;
pub mod cover_protocol;
mod database;
mod db_backup;
mod db_maintenance;
mod device_name;
mod diagnostics;
#[cfg(feature = "e2e")]
mod e2e_hooks;
pub mod epub_entries;
mod epub_parser;
mod epub_rewriter;
pub mod epubcfi;
mod file_transfer;
pub mod folder_walk;
pub mod fuzzy_search;
pub(crate) mod http;
pub mod image_ops;
mod iroh_sync;
pub mod mdict;
pub mod mobi_parser;
mod offload_commands;
pub mod opds_net;
pub mod rss_parser;
mod smart_shelves;
pub mod stardict;
pub mod stemmer;
pub mod supertonic;
mod sync_access;
mod sync_commands;
pub use theorem_core::text_normalizer;
#[cfg(not(target_os = "android"))]
mod tts_desktop;
#[cfg(target_os = "linux")]
mod tts_linux;
pub mod tts_model;
pub mod vault_export;
mod zip_util;

mod android;
mod cli_install;
mod dictionary_net;
mod library_folder;
mod lifecycle;
mod open_files;
mod pdf;
mod reader_files;
mod setup;
#[cfg(desktop)]
mod tray;
mod tts_platform;
mod web_fetch;
mod window;

#[cfg(desktop)]
use tauri::Manager;
use tauri::WindowEvent;

#[cfg(target_os = "linux")]
use setup::apply_linux_webkit_workarounds;
use setup::dialog_plugin;

#[cfg(desktop)]
use lifecycle::trim_memory_soon;
use lifecycle::QuitCoordinator;
use open_files::PendingOpenFiles;
#[cfg(all(
    not(any(target_os = "android", target_os = "ios")),
    not(debug_assertions)
))]
use open_files::{collect_open_paths, enqueue_open_paths};
#[cfg(desktop)]
use window::close_reader_windows;

// Paths other modules (and the CLI) use from the crate root.
pub use cli_install::{setup_linux_cli_symlink_inner, CliSetupStatus};
pub use window::open_reader_window;

pub(crate) use cli_install::cli_setup_status;
#[cfg(not(target_os = "android"))]
pub(crate) use dictionary_net::fetch_online_definition;
pub(crate) use library_folder::scan_library_folder_desktop;
#[cfg(feature = "e2e")]
pub(crate) use lifecycle::request_graceful_quit;
pub(crate) use lifecycle::trim_memory;
pub(crate) use pdf::{
    get_pdf_metadata, prefetch_pdf_structure, read_pdf_file, read_pdf_file_size, read_pdf_range,
    PdfMetadata, PdfStructure,
};
pub(crate) use reader_files::{read_cbr_as_cbz, read_file};
pub(crate) use tts_platform::tts_get_voices;
pub(crate) use web_fetch::{fetch_binary_content, fetch_rss_feed, fetch_url_content};

/// The shared blocking HTTP client (see `http::blocking_client`). Building it
/// can fail (no usable TLS backend); the failure is returned to the caller,
/// never a panic, and is remembered so each request does not retry the build.
fn shared_http_client() -> Result<&'static reqwest::blocking::Client, String> {
    http::blocking_client()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, so a panic anywhere below is written to the log file once the
    // log plugin is up (and still reaches the default hook before that).
    diagnostics::install_panic_hook();

    #[cfg(target_os = "linux")]
    apply_linux_webkit_workarounds();

    let _ = rustls::crypto::ring::default_provider().install_default();

    // Tell `theorem` commands that the app is running, so they do not write
    // to the library behind its back (see `app_lock`).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Ok(dir) = cli::app_data_dir() {
        app_lock::hold_for_app(&dir);
    }

    let builder = tauri::Builder::default()
        .manage(PendingOpenFiles::default())
        .manage(QuitCoordinator::default())
        .register_asynchronous_uri_scheme_protocol(
            cover_protocol::COVER_SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(cover_protocol::respond(&app, &request));
                });
            },
        )
        .on_window_event(|window, event| {
            // Give memory back when the user switches away, from here rather than from the
            // page: a webview being hidden cancels IPC requests, and WebKit logs each one as
            // "Fetch API cannot load ipc://localhost/… due to access control checks".
            #[cfg(desktop)]
            if let WindowEvent::Focused(false) = event {
                trim_memory_soon(window.app_handle());
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // Reader windows are separate webviews, so closing the main
                    // window used to leave them open on screen. Close them with it.
                    #[cfg(desktop)]
                    close_reader_windows(window.app_handle());

                    #[cfg(not(debug_assertions))]
                    {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(dialog_plugin())
        // Info and up in shipped builds (JNI/network trace output can overwhelm
        // Android during startup), to stdout/logcat and a rotating log file.
        .plugin(diagnostics::log_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_mobile_folder_scan::init())
        .plugin(tauri_plugin_android_tts_audio::init());

    // Release builds only: `tauri dev` shares the identifier with the installed
    // app, so with this plugin a dev run found the installed app (often still
    // alive in the tray), handed it the arguments and exited, which also
    // stopped `pnpm dev:tauri`.
    #[cfg(all(
        not(any(target_os = "android", target_os = "ios")),
        not(debug_assertions)
    ))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        if let Some(book_id) = argv
            .iter()
            .find_map(|a| a.strip_prefix("--open-book=").map(str::to_string))
        {
            let _ = open_reader_window(app, &book_id, "Theorem Reader");
            return;
        }
        let paths = collect_open_paths(argv, Some(&cwd));
        enqueue_open_paths(app, paths, true);

        let window = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next());
        if let Some(window) = window {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    #[cfg(desktop)]
    let builder = builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .setup(setup::setup)
        .invoke_handler(tauri::generate_handler![
            smart_shelves::evaluate_smart_shelves,
            diagnostics::export_logs_bundle,
            cli_install::setup_linux_cli_symlink,
            window::print_webview,
            tts_platform::tts_get_engines,
            tts_platform::tts_set_engine,
            tts_platform::tts_synthesize_to_file,
            offload_commands::tts_model_status,
            tts_model::tts_model_download_asset,
            offload_commands::tts_model_remove,
            supertonic::tts_synthesize,
            offload_commands::extract_audiobook_metadata,
            audio_player::tts_audio_play,
            audio_player::tts_audio_append,
            supertonic::tts_engine_preload,
            offload_commands::tts_text_chunks,
            audio_player::tts_audio_pause,
            audio_player::tts_audio_resume,
            audio_player::tts_audio_stop,
            audio_player::tts_audio_seek,
            audio_player::tts_audio_set_speed,
            audio_player::tts_audio_get_speed,
            audio_player::tts_audio_set_volume,
            audio_player::tts_audio_get_volume,
            audio_player::tts_audio_position,
            audio_player::tts_audio_finished,
            audio_player::tts_audio_status,
            audiobook_gen::generate_audiobook,
            audiobook_gen::generate_audiobook_cancel,
            audiobook_gen::delete_generated_audiobook,
            supertonic::tts_prefetch,
            offload_commands::tts_neural_status,
            offload_commands::tts_engine_unload,
            offload_commands::trim_memory,
            lifecycle::app_quit_ready,
            offload_commands::sqlite_list_cover_versions,
            offload_commands::cli_setup_status,
            cli_install::remove_linux_cli_symlink,
            tts_platform::tts_speak,
            tts_platform::tts_stop,
            tts_platform::tts_pause,
            tts_platform::tts_resume,
            offload_commands::tts_get_voices,
            epub_parser::prefetch_zip_metadata,
            epub_entries::epub_read_entry,
            offload_commands::rewrite_epub_metadata,
            offload_commands::read_file,
            offload_commands::read_cbr_as_cbz,
            offload_commands::read_pdf_file,
            offload_commands::read_pdf_file_size,
            offload_commands::read_pdf_range,
            offload_commands::get_pdf_metadata,
            offload_commands::prefetch_pdf_structure,
            open_files::take_pending_open_files,
            lifecycle::app_build_info,
            offload_commands::fetch_rss_feed,
            offload_commands::fetch_url_content,
            offload_commands::fetch_binary_content,
            library_folder::pick_library_folder_mobile,
            library_folder::scan_library_folder_mobile,
            library_folder::cancel_import_job,
            offload_commands::scan_library_folder_desktop,
            android::save_share_image_mobile,
            android::save_file_mobile,
            android::materialize_android_content_uri,
            offload_commands::sqlite_save_book_data,
            offload_commands::finish_book_import,
            offload_commands::import_book_path,
            offload_commands::sqlite_register_materialized_book,
            offload_commands::sqlite_get_book_data,
            offload_commands::sqlite_delete_book_data,
            offload_commands::sqlite_get_materialized_book_path,
            offload_commands::sqlite_save_cover_image,
            offload_commands::sqlite_get_cover_image,
            offload_commands::sqlite_delete_cover_image,
            offload_commands::sqlite_get_storage_stats,
            offload_commands::sqlite_cleanup_orphaned_storage,
            offload_commands::sqlite_clear_all_storage,
            offload_commands::sqlite_get_kv,
            offload_commands::sqlite_check_goal_reminder,
            offload_commands::sqlite_batch_get_kv,
            offload_commands::sqlite_set_kv,
            offload_commands::sqlite_delete_kv,
            offload_commands::sqlite_count_kv_by_prefix,
            offload_commands::sqlite_delete_kv_by_prefix,
            offload_commands::sqlite_set_blob,
            offload_commands::sqlite_get_blob,
            offload_commands::sqlite_delete_blob,
            offload_commands::sqlite_delete_blobs_by_prefix,
            offload_commands::sqlite_get_blob_stats,
            offload_commands::sqlite_index_book_fts,
            offload_commands::sqlite_index_books_fts_batch,
            offload_commands::sqlite_search_books,
            offload_commands::sqlite_save_book_metadata,
            offload_commands::sqlite_get_book_metadata,
            offload_commands::sqlite_delete_book_metadata,
            offload_commands::sqlite_load_all_books,
            offload_commands::sqlite_update_book_progress,
            offload_commands::sqlite_save_book_annotations,
            offload_commands::sqlite_get_book_annotations,
            offload_commands::sqlite_load_all_annotations,
            offload_commands::sqlite_upsert_annotation,
            offload_commands::sqlite_delete_annotation,
            offload_commands::sqlite_merge_sync_entries,
            offload_commands::sqlite_list_sync_conflicts,
            offload_commands::sqlite_dismiss_sync_conflicts,
            offload_commands::sqlite_shrink_memory,
            offload_commands::sqlite_query_books_window,
            offload_commands::sqlite_get_rss_feeds,
            offload_commands::sqlite_save_rss_feed,
            offload_commands::sqlite_delete_rss_feed,
            offload_commands::sqlite_get_rss_articles,
            offload_commands::sqlite_get_rss_article,
            offload_commands::sqlite_get_rss_article_content,
            offload_commands::sqlite_save_rss_article,
            offload_commands::sqlite_mark_article_read,
            offload_commands::sqlite_mark_article_favorite,
            offload_commands::sqlite_mark_article_saved,
            offload_commands::sqlite_delete_rss_article,
            offload_commands::sqlite_cleanup_old_rss_articles,
            offload_commands::sqlite_record_reading_session,
            offload_commands::sqlite_get_reading_sessions,
            offload_commands::sqlite_get_vocabulary_terms,
            offload_commands::sqlite_save_vocabulary_term,
            offload_commands::sqlite_delete_vocabulary_term,
            fuzzy_search::fuzzy_rank_candidates,
            fuzzy_search::two_tier_search_books,
            sync_commands::iroh_start,
            sync_commands::iroh_stop,
            sync_commands::generate_pairing_qr,
            sync_commands::submit_pairing_code,
            sync_commands::get_device_identity,
            sync_commands::set_device_fingerprint,
            sync_commands::get_paired_devices,
            sync_commands::unpair_device,
            sync_commands::set_device_name,
            sync_commands::sync_probe_device,
            sync_commands::respond_pairing_request,
            sync_commands::close_pairing_qr,
            sync_commands::docs_create_sync_doc,
            sync_commands::docs_import_sync_doc,
            sync_commands::docs_set_entry,
            sync_commands::docs_set_entries,
            sync_commands::docs_retain_own_entries,
            sync_commands::docs_get_all_entries,
            sync_commands::docs_get_changed_entries,
            sync_commands::docs_ack_entries,
            sync_commands::docs_purge_entities,
            sync_commands::docs_sync_now,
            file_transfer::download_book_file,
            sync_commands::clear_sync_databases,
            android::set_android_fingerprint,
            android::reminder_status,
            android::system_insets,
            android::configure_reading_reminder,
            android::open_exact_alarm_settings,
            android::open_notification_settings,
            window::hide_to_tray,
            dictionary_net::download_and_extract_stardict,
            stardict::stardict_lookup,
            stardict::stardict_delete,
            dictionary_net::fetch_online_definition,
            batch_ingest::ingest_books_native,
            book_search::search_book_content,
            offload_commands::decompress_palmdoc_record,
            offload_commands::get_mobi_metadata,
            article_extractor::fetch_and_extract_article_native,
            offload_commands::extract_article_from_html_native,
            opds_net::opds_load,
            opds_net::opds_search,
            opds_net::opds_download,
            opds_net::opds_cleanup_download,
            window::open_book_in_new_window,
            mdict::mdx_lookup,
            vault_export::vault_export_snapshot,
            rss_parser::parse_rss_feed_native,
            rss_parser::fetch_and_parse_rss_feed,
            rss_parser::render_markdown_to_html,
            rss_parser::render_markdown_batch,
            image_ops::downsample_cover,
            image_ops::extract_cover_palette,
            stemmer::lemmatize_word,
            article_epub::create_article_epub_native,
            db_backup::db_health_status,
            db_backup::db_health_dismiss,
            db_backup::db_list_snapshots,
            db_backup::db_backup_create,
            db_backup::db_backup_inspect,
            db_backup::db_backup_restore,
            db_backup::db_restore_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
