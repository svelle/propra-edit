//! The `CourseIndex`: every part (chapter, taskgroup, task, zip dir) with path and title,
//! glossary terms, and the altdir counterpart of each task.

use super::config::CourseConfig;
use super::topmatter;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PartKind {
    Chapter,
    Taskgroup,
    Task,
    Zipdir,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartInfo {
    pub name: String,
    pub kind: PartKind,
    /// The part's Markdown file (`index.md` for chapters/taskgroups), or the directory for zip dirs.
    pub path: PathBuf,
    /// `path` relative to the course root, always with `/` separators (for display and matching).
    pub rel: String,
    pub title: Option<String>,
    pub stage: Option<String>,
    pub difficulty: Option<String>,
    pub timevalue: Option<f64>,
    pub chapter: Option<String>,
    pub taskgroup: Option<String>,
    /// Same-named file in the altdir tree (tasks only).
    pub altdir_path: Option<PathBuf>,
    pub altdir_exists: bool,
    /// Configured in `sedrila.yaml` but the file/directory does not exist.
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: PathBuf,
    pub rel: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskgroupNode {
    pub part: PartInfo,
    pub tasks: Vec<PartInfo>,
    pub zipdirs: Vec<PartInfo>,
    /// Non-part files below the taskgroup directory (resources, include files, ...).
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterNode {
    pub part: PartInfo,
    pub taskgroups: Vec<TaskgroupNode>,
    pub zipdirs: Vec<PartInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryTerm {
    /// First name is the display name; all names are valid TERMREF targets.
    pub names: Vec<String>,
    pub term0: bool,
    /// 0-based line of the `[TERM::...]` call.
    pub line: usize,
    /// 0-based line of the matching `[ENDTERM]` (TERM only).
    pub end_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseIndex {
    pub config: CourseConfig,
    pub chapters: Vec<ChapterNode>,
    pub glossary: Option<FileEntry>,
    pub glossary_terms: Vec<GlossaryTerm>,
    /// Markdown files directly in chapterdir other than the glossary (index.md, template.md, ...).
    pub top_files: Vec<FileEntry>,
    /// Files below `chapterdir/_include`.
    pub include_files: Vec<FileEntry>,
    /// Directories in chapterdir / chapter dirs that `sedrila.yaml` does not list.
    pub unconfigured: Vec<FileEntry>,
    pub duplicate_names: Vec<String>,
    pub altdir_available: bool,
}

pub fn rel_string(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn sorted_entries(dir: &Path) -> Vec<std::fs::DirEntry> {
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).collect())
        .unwrap_or_default();
    v.sort_by_key(|e| e.file_name());
    v
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn read_part(root: &Path, name: &str, kind: PartKind, path: PathBuf) -> PartInfo {
    let text = std::fs::read_to_string(&path).ok();
    let tm = text.as_deref().map(topmatter::parse).unwrap_or_default();
    PartInfo {
        name: name.to_string(),
        kind,
        rel: rel_string(root, &path),
        missing: text.is_none(),
        path,
        title: tm.title,
        stage: tm.stage,
        difficulty: tm.difficulty,
        timevalue: tm.timevalue,
        chapter: None,
        taskgroup: None,
        altdir_path: None,
        altdir_exists: false,
    }
}

fn zipdirs_in(root: &Path, dir: &Path, chapter: &str, taskgroup: Option<&str>) -> Vec<PartInfo> {
    sorted_entries(dir)
        .into_iter()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.ends_with(".zip").then(|| PartInfo {
                rel: rel_string(root, &e.path()),
                path: e.path(),
                title: Some(name.clone()),
                name,
                kind: PartKind::Zipdir,
                stage: None,
                difficulty: None,
                timevalue: None,
                chapter: Some(chapter.to_string()),
                taskgroup: taskgroup.map(str::to_string),
                altdir_path: None,
                altdir_exists: false,
                missing: false,
            })
        })
        .collect()
}

fn collect_files(root: &Path, dir: &Path, depth: usize, skip: &dyn Fn(&Path) -> bool, out: &mut Vec<FileEntry>) {
    if depth == 0 {
        return;
    }
    for e in sorted_entries(dir) {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) || skip(&path) {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, depth - 1, skip, out);
        } else {
            out.push(FileEntry { rel: rel_string(root, &path), path, name, is_dir: false });
        }
    }
}

/// Parse the glossary's `[TERM::a|b]`/`[ENDTERM]` blocks and `[TERM0::a|b]` entries.
pub fn parse_glossary(text: &str) -> Vec<GlossaryTerm> {
    let mut terms: Vec<GlossaryTerm> = Vec::new();
    let mut open: Option<usize> = None;
    let mut off = false;
    for (lineno, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.contains("sedrila:") && line.contains("macros off") {
            off = !line.contains("end");
            continue;
        }
        if off {
            continue;
        }
        for (prefix, term0) in [("[TERM::", false), ("[TERM0::", true)] {
            if let Some(start) = line.find(prefix) {
                let rest = &line[start + prefix.len()..];
                if let Some(end) = rest.find(']') {
                    let names = rest[..end]
                        .split('|')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    if !term0 {
                        open = Some(terms.len());
                    }
                    terms.push(GlossaryTerm { names, term0, line: lineno, end_line: None });
                }
            }
        }
        if line.contains("[ENDTERM]") {
            if let Some(i) = open.take() {
                terms[i].end_line = Some(lineno);
            }
        }
    }
    terms
}

impl CourseIndex {
    pub fn build(config: CourseConfig) -> CourseIndex {
        let root = config.root.clone();
        let chdir = config.chapterdir.clone();
        let altdir_available = config.altdir.as_ref().map(|a| a.is_dir()).unwrap_or(false);
        let mut chapters = Vec::new();
        let mut unconfigured = Vec::new();
        let mut name_count: HashMap<String, usize> = HashMap::new();
        let mut count = |n: &str| *name_count.entry(n.to_string()).or_default() += 1;

        for chcfg in &config.chapters {
            let chpath = chdir.join(&chcfg.name);
            let chpart = read_part(&root, &chcfg.name, PartKind::Chapter, chpath.join("index.md"));
            count(&chcfg.name);
            let mut taskgroups = Vec::new();
            for tgname in &chcfg.taskgroups {
                let tgpath = chpath.join(tgname);
                let mut tgpart = read_part(&root, tgname, PartKind::Taskgroup, tgpath.join("index.md"));
                tgpart.chapter = Some(chcfg.name.clone());
                count(tgname);
                let mut tasks = Vec::new();
                for e in sorted_entries(&tgpath) {
                    let p = e.path();
                    let fname = e.file_name().to_string_lossy().into_owned();
                    if !p.is_file() || fname == "index.md" || is_hidden(&fname) {
                        continue;
                    }
                    let Some(taskname) = fname.strip_suffix(".md") else { continue };
                    let mut t = read_part(&root, taskname, PartKind::Task, p);
                    t.chapter = Some(chcfg.name.clone());
                    t.taskgroup = Some(tgname.clone());
                    if let Some(alt) = &config.altdir {
                        let ap = alt.join(&chcfg.name).join(tgname).join(&fname);
                        t.altdir_exists = ap.is_file();
                        t.altdir_path = Some(ap);
                    }
                    count(taskname);
                    tasks.push(t);
                }
                let zipdirs = zipdirs_in(&root, &tgpath, &chcfg.name, Some(tgname));
                zipdirs.iter().for_each(|z| count(&z.name));
                let tgpath_c = tgpath.clone();
                // task files and index.md directly in the taskgroup dir are parts, not resources;
                // zip dirs are listed separately
                let skip = move |p: &Path| {
                    p.parent() == Some(tgpath_c.as_path())
                        && (p.extension().is_some_and(|x| x == "md")
                            || (p.is_dir() && p.extension().is_some_and(|x| x == "zip")))
                };
                let mut files = Vec::new();
                collect_files(&root, &tgpath, 4, &skip, &mut files);
                taskgroups.push(TaskgroupNode { part: tgpart, tasks, zipdirs, files });
            }
            // directories in the chapter that are not configured taskgroups
            for e in sorted_entries(&chpath) {
                let name = e.file_name().to_string_lossy().into_owned();
                if e.path().is_dir() && !is_hidden(&name) && !name.ends_with(".zip") && !chcfg.taskgroups.contains(&name) {
                    unconfigured.push(FileEntry { rel: rel_string(&root, &e.path()), path: e.path(), name, is_dir: true });
                }
            }
            let zipdirs = zipdirs_in(&root, &chpath, &chcfg.name, None);
            zipdirs.iter().for_each(|z| count(&z.name));
            chapters.push(ChapterNode { part: chpart, taskgroups, zipdirs });
        }

        let mut glossary = None;
        let mut glossary_terms = Vec::new();
        let mut top_files = Vec::new();
        let mut include_files = Vec::new();
        for e in sorted_entries(&chdir) {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if is_hidden(&name) {
                continue;
            }
            let entry = FileEntry { rel: rel_string(&root, &p), path: p.clone(), name: name.clone(), is_dir: p.is_dir() };
            if p.is_file() {
                if name == "glossary.md" {
                    glossary_terms = std::fs::read_to_string(&p).map(|t| parse_glossary(&t)).unwrap_or_default();
                    glossary = Some(entry);
                } else {
                    top_files.push(entry);
                }
            } else if name == "_include" {
                collect_files(&root, &p, 4, &|_| false, &mut include_files);
            } else if !config.chapters.iter().any(|c| c.name == name) {
                unconfigured.push(entry);
            }
        }

        let mut duplicate_names: Vec<String> =
            name_count.into_iter().filter(|(_, c)| *c > 1).map(|(n, _)| n).collect();
        duplicate_names.sort();

        CourseIndex {
            config,
            chapters,
            glossary,
            glossary_terms,
            top_files,
            include_files,
            unconfigured,
            duplicate_names,
            altdir_available,
        }
    }

    pub fn tasks(&self) -> impl Iterator<Item = &PartInfo> {
        self.chapters.iter().flat_map(|c| c.taskgroups.iter().flat_map(|tg| tg.tasks.iter()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_index() -> CourseIndex {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-fixtures/course");
        CourseIndex::build(CourseConfig::load(&root).unwrap())
    }

    #[test]
    fn indexes_fixture_course() {
        let idx = fixture_index();
        assert_eq!(idx.chapters.len(), 2);
        let tasks: Vec<_> = idx.tasks().map(|t| t.name.as_str()).collect();
        assert_eq!(tasks.len(), 8);
        assert!(tasks.contains(&"Shell-Pipes"));
        let pipes = idx.tasks().find(|t| t.name == "Shell-Pipes").unwrap();
        assert_eq!(pipes.title.as_deref(), Some("Pipelines und Umlenkung"));
        assert_eq!(pipes.stage.as_deref(), Some("alpha"));
        assert_eq!(pipes.difficulty.as_deref(), Some("2"));
        assert_eq!(pipes.rel, "ch/Basis/Shell/Shell-Pipes.md");
        assert!(pipes.altdir_exists);
        let merge = idx.tasks().find(|t| t.name == "Git-Merge").unwrap();
        assert!(!merge.altdir_exists);
        assert!(idx.altdir_available);
        assert!(idx.duplicate_names.is_empty());
        let py = &idx.chapters[1].taskgroups[0];
        assert_eq!(py.zipdirs[0].name, "py-Daten.zip");
        assert!(py.files.iter().any(|f| f.rel == "ch/Sprachen/Python/include/demo.py"));
        assert!(py.files.iter().any(|f| f.rel.ends_with("py-Daten.zip/daten/zahlen.csv")) == false);
        assert!(idx.glossary.is_some());
        assert!(idx.top_files.iter().any(|f| f.name == "template.md"));
        assert_eq!(idx.include_files.len(), 2);
    }

    #[test]
    fn parses_glossary_terms() {
        let idx = fixture_index();
        let t = &idx.glossary_terms;
        assert_eq!(t.len(), 17);
        assert_eq!(t[0].names, vec!["Account", "Konto", "Benutzerkonto"]);
        assert!(t[0].end_line.unwrap() > t[0].line);
        let datei = t.iter().find(|x| x.names[0] == "Datei").unwrap();
        assert!(datei.term0);
        assert_eq!(datei.end_line, None);
    }

    #[test]
    fn rel_string_uses_forward_slashes() {
        let root = Path::new("r");
        let p = root.join("ch").join("a").join("b.md");
        assert_eq!(rel_string(root, &p), "ch/a/b.md");
    }
}
