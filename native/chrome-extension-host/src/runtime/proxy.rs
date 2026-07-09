use super::{
    broker::{Broker, ClientConnection, DEFAULT_CLIENT_ID, validate_client_id},
    http::HeaderLimitedStream,
    process::{child_channel, spawn_child_writer, spawn_stdout_reader},
};
use crate::config::HostConfig;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{self, Read},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use tungstenite::{
    Error as WebSocketError, Message,
    handshake::server::{Callback, ErrorResponse, Request, Response},
    http::StatusCode,
    protocol::WebSocketConfig,
};

const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_HANDSHAKES: usize = 16;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);

pub struct RuntimeSession {
    id: String,
    url: String,
    child: Mutex<Child>,
    broker: Arc<Broker>,
    stop: Arc<AtomicBool>,
}

impl RuntimeSession {
    pub fn start(config: &HostConfig, extension_id: String) -> Result<Arc<Self>> {
        let listener = TcpListener::bind((config.proxy_host.as_str(), config.proxy_port))
            .with_context(|| {
                format!(
                    "failed to bind app-server proxy at {}:{}",
                    config.proxy_host, config.proxy_port
                )
            })?;
        listener
            .set_nonblocking(true)
            .context("failed to make app-server proxy nonblocking")?;
        let address = listener
            .local_addr()
            .context("failed to read proxy address")?;
        if !address.ip().is_loopback() {
            bail!("app-server proxy did not bind to loopback: {address}");
        }

        let mut command = Command::new(&config.codex_cli_path);
        command
            .arg("app-server")
            .arg("--analytics-default-enabled")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("CODEX_CLI_PATH", &config.codex_cli_path)
            .env("CODEX_EXTENSION_ID", &extension_id)
            .env("CODEX_BROWSER_USE_NODE_PATH", &config.node_path)
            .env("CODEX_NODE_REPL_PATH", &config.node_repl_path)
            .env("CODEX_APP_SERVER_PROXY_HOST", address.ip().to_string())
            .env("CODEX_APP_SERVER_PROXY_PORT", address.port().to_string());
        if let Some(path) = &config.browser_client_path {
            command.env("CODEX_BROWSER_CLIENT_PATH", path);
        }
        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to spawn {} app-server",
                config.codex_cli_path.display()
            )
        })?;
        let child_stdin = child
            .stdin
            .take()
            .context("Codex app-server stdin is unavailable")?;
        let child_stdout = child
            .stdout
            .take()
            .context("Codex app-server stdout is unavailable")?;
        let (child_sender, child_receiver) = child_channel();
        let broker = Arc::new(Broker::new(child_sender));
        spawn_child_writer(child_stdin, child_receiver);
        spawn_stdout_reader(child_stdout, Arc::clone(&broker));

        let token = random_hex(32)?;
        let session_id = random_hex(16)?;
        let host = match address.ip() {
            std::net::IpAddr::V6(ip) => format!("[{ip}]"),
            std::net::IpAddr::V4(ip) => ip.to_string(),
        };
        let session = Arc::new(Self {
            id: session_id,
            url: format!("ws://{host}:{}/?token={token}", address.port()),
            child: Mutex::new(child),
            broker,
            stop: Arc::new(AtomicBool::new(false)),
        });
        spawn_proxy_listener(listener, Arc::clone(&session), token, extension_id)?;
        Ok(session)
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn is_alive(&self) -> Result<bool> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| anyhow::anyhow!("app-server child mutex poisoned"))?;
        Ok(child.try_wait()?.is_none())
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for RuntimeSession {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_proxy_listener(
    listener: TcpListener,
    session: Arc<RuntimeSession>,
    token: String,
    extension_id: String,
) -> Result<()> {
    thread::Builder::new()
        .name("codex-app-server-proxy".to_string())
        .spawn(move || {
            let handshakes = Arc::new(AtomicUsize::new(0));
            while !session.stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if handshakes.fetch_add(1, Ordering::AcqRel) >= MAX_HANDSHAKES {
                            handshakes.fetch_sub(1, Ordering::AcqRel);
                            crate::log("app-server proxy rejected excess handshake");
                            continue;
                        }
                        let session = Arc::clone(&session);
                        let handshakes = Arc::clone(&handshakes);
                        let token = token.clone();
                        let extension_id = extension_id.clone();
                        thread::spawn(move || {
                            if let Err(error) =
                                serve_connection(stream, &session, &token, &extension_id)
                            {
                                crate::log(format_args!("app-server proxy connection: {error}"));
                            }
                            handshakes.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => {
                        crate::log(format_args!("app-server proxy accept error: {error}"));
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        })
        .context("failed to spawn app-server proxy listener")?;
    Ok(())
}

fn serve_connection(
    stream: TcpStream,
    session: &RuntimeSession,
    token: &str,
    extension_id: &str,
) -> Result<()> {
    stream
        .set_read_timeout(Some(SOCKET_TIMEOUT))
        .context("failed to set WebSocket handshake read timeout")?;
    stream
        .set_write_timeout(Some(SOCKET_TIMEOUT))
        .context("failed to set WebSocket handshake write timeout")?;
    let expected_origin = format!("chrome-extension://{extension_id}");
    let selected_client = Arc::new(Mutex::new(None));
    let config = WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_WS_MESSAGE_BYTES * 2)
        .max_message_size(Some(MAX_WS_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_WS_MESSAGE_BYTES))
        .accept_unmasked_frames(false);
    let mut websocket = tungstenite::accept_hdr_with_config(
        HeaderLimitedStream::new(stream),
        UpgradeAuthorizer {
            token,
            expected_origin: &expected_origin,
            selected_client: Arc::clone(&selected_client),
        },
        Some(config),
    )
    .map_err(|error| anyhow::anyhow!("WebSocket handshake failed: {error}"))?;
    websocket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(50)))?;
    websocket
        .get_mut()
        .set_write_timeout(Some(SOCKET_TIMEOUT))?;
    let client_id = selected_client
        .lock()
        .map_err(|_| anyhow::anyhow!("selected client mutex poisoned"))?
        .take()
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());
    let connection = session.broker.register(client_id)?;
    let result = serve_registered_connection(&mut websocket, session, &connection);
    session
        .broker
        .unregister(&connection.client_id, connection.generation);
    result
}

fn serve_registered_connection(
    websocket: &mut tungstenite::WebSocket<HeaderLimitedStream<TcpStream>>,
    session: &RuntimeSession,
    connection: &ClientConnection,
) -> Result<()> {
    loop {
        if !connection.alive.load(Ordering::Acquire) {
            bail!("side panel connection was replaced or overloaded");
        }
        for _ in 0..64 {
            match connection.receiver.try_recv() {
                Ok(message) => {
                    websocket.send(Message::text(serde_json::to_string(&message)?))?;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
            }
        }
        match websocket.read() {
            Ok(Message::Text(text)) => {
                let message = serde_json::from_str::<Value>(text.as_str())
                    .context("side panel sent invalid app-server JSON")?;
                if let Err(error) = session.broker.route_client_message(
                    &connection.client_id,
                    connection.generation,
                    message.clone(),
                ) {
                    let response = json!({
                        "id": message.get("id").cloned().unwrap_or(Value::Null),
                        "error": {"code": -32603, "message": error.to_string()}
                    });
                    websocket.send(Message::text(serde_json::to_string(&response)?))?;
                    return Err(error);
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(Message::Binary(_)) => bail!("binary app-server messages are not supported"),
            Ok(_) => websocket.flush()?,
            Err(WebSocketError::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed) => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        if session.stop.load(Ordering::Acquire) {
            return Ok(());
        }
    }
}

struct UpgradeAuthorizer<'a> {
    token: &'a str,
    expected_origin: &'a str,
    selected_client: Arc<Mutex<Option<String>>>,
}

impl Callback for UpgradeAuthorizer<'_> {
    fn on_request(
        self,
        request: &Request,
        response: Response,
    ) -> std::result::Result<Response, ErrorResponse> {
        if !authorize_upgrade(request, self.token, self.expected_origin) {
            return Err(forbidden());
        }
        let client_id = requested_client_id(request).map_err(|_| forbidden())?;
        *self.selected_client.lock().map_err(|_| forbidden())? = Some(client_id);
        Ok(response)
    }
}

fn requested_client_id(request: &Request) -> Result<String> {
    let mut client_id = None;
    if let Some(query) = request.uri().query() {
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            if key != "clientId" {
                continue;
            }
            if client_id.replace(value.to_string()).is_some() {
                bail!("clientId query parameter is duplicated");
            }
        }
    }
    let client_id = client_id.unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());
    validate_client_id(&client_id)?;
    Ok(client_id)
}

fn authorize_upgrade(request: &Request, token: &str, expected_origin: &str) -> bool {
    let origin_ok = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| origin == expected_origin || origin == format!("{expected_origin}/"));
    let supplied_token = request.uri().query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == "token").then_some(value)
        })
    });
    origin_ok && supplied_token.is_some_and(|supplied| constant_time_eq(supplied, token))
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn forbidden() -> ErrorResponse {
    tungstenite::http::Response::builder()
        .status(StatusCode::FORBIDDEN)
        .body(Some("Forbidden".to_string()))
        .expect("valid static forbidden response")
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut random = vec![0_u8; bytes];
    File::open("/dev/urandom")
        .context("failed to open /dev/urandom")?
        .read_exact(&mut random)
        .context("failed to read /dev/urandom")?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
