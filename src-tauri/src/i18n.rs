//! Language of the messages the Rust core shows to the user (errors, LanguageTool status,
//! macOS menu). The frontend sets it at start-up from the settings; German by default.
//! Log file entries are not translated.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_language(lang: &str) {
    ENGLISH.store(lang == "en", Ordering::Relaxed);
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// Pick the German or English text.
pub fn tr(de: &str, en: &str) -> String {
    if is_english() { en } else { de }.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches() {
        assert_eq!(tr("Hallo", "Hello"), if is_english() { "Hello" } else { "Hallo" });
    }
}
