//! Legacy Browser Use relay over a private Unix-domain socket.

#[path = "legacy_connection.rs"]
mod connection;
#[path = "legacy_info.rs"]
mod info;

use crate::{
    framing::{MAX_OUTBOUND_BYTES, read_frame_with_limit, write_frame},
    rollout::RolloutTracker,
    rpc,
    uds::authorize_peer,
};
use connection::ConnectionPermit;
#[cfg(test)]
use connection::MAX_CLIENT_CONNECTIONS;
use info::{extension_info_response, missing_runtime_get_version};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Write,
    net::Shutdown,
    os::unix::net::{UnixListener, UnixStream},
    process,
    sync::{
        Arc, Mutex,
        atomic::AtomicUsize,
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

const OUTPUT_QUEUE: usize = 256;
const CLIENT_QUEUE: usize = 256;
const MAX_PENDING_REQUESTS: usize = 2048;
const PENDING_TTL: Duration = Duration::from_secs(2 * 60);

pub fn spawn_chrome_writer(writer: impl Write + Send + 'static) -> SyncSender<Value> {
    let (sender, receiver) = mpsc::sync_channel(OUTPUT_QUEUE);
    thread::Builder::new()
        .name("codex-native-stdout".to_string())
        .spawn(move || {
            let mut writer = writer;
            for message in receiver {
                if let Err(error) = write_frame(&mut writer, &message) {
                    crate::log(format_args!("native stdout error: {error}"));
                    process::exit(1);
                }
            }
        })
        .expect("failed to spawn native stdout writer");
    sender
}

pub struct LegacyBridge {
    state: Arc<Mutex<State>>,
    _rollout_tracker: RolloutTracker,
}

struct State {
    chrome_output: SyncSender<Value>,
    extension_id: Option<String>,
    clients: HashMap<u64, Client>,
    pending_chrome: HashMap<String, PendingChrome>,
    pending_clients: HashMap<String, PendingClient>,
    next_client_id: u64,
    next_chrome_id: u64,
    next_client_request_id: u64,
}

struct Client {
    sender: SyncSender<Value>,
    shutdown: UnixStream,
}

struct PendingChrome {
    client_id: u64,
    original_id: Value,
    fallback_extension_info: bool,
    created_at: Instant,
}

struct PendingClient {
    client_id: u64,
    original_id: Value,
    created_at: Instant,
}

impl LegacyBridge {
    pub fn start(
        listener: UnixListener,
        chrome_output: SyncSender<Value>,
        extension_id: Option<String>,
    ) -> Self {
        let state = Arc::new(Mutex::new(State {
            chrome_output: chrome_output.clone(),
            extension_id,
            clients: HashMap::new(),
            pending_chrome: HashMap::new(),
            pending_clients: HashMap::new(),
            next_client_id: 1,
            next_chrome_id: 1,
            next_client_request_id: 1,
        }));
        let rollout_tracker = RolloutTracker::start(chrome_output);
        let accept_state = Arc::clone(&state);
        let accept_tracker = rollout_tracker.clone();
        thread::Builder::new()
            .name("codex-browser-relay-accept".to_string())
            .spawn(move || accept_clients(listener, accept_state, accept_tracker))
            .expect("failed to spawn browser relay listener");
        Self {
            state,
            _rollout_tracker: rollout_tracker,
        }
    }

    pub fn handle_chrome_message(&self, message: Value) {
        if rpc::is_response(&message) {
            self.handle_chrome_response(message);
        } else if rpc::is_request(&message) {
            self.handle_chrome_request(message);
        } else {
            let senders = {
                let state = self.state.lock().expect("browser relay mutex poisoned");
                state
                    .clients
                    .iter()
                    .map(|(id, client)| (*id, client.sender.clone()))
                    .collect::<Vec<_>>()
            };
            for (client_id, sender) in senders {
                if sender.send(message.clone()).is_err() {
                    crate::log(format_args!(
                        "browser client {client_id} output channel disconnected"
                    ));
                    remove_client(&self.state, client_id);
                }
            }
        }
    }

    fn handle_chrome_response(&self, message: Value) {
        let Some(id) = rpc::string_id(&message) else {
            return;
        };
        let route = {
            let mut state = self.state.lock().expect("browser relay mutex poisoned");
            state.prune_pending();
            let Some(pending) = state.pending_chrome.remove(id) else {
                return;
            };
            let response =
                if pending.fallback_extension_info && missing_runtime_get_version(&message) {
                    extension_info_response(pending.original_id, state.extension_id.as_deref())
                } else {
                    rpc::replace_id(message, pending.original_id)
                };
            state
                .clients
                .get(&pending.client_id)
                .map(|client| (pending.client_id, client.sender.clone(), response))
        };
        if let Some((client_id, sender, response)) = route
            && sender.send(response).is_err()
        {
            crate::log(format_args!(
                "browser client {client_id} response channel disconnected"
            ));
            remove_client(&self.state, client_id);
        }
    }

    fn handle_chrome_request(&self, message: Value) {
        let original_id = rpc::id(&message);
        let route: std::result::Result<_, _> = {
            let mut state = self.state.lock().expect("browser relay mutex poisoned");
            state.prune_pending();
            if state.clients.len() != 1 {
                let error_message = if state.clients.is_empty() {
                    "No Codex browser client is connected"
                } else {
                    "Multiple Codex browser clients are connected"
                };
                Err((
                    state.chrome_output.clone(),
                    rpc::error(original_id, rpc::SERVER_ERROR, error_message),
                ))
            } else if state.pending_clients.len() >= MAX_PENDING_REQUESTS {
                Err((
                    state.chrome_output.clone(),
                    rpc::error(
                        original_id,
                        rpc::SERVER_ERROR,
                        "Too many pending browser client requests",
                    ),
                ))
            } else {
                let (&client_id, client) = state.clients.iter().next().expect("one client");
                let sender = client.sender.clone();
                let routed_id =
                    format!("chrome-{}-{}", process::id(), state.next_client_request_id);
                state.next_client_request_id += 1;
                state.pending_clients.insert(
                    routed_id.clone(),
                    PendingClient {
                        client_id,
                        original_id,
                        created_at: Instant::now(),
                    },
                );
                Ok((
                    client_id,
                    sender,
                    rpc::replace_id(message, Value::String(routed_id)),
                ))
            }
        };
        match route {
            Ok((client_id, sender, message)) => {
                if sender.send(message).is_err() {
                    crate::log(format_args!(
                        "browser client {client_id} request channel disconnected"
                    ));
                    remove_client(&self.state, client_id);
                }
            }
            Err((chrome, message)) => {
                if chrome.send(message).is_err() {
                    crate::log("native stdout channel disconnected");
                }
            }
        }
    }
}

fn accept_clients(listener: UnixListener, state: Arc<Mutex<State>>, tracker: RolloutTracker) {
    let active = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                crate::log(format_args!("browser relay accept error: {error}"));
                continue;
            }
        };
        if let Err(error) = authorize_peer(&stream) {
            crate::log(error);
            continue;
        }
        let Some(permit) = ConnectionPermit::acquire(Arc::clone(&active)) else {
            crate::log("browser relay rejected excess client connection");
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        };
        let state = Arc::clone(&state);
        let tracker = tracker.clone();
        if let Err(error) = thread::Builder::new()
            .name("codex-browser-relay-client".to_string())
            .spawn(move || {
                let _permit = permit;
                serve_client(stream, state, tracker);
            })
        {
            crate::log(format_args!(
                "failed to spawn browser relay client: {error}"
            ));
        }
    }
}

fn serve_client(mut stream: UnixStream, state: Arc<Mutex<State>>, tracker: RolloutTracker) {
    if let Err(error) = stream.set_read_timeout(Some(Duration::from_secs(5))) {
        crate::log(format_args!("browser client timeout setup: {error}"));
        return;
    }
    let first = match read_frame_with_limit(&mut stream, MAX_OUTBOUND_BYTES) {
        Ok(Some(message)) => message,
        Ok(None) => return,
        Err(error) => {
            crate::log(format_args!("browser client first frame: {error}"));
            return;
        }
    };
    if let Err(error) = stream.set_read_timeout(None) {
        crate::log(format_args!("browser client timeout reset: {error}"));
        return;
    }
    let writer_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(error) => {
            crate::log(format_args!("browser socket clone error: {error}"));
            return;
        }
    };
    if let Err(error) = writer_stream.set_write_timeout(Some(Duration::from_secs(5))) {
        crate::log(format_args!("browser client write timeout setup: {error}"));
        return;
    }
    let shutdown = match stream.try_clone() {
        Ok(stream) => stream,
        Err(error) => {
            crate::log(format_args!("browser socket clone error: {error}"));
            return;
        }
    };
    let (sender, receiver) = mpsc::sync_channel(CLIENT_QUEUE);
    thread::spawn(move || client_writer(writer_stream, receiver));
    let client_id = register_client(&state, sender, shutdown);
    handle_client_message(&state, &tracker, client_id, first);
    loop {
        match read_frame_with_limit(&mut stream, MAX_OUTBOUND_BYTES) {
            Ok(Some(message)) => handle_client_message(&state, &tracker, client_id, message),
            Ok(None) => break,
            Err(error) => {
                crate::log(format_args!("browser client frame: {error}"));
                break;
            }
        }
    }
    remove_client(&state, client_id);
}

fn client_writer(mut stream: UnixStream, receiver: mpsc::Receiver<Value>) {
    for message in receiver {
        if let Err(error) = write_frame(&mut stream, &message) {
            crate::log(format_args!("browser socket write error: {error}"));
            break;
        }
    }
}

fn register_client(
    state: &Arc<Mutex<State>>,
    sender: SyncSender<Value>,
    shutdown: UnixStream,
) -> u64 {
    let evicted = {
        let mut state = state.lock().expect("browser relay mutex poisoned");
        let evicted = state
            .clients
            .drain()
            .map(|(_, client)| client)
            .collect::<Vec<_>>();
        state.pending_chrome.clear();
        state.pending_clients.clear();
        let id = state.next_client_id;
        state.next_client_id += 1;
        state.clients.insert(id, Client { sender, shutdown });
        (id, evicted)
    };
    for client in evicted.1 {
        let _ = client.shutdown.shutdown(Shutdown::Both);
    }
    evicted.0
}

fn remove_client(state: &Arc<Mutex<State>>, client_id: u64) {
    let mut state = state.lock().expect("browser relay mutex poisoned");
    state.clients.remove(&client_id);
    state
        .pending_chrome
        .retain(|_, pending| pending.client_id != client_id);
    state
        .pending_clients
        .retain(|_, pending| pending.client_id != client_id);
}

fn handle_client_message(
    state: &Arc<Mutex<State>>,
    tracker: &RolloutTracker,
    client_id: u64,
    message: Value,
) {
    if rpc::is_response(&message) {
        handle_client_response(state, client_id, message);
        return;
    }
    if !rpc::is_request(&message) {
        let output = {
            let state = state.lock().expect("browser relay mutex poisoned");
            state
                .clients
                .contains_key(&client_id)
                .then(|| state.chrome_output.clone())
        };
        if let Some(output) = output
            && output.send(message).is_err()
        {
            crate::log("native stdout channel disconnected");
        }
        return;
    }
    tracker.observe_request(&message);
    if message.get("method").and_then(Value::as_str) == Some("ping") {
        let response = rpc::result(rpc::id(&message), json!("pong"));
        let sender = {
            let state = state.lock().expect("browser relay mutex poisoned");
            state
                .clients
                .get(&client_id)
                .map(|client| client.sender.clone())
        };
        if let Some(sender) = sender
            && sender.send(response).is_err()
        {
            crate::log(format_args!(
                "browser client {client_id} ping channel disconnected"
            ));
            remove_client(state, client_id);
        }
        return;
    }
    route_client_request(state, client_id, message);
}

fn handle_client_response(state: &Arc<Mutex<State>>, client_id: u64, message: Value) {
    let Some(id) = rpc::string_id(&message) else {
        return;
    };
    let output = {
        let mut state = state.lock().expect("browser relay mutex poisoned");
        state.prune_pending();
        let Some(pending) = state.pending_clients.get(id) else {
            return;
        };
        if pending.client_id != client_id {
            return;
        }
        let pending = state.pending_clients.remove(id).expect("pending exists");
        (
            state.chrome_output.clone(),
            rpc::replace_id(message, pending.original_id),
        )
    };
    if output.0.send(output.1).is_err() {
        crate::log("native stdout channel disconnected");
    }
}

fn route_client_request(state: &Arc<Mutex<State>>, client_id: u64, message: Value) {
    let original_id = rpc::id(&message);
    let route = {
        let mut locked = state.lock().expect("browser relay mutex poisoned");
        locked.prune_pending();
        if !locked.clients.contains_key(&client_id) {
            return;
        }
        if locked.pending_chrome.len() >= MAX_PENDING_REQUESTS {
            let response = rpc::error(
                original_id,
                rpc::SERVER_ERROR,
                "Too many pending Chrome requests",
            );
            let sender = locked
                .clients
                .get(&client_id)
                .map(|client| client.sender.clone());
            drop(locked);
            if let Some(sender) = sender
                && sender.send(response).is_err()
            {
                crate::log(format_args!(
                    "browser client {client_id} error channel disconnected"
                ));
                remove_client(state, client_id);
            }
            return;
        }
        let routed_id = format!("linux-{}-{}", process::id(), locked.next_chrome_id);
        locked.next_chrome_id += 1;
        locked.pending_chrome.insert(
            routed_id.clone(),
            PendingChrome {
                client_id,
                original_id,
                fallback_extension_info: message.get("method").and_then(Value::as_str)
                    == Some("getInfo"),
                created_at: Instant::now(),
            },
        );
        (
            locked.chrome_output.clone(),
            rpc::replace_id(message, Value::String(routed_id)),
        )
    };
    if route.0.send(route.1).is_err() {
        crate::log("native stdout channel disconnected");
    }
}

impl State {
    fn prune_pending(&mut self) {
        self.pending_chrome
            .retain(|_, request| request.created_at.elapsed() < PENDING_TTL);
        self.pending_clients
            .retain(|_, request| request.created_at.elapsed() < PENDING_TTL);
    }
}

#[cfg(test)]
#[path = "legacy_tests.rs"]
mod tests;
