//! "Wo verwendet?": where glossary terms are referenced, via `[TERMREF::x]`,
//! `[TERMREF2::x::…]` and `explains:` in top matter, across all Markdown files of chapterdir.

use super::config::CourseConfig;
use super::index::rel_string;
use super::topmatter;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermUsage {
    pub term: String,
    pub path: PathBuf,
    pub rel: String,
    /// 0-based line.
    pub line: usize,
    /// "termref" or "explains"
    pub kind: String,
}

/// Terms referenced in one file's text.
pub fn usages_in(text: &str) -> Vec<(String, usize, &'static str)> {
    let mut out = Vec::new();
    let body_start_line = match topmatter::split(text) {
        Some(yaml) => {
            for (i, line) in yaml.lines().enumerate() {
                if let Some(v) = line.strip_prefix("explains:") {
                    let v = v.split(" #").next().unwrap_or("");
                    for t in v.split(',').map(str::trim).filter(|t| !t.is_empty()) {
                        out.push((t.to_string(), i, "explains"));
                    }
                }
            }
            yaml.lines().count() + 1
        }
        None => 0,
    };
    let mut off = false;
    for (i, line) in text.lines().enumerate().skip(body_start_line) {
        if line.contains("sedrila:") && line.contains("macros off") {
            off = !line.contains("end");
            continue;
        }
        if off {
            continue;
        }
        for prefix in ["[TERMREF::", "[TERMREF2::"] {
            let mut rest = line;
            while let Some(p) = rest.find(prefix) {
                let after = &rest[p + prefix.len()..];
                let end = after.find(|c| c == ']' || c == ':').unwrap_or(after.len());
                if end > 0 && after[end..].starts_with(&[']', ':'][..]) {
                    out.push((after[..end].to_string(), i, "termref"));
                }
                rest = &after[end..];
            }
        }
    }
    out
}

pub fn scan(cfg: &CourseConfig) -> Vec<TermUsage> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![cfg.chapterdir.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.filter_map(Result::ok) {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                if !name.ends_with(".zip") {
                    stack.push(p);
                }
            } else if name.ends_with(".md") {
                if let Ok(text) = std::fs::read_to_string(&p) {
                    for (term, line, kind) in usages_in(&text) {
                        out.push(TermUsage { term, rel: rel_string(&cfg.root, &p), path: p.clone(), line, kind: kind.into() });
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| (&a.rel, a.line).cmp(&(&b.rel, b.line)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn finds_termrefs_and_explains() {
        let t = "title: x\nexplains: Shell, Commit (git) # Kommentar\n---\nDie [TERMREF::Shell] und [TERMREF2::Branch::-es].\n<!-- sedrila: macros off -->\n[TERMREF::Nicht]\n<!-- sedrila: macros off end -->\n";
        let u = usages_in(t);
        assert_eq!(
            u,
            vec![
                ("Shell".into(), 1, "explains"),
                ("Commit (git)".into(), 1, "explains"),
                ("Shell".into(), 3, "termref"),
                ("Branch".into(), 3, "termref"),
            ]
        );
    }

    #[test]
    fn scans_fixture_course() {
        let cfg = CourseConfig::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-fixtures/course")).unwrap();
        let u = scan(&cfg);
        let shell: Vec<_> = u.iter().filter(|x| x.term == "Shell").map(|x| (x.rel.as_str(), x.kind.as_str())).collect();
        assert!(shell.contains(&("ch/Basis/Shell/Shell-Einstieg.md", "explains")));
        assert!(shell.contains(&("ch/Basis/Shell/Shell-Einstieg.md", "termref")));
        assert!(shell.contains(&("ch/glossary.md", "termref")));
    }
}
