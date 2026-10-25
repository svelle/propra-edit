//! File watching for the course root (including the altdir submodule).
//!
//! Events are debounced and sent to the frontend as `file-changed` with absolute paths.
//! The frontend compares the disk content with what it last saved, so the editor's own
//! saves do not trigger reload prompts.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

const DEBOUNCE: Duration = Duration::from_millis(150);

pub fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == ".git" || s == "node_modules" || s == "__pycache__" || s == ".sedrila_cache"
    }) || path
        .file_name()
        .map(|n| n.to_string_lossy().contains(".propra-tmp-"))
        .unwrap_or(false)
}

/// Starts watching `root`. `on_batch` is called from a background thread with each
/// debounced batch of changed paths. Dropping the returned watcher stops it.
pub fn start<F>(root: &Path, on_batch: F) -> Result<RecommendedWatcher, String>
where
    F: Fn(Vec<PathBuf>) + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            for p in ev.paths {
                if !is_ignored(&p) {
                    let _ = tx.send(p);
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        // Ends when the watcher (and with it the sender) is dropped.
        while let Ok(first) = rx.recv() {
            let mut batch = BTreeSet::from([first]);
            while let Ok(p) = rx.recv_timeout(DEBOUNCE) {
                batch.insert(p);
            }
            on_batch(batch.into_iter().collect());
        }
    });
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_git_and_temp_files() {
        assert!(is_ignored(&Path::new("r").join(".git").join("index")));
        assert!(is_ignored(&Path::new("r").join("altdir").join(".git")));
        assert!(is_ignored(&Path::new("r").join(".task.md.propra-tmp-12")));
        assert!(!is_ignored(&Path::new("r").join("ch").join("task.md")));
    }

    #[test]
    fn reports_changes() {
        let dir = std::env::temp_dir().join(format!("propra-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = start(&dir, move |b| {
            let _ = tx.send(b);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let f = dir.join("a.md");
        std::fs::write(&f, "x").unwrap();
        let batch = rx.recv_timeout(Duration::from_secs(5)).expect("no event");
        assert!(batch.iter().any(|p| p.file_name() == f.file_name()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
