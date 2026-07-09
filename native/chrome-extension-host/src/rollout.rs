//! Bounded rollout watcher used to synthesize the legacy turnEnded event.

use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    fs::File,
    io::{self, BufRead, BufReader, Seek},
    path::{Path, PathBuf},
    sync::mpsc::{self, SyncSender},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const OBSERVED_TURN_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const SEARCH_MAX_DEPTH: usize = 5;
const SEARCH_MAX_ENTRIES: usize = 10_000;
const MAX_OBSERVED_TURNS: usize = 1024;
const MAX_ROLLOUT_LINE_BYTES: usize = 1024 * 1024;
const INITIAL_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_DISCOVERY_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct RolloutTracker {
    observations: SyncSender<Observation>,
}

#[derive(Debug)]
struct Observation {
    session_id: String,
    turn_id: String,
}

struct ObservedTurn {
    session_id: String,
    turn_id: String,
    path: Option<PathBuf>,
    offset: u64,
    created_at: Instant,
    next_discovery_at: Instant,
    discovery_backoff: Duration,
}

impl RolloutTracker {
    pub fn start(chrome_output: SyncSender<Value>) -> Self {
        Self::start_with_root(chrome_output, sessions_root())
    }

    pub fn start_with_root(
        chrome_output: SyncSender<Value>,
        sessions_root: Option<PathBuf>,
    ) -> Self {
        let (sender, receiver) = mpsc::sync_channel(MAX_OBSERVED_TURNS);
        thread::Builder::new()
            .name("codex-rollout-tracker".to_string())
            .spawn(move || {
                let mut observed = HashMap::new();
                loop {
                    match receiver.recv_timeout(POLL_INTERVAL) {
                        Ok(observation) => insert_observation(&mut observed, observation),
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    while let Ok(observation) = receiver.try_recv() {
                        insert_observation(&mut observed, observation);
                    }
                    process_observed(&mut observed, sessions_root.as_deref(), &chrome_output);
                }
            })
            .expect("failed to spawn rollout tracker");
        Self {
            observations: sender,
        }
    }

    pub fn observe_request(&self, message: &Value) {
        let Some((session_id, turn_id)) = session_turn_from_message(message) else {
            return;
        };
        if let Err(error) = self.observations.send(Observation {
            session_id,
            turn_id,
        }) {
            crate::log(format_args!(
                "rollout observation channel disconnected: {error}"
            ));
        }
    }
}

fn insert_observation(observed: &mut HashMap<String, ObservedTurn>, item: Observation) {
    let key = observed_turn_key(&item.session_id, &item.turn_id);
    if observed.contains_key(&key) {
        return;
    }
    if observed.len() >= MAX_OBSERVED_TURNS {
        crate::log("rollout observation limit reached; request was not tracked");
        return;
    }
    let now = Instant::now();
    observed.insert(
        key,
        ObservedTurn {
            session_id: item.session_id,
            turn_id: item.turn_id,
            path: None,
            offset: 0,
            created_at: now,
            next_discovery_at: now,
            discovery_backoff: POLL_INTERVAL,
        },
    );
}

fn process_observed(
    observed: &mut HashMap<String, ObservedTurn>,
    root: Option<&Path>,
    chrome_output: &SyncSender<Value>,
) {
    let mut remove = Vec::new();
    for (key, turn) in observed.iter_mut() {
        if turn.created_at.elapsed() >= OBSERVED_TURN_TTL {
            remove.push(key.clone());
            continue;
        }
        let Some(root) = root else {
            continue;
        };
        if turn.path.is_none() {
            let now = Instant::now();
            if now < turn.next_discovery_at {
                continue;
            }
            if let Some(path) = find_rollout_path(root, &turn.session_id) {
                turn.offset = fs::metadata(&path)
                    .map(|metadata| metadata.len().saturating_sub(INITIAL_TAIL_BYTES))
                    .unwrap_or(0);
                turn.path = Some(path);
            } else {
                turn.next_discovery_at = now + turn.discovery_backoff;
                turn.discovery_backoff = turn
                    .discovery_backoff
                    .saturating_mul(2)
                    .min(MAX_DISCOVERY_BACKOFF);
            }
        }
        let Some(path) = turn.path.as_deref() else {
            continue;
        };
        match drain_rollout_file(path, turn.offset, &turn.turn_id) {
            Ok((offset, true)) => {
                turn.offset = offset;
                let message = json!({
                    "jsonrpc": "2.0",
                    "id": format!("native-turn-ended:{}:{}", turn.session_id, turn.turn_id),
                    "method": "turnEnded",
                    "params": {
                        "session_id": turn.session_id,
                        "turn_id": turn.turn_id
                    }
                });
                if chrome_output.send(message).is_err() {
                    crate::log("turnEnded could not be delivered: native stdout disconnected");
                }
                remove.push(key.clone());
            }
            Ok((offset, false)) => turn.offset = offset,
            Err(error) => crate::log(format_args!(
                "failed to read rollout {}: {error}",
                path.display()
            )),
        }
    }
    for key in remove {
        observed.remove(&key);
    }
}

fn sessions_root() -> Option<PathBuf> {
    if let Some(path) = env::var_os("CODEX_BROWSER_USE_SESSIONS_DIR") {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("CODEX_HOME") {
        return Some(PathBuf::from(path).join("sessions"));
    }
    env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex/sessions"))
}

fn session_turn_from_message(message: &Value) -> Option<(String, String)> {
    let params = message.get("params")?;
    let session_id = non_empty_string(params.get("session_id")?)?;
    let turn_id = non_empty_string(params.get("turn_id")?)?;
    Some((session_id.to_string(), turn_id.to_string()))
}

fn non_empty_string(value: &Value) -> Option<&str> {
    let string = value.as_str()?.trim();
    (valid_identifier(string)).then_some(string)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn observed_turn_key(session_id: &str, turn_id: &str) -> String {
    format!("{session_id}\n{turn_id}")
}

fn find_rollout_path(root: &Path, session_id: &str) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    let mut visited = 0;
    let mut best: Option<(SystemTime, PathBuf)> = None;
    while let Some((directory, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > SEARCH_MAX_ENTRIES {
                return best.map(|(_, path)| path);
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if depth < SEARCH_MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !file_name.contains(session_id)
                || !(file_name.ends_with(".jsonl") || file_name.ends_with(".json"))
            {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            if best
                .as_ref()
                .is_none_or(|(best_modified, _)| modified > *best_modified)
            {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, path)| path)
}

fn drain_rollout_file(path: &Path, offset: u64, turn_id: &str) -> io::Result<(u64, bool)> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let start = if offset > length { 0 } else { offset };
    file.seek(io::SeekFrom::Start(start))?;
    let mut reader = BufReader::new(file);
    let mut complete = false;
    loop {
        let line_start = reader.stream_position()?;
        let mut line = Vec::new();
        let (has_data, terminated) = read_bounded_until_newline(&mut reader, &mut line)?;
        if !has_data {
            break;
        }
        if !terminated {
            return Ok((line_start, complete));
        }
        if line.len() <= MAX_ROLLOUT_LINE_BYTES
            && std::str::from_utf8(&line)
                .ok()
                .is_some_and(|line| line_marks_turn_complete(line, turn_id))
        {
            complete = true;
        }
    }
    Ok((reader.stream_position()?, complete))
}

fn read_bounded_until_newline(
    reader: &mut impl BufRead,
    output: &mut Vec<u8>,
) -> io::Result<(bool, bool)> {
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((!output.is_empty(), false));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if output.len() < MAX_ROLLOUT_LINE_BYTES {
            let remaining = MAX_ROLLOUT_LINE_BYTES - output.len();
            output.extend_from_slice(&available[..take.min(remaining)]);
        }
        reader.consume(take);
        if newline.is_some() {
            return Ok((true, true));
        }
    }
}

fn line_marks_turn_complete(line: &str, turn_id: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let payload = value.get("payload").unwrap_or(&value);
    if payload.get("type").and_then(Value::as_str) == Some("task_complete")
        && payload.get("turn_id").and_then(Value::as_str) == Some(turn_id)
    {
        return true;
    }
    value.get("type").and_then(Value::as_str) == Some("turn")
        && matches!(
            value.get("kind").and_then(Value::as_str),
            Some("end" | "completed" | "complete")
        )
        && value.get("turn_id").and_then(Value::as_str) == Some(turn_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn root(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn finds_nested_rollout_and_detects_completion() {
        let root = root("codex-rollout");
        let nested = root.join("2026/07/09");
        fs::create_dir_all(&nested).unwrap();
        let path = nested.join("rollout-session-1.jsonl");
        writeln!(
            File::create(&path).unwrap(),
            "{}",
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}})
        )
        .unwrap();
        assert_eq!(find_rollout_path(&root, "session-1"), Some(path.clone()));
        assert!(drain_rollout_file(&path, 0, "turn-1").unwrap().1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn truncated_rollout_restarts_from_beginning() {
        let root = root("codex-rollout-truncate");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-session-1.jsonl");
        fs::write(
            &path,
            "{\"type\":\"turn\",\"kind\":\"complete\",\"turn_id\":\"turn-1\"}\n",
        )
        .unwrap();
        assert!(drain_rollout_file(&path, 10_000, "turn-1").unwrap().1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_only_non_empty_session_and_turn() {
        let request = json!({"params":{"session_id":"session-1","turn_id":"turn-1"}});
        assert_eq!(
            session_turn_from_message(&request),
            Some(("session-1".to_string(), "turn-1".to_string()))
        );
        assert!(
            session_turn_from_message(&json!({"params":{"session_id":"","turn_id":"x"}})).is_none()
        );
        assert!(
            session_turn_from_message(
                &json!({"params":{"session_id":"../escape","turn_id":"turn-1"}})
            )
            .is_none()
        );
        assert!(
            session_turn_from_message(
                &json!({"params":{"session_id":"session-1","turn_id":"x".repeat(129)}})
            )
            .is_none()
        );
    }
}
