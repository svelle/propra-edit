//! File reading and atomic writing that preserves encoding details.
//!
//! The editor works on `\n`-separated text. On read we remember the file's line ending
//! and UTF-8 BOM; on write we restore them, so a save without edits is byte-identical.
//! The final newline needs no special handling: it is just part of the text.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

const BOM: &str = "\u{feff}";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    /// Content with `\n` line endings and without BOM.
    pub text: String,
    /// `"\n"` or `"\r\n"`: the dominant line ending of the file.
    pub eol: String,
    pub bom: bool,
    /// The file mixes CRLF and LF. Saving will normalize it to `eol`.
    pub mixed_eol: bool,
}

pub fn decode(bytes: &[u8]) -> Result<TextFile, String> {
    let s = std::str::from_utf8(bytes).map_err(|e| format!("kein gültiges UTF-8: {e}"))?;
    let (bom, s) = match s.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let crlf = s.matches("\r\n").count();
    let lf = s.matches('\n').count() - crlf;
    let eol = if crlf > lf { "\r\n" } else { "\n" };
    let text = if crlf > 0 { s.replace("\r\n", "\n") } else { s.to_string() };
    Ok(TextFile { text, eol: eol.to_string(), bom, mixed_eol: crlf > 0 && lf > 0 })
}

pub fn encode(text: &str, eol: &str, bom: bool) -> Vec<u8> {
    let normalized = if text.contains("\r\n") { text.replace("\r\n", "\n") } else { text.to_string() };
    let body = if eol == "\r\n" { normalized.replace('\n', "\r\n") } else { normalized };
    let mut out = String::with_capacity(body.len() + 3);
    if bom {
        out.push_str(BOM);
    }
    out.push_str(&body);
    out.into_bytes()
}

pub fn read_text(path: &Path) -> Result<TextFile, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    decode(&bytes).map_err(|e| format!("{}: {}", path.display(), e))
}

fn temp_path_for(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!(".{}.propra-tmp-{}", name, std::process::id()))
}

/// Write bytes atomically: write a temp file in the same directory, flush it to disk,
/// then rename it over the target. Keeps the target's permissions.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let err = |e: std::io::Error| format!("{}: {}", path.display(), e);
    let tmp = temp_path_for(path);
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if let Ok(meta) = std::fs::metadata(path) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        // On Windows a rename can fail briefly if another program (indexer, virus scanner)
        // holds the target open; retry a few times.
        let mut last = None;
        for attempt in 0..5 {
            match std::fs::rename(&tmp, path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(20 * (attempt + 1)));
                }
            }
        }
        Err(last.unwrap())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(err)
}

pub fn write_text(path: &Path, text: &str, eol: &str, bom: bool) -> Result<(), String> {
    write_atomic(path, &encode(text, eol, bom))
}

/// Create a new file; fails if it exists. Creates missing parent directories.
pub fn create_new(path: &Path, text: &str) -> Result<(), String> {
    let err = |e: std::io::Error| format!("{}: {}", path.display(), e);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(err)?;
    f.write_all(text.as_bytes()).map_err(err)?;
    f.sync_all().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("propra-fs-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn roundtrip_is_byte_identical() {
        for original in [
            "a\nb\n".as_bytes(),
            b"a\r\nb\r\n",
            b"no final newline",
            b"a\r\nb",
            "\u{feff}mit BOM\r\n".as_bytes(),
            "Umlaute äöüß „Zitat“\n".as_bytes(),
            b"",
        ] {
            let tf = decode(original).unwrap();
            assert!(!tf.text.contains('\r'));
            assert_eq!(encode(&tf.text, &tf.eol, tf.bom), original);
        }
    }

    #[test]
    fn detects_mixed_line_endings() {
        let tf = decode(b"a\r\nb\nc\r\n").unwrap();
        assert!(tf.mixed_eol);
        assert_eq!(tf.eol, "\r\n");
        assert_eq!(tf.text, "a\nb\nc\n");
    }

    #[test]
    fn rejects_invalid_utf8() {
        assert!(decode(&[0x66, 0xff, 0x00]).is_err());
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = scratch("atomic");
        let p = dir.join("task.md");
        std::fs::write(&p, "alt\r\n").unwrap();
        let tf = read_text(&p).unwrap();
        write_text(&p, &format!("{}neu\n", tf.text), &tf.eol, tf.bom).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"alt\r\nneu\r\n");
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(Result::ok).collect();
        assert_eq!(leftovers.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_new_refuses_existing_and_creates_parents() {
        let dir = scratch("create");
        let p = dir.join("a").join("b").join("x.md");
        create_new(&p, "hallo\n").unwrap();
        assert!(create_new(&p, "nochmal").is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hallo\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
