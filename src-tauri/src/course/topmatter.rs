//! Minimal top matter reading for the course index (title, stage, difficulty, timevalue).
//!
//! sedrila splits a part file at the first `---` line: YAML before it, Markdown after.
//! There is no opening `---`.

use serde_yaml::Value;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct TopMatter {
    pub title: Option<String>,
    pub stage: Option<String>,
    pub difficulty: Option<String>,
    pub timevalue: Option<f64>,
}

/// Returns the YAML text before the first line consisting of exactly `---`,
/// or `None` if there is no such line.
pub fn split(text: &str) -> Option<&str> {
    let mut pos = 0;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end_matches(['\n', '\r']);
        if content == "---" {
            return Some(&text[..pos]);
        }
        pos += line.len();
    }
    None
}

fn scalar_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Line-based fallback for top matter that serde_yaml rejects (e.g. duplicate keys, which
/// sedrila's PyYAML accepts with "last one wins").
fn parse_lines(yaml: &str) -> TopMatter {
    let mut tm = TopMatter::default();
    for line in yaml.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        if k.is_empty() || !k.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
            continue;
        }
        let mut v = v.trim();
        if let Some(i) = v.find(" #") {
            v = v[..i].trim();
        }
        let v = v.trim_matches(|c| c == '"' || c == '\'').to_string();
        let opt = if v.is_empty() { None } else { Some(v.clone()) };
        match k {
            "title" => tm.title = opt,
            "stage" => tm.stage = opt,
            "difficulty" => tm.difficulty = opt,
            "timevalue" => tm.timevalue = v.parse().ok(),
            _ => {}
        }
    }
    tm
}

pub fn parse(text: &str) -> TopMatter {
    let Some(yaml) = split(text) else { return TopMatter::default() };
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(yaml) else {
        return parse_lines(yaml);
    };
    let get = |k: &str| map.get(Value::String(k.into()));
    TopMatter {
        title: get("title").and_then(scalar_to_string),
        stage: get("stage").and_then(scalar_to_string),
        difficulty: get("difficulty").and_then(scalar_to_string),
        timevalue: get("timevalue").and_then(|v| match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_task() {
        let tm = parse("title: Hallo \"Welt\"\nstage: alpha # Kommentar\ntimevalue: 1.5\ndifficulty: 2\n---\n[SECTION::goal::idea]\n");
        assert_eq!(tm.title.as_deref(), Some("Hallo \"Welt\""));
        assert_eq!(tm.stage.as_deref(), Some("alpha"));
        assert_eq!(tm.timevalue, Some(1.5));
        assert_eq!(tm.difficulty.as_deref(), Some("2"));
    }

    #[test]
    fn crlf_and_empty_top_matter() {
        assert_eq!(split("title: x\r\n---\r\nbody"), Some("title: x\r\n"));
        assert_eq!(split("---\nbody"), Some(""));
        assert_eq!(split("no separator"), None);
        assert_eq!(parse("---\nbody"), TopMatter::default());
        // A '----' line or '---' inside text does not count.
        assert_eq!(split("a: 1\n----\n"), None);
    }

    #[test]
    fn duplicate_keys_fall_back_to_lines() {
        let tm = parse("title: \"T\"\nstage: alpha\nstage: beta # x\ntimevalue: 2\n---\n");
        assert_eq!(tm.title.as_deref(), Some("T"));
        assert_eq!(tm.stage.as_deref(), Some("beta"));
        assert_eq!(tm.timevalue, Some(2.0));
    }
}
