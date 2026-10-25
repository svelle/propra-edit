//! Resolution of `[INCLUDE]`, `[PROT]`, `[SNIPPET]` and `[TREEREF]` paths, mirroring
//! sedrila's `includefile_path` (framework/macroexpanders.py):
//!
//! - `ALT:` and `ITREE:` prefixes switch the base tree from chapterdir to altdir/itreedir.
//! - A leading `/` (after the prefix) means relative to the top of that tree.
//! - Otherwise the path is relative to the context file's directory, mapped into that tree.
//! - An empty path means "same file name as the context file" (`[INCLUDE::ALT:]`).
//! - TREEREF always resolves in itreedir (prefixes make no sense there and are ignored).

use super::config::{join_rel, CourseConfig};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const ALT_PREFIX: &str = "ALT:";
pub const ITREE_PREFIX: &str = "ITREE:";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludeQuery {
    /// INCLUDE, PROT, SNIPPET or TREEREF
    pub macro_name: String,
    pub arg: String,
    /// SNIPPET only: the snippet name to look for.
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IncludeResult {
    pub path: Option<PathBuf>,
    pub exists: bool,
    /// The tree the path points into is not available (e.g. altdir not checked out).
    pub tree_missing: bool,
    pub snippet_found: Option<bool>,
}

/// Resolve `arg` as sedrila would, in the context of the file `context`.
pub fn resolve(cfg: &CourseConfig, context: &Path, arg: &str, itree_mode: bool) -> Option<PathBuf> {
    let (kw, rest) = if let Some(r) = arg.strip_prefix(ALT_PREFIX) {
        (Some(ALT_PREFIX), r)
    } else if let Some(r) = arg.strip_prefix(ITREE_PREFIX) {
        (Some(ITREE_PREFIX), r)
    } else {
        (None, arg)
    };
    let top: PathBuf = if itree_mode {
        cfg.itreedir.clone()?
    } else {
        match kw {
            Some(ALT_PREFIX) => cfg.altdir.clone()?,
            Some(_) => cfg.itreedir.clone()?,
            None => cfg.chapterdir.clone(),
        }
    };
    let (is_abs, incfile) = match rest.strip_prefix('/') {
        Some(r) => (true, r),
        None => (false, rest),
    };
    let ctx_dir = context.parent()?;
    let ctx_name = context.file_name()?;
    let dir = if is_abs {
        top.clone()
    } else {
        match ctx_dir.strip_prefix(&cfg.chapterdir) {
            Ok(rel) => top.join(rel),
            Err(_) => ctx_dir.to_path_buf(),
        }
    };
    Some(if incfile.is_empty() { dir.join(ctx_name) } else { join_rel(&dir, incfile) })
}

fn tree_missing(cfg: &CourseConfig, arg: &str, itree_mode: bool) -> bool {
    let dir = if itree_mode || arg.starts_with(ITREE_PREFIX) {
        cfg.itreedir.as_ref()
    } else if arg.starts_with(ALT_PREFIX) {
        cfg.altdir.as_ref()
    } else {
        return false;
    };
    !dir.is_some_and(|d| d.is_dir())
}

/// Does `file` contain a `SNIPPET::name` marker (in any comment syntax)?
pub fn has_snippet(file: &Path, name: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let marker = format!("SNIPPET::{name}");
    text.lines().any(|l| {
        l.find(&marker).is_some_and(|i| {
            let after = &l[i + marker.len()..];
            !after.starts_with(|c: char| c.is_alphanumeric() || c == '_')
        }) && !l.contains("ENDSNIPPET")
    })
}

/// SNIPPET accepts `ALT` and `ITREE` as shorthand for `ALT:` and `ITREE:` (sedrila's
/// `_normalize_filespec_value`).
pub fn normalize_arg(macro_name: &str, arg: &str) -> String {
    let t = arg.trim();
    match (macro_name, t) {
        ("SNIPPET", "ALT") => ALT_PREFIX.to_string(),
        ("SNIPPET", "ITREE") => ITREE_PREFIX.to_string(),
        ("SNIPPET", _) => t.to_string(),
        _ => arg.to_string(),
    }
}

pub fn check(cfg: &CourseConfig, context: &Path, q: &IncludeQuery) -> IncludeResult {
    let itree_mode = q.macro_name == "TREEREF";
    let arg = normalize_arg(&q.macro_name, &q.arg);
    let path = resolve(cfg, context, &arg, itree_mode);
    let exists = path.as_ref().is_some_and(|p| p.is_file() || (itree_mode && p.exists()));
    let snippet_found = match (&q.snippet, &path) {
        (Some(name), Some(p)) if exists => Some(has_snippet(p, name)),
        _ => None,
    };
    IncludeResult { exists, tree_missing: tree_missing(cfg, &arg, itree_mode), path, snippet_found }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub is_dir: bool,
}

/// Entries of the directory that the partial argument `partial` (up to its last `/`) points to.
pub fn list_dir(cfg: &CourseConfig, context: &Path, partial: &str, itree_mode: bool) -> Vec<DirEntryInfo> {
    let dir_part = match partial.rfind('/') {
        Some(i) => &partial[..=i],
        None => {
            // only the prefix (or nothing) typed so far: the context directory in that tree
            let kw = if partial.starts_with(ALT_PREFIX) { ALT_PREFIX } else if partial.starts_with(ITREE_PREFIX) { ITREE_PREFIX } else { "" };
            kw
        }
    };
    // resolve "<dir_part>x" and take the parent
    let Some(probe) = resolve(cfg, context, &format!("{dir_part}x"), itree_mode) else { return vec![] };
    let Some(dir) = probe.parent() else { return vec![] };
    let mut out: Vec<DirEntryInfo> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| DirEntryInfo { name: e.file_name().to_string_lossy().into_owned(), is_dir: e.path().is_dir() })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> CourseConfig {
        CourseConfig::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-fixtures/course")).unwrap()
    }

    fn task(cfg: &CourseConfig, rel: &[&str]) -> PathBuf {
        rel.iter().fold(cfg.chapterdir.clone(), |p, c| p.join(c))
    }

    fn q(m: &str, arg: &str) -> IncludeQuery {
        IncludeQuery { macro_name: m.into(), arg: arg.into(), snippet: None }
    }

    #[test]
    fn resolves_like_sedrila() {
        let c = cfg();
        let t = task(&c, &["Basis", "Shell", "Shell-Pipes.md"]);
        let alt = c.altdir.clone().unwrap();
        assert_eq!(resolve(&c, &t, "ALT:", false).unwrap(), alt.join("Basis").join("Shell").join("Shell-Pipes.md"));
        assert_eq!(resolve(&c, &t, "ALT:Shell-Pipes.prot", false).unwrap(), alt.join("Basis").join("Shell").join("Shell-Pipes.prot"));
        assert_eq!(resolve(&c, &t, "/_include/a.md", false).unwrap(), c.chapterdir.join("_include").join("a.md"));
        assert_eq!(resolve(&c, &t, "../x.md", false).unwrap(), c.chapterdir.join("Basis").join("Shell").join("..").join("x.md"));
        let itree = c.itreedir.clone().unwrap();
        assert_eq!(resolve(&c, &t, "/Basis/Shell/zeilen.sh", true).unwrap(), itree.join("Basis").join("Shell").join("zeilen.sh"));
        assert_eq!(resolve(&c, &t, "zeilen.sh", true).unwrap(), itree.join("Basis").join("Shell").join("zeilen.sh"));
        assert_eq!(resolve(&c, &t, "ITREE:a.py", false).unwrap(), itree.join("Basis").join("Shell").join("a.py"));
    }

    #[test]
    fn checks_existence_and_snippets() {
        let c = cfg();
        let pipes = task(&c, &["Basis", "Shell", "Shell-Pipes.md"]);
        assert!(check(&c, &pipes, &q("INCLUDE", "ALT:")).exists);
        assert!(check(&c, &pipes, &q("PROT", "ALT:Shell-Pipes.prot")).exists);
        assert!(check(&c, &pipes, &q("INCLUDE", "/_include/Submission-Kommandoprotokoll.md")).exists);
        assert!(!check(&c, &pipes, &q("INCLUDE", "/_include/gibtsnicht.md")).exists);
        let skripte = task(&c, &["Basis", "Shell", "Shell-Skripte.md"]);
        assert!(check(&c, &skripte, &q("TREEREF", "/Basis/Shell/zeilen.sh")).exists);
        let funcs = task(&c, &["Sprachen", "Python", "py-Funktionen.md"]);
        let mut s = q("SNIPPET", "include/demo.py");
        s.snippet = Some("quadrat".into());
        assert_eq!(check(&c, &funcs, &s).snippet_found, Some(true));
        s.snippet = Some("quadra".into());
        assert_eq!(check(&c, &funcs, &s).snippet_found, Some(false));
        assert!(check(&c, &funcs, &q("TREEREF", "py-Funktionen.py")).exists);
        assert_eq!(normalize_arg("SNIPPET", "ALT"), "ALT:");
        assert_eq!(normalize_arg("INCLUDE", "ALT"), "ALT");
    }

    #[test]
    fn reports_missing_altdir_tree() {
        let mut c = cfg();
        c.altdir = Some(c.root.join("gibts-nicht"));
        let t = task(&c, &["Basis", "Shell", "Shell-Pipes.md"]);
        let r = check(&c, &t, &q("INCLUDE", "ALT:"));
        assert!(!r.exists);
        assert!(r.tree_missing);
    }

    #[test]
    fn lists_directories_for_completion() {
        let c = cfg();
        let t = task(&c, &["Basis", "Shell", "Shell-Pipes.md"]);
        let inc = list_dir(&c, &t, "/_include/", false);
        assert!(inc.iter().any(|e| e.name == "Submission-Markdowndokument.md" && !e.is_dir));
        let top = list_dir(&c, &t, "/", false);
        assert!(top.iter().any(|e| e.name == "Basis" && e.is_dir));
        let alt = list_dir(&c, &t, "ALT:", false);
        assert!(alt.iter().any(|e| e.name == "Shell-Pipes.prot"));
        let here = list_dir(&c, &t, "", false);
        assert!(here.iter().any(|e| e.name == "Shell-Einstieg.md"));
    }

    #[test]
    fn golden_includes_resolve_in_propra_inf() {
        // Set PROPRA_INF_DIR to check every non-ALT include of a real checkout.
        let Ok(dir) = std::env::var("PROPRA_INF_DIR") else { return };
        let c = CourseConfig::load(Path::new(&dir)).unwrap();
        let re_call = |line: &str| -> Vec<(String, String, Option<String>)> {
            let mut out = vec![];
            for m in ["INCLUDE", "PROT", "SNIPPET", "TREEREF"] {
                let pat = format!("[{m}::");
                let mut rest = line;
                while let Some(i) = rest.find(&pat) {
                    let after = &rest[i + pat.len()..];
                    if let Some(j) = after.find(']') {
                        let args: Vec<&str> = after[..j].splitn(2, "::").collect();
                        out.push((m.to_string(), args[0].to_string(), args.get(1).map(|s| s.to_string())));
                        rest = &after[j..];
                    } else {
                        break;
                    }
                }
            }
            out
        };
        let mut missing = vec![];
        let mut count = 0;
        let mut stack = vec![c.chapterdir.clone()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().filter_map(Result::ok) {
                let p = e.path();
                if p.is_dir() {
                    if !p.to_string_lossy().contains(".zip") && !p.ends_with("_include") {
                        stack.push(p);
                    }
                } else if p.extension().is_some_and(|x| x == "md") {
                    let text = std::fs::read_to_string(&p).unwrap();
                    let mut off = false;
                    for line in text.lines() {
                        if line.contains("sedrila: macros off") {
                            off = !line.contains("end");
                        }
                        if off {
                            continue;
                        }
                        for (m, arg, snip) in re_call(line) {
                            let arg = normalize_arg(&m, &arg);
                            if (arg.starts_with(ALT_PREFIX) || arg.starts_with(ITREE_PREFIX) || m == "TREEREF") && !c.altdir.as_ref().is_some_and(|a| a.is_dir()) {
                                continue;
                            }
                            count += 1;
                            let r = check(&c, &p, &IncludeQuery { macro_name: m.clone(), arg: arg.clone(), snippet: snip });
                            if !r.exists {
                                missing.push(format!("{}: [{m}::{arg}]", p.display()));
                            }
                        }
                    }
                }
            }
        }
        assert!(count > 100, "only {count} includes found");
        assert!(missing.is_empty(), "{} unresolved:\n{}", missing.len(), missing.join("\n"));
    }
}
