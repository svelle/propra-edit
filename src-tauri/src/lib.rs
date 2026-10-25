//! Rust core: owns the file system access, the course index and the file watcher,
//! and exposes them to the frontend as Tauri commands and events.

pub mod applog;
pub mod build;
pub mod course;
pub mod fs;
pub mod git;
pub mod i18n;
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
    build: Arc<Mutex<build::BuildState>>,
}

fn lt_handle(state: &AppState) -> Result<lt::LanguageTool, String> {
    state.lt.lock().unwrap().clone().ok_or_else(|| i18n::tr("LanguageTool ist nicht initialisiert", "LanguageTool is not initialized"))
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
    let course = guard.as_ref().ok_or_else(|| i18n::tr("Kein Kurs geöffnet", "No course open"))?;
    let c = canonical_lenient(&p).ok_or_else(|| format!("{}: {path}", i18n::tr("Ungültiger Pfad", "Invalid path")))?;
    if c.starts_with(&course.canonical_root) {
        Ok(p)
    } else {
        Err(format!("{}: {path}", i18n::tr("Pfad liegt außerhalb des Kurses", "Path is outside the course")))
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
    let c = guard.as_mut().ok_or_else(|| i18n::tr("Kein Kurs geöffnet", "No course open"))?;
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
    let c = guard.as_ref().ok_or_else(|| i18n::tr("Kein Kurs geöffnet", "No course open"))?;
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
    let location = lt_location(&app);
    if let Err(e) = &location {
        applog::error(format!("LanguageTool nicht gefunden: {e}"));
    }
    applog::info("LanguageTool: Neustart angefordert");
    lt.set_location(location);
    lt.restart();
    Ok(())
}

fn git_program(app: &AppHandle) -> String {
    let cfg = settings_dir(app).map(|d| settings::load(&d)).unwrap_or_default();
    cfg.get("gitPath").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn git_repos(app: &AppHandle, state: &AppState) -> Result<(String, CourseConfig, Vec<git::Repo>), String> {
    let cfg = course_config(state)?;
    let prog = git_program(app);
    let repos = git::discover(&prog, &cfg.root, cfg.altdir.as_deref());
    Ok((prog, cfg, repos))
}

/// The repo with this root (only the course and altdir repos may be operated on).
fn git_repo(app: &AppHandle, state: &AppState, root: &str) -> Result<(String, git::Repo), String> {
    let (prog, _, repos) = git_repos(app, state)?;
    let repo = repos.into_iter().find(|r| r.root == Path::new(root)).ok_or_else(|| format!("{}: {root}", i18n::tr("Unbekanntes Repository", "Unknown repository")))?;
    Ok((prog, repo))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Status of the course repo and the altdir repo (empty if the course is not in git).
#[tauri::command]
async fn git_status(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<git::RepoStatus>, String> {
    let (prog, cfg, repos) = git_repos(&app, &state)?;
    blocking(move || {
        let mut all = git::status_all(&prog, &repos)?;
        // altdir files belong to the task at the same place below chapterdir
        if let Some(alt) = &cfg.altdir {
            for st in all.iter_mut().filter(|s| s.kind == "altdir") {
                for f in &mut st.files {
                    if let Ok(rest) = f.path.strip_prefix(alt) {
                        f.task_path = Some(cfg.chapterdir.join(rest));
                    }
                }
            }
        }
        Ok(all)
    })
    .await
}

#[tauri::command]
async fn git_stage(app: AppHandle, state: State<'_, AppState>, root: String, rels: Vec<String>) -> Result<(), String> {
    let (prog, repo) = git_repo(&app, &state, &root)?;
    blocking(move || git::stage(&prog, &repo.root, &rels)).await
}

#[tauri::command]
async fn git_unstage(app: AppHandle, state: State<'_, AppState>, root: String, rels: Vec<String>, has_commits: bool) -> Result<(), String> {
    let (prog, repo) = git_repo(&app, &state, &root)?;
    blocking(move || git::unstage(&prog, &repo.root, &rels, has_commits)).await
}

#[tauri::command]
async fn git_commit(app: AppHandle, state: State<'_, AppState>, root: String, message: String) -> Result<String, String> {
    let (prog, repo) = git_repo(&app, &state, &root)?;
    let res = blocking(move || git::commit(&prog, &repo.root, &message)).await;
    match &res {
        Ok(_) => applog::info(format!("git commit in {root}")),
        Err(e) => applog::error(format!("git commit in {root}: {e}")),
    }
    res
}

#[tauri::command]
async fn git_push(app: AppHandle, state: State<'_, AppState>, root: String, has_upstream: bool) -> Result<String, String> {
    let (prog, repo) = git_repo(&app, &state, &root)?;
    let res = blocking(move || git::push(&prog, &repo.root, has_upstream)).await;
    if let Err(e) = &res {
        applog::error(format!("git push in {root}: {e}"));
    }
    res
}

#[tauri::command]
async fn git_pull(app: AppHandle, state: State<'_, AppState>, root: String) -> Result<String, String> {
    let (prog, repo) = git_repo(&app, &state, &root)?;
    let res = blocking(move || git::pull(&prog, &repo.root)).await;
    if let Err(e) = &res {
        applog::error(format!("git pull in {root}: {e}"));
    }
    res
}

/// A file's content at HEAD (for the diff view); null for files not in HEAD.
#[tauri::command]
async fn git_head_text(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let prog = git_program(&app);
    blocking(move || git::head_text(&prog, Path::new(&path))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogInfo {
    dir: String,
    app: String,
    languagetool: String,
}

/// Paths and the last 256 KB of both logs, for the log viewer.
#[tauri::command]
async fn read_logs(app: AppHandle) -> LogInfo {
    let dir = log_dir(&app);
    LogInfo {
        dir: dir.to_string_lossy().into_owned(),
        app: applog::tail(&dir.join(applog::APP_LOG), 256 * 1024),
        languagetool: applog::tail(&dir.join(applog::LT_LOG), 256 * 1024),
    }
}

/// Set the language of backend messages (called by the frontend at start-up).
#[tauri::command]
fn set_ui_language(lang: String) {
    i18n::set_language(&lang);
}

/// Open the log directory in Finder/Explorer.
#[tauri::command]
fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = log_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| format!("{} ({}): {e}", i18n::tr("Ordner konnte nicht geöffnet werden", "Could not open the folder"), dir.display()))
}

/// Errors from the frontend (uncaught exceptions, error toasts) go into the app log too.
#[tauri::command]
fn log_frontend(level: String, message: String) {
    applog::write(if level == "error" { "ERROR" } else { "INFO" }, &format!("[UI] {message}"));
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

/// The UI language stored in the settings ("uiLanguage"), for backend messages.
fn language_from_settings(app: &AppHandle) {
    let cfg = settings_dir(app).map(|d| settings::load(&d)).unwrap_or_default();
    i18n::set_language(cfg.get("uiLanguage").and_then(|v| v.as_str()).unwrap_or("de"));
}

/// Directory for propra-editor.log and languagetool.log.
fn log_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_log_dir()
        .or_else(|_| app.path().app_cache_dir())
        .unwrap_or_else(|_| std::env::temp_dir().join("propra-editor"))
}

fn start_languagetool(app: &AppHandle) {
    let work_dir = log_dir(app);
    let app2 = app.clone();
    let location = lt_location(app);
    if let Err(e) = &location {
        applog::error(format!("LanguageTool nicht gefunden: {e}"));
    }
    let lt = lt::LanguageTool::new(location, work_dir, Arc::new(move |s: &lt::LtStatus| {
        match s.state.as_str() {
            "error" => applog::error(format!("LanguageTool: {}", s.message.as_deref().unwrap_or("Fehler"))),
            "ready" => applog::info("LanguageTool bereit"),
            _ => {}
        }
        let _ = app2.emit("lt-status", s);
    }));
    lt.restart();
    *app.state::<AppState>().lt.lock().unwrap() = Some(lt);
}

fn course_config(state: &AppState) -> Result<CourseConfig, String> {
    let guard = state.course.lock().unwrap();
    Ok(guard.as_ref().ok_or_else(|| i18n::tr("Kein Kurs geöffnet", "No course open"))?.index.config.clone())
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

/// The course's own stylesheets (sedrila.css, local.css, codehilite.css from baseresourcedir) for the preview.
#[tauri::command]
async fn course_css(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = course_config(&state)?;
    let Some(dir) = cfg.baseresourcedir else { return Ok(String::new()) };
    let mut css = String::new();
    for name in ["sedrila.css", "local.css", "codehilite.css"] {
        if let Ok(t) = std::fs::read_to_string(dir.join(name)) {
            css.push_str(&t);
            css.push('\n');
        }
    }
    Ok(css)
}

/// Absolute path for a `/`-separated path relative to the course root (from sedrila output).
#[tauri::command]
fn course_path(state: State<'_, AppState>, rel: String) -> Result<String, String> {
    Ok(course::config::join_rel(&course_root(&state)?, &rel).to_string_lossy().into_owned())
}

fn course_root(state: &AppState) -> Result<PathBuf, String> {
    Ok(course_config(state)?.root)
}

/// Output directory for builds: the setting, or `<app cache dir>/build`.
fn build_outdir(app: &AppHandle, setting: &str) -> Result<PathBuf, String> {
    if !setting.trim().is_empty() {
        return Ok(PathBuf::from(setting.trim()));
    }
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("build"))
}

#[tauri::command]
fn build_default_outdir(app: AppHandle) -> Result<String, String> {
    Ok(build_outdir(&app, "")?.to_string_lossy().into_owned())
}

/// Start a sedrila build from the course root; output arrives as `build-line` events,
/// completion as `build-done`. Returns the build id and the command line actually run.
#[tauri::command]
async fn build_start(app: AppHandle, state: State<'_, AppState>, command: String, outdir: String) -> Result<(u64, String), String> {
    let root = course_root(&state)?;
    let out = build_outdir(&app, &outdir)?;
    // builds into the same directory are incremental (about 3x faster for propra-inf)
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let cmdline = build::expand_command(&command, &out);
    let a1 = app.clone();
    let a2 = app.clone();
    let id = build::start(
        state.build.clone(),
        cmdline.clone(),
        root,
        Arc::new(move |l| {
            let _ = a1.emit("build-line", l);
        }),
        Arc::new(move |d: build::BuildDone| {
            match (&d.error, d.cancelled) {
                (Some(e), _) => applog::error(format!("Build konnte nicht gestartet werden: {e}")),
                (None, true) => applog::info("Build abgebrochen"),
                (None, false) => applog::info(format!("Build beendet (Exit-Code {:?}, {} ms)", d.code, d.elapsed_ms)),
            }
            let _ = a2.emit("build-done", d);
        }),
    )?;
    applog::info(format!("Build gestartet: {cmdline}"));
    Ok((id, cmdline))
}

#[tauri::command]
fn build_cancel(state: State<'_, AppState>) -> bool {
    build::cancel(&state.build)
}

/// Run `sedrila --version` the way builds run (for the settings dialog).
#[tauri::command]
async fn sedrila_test(state: State<'_, AppState>, command: String) -> Result<String, String> {
    let root = course_root(&state).unwrap_or_else(|_| std::env::temp_dir());
    let first = if command.trim().is_empty() { build::DEFAULT_COMMAND } else { command.trim() };
    // "uv run sedrila author build …" -> "uv run sedrila --version"
    let prog = match first.find("author") {
        Some(i) => first[..i].trim_end().to_string(),
        None => "sedrila".to_string(),
    };
    tauri::async_runtime::spawn_blocking(move || build::run_once(&format!("{prog} --version"), &root))
        .await
        .map_err(|e| e.to_string())?
}

/// Open the built page of a part in the system browser (instructor version if present).
#[tauri::command]
fn open_built_page(app: AppHandle, outdir: String, name: String) -> Result<String, String> {
    let out = build_outdir(&app, &outdir)?;
    let candidates = [out.join("instructor").join(format!("{name}.html")), out.join(format!("{name}.html"))];
    let page = candidates.iter().find(|p| p.exists()).ok_or_else(|| {
        if i18n::is_english() {
            format!("No built page for “{name}” in {}", out.display())
        } else {
            format!("Keine gebaute Seite für „{name}“ in {}", out.display())
        }
    })?;
    tauri_plugin_opener::open_path(page, None::<&str>).map_err(|e| format!("{}: {e}", i18n::tr("Browser konnte nicht gestartet werden", "Could not start the browser")))?;
    Ok(page.to_string_lossy().into_owned())
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
    language_from_settings(app); // the menu is built before setup runs
    let quit = MenuItem::with_id(app, "quit", i18n::tr("ProPra Editor beenden", "Quit ProPra Editor"), true, Some("CmdOrCtrl+Q"))?;
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
        i18n::tr("Bearbeiten", "Edit"),
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
        i18n::tr("Fenster", "Window"),
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
            course_css,
            build_default_outdir,
            course_path,
            read_logs,
            set_ui_language,
            git_status,
            git_stage,
            git_unstage,
            git_commit,
            git_push,
            git_pull,
            git_head_text,
            open_log_dir,
            log_frontend,
            build_start,
            build_cancel,
            sedrila_test,
            open_built_page,
            list_include_dir,
            lt_status,
            lt_restart,
            lt_check,
            get_dictionary,
            save_dictionary,
        ])
        .setup(|app| {
            language_from_settings(app.handle());
            let dir = log_dir(app.handle());
            applog::init(&dir);
            applog::info(format!(
                "ProPra Editor {} gestartet ({} {})",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                applog::error(format!("Panic: {info}"));
                default_hook(info);
            }));
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
