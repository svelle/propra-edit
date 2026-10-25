//! Running `sedrila author build` (or a user-configured command) from the course root.
//!
//! The command runs through the user's shell so that a venv, `uv`, pipx or environment
//! variables from the shell profile (propra-inf's sedrila.yaml needs SEDRILA_* variables)
//! work as in a terminal: `$SHELL -l -i -c` on Unix, `cmd /C` on Windows. Output lines
//! (ANSI colors kept) are streamed as events; the frontend parses them.
//! sedrila exits with 0 even when it reports errors, so the exit code is only informative.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const DEFAULT_COMMAND: &str = "sedrila author build --include-stage draft {outdir}";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildLine {
    pub id: u64,
    pub line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDone {
    pub id: u64,
    pub code: Option<i32>,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// Set when the process could not be started at all.
    pub error: Option<String>,
}

#[derive(Default)]
pub struct BuildState {
    running: Option<Running>,
    next_id: u64,
}

struct Running {
    pid: u32,
    cancelled: Arc<Mutex<bool>>,
}

/// Quote a path for the shell that runs the command.
pub fn shell_quote(s: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", s.replace('"', ""))
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Insert the output directory into the command (`{outdir}`), or append it if missing.
pub fn expand_command(template: &str, outdir: &Path) -> String {
    let t = if template.trim().is_empty() { DEFAULT_COMMAND } else { template.trim() };
    let q = shell_quote(&outdir.to_string_lossy());
    if t.contains("{outdir}") {
        t.replace("{outdir}", &q)
    } else {
        format!("{t} {q}")
    }
}

fn shell_command(cmdline: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        // raw_arg keeps the user's quoting intact; CREATE_NO_WINDOW avoids a console flash
        c.arg("/C").raw_arg(cmdline).creation_flags(0x0800_0000);
        c
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let mut c = Command::new(&shell);
        // -i so that rc files (where SEDRILA_* variables usually live) are read; plain sh has no -i noise
        if shell.ends_with("/sh") {
            c.arg("-l");
        } else {
            c.arg("-l").arg("-i");
        }
        c.arg("-c").arg(cmdline);
        c.process_group(0);
        c
    }
}

fn prepare(cmdline: &str, cwd: &Path) -> Command {
    let mut c = shell_command(cmdline);
    c.current_dir(cwd)
        .env("FORCE_COLOR", "1")
        .env("COLUMNS", "2000") // rich wraps at COLUMNS; long messages must stay on one line
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

fn kill_tree(pid: u32) {
    #[cfg(unix)]
    {
        // the child leads its own process group (process_group(0)), so this reaches sedrila too
        // "--" so that procps kill reads the negative number as a process group, not a signal;
        // interactive shells ignore SIGTERM, so follow up with SIGKILL
        let group = format!("-{pid}");
        let _ = Command::new("kill").args(["-TERM", "--", &group]).status();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let _ = Command::new("kill").args(["-KILL", "--", &group]).stderr(Stdio::null()).status();
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(0x0800_0000).status();
    }
}

fn pump<R: Read + Send + 'static>(r: R, id: u64, emit: Arc<dyn Fn(BuildLine) + Send + Sync>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end_matches(['\n', '\r']).to_string();
                    emit(BuildLine { id, line });
                }
            }
        }
    })
}

impl BuildState {
    pub fn is_running(&self) -> bool {
        self.running.is_some()
    }
}

/// Start a build. Returns the build id; output and completion arrive through the callbacks.
pub fn start(
    state: Arc<Mutex<BuildState>>,
    cmdline: String,
    cwd: PathBuf,
    on_line: Arc<dyn Fn(BuildLine) + Send + Sync>,
    on_done: Arc<dyn Fn(BuildDone) + Send + Sync>,
) -> Result<u64, String> {
    let mut st = state.lock().unwrap();
    if st.running.is_some() {
        return Err("Es läuft bereits ein Build".into());
    }
    st.next_id += 1;
    let id = st.next_id;
    let started = Instant::now();
    let mut child: Child = match prepare(&cmdline, &cwd).spawn() {
        Ok(c) => c,
        Err(e) => {
            drop(st);
            on_done(BuildDone { id, code: None, elapsed_ms: 0, cancelled: false, error: Some(e.to_string()) });
            return Ok(id);
        }
    };
    let cancelled = Arc::new(Mutex::new(false));
    st.running = Some(Running { pid: child.id(), cancelled: cancelled.clone() });
    drop(st);
    let out = pump(child.stdout.take().unwrap(), id, on_line.clone());
    let err = pump(child.stderr.take().unwrap(), id, on_line);
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = out.join();
        let _ = err.join();
        let was_cancelled = *cancelled.lock().unwrap();
        state.lock().unwrap().running = None;
        on_done(BuildDone {
            id,
            code: status.ok().and_then(|s| s.code()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            cancelled: was_cancelled,
            error: None,
        });
    });
    Ok(id)
}

/// Cancel the running build (kills the whole process tree).
pub fn cancel(state: &Mutex<BuildState>) -> bool {
    let st = state.lock().unwrap();
    match &st.running {
        Some(r) => {
            *r.cancelled.lock().unwrap() = true;
            kill_tree(r.pid);
            true
        }
        None => false,
    }
}

/// Run a short command (e.g. `sedrila --version`) the same way and return its output.
pub fn run_once(cmdline: &str, cwd: &Path) -> Result<String, String> {
    let out = prepare(cmdline, cwd).output().map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        Err(format!("Exit-Code {}: {}", out.status.code().unwrap_or(-1), text.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn expands_outdir() {
        let p = Path::new("/tmp/out dir");
        let c = expand_command("", p);
        assert!(c.starts_with("sedrila author build --include-stage draft "));
        assert!(c.contains("out dir"));
        assert_eq!(expand_command("uv run sedrila author build", Path::new("/o")), format!("uv run sedrila author build {}", shell_quote("/o")));
    }

    #[cfg(unix)]
    #[test]
    fn quotes_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[cfg(unix)]
    #[test]
    fn streams_output_and_reports_completion() {
        let state = Arc::new(Mutex::new(BuildState::default()));
        let (tx, rx) = mpsc::channel();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let l2 = lines.clone();
        let id = start(
            state.clone(),
            "printf 'eins\\nzwei\\n'; echo drei >&2; exit 3".into(),
            std::env::temp_dir(),
            Arc::new(move |l| l2.lock().unwrap().push(l.line)),
            Arc::new(move |d| tx.send(d).unwrap()),
        )
        .unwrap();
        let done = rx.recv_timeout(std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(done.id, id);
        assert_eq!(done.code, Some(3));
        let got = lines.lock().unwrap().clone();
        for want in ["eins", "zwei", "drei"] {
            assert!(got.iter().any(|l| l == want), "{got:?}");
        }
        assert!(!state.lock().unwrap().is_running());
    }

    #[cfg(unix)]
    #[test]
    fn cancel_kills_the_process_tree() {
        let state = Arc::new(Mutex::new(BuildState::default()));
        let (tx, rx) = mpsc::channel();
        start(state.clone(), "sleep 30 & sleep 30; wait".into(), std::env::temp_dir(), Arc::new(|_| {}), Arc::new(move |d| tx.send(d).unwrap())).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(cancel(&state));
        let done = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert!(done.cancelled);
    }
}
