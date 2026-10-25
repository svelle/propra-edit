//! Rust core: owns the file system access, the course index and the file watcher,
//! and exposes them to the frontend as Tauri commands and events.

pub mod course;
pub mod fs;
pub mod lt;
pub mod settings;
pub mod watcher;

use course::{CourseConfig, CourseIndex};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct OpenCourse {
    root: PathBuf,
    /// Canonical form of `root`, for containment checks.
    canonical_root: PathBuf,
    index: CourseIndex,
    _watcher: Option<notify::RecommendedWatcher>,
}

#[derive(Default)]
struct AppState {
    course: Arc<Mutex<Option<OpenCourse>>>,
    lt: Mutex<Option<lt::LanguageTool>>,
}

fn lt_handle(state: &AppState) -> Result<lt::LanguageTool, String> {
    state.lt.lock().unwrap().clone().ok_or_else(|| "LanguageTool ist nicht initialisiert".to_string())
}

fn settings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Resolve `path` through its nearest existing ancestor so that paths of files that do
/// not exist yet can be checked too.
fn canonical_lenient(path: &Path) -> Option<PathBuf> {
    let mut tail = Vec::new();
    let mut cur = path;
    loop {
        if let Ok(c) = cur.canonicalize() {
            let mut out = c;
            for t in tail.iter().rev() {
                out.push(t);
            }
            return Some(out);
        }
        tail.push(cur.file_name()?.to_os_string());
        cur = cur.parent()?;
    }
}

/// All file commands are restricted to the open course root.
fn checked_path(state: &AppState, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let guard = state.course.lock().unwrap();
    let course = guard.as_ref().ok_or("Kein Kurs geöffnet")?;
    let c = canonical_lenient(&p).ok_or_else(|| format!("Ungültiger Pfad: {path}"))?;
    if c.starts_with(&course.canonical_root) {
        Ok(p)
    } else {
        Err(format!("Pfad liegt außerhalb des Kurses: {path}"))
    }
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(settings::load(&settings_dir(&app)?))
}

#[tauri::command]
async fn save_settings(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    settings::save(&settings_dir(&app)?, &value)
}

#[tauri::command]
async fn open_course(app: AppHandle, state: State<'_, AppState>, root: String) -> Result<CourseIndex, String> {
    let root = PathBuf::from(root);
    let config = CourseConfig::load(&root)?;
    let index = CourseIndex::build(config);
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;

    let course_slot = state.course.clone();
    let app2 = app.clone();
    let (root2, canon2) = (root.clone(), canonical_root.clone());
    let watch = watcher::start(&root, move |paths| {
        // Some platforms (macOS) report canonical paths; map them back onto the root as
        // opened, so they compare equal to the paths in the index.
        let paths: Vec<PathBuf> = paths
            .into_iter()
            .map(|p| match p.strip_prefix(&canon2) {
                Ok(rel) => root2.join(rel),
                Err(_) => p,
            })
            .collect();
        let mut rebuild = false;
        if let Some(c) = course_slot.lock().unwrap().as_mut() {
            let cfg = &c.index.config;
            let relevant = |p: &Path| {
                p.starts_with(&cfg.chapterdir)
                    || cfg.altdir.as_ref().is_some_and(|a| p.starts_with(a))
                    || p.file_name().is_some_and(|n| n == course::config::CONFIG_FILE)
            };
            if paths.iter().any(|p| relevant(p)) {
                rebuild = true;
                match CourseConfig::load(&c.root) {
                    Ok(cfg) => c.index = CourseIndex::build(cfg),
                    Err(e) => {
                        let _ = app2.emit("index-error", e);
                    }
                }
            }
            if rebuild {
                let _ = app2.emit("index-changed", &c.index);
            }
        }
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let _ = app2.emit("file-changed", strs);
    });
    let watch = match watch {
        Ok(w) => Some(w),
        Err(e) => {
            let _ = app.emit("watcher-error", e);
            None
        }
    };
    *state.course.lock().unwrap() =
        Some(OpenCourse { root, canonical_root, index: index.clone(), _watcher: watch });
    Ok(index)
}

#[tauri::command]
async fn refresh_index(state: State<'_, AppState>) -> Result<CourseIndex, String> {
    let mut guard = state.course.lock().unwrap();
    let c = guard.as_mut().ok_or("Kein Kurs geöffnet")?;
    c.index = CourseIndex::build(CourseConfig::load(&c.root)?);
    Ok(c.index.clone())
}

#[tauri::command]
async fn read_text_file(state: State<'_, AppState>, path: String) -> Result<fs::TextFile, String> {
    let p = checked_path(&state, &path)?;
    fs::read_text(&p)
}

#[tauri::command]
async fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    text: String,
    eol: String,
    bom: bool,
) -> Result<(), String> {
    let p = checked_path(&state, &path)?;
    fs::write_text(&p, &text, &eol, bom)
}

#[tauri::command]
async fn create_file(state: State<'_, AppState>, path: String, text: String) -> Result<(), String> {
    let p = checked_path(&state, &path)?;
    fs::create_new(&p, &text)
}

#[tauri::command]
async fn path_exists(state: State<'_, AppState>, path: String) -> Result<bool, String> {
    Ok(checked_path(&state, &path)?.exists())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewTaskPaths {
    task: PathBuf,
    altdir: Option<PathBuf>,
    template: PathBuf,
}

#[tauri::command]
async fn new_task_paths(
    state: State<'_, AppState>,
    chapter: String,
    taskgroup: String,
    name: String,
) -> Result<NewTaskPaths, String> {
    let guard = state.course.lock().unwrap();
    let c = guard.as_ref().ok_or("Kein Kurs geöffnet")?;
    let cfg = &c.index.config;
    let file = format!("{name}.md");
    Ok(NewTaskPaths {
        task: cfg.chapterdir.join(&chapter).join(&taskgroup).join(&file),
        altdir: cfg.altdir.as_ref().map(|a| a.join(&chapter).join(&taskgroup).join(&file)),
        template: cfg.chapterdir.join("template.md"),
    })
}

#[tauri::command]
async fn lt_status(state: State<'_, AppState>) -> Result<lt::LtStatus, String> {
    Ok(lt_handle(&state)?.status())
}

#[tauri::command]
async fn lt_restart(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let lt = lt_handle(&state)?;
    lt.set_location(lt_location(&app));
    lt.restart();
    Ok(())
}

/// Check annotated text (LanguageTool's `data` JSON). Returns LanguageTool's JSON response.
#[tauri::command]
async fn lt_check(
    state: State<'_, AppState>,
    data: String,
    language: String,
    disabled_rules: Vec<String>,
    enabled_rules: Vec<String>,
) -> Result<String, String> {
    let lt = lt_handle(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let disabled = disabled_rules.join(",");
        let enabled = enabled_rules.join(",");
        let mut form: Vec<(&str, &str)> = vec![("language", &language), ("data", &data)];
        if !disabled.is_empty() {
            form.push(("disabledRules", &disabled));
        }
        if !enabled.is_empty() {
            form.push(("enabledRules", &enabled));
        }
        lt.check(&form)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_dictionary(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(settings::load_words(&settings_dir(&app)?))
}

#[tauri::command]
async fn save_dictionary(app: AppHandle, words: Vec<String>) -> Result<(), String> {
    settings::save_words(&settings_dir(&app)?, &words)
}

fn lt_location(app: &AppHandle) -> Result<lt::LtLocation, String> {
    let cfg = settings_dir(app).map(|d| settings::load(&d)).unwrap_or_default();
    let path_setting = |k: &str| cfg.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(PathBuf::from);
    let resources = app.path().resource_dir().ok();
    lt::locate(resources.as_deref(), path_setting("ltJava"), path_setting("ltLibDir"))
}

fn start_languagetool(app: &AppHandle) {
    let work_dir = app
        .path()
        .app_log_dir()
        .or_else(|_| app.path().app_cache_dir())
        .unwrap_or_else(|_| std::env::temp_dir().join("propra-editor"));
    let app2 = app.clone();
    let lt = lt::LanguageTool::new(lt_location(app), work_dir, Arc::new(move |s| {
        let _ = app2.emit("lt-status", s);
    }));
    lt.restart();
    *app.state::<AppState>().lt.lock().unwrap() = Some(lt);
}

fn course_config(state: &AppState) -> Result<CourseConfig, String> {
    let guard = state.course.lock().unwrap();
    Ok(guard.as_ref().ok_or("Kein Kurs geöffnet")?.index.config.clone())
}

/// Resolve INCLUDE/PROT/SNIPPET/TREEREF arguments of `context` like sedrila and check them.
#[tauri::command]
async fn check_includes(
    state: State<'_, AppState>,
    context: String,
    queries: Vec<course::includes::IncludeQuery>,
) -> Result<Vec<course::includes::IncludeResult>, String> {
    let cfg = course_config(&state)?;
    let ctx = PathBuf::from(context);
    Ok(queries.iter().map(|q| course::includes::check(&cfg, &ctx, q)).collect())
}

/// All glossary term references in the course ("Wo verwendet?").
#[tauri::command]
async fn term_usages(state: State<'_, AppState>) -> Result<Vec<course::usages::TermUsage>, String> {
    let cfg = course_config(&state)?;
    tauri::async_runtime::spawn_blocking(move || course::usages::scan(&cfg)).await.map_err(|e| e.to_string())
}

/// Directory entries for path completion inside INCLUDE/PROT/SNIPPET/TREEREF.
#[tauri::command]
async fn list_include_dir(
    state: State<'_, AppState>,
    context: String,
    partial: String,
    itree_mode: bool,
) -> Result<Vec<course::includes::DirEntryInfo>, String> {
    let cfg = course_config(&state)?;
    Ok(course::includes::list_dir(&cfg, Path::new(&context), &partial, itree_mode))
}

/// Checks whether `dir` contains `sedrila.yaml` (used by the course picker).
#[tauri::command]
async fn is_course_root(dir: String) -> bool {
    Path::new(&dir).join(course::config::CONFIG_FILE).is_file()
}

/// macOS app menu. The standard Edit items are needed for clipboard shortcuts in the
/// webview. Close/Quit go through the window's close request so the frontend can ask
/// about unsaved changes; Cmd+W is left to the frontend (closes a tab).
#[cfg(target_os = "macos")]
fn macos_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let quit = MenuItem::with_id(app, "quit", "ProPra Editor beenden", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "ProPra Editor",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Bearbeiten",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Fenster",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu).on_menu_event(|app, event| {
        if event.id().as_ref() == "quit" {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close();
            }
        }
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            open_course,
            refresh_index,
            read_text_file,
            write_text_file,
            create_file,
            path_exists,
            new_task_paths,
            is_course_root,
            check_includes,
            term_usages,
            list_include_dir,
            lt_status,
            lt_restart,
            lt_check,
            get_dictionary,
            save_dictionary,
        ])
        .setup(|app| {
            start_languagetool(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(lt) = app.state::<AppState>().lt.lock().unwrap().as_ref() {
                    lt.shutdown();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_lenient_resolves_missing_tail() {
        let base = std::env::temp_dir().canonicalize().unwrap();
        let p = base.join("does-not-exist-propra").join("x.md");
        assert_eq!(canonical_lenient(&p).unwrap(), p);
    }
}
