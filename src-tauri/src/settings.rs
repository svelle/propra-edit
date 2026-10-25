//! Settings: one JSON file in the platform config dir.
//!
//! The frontend owns the schema (with defaults); Rust only persists the object and reads
//! the course root from it.

use serde_json::Value;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "settings.json";

pub fn load(dir: &Path) -> Value {
    let p = dir.join(FILE_NAME);
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()))
}

pub fn save(dir: &Path, value: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    crate::fs::write_atomic(&dir.join(FILE_NAME), text.as_bytes())
}

pub const DICTIONARY_FILE: &str = "dictionary.json";

/// Personal dictionary: a JSON array of words.
pub fn load_words(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join(DICTIONARY_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
}

pub fn save_words(dir: &Path, words: &[String]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let mut sorted: Vec<&String> = words.iter().collect();
    sorted.sort_by_key(|w| w.to_lowercase());
    sorted.dedup();
    let text = serde_json::to_string_pretty(&sorted).map_err(|e| e.to_string())?;
    crate::fs::write_atomic(&dir.join(DICTIONARY_FILE), text.as_bytes())
}

pub fn course_root(value: &Value) -> Option<PathBuf> {
    value.get("courseRoot")?.as_str().filter(|s| !s.is_empty()).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load() {
        let dir = std::env::temp_dir().join(format!("propra-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), serde_json::json!({}));
        let v = serde_json::json!({"courseRoot": "/x/y", "fontSize": 15});
        save(&dir, &v).unwrap();
        assert_eq!(load(&dir), v);
        assert_eq!(course_root(&v), Some(PathBuf::from("/x/y")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
