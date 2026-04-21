use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

// Common Tarkov install roots — resolved at runtime. The first one that
// contains a `build/Logs` subfolder wins.
const CANDIDATE_INSTALL_ROOTS: &[&str] = &[
    r"C:\Program Files (x86)\Steam\steamapps\common\Escape from Tarkov",
    r"C:\Battlestate Games\EFT",
    r"C:\Battlestate Games\Escape from Tarkov",
    r"C:\Program Files\Battlestate Games\EFT",
    r"C:\Program Files\Battlestate Games\Escape from Tarkov",
];

fn logs_dir_for_install(install: &Path) -> PathBuf {
    install.join("build").join("Logs")
}

#[tauri::command]
pub fn detect_tarkov_logs_dir() -> Option<String> {
    for root in CANDIDATE_INSTALL_ROOTS {
        let dir = logs_dir_for_install(Path::new(root));
        if dir.is_dir() {
            return Some(dir.to_string_lossy().to_string());
        }
    }
    None
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    SessionMode { mode: String, ts: String },
    ProfileSelected { profile_id: String, account_id: String, ts: String },
    RaidStarted { map: String, game_mode: String, short_id: String, ts: String },
    RaidLocationLoaded { seconds: f64, ts: String },
    RaidEnded { map: String, short_id: String, ts: String },
    TaskStarted { quest_id: String, trader_id: String, ts: String },
    TaskFailed { quest_id: String, trader_id: String, ts: String },
    TaskFinished { quest_id: String, trader_id: String, ts: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct LogSessionResult {
    pub session_name: String,
    pub events: Vec<LogEvent>,
}

/// Parse a single session folder. Reads relevant `.log` files and returns
/// every event we recognize. Used internally by `scan_logs_dir`.
fn scan_log_session(session_dir: String) -> Result<LogSessionResult, String> {
    let dir = PathBuf::from(&session_dir);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {session_dir}"));
    }
    let session_name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut events = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        // Only bother with the log files we know carry interesting events.
        if file_name.contains("application_") {
            if let Ok(text) = fs::read_to_string(&path) {
                parse_application_log(&text, &mut events);
            }
        } else if file_name.contains("push-notifications_") {
            if let Ok(text) = fs::read_to_string(&path) {
                parse_notifications_log(&text, &mut events);
            }
        }
    }

    Ok(LogSessionResult { session_name, events })
}

/// Scan every session folder under a logs root. Returns results ordered by
/// session name (which is timestamp-encoded, so this is chronological).
#[tauri::command]
pub fn scan_logs_dir(logs_dir: String) -> Result<Vec<LogSessionResult>, String> {
    let dir = PathBuf::from(&logs_dir);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {logs_dir}"));
    }
    let mut sessions: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read logs dir: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    sessions.sort();

    let mut out = Vec::with_capacity(sessions.len());
    for s in sessions {
        if let Ok(result) = scan_log_session(s.to_string_lossy().to_string()) {
            out.push(result);
        }
    }
    Ok(out)
}

// ─── Parsing ────────────────────────────────────────────────────────────

/// Extract the timestamp from the standard Tarkov log line prefix:
/// `YYYY-MM-DD HH:MM:SS.mmm|VERSION|LEVEL|CATEGORY|<payload>`.
fn timestamp_of(line: &str) -> Option<&str> {
    let first_bar = line.find('|')?;
    Some(line[..first_bar].trim())
}

/// Extract a `key: value` field from a free-form payload up to the next
/// comma or end-of-string. Used for parsing the NetworkGameCreate trace.
fn extract_field<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    let idx = s.find(key)?;
    let rest = &s[idx + key.len()..];
    let end = rest
        .find(|c: char| c == ',' || c == '\'' || c == '\n')
        .unwrap_or(rest.len());
    Some(rest[..end].trim())
}

fn parse_application_log(text: &str, events: &mut Vec<LogEvent>) {
    for line in text.lines() {
        let ts = timestamp_of(line).unwrap_or("").to_string();
        if ts.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix_find("Session mode: ") {
            events.push(LogEvent::SessionMode { mode: rest.trim().to_string(), ts });
            continue;
        }

        if let Some(rest) = line.strip_prefix_find("SelectProfile ") {
            let profile_id = extract_field(rest, "ProfileId:").unwrap_or("").to_string();
            let account_id = extract_field(rest, "AccountId:").unwrap_or("").to_string();
            events.push(LogEvent::ProfileSelected { profile_id, account_id, ts });
            continue;
        }

        if line.contains("TRACE-NetworkGameCreate") {
            let map = extract_field(line, "Location: ").unwrap_or("").to_string();
            let game_mode = extract_field(line, "GameMode: ").unwrap_or("").to_string();
            let short_id = extract_field(line, "shortId: ").unwrap_or("").to_string();
            if !map.is_empty() {
                events.push(LogEvent::RaidStarted { map, game_mode, short_id, ts });
            }
            continue;
        }

        if let Some(rest) = line.strip_prefix_find("LocationLoaded:") {
            if let Some(num) = rest.split_whitespace().next() {
                if let Ok(seconds) = num.parse::<f64>() {
                    events.push(LogEvent::RaidLocationLoaded { seconds, ts });
                }
            }
        }
    }
}

/// Parse push-notifications log lines. Most notifications are a header line
/// ("Got notification | <Type>") immediately followed by a multi-line JSON
/// body. We care about `UserMatchOver` — emitted by the server when a raid
/// ends and the client transitions back to the menu.
fn parse_notifications_log(text: &str, events: &mut Vec<LogEvent>) {
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(rest) = line.strip_prefix_find("Got notification | ") {
            let kind = rest.trim();
            let ts = timestamp_of(line).unwrap_or("").to_string();

            if kind == "UserMatchOver" {
                if let Some((json, consumed)) = collect_json_block(&lines[i + 1..]) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
                        let map = v.get("location").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        let short_id = v.get("shortId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        if !short_id.is_empty() {
                            events.push(LogEvent::RaidEnded { map, short_id, ts });
                        }
                    }
                    i += consumed + 1;
                    continue;
                }
            }

            // Task state transitions ride the normal ChatMessage system —
            // traders "message" you when you start / finish / fail a task.
            // MessageType codes (from TarkovMonitor): 10=Started, 11=Failed,
            // 12=Finished. The quest ID is the first 24-hex-char ObjectId
            // at the start of templateId.
            if kind == "ChatMessageReceived" {
                if let Some((json, consumed)) = collect_json_block(&lines[i + 1..]) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
                        if let Some(msg) = v.get("message") {
                            let msg_type = msg.get("type").and_then(|x| x.as_i64()).unwrap_or(0);
                            if msg_type == 10 || msg_type == 11 || msg_type == 12 {
                                let template_id = msg.get("templateId").and_then(|x| x.as_str()).unwrap_or("");
                                let quest_id = template_id
                                    .split_whitespace()
                                    .next()
                                    .unwrap_or("")
                                    .to_string();
                                let trader_id = msg.get("uid").and_then(|x| x.as_str()).unwrap_or("").to_string();
                                if quest_id.len() == 24 && quest_id.chars().all(|c| c.is_ascii_hexdigit()) {
                                    let ev = match msg_type {
                                        10 => LogEvent::TaskStarted { quest_id, trader_id, ts },
                                        11 => LogEvent::TaskFailed { quest_id, trader_id, ts },
                                        12 => LogEvent::TaskFinished { quest_id, trader_id, ts },
                                        _ => unreachable!(),
                                    };
                                    events.push(ev);
                                }
                            }
                        }
                    }
                    i += consumed + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
}

/// Collect a balanced JSON object starting with a `{` line. Returns the
/// concatenated body + how many input lines were consumed. Returns None if
/// the block never balances (truncated log, etc.).
fn collect_json_block(lines: &[&str]) -> Option<(String, usize)> {
    let mut buf = String::new();
    let mut depth: i32 = 0;
    let mut started = false;
    for (idx, l) in lines.iter().enumerate() {
        buf.push_str(l);
        buf.push('\n');
        for c in l.chars() {
            match c {
                '{' => { depth += 1; started = true; }
                '}' => { depth -= 1; }
                _ => {}
            }
        }
        if started && depth == 0 {
            return Some((buf, idx + 1));
        }
        if idx > 200 {
            return None; // runaway guard
        }
    }
    None
}

// Tiny extension trait so the parser reads cleanly — each event kind just
// names the in-line prefix it's looking for.
trait StrEx {
    fn strip_prefix_find<'a>(&'a self, needle: &str) -> Option<&'a str>;
}
impl StrEx for str {
    fn strip_prefix_find<'a>(&'a self, needle: &str) -> Option<&'a str> {
        let idx = self.find(needle)?;
        Some(&self[idx + needle.len()..])
    }
}
