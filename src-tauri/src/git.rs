//! Git for the course repo and the altdir repo (in propra-inf a submodule of the course repo).
//!
//! Everything goes through the `git` command line, so the user's configuration, credential
//! helpers and SSH setup apply exactly as in a terminal. Nothing here needs a shell.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Absolute path (native separators).
    pub path: PathBuf,
    /// Path relative to the repository root, `/`-separated (display, git arguments).
    pub rel: String,
    /// Status letters as in `git status --short`: index and work tree ('.' = unchanged).
    pub index: char,
    pub worktree: char,
    pub untracked: bool,
    pub conflict: bool,
    /// The entry is a submodule (the altdir pointer in the course repo).
    pub submodule: bool,
    pub orig_rel: Option<String>,
    /// For files in altdir: the task file they belong to (same path below chapterdir).
    pub task_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub root: PathBuf,
    /// "course" or "altdir".
    pub kind: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_commits: bool,
    pub files: Vec<GitFile>,
    /// For the course repo: path of the altdir submodule relative to it, if altdir is one.
    pub submodule_rel: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Repo {
    pub root: PathBuf,
    pub kind: &'static str,
}

fn git_cmd(git: &str, dir: &Path) -> Command {
    let mut c = Command::new(if git.trim().is_empty() { "git" } else { git.trim() });
    c.current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0") // never wait for a password on a terminal we don't have
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Run git, returning stdout on success or a message with stderr on failure.
pub fn run(git: &str, dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(git, dir).args(args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git wurde nicht gefunden. Bitte git installieren oder den Pfad in den Einstellungen angeben.".to_string()
        } else {
            e.to_string()
        }
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = format!("{}{}", stdout, stderr).trim().to_string();
        Err(if msg.is_empty() { format!("git {} fehlgeschlagen", args.first().unwrap_or(&"")) } else { msg })
    }
}

/// Run git and return stdout and stderr together (push/pull/commit report on stderr).
pub fn run_all(git: &str, dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(git, dir).args(args).output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

/// Canonical path without Windows' `\\?\` prefix (so it compares with ordinary paths).
fn canon(p: &Path) -> PathBuf {
    let c = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => c,
    }
}

/// Top level of the work tree containing `dir`, if any (canonical).
pub fn toplevel(git: &str, dir: &Path) -> Option<PathBuf> {
    let out = run(git, dir, &["rev-parse", "--show-toplevel"]).ok()?;
    Some(canon(Path::new(out.trim())))
}

/// The ancestor of `given` that is the work tree root `top`, spelled like `given` (so file
/// paths built from it match the paths in the course index, also through symlinks).
fn spelled_like(given: &Path, top: &Path) -> PathBuf {
    let mut p = Some(given);
    while let Some(d) = p {
        if canon(d) == top {
            return d.to_path_buf();
        }
        p = d.parent();
    }
    top.to_path_buf()
}

/// The course repo and, if altdir lives in a different work tree, the altdir repo.
pub fn discover(git: &str, course_root: &Path, altdir: Option<&Path>) -> Vec<Repo> {
    let mut repos: Vec<(PathBuf, Repo)> = Vec::new();
    if let Some(top) = toplevel(git, course_root) {
        repos.push((top.clone(), Repo { root: spelled_like(course_root, &top), kind: "course" }));
    }
    if let Some(alt) = altdir.filter(|a| a.is_dir()) {
        if let Some(top) = toplevel(git, alt) {
            if !repos.iter().any(|(t, _)| *t == top) {
                repos.push((top.clone(), Repo { root: spelled_like(alt, &top), kind: "altdir" }));
            }
        }
    }
    repos.into_iter().map(|(_, r)| r).collect()
}

fn native(root: &Path, rel: &str) -> PathBuf {
    crate::course::config::join_rel(root, rel)
}

/// Parse `git status --porcelain=v2 --branch -z` output.
pub fn parse_status(root: &Path, kind: &str, out: &str) -> RepoStatus {
    let mut st = RepoStatus {
        root: root.to_path_buf(),
        kind: kind.to_string(),
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        has_commits: true,
        files: vec![],
        submodule_rel: None,
    };
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    while let Some(f) = fields.next() {
        if let Some(h) = f.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" => st.has_commits = v != "(initial)",
                "branch.head" => st.branch = (v != "(detached)").then(|| v.to_string()),
                "branch.upstream" => st.upstream = Some(v.to_string()),
                "branch.ab" => {
                    for part in v.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind_ch = f.chars().next().unwrap_or(' ');
        match kind_ch {
            '1' | '2' | 'u' => {
                // 1 XY sub mH mI mW hH hI path
                // 2 XY sub mH mI mW hH hI Xscore path \0 orig
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let n = match kind_ch {
                    '1' => 8,
                    '2' => 9,
                    _ => 10,
                };
                let parts: Vec<&str> = f.splitn(n + 1, ' ').collect();
                if parts.len() < n + 1 {
                    continue;
                }
                let xy: Vec<char> = parts[1].chars().collect();
                let rel = parts[n].to_string();
                let orig_rel = if kind_ch == '2' { fields.next().map(str::to_string) } else { None };
                st.files.push(GitFile {
                    path: native(root, &rel),
                    rel,
                    index: xy.first().copied().unwrap_or('.'),
                    worktree: xy.get(1).copied().unwrap_or('.'),
                    untracked: false,
                    conflict: kind_ch == 'u',
                    submodule: parts[2].starts_with('S'),
                    orig_rel,
                    task_path: None,
                });
            }
            '?' => {
                let rel = f[2..].to_string();
                st.files.push(GitFile {
                    path: native(root, &rel),
                    rel,
                    index: '?',
                    worktree: '?',
                    untracked: true,
                    conflict: false,
                    submodule: false,
                    orig_rel: None,
                    task_path: None,
                });
            }
            _ => {}
        }
    }
    st
}

pub fn status(git: &str, repo: &Repo) -> Result<RepoStatus, String> {
    // --ignore-submodules=dirty: the altdir pointer shows as changed only when altdir's HEAD
    // moved (a commit there), not for uncommitted edits, which the altdir repo itself lists
    let out = run(git, &repo.root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty"])?;
    Ok(parse_status(&repo.root, repo.kind, &out))
}

/// Status of all repos; the course repo learns where the altdir submodule is.
pub fn status_all(git: &str, repos: &[Repo]) -> Result<Vec<RepoStatus>, String> {
    let mut all = Vec::new();
    for r in repos {
        all.push(status(git, r)?);
    }
    let alt_root = repos.iter().find(|r| r.kind == "altdir").map(|r| r.root.clone());
    if let (Some(alt), Some(course)) = (alt_root, all.iter_mut().find(|s| s.kind == "course")) {
        if let Ok(rel) = canon(&alt).strip_prefix(canon(&course.root)) {
            course.submodule_rel = Some(crate::course::index::rel_string(Path::new(""), rel));
        }
    }
    Ok(all)
}

pub fn stage(git: &str, repo: &Path, rels: &[String]) -> Result<(), String> {
    let mut args = vec!["add", "-A", "--"];
    args.extend(rels.iter().map(String::as_str));
    run(git, repo, &args).map(|_| ())
}

pub fn unstage(git: &str, repo: &Path, rels: &[String], has_commits: bool) -> Result<(), String> {
    let mut args: Vec<&str> = if has_commits { vec!["reset", "-q", "--"] } else { vec!["rm", "--cached", "-q", "-r", "--"] };
    args.extend(rels.iter().map(String::as_str));
    run(git, repo, &args).map(|_| ())
}

/// Push; without an upstream, push the current branch to origin and set it as upstream.
pub fn push(git: &str, repo: &Path, has_upstream: bool) -> Result<String, String> {
    if has_upstream {
        run_all(git, repo, &["push"])
    } else {
        run_all(git, repo, &["push", "-u", "origin", "HEAD"])
    }
}

/// Pull without ever creating a merge commit or opening an editor.
pub fn pull(git: &str, repo: &Path) -> Result<String, String> {
    run_all(git, repo, &["pull", "--ff-only"])
}

pub fn commit(git: &str, repo: &Path, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Die Commit-Nachricht ist leer".into());
    }
    run_all(git, repo, &["commit", "-m", message])
}

/// Content of a file at HEAD of its repository; None if it is not in HEAD (new file).
pub fn head_text(git: &str, path: &Path) -> Result<Option<String>, String> {
    let dir = path.parent().ok_or("kein Verzeichnis")?;
    let top = toplevel(git, dir).ok_or("Die Datei liegt in keinem git-Repository")?;
    let rel = canon(path)
        .strip_prefix(&top)
        .map(|r| crate::course::index::rel_string(Path::new(""), r))
        .map_err(|_| "Pfad außerhalb des Repositorys".to_string())?;
    let out = git_cmd(git, &top).args(["show", &format!("HEAD:{rel}")]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 a a ch/A/a.md\0\
1 M. N... 100644 100644 100644 a a ch/B b.md\0\
2 R. N... 100644 100644 100644 a a R100 ch/neu.md\0ch/alt.md\0\
1 .M SC.. 160000 160000 160000 a a altdir\0\
u UU N... 100644 100644 100644 100644 a b c konflikt.md\0\
? ch/frisch.md\0";
        let st = parse_status(Path::new("/r"), "course", out);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        let short: Vec<_> = st.files.iter().map(|f| (f.rel.as_str(), f.index, f.worktree, f.submodule, f.untracked, f.conflict)).collect();
        assert_eq!(
            short,
            vec![
                ("ch/A/a.md", '.', 'M', false, false, false),
                ("ch/B b.md", 'M', '.', false, false, false),
                ("ch/neu.md", 'R', '.', false, false, false),
                ("altdir", '.', 'M', true, false, false),
                ("konflikt.md", 'U', 'U', false, false, true),
                ("ch/frisch.md", '?', '?', false, true, false),
            ]
        );
        assert_eq!(st.files[2].orig_rel.as_deref(), Some("ch/alt.md"));
        assert_eq!(st.files[1].path, Path::new("/r").join("ch").join("B b.md"));
    }

    #[test]
    fn initial_repo_has_no_commits() {
        let st = parse_status(Path::new("/r"), "course", "# branch.oid (initial)\0# branch.head main\0");
        assert!(!st.has_commits);
        assert_eq!(st.ahead, 0);
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=Test", "-c", "user.email=t@example.org", "-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// course repo with altdir as a submodule, like propra-inf
    fn setup() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("propra-git-{}-{}", std::process::id(), rand_suffix()));
        let upstream_alt = base.join("alt-upstream");
        let course = base.join("course");
        std::fs::create_dir_all(upstream_alt.join("ch")).unwrap();
        std::fs::create_dir_all(course.join("ch")).unwrap();
        std::fs::write(upstream_alt.join("ch/task.md"), "- [EREFQ::1] Lösung\n").unwrap();
        git_ok(&upstream_alt, &["init", "-q"]);
        git_ok(&upstream_alt, &["add", "-A"]);
        git_ok(&upstream_alt, &["commit", "-q", "-m", "alt"]);
        std::fs::write(course.join("ch/task.md"), "title: x\n---\n[EQ] Frage\n").unwrap();
        git_ok(&course, &["init", "-q"]);
        git_ok(&course, &["submodule", "add", "-q", upstream_alt.to_str().unwrap(), "altdir"]);
        git_ok(&course, &["add", "-A"]);
        git_ok(&course, &["commit", "-q", "-m", "course"]);
        (course.clone(), course.join("altdir"))
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    fn commit_as_test(repo: &Path, msg: &str) -> Result<String, String> {
        let out = git_cmd("", repo)
            .args(["-c", "user.name=Test", "-c", "user.email=t@example.org", "commit", "-m", msg])
            .output()
            .unwrap();
        if out.status.success() { Ok(String::new()) } else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) }
    }

    #[test]
    fn two_repos_and_submodule_pointer() {
        let (course, alt) = setup();
        let repos = discover("", &course, Some(&alt.join("ch")));
        assert_eq!(repos.iter().map(|r| r.kind).collect::<Vec<_>>(), vec!["course", "altdir"]);

        std::fs::write(course.join("ch/task.md"), "title: x\n---\n[EQ] Frage geändert\n").unwrap();
        std::fs::write(alt.join("ch/task.md"), "- [EREFQ::1] Lösung geändert\n").unwrap();
        let st = status_all("", &repos).unwrap();
        assert_eq!(st[0].submodule_rel.as_deref(), Some("altdir"));
        // uncommitted altdir edits do not mark the pointer
        assert_eq!(st[0].files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), vec!["ch/task.md"]);
        assert_eq!(st[1].files.iter().map(|f| (f.rel.as_str(), f.worktree)).collect::<Vec<_>>(), vec![("ch/task.md", 'M')]);

        // commit altdir first: now the course repo sees the moved submodule pointer
        stage("", &alt, &["ch/task.md".into()]).unwrap();
        commit_as_test(&alt, "Lösung").unwrap();
        let st = status_all("", &repos).unwrap();
        assert!(st[1].files.is_empty());
        let pointer = st[0].files.iter().find(|f| f.rel == "altdir").expect("pointer changed");
        assert!(pointer.submodule);

        stage("", &course, &["ch/task.md".into(), "altdir".into()]).unwrap();
        commit_as_test(&course, "Aufgabe + Lösung").unwrap();
        let st = status_all("", &repos).unwrap();
        assert!(st[0].files.is_empty() && st[1].files.is_empty(), "{st:?}");
        let _ = std::fs::remove_dir_all(course.parent().unwrap());
    }

    #[test]
    fn stage_unstage_and_head_text() {
        let (course, _alt) = setup();
        let repo = Repo { root: course.clone(), kind: "course" };
        std::fs::write(course.join("ch/neu.md"), "neu\n").unwrap();
        std::fs::write(course.join("ch/task.md"), "geändert\n").unwrap();
        stage("", &repo.root, &["ch/neu.md".into(), "ch/task.md".into()]).unwrap();
        let st = status("", &repo).unwrap();
        assert_eq!(st.files.iter().map(|f| (f.rel.as_str(), f.index)).collect::<Vec<_>>(), vec![("ch/neu.md", 'A'), ("ch/task.md", 'M')]);
        unstage("", &repo.root, &["ch/neu.md".into()], true).unwrap();
        let st = status("", &repo).unwrap();
        assert!(st.files.iter().any(|f| f.rel == "ch/neu.md" && f.untracked));
        assert_eq!(head_text("", &course.join("ch/task.md")).unwrap().as_deref(), Some("title: x\n---\n[EQ] Frage\n"));
        assert_eq!(head_text("", &course.join("ch/neu.md")).unwrap(), None);
        assert!(commit("", &repo.root, "  ").is_err());
        let _ = std::fs::remove_dir_all(course.parent().unwrap());
    }
}
