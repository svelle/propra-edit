//! Loading of `sedrila.yaml`: the parts of the course configuration the editor needs.
//!
//! Paths are never hard-coded; `chapterdir`, `altdir` and `itreedir` come from the file.
//! Chapters and taskgroups come from the `chapters:` list, exactly as sedrila does it
//! (directories not listed there are ignored by sedrila).

use serde::Serialize;
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "sedrila.yaml";

/// A block macro defined via an uppercase key in `blockmacro_topmatter` (e.g. INSTRUCTOR).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BlockMacroDef {
    pub name: String,
    /// Number of arguments: 2 if the template mentions `{arg2}`, 1 if `{arg1}`, else 0
    /// (same rule as sedrila's `register_macros`).
    pub arity: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChapterConfig {
    pub name: String,
    pub taskgroups: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseConfig {
    pub root: PathBuf,
    pub chapterdir: PathBuf,
    pub altdir: Option<PathBuf>,
    pub itreedir: Option<PathBuf>,
    pub stages: Vec<String>,
    pub block_macros: Vec<BlockMacroDef>,
    /// Section type -> allowed subtypes, from the `section_<type>_<subtype>` keys.
    pub section_types: BTreeMap<String, Vec<String>>,
    pub chapters: Vec<ChapterConfig>,
    /** All `blockmacro_topmatter` templates (section headings, hint text, user block macros). */
    pub topmatter: BTreeMap<String, String>,
    pub baseresourcedir: Option<PathBuf>,
}

fn get_str(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    match map.get(Value::String(key.to_string()))? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Join a `/`-separated relative path from the config onto `root` component by component,
/// so the result uses native separators on every platform.
pub fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for comp in rel.split(['/', '\\']).filter(|c| !c.is_empty() && *c != ".") {
        p.push(comp);
    }
    p
}

impl CourseConfig {
    pub fn load(root: &Path) -> Result<CourseConfig, String> {
        let file = root.join(CONFIG_FILE);
        let text = std::fs::read_to_string(&file)
            .map_err(|e| format!("{}: {}", file.display(), e))?;
        Self::parse(root, &text)
    }

    pub fn parse(root: &Path, text: &str) -> Result<CourseConfig, String> {
        let doc: Value =
            serde_yaml::from_str(text).map_err(|e| format!("{}: {}", CONFIG_FILE, e))?;
        let map = doc
            .as_mapping()
            .ok_or_else(|| format!("{}: top level is not a mapping", CONFIG_FILE))?;

        let chapterdir_rel = get_str(map, "chapterdir")
            .ok_or_else(|| format!("{}: 'chapterdir' is missing", CONFIG_FILE))?;
        let chapterdir = join_rel(root, &chapterdir_rel);
        let altdir = get_str(map, "altdir").map(|s| join_rel(root, &s));
        let itreedir = get_str(map, "itreedir").map(|s| join_rel(root, &s));

        let stages = match map.get(Value::String("stages".into())) {
            Some(Value::Sequence(seq)) => seq
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
            _ => vec![],
        };

        let mut topmatter = BTreeMap::new();
        let mut block_macros = Vec::new();
        let mut section_types: BTreeMap<String, Vec<String>> = BTreeMap::new();
        if let Some(Value::Mapping(bm)) = map.get(Value::String("blockmacro_topmatter".into())) {
            for (k, v) in bm {
                let Some(key) = k.as_str() else { continue };
                let tmpl = v.as_str().unwrap_or("");
                topmatter.insert(key.to_string(), tmpl.to_string());
                if !key.is_empty() && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
                    let arity = if tmpl.contains("{arg2}") {
                        2
                    } else if tmpl.contains("{arg1}") {
                        1
                    } else {
                        0
                    };
                    block_macros.push(BlockMacroDef { name: key.to_string(), arity });
                } else if let Some(rest) = key.strip_prefix("section_") {
                    match rest.split_once('_') {
                        Some((ty, sub)) => section_types
                            .entry(ty.to_string())
                            .or_default()
                            .push(sub.to_string()),
                        None => {
                            section_types.entry(rest.to_string()).or_default();
                        }
                    }
                }
            }
        }

        let mut chapters = Vec::new();
        if let Some(Value::Sequence(chs)) = map.get(Value::String("chapters".into())) {
            for ch in chs {
                let Some(chm) = ch.as_mapping() else { continue };
                let Some(name) = get_str(chm, "name") else { continue };
                let mut taskgroups = Vec::new();
                if let Some(Value::Sequence(tgs)) = chm.get(Value::String("taskgroups".into())) {
                    for tg in tgs {
                        if let Some(tgname) = tg.as_mapping().and_then(|m| get_str(m, "name")) {
                            taskgroups.push(tgname);
                        }
                    }
                }
                chapters.push(ChapterConfig { name, taskgroups });
            }
        }

        Ok(CourseConfig {
            root: root.to_path_buf(),
            chapterdir,
            altdir,
            itreedir,
            stages,
            block_macros,
            section_types,
            chapters,
            topmatter,
            baseresourcedir: get_str(map, "baseresourcedir").map(|s| join_rel(root, &s)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-fixtures/course")
    }

    #[test]
    fn loads_fixture_config() {
        let cfg = CourseConfig::load(&fixture_root()).unwrap();
        assert_eq!(cfg.stages, vec!["draft", "alpha", "beta"]);
        assert!(cfg.chapterdir.ends_with("ch"));
        assert!(cfg.altdir.as_ref().unwrap().ends_with(Path::new("altdir").join("ch")));
        assert_eq!(cfg.chapters.len(), 2);
        assert_eq!(cfg.chapters[0].taskgroups, vec!["Shell", "Git"]);
        let names: Vec<_> = cfg.block_macros.iter().map(|b| (b.name.as_str(), b.arity)).collect();
        assert_eq!(names, vec![("INSTRUCTOR", 1), ("WARNING", 0), ("NOTICE", 0)]);
        assert_eq!(cfg.section_types["goal"], vec!["product", "idea", "experience", "trial"]);
        assert_eq!(cfg.section_types["background"], vec!["default"]);
        assert!(!cfg.section_types.contains_key("hint"));
        assert_eq!(cfg.topmatter["section_goal"], "<h2>Ziel</h2>");
        assert_eq!(cfg.topmatter["INSTRUCTOR"], "<h2>Kontrolle Tutor_in: {arg1}</h2>");
    }

    #[test]
    fn join_rel_handles_both_separators() {
        let root = Path::new("base");
        assert_eq!(join_rel(root, "altdir/ch"), Path::new("base").join("altdir").join("ch"));
        assert_eq!(join_rel(root, "altdir\\ch"), Path::new("base").join("altdir").join("ch"));
        assert_eq!(join_rel(root, "./ch/"), Path::new("base").join("ch"));
    }

    #[test]
    fn missing_chapterdir_is_an_error() {
        assert!(CourseConfig::parse(Path::new("."), "stages: [a]\n").is_err());
    }
}
