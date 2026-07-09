use super::broker::Broker;
use serde_json::Value;
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    process::ChildStdin,
    sync::{
        Arc,
        mpsc::{Receiver, SyncSender},
    },
    thread,
};

pub(super) const CHILD_INPUT_CAPACITY: usize = 256;
const MAX_APP_SERVER_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub(super) fn child_channel() -> (SyncSender<Value>, Receiver<Value>) {
    std::sync::mpsc::sync_channel(CHILD_INPUT_CAPACITY)
}

pub(super) fn spawn_child_writer(mut stdin: ChildStdin, receiver: Receiver<Value>) {
    thread::Builder::new()
        .name("codex-app-server-stdin".to_string())
        .spawn(move || {
            for message in receiver {
                let bytes = match serde_json::to_vec(&message) {
                    Ok(bytes) if bytes.len() <= MAX_APP_SERVER_MESSAGE_BYTES => bytes,
                    Ok(bytes) => {
                        crate::log(format_args!(
                            "app-server input is {} bytes; limit is {MAX_APP_SERVER_MESSAGE_BYTES}",
                            bytes.len()
                        ));
                        break;
                    }
                    Err(error) => {
                        crate::log(format_args!(
                            "failed to serialize app-server input: {error}"
                        ));
                        break;
                    }
                };
                if let Err(error) = stdin
                    .write_all(&bytes)
                    .and_then(|()| stdin.write_all(b"\n"))
                    .and_then(|()| stdin.flush())
                {
                    crate::log(format_args!("app-server stdin failed: {error}"));
                    break;
                }
            }
        })
        .expect("failed to spawn app-server stdin writer");
}

pub(super) fn spawn_stdout_reader(stdout: impl Read + Send + 'static, broker: Arc<Broker>) {
    thread::Builder::new()
        .name("codex-app-server-stdout".to_string())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_bounded_line(&mut reader, MAX_APP_SERVER_MESSAGE_BYTES) {
                    Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                        Ok(message) => {
                            if let Err(error) = broker.route_server_message(message) {
                                crate::log(format_args!(
                                    "app-server output routing failed: {error}"
                                ));
                            }
                        }
                        Err(error) => {
                            crate::log(format_args!("app-server emitted invalid JSON: {error}"));
                            broker.mark_unhealthy();
                            break;
                        }
                    },
                    Ok(None) => {
                        broker.mark_unhealthy();
                        break;
                    }
                    Err(error) => {
                        crate::log(format_args!("app-server stdout failed: {error}"));
                        broker.mark_unhealthy();
                        break;
                    }
                }
            }
        })
        .expect("failed to spawn app-server stdout reader");
}

fn read_bounded_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if bytes.len().saturating_add(take) > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "app-server message exceeded WebSocket limit",
            ));
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_line_reader_handles_newline_eof_and_limit() {
        let mut reader = BufReader::new(io::Cursor::new(b"{\"id\":1}\nsecond".to_vec()));
        assert_eq!(
            read_bounded_line(&mut reader, 32).unwrap().as_deref(),
            Some("{\"id\":1}")
        );
        assert_eq!(
            read_bounded_line(&mut reader, 32).unwrap().as_deref(),
            Some("second")
        );
        assert!(read_bounded_line(&mut reader, 32).unwrap().is_none());
        let mut oversized = BufReader::new(io::Cursor::new(vec![b'x'; 33]));
        assert_eq!(
            read_bounded_line(&mut oversized, 32).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
