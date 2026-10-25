//! LanguageTool sidecar: a local LanguageTool HTTP server on 127.0.0.1 and a random port.
//!
//! The frontend never talks to it directly; checks go through `LanguageTool::check`, so port
//! and lifecycle stay private. The server is started at app launch, health-checked, warmed up
//! with one German check (the first check loads the German rules and takes several seconds),
//! and restarted with backoff if it crashes.
//!
//! Important: LanguageTool's server re-creates its rule pipeline for every request unless
//! `pipelineCaching=true` is configured. Without it, the German speller alone costs ~1.2 s
//! per request; with it, a sentence takes a few dozen milliseconds (see docs/decisions.md).

use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const SERVER_CLASS: &str = "org.languagetool.server.HTTPServer";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const CHECK_WAIT_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_RESTARTS: u32 = 5;

/// Server configuration (LanguageTool `--config` properties file).
pub const SERVER_PROPERTIES: &str = "\
# written by ProPra Editor on each start
pipelineCaching=true
maxPipelinePoolSize=2
pipelineExpireTimeInSeconds=86400
maxTextLength=1000000
";

/// A realistic German paragraph: loads tagger, speller and grammar rules once.
const WARMUP_TEXT: &str = "Öffnen Sie ein Terminal und geben Sie das Kommando ein. \
Was bedeutet die Option, die Sie gerade verwendet haben? \
Die Studierenden lesen die Aufgabe sorgfältig durch, bevor sie mit der Arbeit beginnen.";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LtStatus {
    /// "starting" | "ready" | "error" | "stopped"
    pub state: String,
    pub message: Option<String>,
}

impl LtStatus {
    fn new(state: &str, message: Option<String>) -> Self {
        LtStatus { state: state.to_string(), message }
    }
}

#[derive(Debug, Clone)]
pub struct LtLocation {
    pub java: PathBuf,
    /// Directory containing the LanguageTool jars (`languagetool-server-*.jar` and dependencies).
    pub lib: PathBuf,
}

fn has_jars(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().starts_with("languagetool-server")))
        .unwrap_or(false)
}

/// Drop Windows' `\\?\` prefix: Java does not expand `lib\*` classpath wildcards in such paths.
pub fn plain_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

fn java_in(jre: &Path) -> PathBuf {
    jre.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" })
}

/// Find Java and the LanguageTool jars. Explicit settings win; then the bundled resources
/// (`<resources>/jre`, `<resources>/languagetool/lib`); Java falls back to `java` on PATH.
pub fn locate(resource_dir: Option<&Path>, java_override: Option<PathBuf>, lib_override: Option<PathBuf>) -> Result<LtLocation, String> {
    let resource_dir = resource_dir.map(|r| plain_path(r.to_path_buf()));
    let resource_dir = resource_dir.as_deref();
    let lib = lib_override
        .filter(|d| has_jars(d))
        .or_else(|| resource_dir.map(|r| r.join("languagetool").join("lib")).filter(|d| has_jars(d)))
        .ok_or_else(|| {
            format!(
                "LanguageTool wurde nicht gefunden (gesucht in {}). Für Entwicklungs-Builds: scripts/fetch-runtime ausführen.",
                resource_dir.map(|r| r.join("languagetool").join("lib").display().to_string()).unwrap_or_else(|| "–".into())
            )
        })?;
    let java = java_override
        .filter(|j| j.is_file())
        .or_else(|| resource_dir.map(|r| java_in(&r.join("jre"))).filter(|j| j.is_file()))
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "java.exe" } else { "java" }));
    Ok(LtLocation { java, lib })
}

/// The last `n` non-empty lines written after the most recent "===== … Start" header.
fn lines_of_last_start(log: &str, n: usize) -> Vec<String> {
    let since = match log.rfind("\n===== ") {
        Some(i) => log[i + 1..].split_once('\n').map(|(_, rest)| rest).unwrap_or(""),
        None => log,
    };
    let lines: Vec<String> = since.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines[lines.len().saturating_sub(n)..].to_vec()
}

pub fn free_port() -> std::io::Result<u16> {
    let l = TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

type StatusCallback = Arc<dyn Fn(&LtStatus) + Send + Sync>;

struct Inner {
    status: LtStatus,
    port: Option<u16>,
    child: Option<Child>,
    /// Incremented on every (re)start; background threads of older generations stop.
    generation: u64,
    restarts: u32,
    shutting_down: bool,
}

#[derive(Clone)]
pub struct LanguageTool {
    inner: Arc<(Mutex<Inner>, Condvar)>,
    on_status: StatusCallback,
    location: Arc<Mutex<Result<LtLocation, String>>>,
    work_dir: PathBuf,
}

impl LanguageTool {
    /// `work_dir` receives the properties file and `languagetool.log`.
    pub fn new(location: Result<LtLocation, String>, work_dir: PathBuf, on_status: StatusCallback) -> Self {
        let work_dir = plain_path(work_dir);
        LanguageTool {
            inner: Arc::new((
                Mutex::new(Inner {
                    status: LtStatus::new("stopped", None),
                    port: None,
                    child: None,
                    generation: 0,
                    restarts: 0,
                    shutting_down: false,
                }),
                Condvar::new(),
            )),
            on_status,
            location: Arc::new(Mutex::new(location)),
            work_dir,
        }
    }

    pub fn status(&self) -> LtStatus {
        self.inner.0.lock().unwrap().status.clone()
    }

    fn set_status(&self, generation: u64, status: LtStatus) {
        let (lock, cv) = &*self.inner;
        let mut g = lock.lock().unwrap();
        if g.generation != generation {
            return;
        }
        g.status = status.clone();
        cv.notify_all();
        drop(g);
        (self.on_status)(&status);
    }

    pub fn set_location(&self, location: Result<LtLocation, String>) {
        *self.location.lock().unwrap() = location;
    }

    /// (Re)start the server. Resets the crash counter.
    pub fn restart(&self) {
        {
            let mut g = self.inner.0.lock().unwrap();
            g.restarts = 0;
            g.shutting_down = false;
        }
        self.spawn();
    }

    pub fn shutdown(&self) {
        let mut g = self.inner.0.lock().unwrap();
        g.shutting_down = true;
        g.generation += 1;
        if let Some(mut c) = g.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        g.status = LtStatus::new("stopped", None);
        self.inner.1.notify_all();
    }

    fn spawn(&self) {
        let generation = {
            let mut g = self.inner.0.lock().unwrap();
            g.generation += 1;
            if let Some(mut c) = g.child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            g.port = None;
            g.generation
        };
        self.set_status(generation, LtStatus::new("starting", None));
        let me = self.clone();
        std::thread::spawn(move || {
            if let Err(e) = me.run(generation) {
                me.set_status(generation, LtStatus::new("error", Some(e)));
                me.maybe_restart(generation);
            }
        });
    }

    fn launch(&self, loc: &LtLocation, port: u16) -> Result<Child, String> {
        std::fs::create_dir_all(&self.work_dir).map_err(|e| e.to_string())?;
        let props = self.work_dir.join("languagetool.properties");
        std::fs::write(&props, SERVER_PROPERTIES).map_err(|e| e.to_string())?;
        // appended, not truncated: the first failure must survive the automatic restarts
        let log_path = self.log_path();
        if std::fs::metadata(&log_path).map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(false) {
            let _ = std::fs::rename(&log_path, log_path.with_extension("log.1"));
        }
        let mut log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| format!("{}: {}", log_path.display(), e))?;
        let classpath = format!("{}{}*", loc.lib.display(), std::path::MAIN_SEPARATOR);
        let _ = writeln!(
            log,
            "\n===== {} Start: {} -cp {} {} --port {}",
            crate::applog::timestamp(),
            loc.java.display(),
            classpath,
            SERVER_CLASS,
            port
        );
        let log2 = log.try_clone().map_err(|e| e.to_string())?;
        crate::applog::info(format!("LanguageTool startet: java={} lib={} port={port}", loc.java.display(), loc.lib.display()));
        let mut cmd = Command::new(&loc.java);
        cmd.args(["-Xmx1g", "-XX:+UseSerialGC", "-Dfile.encoding=UTF-8", "-cp"])
            .arg(classpath)
            .arg(SERVER_CLASS)
            .args(["--port", &port.to_string(), "--config"])
            .arg(&props)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(log2);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.spawn().map_err(|e| format!("Java konnte nicht gestartet werden ({}): {}", loc.java.display(), e))
    }

    fn run(&self, generation: u64) -> Result<(), String> {
        let loc = self.location.lock().unwrap().clone()?;
        let port = free_port().map_err(|e| e.to_string())?;
        let child = self.launch(&loc, port)?;
        {
            let mut g = self.inner.0.lock().unwrap();
            if g.generation != generation {
                let mut c = child;
                let _ = c.kill();
                return Ok(());
            }
            g.child = Some(child);
        }
        // health check
        let start = Instant::now();
        let url = format!("http://127.0.0.1:{port}/v2/languages");
        loop {
            if self.child_exited(generation) {
                return Err(self.with_log_tail(format!("LanguageTool wurde beim Start beendet ({})", self.exit_info(generation))));
            }
            if ureq::get(&url).timeout(Duration::from_secs(2)).call().is_ok() {
                break;
            }
            if start.elapsed() > STARTUP_TIMEOUT {
                return Err(self.with_log_tail(format!("LanguageTool antwortet nicht (Zeitüberschreitung nach {} s beim Start)", STARTUP_TIMEOUT.as_secs())));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        self.set_status(generation, LtStatus::new("starting", Some("Wird aufgewärmt …".into())));
        post_check(port, &[("language", "de-DE"), ("text", WARMUP_TEXT)]).map_err(|e| self.with_log_tail(format!("Aufwärmen fehlgeschlagen: {e}")))?;
        {
            let mut g = self.inner.0.lock().unwrap();
            if g.generation != generation {
                return Ok(());
            }
            g.port = Some(port);
        }
        self.set_status(generation, LtStatus::new("ready", None));
        let ready_at = Instant::now();
        // monitor
        loop {
            std::thread::sleep(Duration::from_millis(500));
            {
                let g = self.inner.0.lock().unwrap();
                if g.generation != generation || g.shutting_down {
                    return Ok(());
                }
            }
            if self.child_exited(generation) {
                if ready_at.elapsed() > Duration::from_secs(300) {
                    self.inner.0.lock().unwrap().restarts = 0;
                }
                return Err(self.with_log_tail(format!("LanguageTool ist abgestürzt ({})", self.exit_info(generation))));
            }
        }
    }

    pub fn log_path(&self) -> PathBuf {
        self.work_dir.join(crate::applog::LT_LOG)
    }

    /// "Exit-Code 1" (or similar) for the exited child of this generation.
    fn exit_info(&self, generation: u64) -> String {
        let mut g = self.inner.0.lock().unwrap();
        if g.generation != generation {
            return "beendet".into();
        }
        match g.child.as_mut().map(|c| c.try_wait()) {
            Some(Ok(Some(st))) => match st.code() {
                Some(c) => format!("Exit-Code {c}"),
                None => format!("{st}"),
            },
            Some(Err(e)) => e.to_string(),
            _ => "beendet".into(),
        }
    }

    /// Append the last lines of languagetool.log, which usually name the cause.
    fn with_log_tail(&self, msg: String) -> String {
        let lines = lines_of_last_start(&crate::applog::tail(&self.log_path(), 16 * 1024), 8);
        if lines.is_empty() {
            format!("{msg}. Keine Ausgabe von Java in {}", crate::applog::LT_LOG)
        } else {
            format!("{msg}. Letzte Zeilen aus {}:\n{}", crate::applog::LT_LOG, lines.join("\n"))
        }
    }

    fn child_exited(&self, generation: u64) -> bool {
        let mut g = self.inner.0.lock().unwrap();
        if g.generation != generation {
            return false;
        }
        match g.child.as_mut().map(|c| c.try_wait()) {
            Some(Ok(Some(_))) | Some(Err(_)) | None => true,
            Some(Ok(None)) => false,
        }
    }

    fn maybe_restart(&self, generation: u64) {
        let delay = {
            let mut g = self.inner.0.lock().unwrap();
            if g.generation != generation || g.shutting_down || g.restarts >= MAX_RESTARTS {
                return;
            }
            // configuration errors (no jars, no java) do not get better by retrying
            if self.location.lock().unwrap().is_err() {
                return;
            }
            g.restarts += 1;
            Duration::from_secs(1 << (g.restarts - 1))
        };
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let still_current = me.inner.0.lock().unwrap().generation == generation;
            if still_current {
                me.spawn();
            }
        });
    }

    /// Wait until the server is ready (or failed) and return its port.
    fn wait_ready(&self) -> Result<u16, String> {
        let (lock, cv) = &*self.inner;
        let deadline = Instant::now() + CHECK_WAIT_TIMEOUT;
        let mut g = lock.lock().unwrap();
        loop {
            if let (Some(port), "ready") = (g.port, g.status.state.as_str()) {
                return Ok(port);
            }
            if g.status.state == "error" && g.restarts >= MAX_RESTARTS || g.status.state == "stopped" && g.shutting_down {
                return Err(g.status.message.clone().unwrap_or_else(|| "LanguageTool ist nicht verfügbar".into()));
            }
            if self.location.lock().unwrap().is_err() {
                return Err(self.location.lock().unwrap().clone().unwrap_err());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("LanguageTool ist nicht bereit (Zeitüberschreitung)".into());
            }
            g = cv.wait_timeout(g, deadline - now).unwrap().0;
        }
    }

    /// Send a check request; returns LanguageTool's JSON response unchanged.
    pub fn check(&self, form: &[(&str, &str)]) -> Result<String, String> {
        let port = self.wait_ready()?;
        post_check(port, form)
    }
}

fn post_check(port: u16, form: &[(&str, &str)]) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/v2/check");
    match ureq::post(&url).timeout(Duration::from_secs(120)).send_form(form) {
        Ok(resp) => resp.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, resp)) => Err(format!("LanguageTool-Fehler {code}: {}", resp.into_string().unwrap_or_default())),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_lines_only_from_the_last_start() {
        let log = "alt 1\n\n===== t Start: java\nalt 2\n\n===== t Start: java\nError: Could not find main class\n";
        assert_eq!(lines_of_last_start(log, 8), vec!["Error: Could not find main class"]);
        assert!(lines_of_last_start("\n===== t Start: java\n", 8).is_empty());
    }

    #[test]
    fn plain_path_strips_verbatim_prefix() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\C:\Program Files\x")), PathBuf::from(r"C:\Program Files\x"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\server\share")), PathBuf::from(r"\\?\UNC\server\share"));
        assert_eq!(plain_path(PathBuf::from("/opt/x")), PathBuf::from("/opt/x"));
    }

    #[test]
    fn locate_reports_missing_jars() {
        let dir = std::env::temp_dir().join(format!("propra-lt-missing-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        assert!(locate(Some(&dir), None, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn locate_prefers_bundled_runtime() {
        let dir = std::env::temp_dir().join(format!("propra-lt-loc-{}", std::process::id()));
        let lib = dir.join("languagetool").join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("languagetool-server-6.8.jar"), b"").unwrap();
        let java = java_in(&dir.join("jre"));
        std::fs::create_dir_all(java.parent().unwrap()).unwrap();
        std::fs::write(&java, b"").unwrap();
        let loc = locate(Some(&dir), None, None).unwrap();
        assert_eq!(loc.lib, lib);
        assert_eq!(loc.java, java);
        // without a bundled JRE, `java` from PATH is used
        std::fs::remove_file(&java).unwrap();
        assert!(locate(Some(&dir), None, None).unwrap().java.to_string_lossy().starts_with("java"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn free_port_is_nonzero() {
        assert!(free_port().unwrap() > 0);
    }

    /// End-to-end test against a real LanguageTool. Set PROPRA_LT_LIB to a directory with
    /// the jars (and optionally PROPRA_LT_JAVA) to run it.
    #[test]
    fn real_server_check() {
        let Ok(lib) = std::env::var("PROPRA_LT_LIB") else { return };
        let java = std::env::var("PROPRA_LT_JAVA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("java"));
        let work = std::env::temp_dir().join(format!("propra-lt-e2e-{}", std::process::id()));
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let s2 = statuses.clone();
        let lt = LanguageTool::new(Ok(LtLocation { java, lib: lib.into() }), work, Arc::new(move |s| s2.lock().unwrap().push(s.state.clone())));
        lt.restart();
        let json = lt.check(&[("language", "de-DE"), ("text", "Geben Sie das Ergebnis mit der Kommando aus.")]).unwrap();
        assert!(json.contains("DE_AGREEMENT"), "{json}");
        let t = Instant::now();
        lt.check(&[("language", "de-DE"), ("text", "Die Studierenden lesen die Aufgabe durch.")]).unwrap();
        assert!(t.elapsed() < Duration::from_secs(2), "check took {:?}", t.elapsed());
        lt.shutdown();
        assert!(statuses.lock().unwrap().contains(&"ready".to_string()));
    }
}
