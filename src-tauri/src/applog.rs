//! A small append-only app log (`propra-editor.log` in the app's log directory).
//!
//! Records what is needed to diagnose problems on a user's machine: LanguageTool start-up
//! and failures, build and git errors, and errors reported by the frontend. Rotated at 2 MB
//! (one old file is kept as `propra-editor.log.1`).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const APP_LOG: &str = "propra-editor.log";
pub const LT_LOG: &str = "languagetool.log";
const MAX_SIZE: u64 = 2 * 1024 * 1024;

static DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    *DIR.lock().unwrap() = Some(dir.to_path_buf());
}

pub fn dir() -> Option<PathBuf> {
    DIR.lock().unwrap().clone()
}

/// UTC timestamp like `2026-10-25 21:46:16` (no date crate needed).
pub fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format_utc(secs)
}

fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn write(level: &str, msg: &str) {
    let guard = DIR.lock().unwrap();
    let Some(dir) = guard.as_ref() else { return };
    let path = dir.join(APP_LOG);
    if std::fs::metadata(&path).map(|m| m.len() > MAX_SIZE).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join(format!("{APP_LOG}.1")));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} [{level}] {}", timestamp(), msg.trim_end());
    }
}

pub fn info(msg: impl AsRef<str>) {
    write("INFO", msg.as_ref());
}

pub fn warn(msg: impl AsRef<str>) {
    write("WARN", msg.as_ref());
}

pub fn error(msg: impl AsRef<str>) {
    write("ERROR", msg.as_ref());
}

/// The last `max_bytes` of a text file (cut at a line start), or "" if it does not exist.
pub fn tail(path: &Path, max_bytes: u64) -> String {
    let Ok(bytes) = std::fs::read(path) else { return String::new() };
    let start = bytes.len().saturating_sub(max_bytes as usize);
    let mut text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    if start > 0 {
        if let Some(nl) = text.find('\n') {
            text = text[nl + 1..].to_string();
        }
    }
    text
}

/// The last `n` non-empty lines of a file, for error messages.
pub fn last_lines(path: &Path, n: usize) -> Vec<String> {
    let text = tail(path, 16 * 1024);
    let lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines[lines.len().saturating_sub(n)..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(format_utc(1_793_051_176), "2026-10-26 21:46:16 UTC");
        assert_eq!(format_utc(951_782_400), "2000-02-29 00:00:00 UTC");
    }

    #[test]
    fn tail_cuts_at_line_start() {
        let p = std::env::temp_dir().join(format!("propra-tail-{}.txt", std::process::id()));
        std::fs::write(&p, "eins\nzwei\ndrei\n").unwrap();
        assert_eq!(tail(&p, 8), "drei\n");
        assert_eq!(last_lines(&p, 2), vec!["zwei", "drei"]);
        assert_eq!(tail(&p.with_extension("fehlt"), 8), "");
        let _ = std::fs::remove_file(p);
    }
}
