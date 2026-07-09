use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    time::{Duration, Instant},
};

const CLIENT_QUEUE_CAPACITY: usize = 64;
const MAX_CLIENTS: usize = 64;
const MAX_PENDING_REQUESTS: usize = 4096;
const PENDING_TTL: Duration = Duration::from_secs(2 * 60);
pub(super) const DEFAULT_CLIENT_ID: &str = "default";

pub(super) struct Broker {
    state: Mutex<State>,
    child_input: SyncSender<Value>,
}

struct State {
    clients: HashMap<String, Client>,
    pending: HashMap<String, PendingRoute>,
    server_pending: HashMap<String, PendingRoute>,
    initialize: InitializeState,
    next_connection: u64,
    next_request: u64,
}

struct Client {
    generation: u64,
    sender: SyncSender<Value>,
    alive: Arc<AtomicBool>,
}

#[derive(Clone)]
struct PendingRoute {
    client_id: String,
    generation: u64,
    original_id: Value,
    created_at: Instant,
}

#[derive(Default)]
struct InitializeState {
    internal_id: Option<String>,
    response: Option<Value>,
    waiters: Vec<PendingRoute>,
}

pub(super) struct ClientConnection {
    pub client_id: String,
    pub generation: u64,
    pub receiver: Receiver<Value>,
    pub alive: Arc<AtomicBool>,
}

enum ServerMessageRoute {
    Initialize(Vec<PendingRoute>),
    Response(PendingRoute),
    UnknownResponse,
}

impl Broker {
    pub fn new(child_input: SyncSender<Value>) -> Self {
        Self {
            state: Mutex::new(State {
                clients: HashMap::new(),
                pending: HashMap::new(),
                server_pending: HashMap::new(),
                initialize: InitializeState::default(),
                next_connection: 1,
                next_request: 1,
            }),
            child_input,
        }
    }

    pub fn register(&self, client_id: String) -> Result<ClientConnection> {
        validate_client_id(&client_id)?;
        let (sender, receiver) = mpsc::sync_channel(CLIENT_QUEUE_CAPACITY);
        let alive = Arc::new(AtomicBool::new(true));
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("app-server broker mutex poisoned"))?;
        state.prune();
        if !state.clients.contains_key(&client_id) && state.clients.len() >= MAX_CLIENTS {
            bail!("Too many connected app-server clients");
        }
        let generation = state.next_connection;
        state.next_connection = state.next_connection.wrapping_add(1).max(1);
        if let Some(previous) = state.clients.insert(
            client_id.clone(),
            Client {
                generation,
                sender,
                alive: Arc::clone(&alive),
            },
        ) {
            previous.alive.store(false, Ordering::Release);
            state.remove_routes(&client_id, previous.generation);
        }
        Ok(ClientConnection {
            client_id,
            generation,
            receiver,
            alive,
        })
    }

    pub fn unregister(&self, client_id: &str, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state
            .clients
            .get(client_id)
            .is_some_and(|client| client.generation == generation)
        {
            if let Some(client) = state.clients.remove(client_id) {
                client.alive.store(false, Ordering::Release);
            }
            state.remove_routes(client_id, generation);
        }
    }

    pub fn route_client_message(
        &self,
        client_id: &str,
        generation: u64,
        message: Value,
    ) -> Result<()> {
        self.ensure_current(client_id, generation)?;
        if is_response(&message) {
            return self.route_client_response(client_id, generation, message);
        }
        let method = message.get("method").and_then(Value::as_str);
        if method == Some("initialize") {
            return self.route_initialize(client_id, generation, message);
        }
        if method.is_none() || message.get("id").is_none() {
            return self.send_child(message);
        }

        let original_id = message["id"].clone();
        let internal_id = {
            let mut state = self.state()?;
            state.prune();
            state.ensure_current(client_id, generation)?;
            if state.pending.len() >= MAX_PENDING_REQUESTS {
                bail!("Too many pending app-server requests");
            }
            let internal_id = state.next_id("client");
            state.pending.insert(
                internal_id.clone(),
                PendingRoute {
                    client_id: client_id.to_string(),
                    generation,
                    original_id,
                    created_at: Instant::now(),
                },
            );
            internal_id
        };
        let routed = replace_id(message, Value::String(internal_id.clone()));
        if let Err(error) = self.send_child(routed) {
            if let Ok(mut state) = self.state.lock() {
                state.pending.remove(&internal_id);
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn route_server_message(&self, message: Value) -> Result<()> {
        if is_response(&message) {
            return self.route_server_response(message);
        }
        if message.get("method").is_some() && message.get("id").is_some() {
            return self.route_server_request(message);
        }
        self.broadcast(message)
    }

    fn route_initialize(&self, client_id: &str, generation: u64, message: Value) -> Result<()> {
        let original_id = message
            .get("id")
            .cloned()
            .context("initialize request is missing id")?;
        let route = PendingRoute {
            client_id: client_id.to_string(),
            generation,
            original_id,
            created_at: Instant::now(),
        };
        let (replay, forward) = {
            let mut state = self.state()?;
            state.ensure_current(client_id, generation)?;
            if let Some(response) = state.initialize.response.clone() {
                (Some(replace_id(response, route.original_id.clone())), None)
            } else {
                state.initialize.waiters.retain(|waiter| {
                    waiter.client_id != client_id || waiter.generation != generation
                });
                state.initialize.waiters.push(route.clone());
                if state.initialize.internal_id.is_some() {
                    (None, None)
                } else {
                    let internal_id = state.next_id("initialize");
                    state.initialize.internal_id = Some(internal_id.clone());
                    (None, Some(replace_id(message, Value::String(internal_id))))
                }
            }
        };
        if let Some(response) = replay {
            return self.send_to_client(&route, response);
        }
        if let Some(request) = forward
            && let Err(error) = self.send_child(request)
        {
            self.fail_initialize(&error.to_string());
            return Err(error);
        }
        Ok(())
    }

    fn route_server_response(&self, message: Value) -> Result<()> {
        let Some(internal_id) = message.get("id").and_then(Value::as_str) else {
            bail!("app-server response is missing a string id");
        };
        let route = {
            let mut state = self.state()?;
            state.prune();
            if state.initialize.internal_id.as_deref() == Some(internal_id) {
                state.initialize.response = Some(message.clone());
                ServerMessageRoute::Initialize(std::mem::take(&mut state.initialize.waiters))
            } else if let Some(route) = state.pending.remove(internal_id) {
                ServerMessageRoute::Response(route)
            } else {
                ServerMessageRoute::UnknownResponse
            }
        };
        match route {
            ServerMessageRoute::Initialize(waiters) => {
                let mut failures = 0;
                for waiter in waiters {
                    let response = replace_id(message.clone(), waiter.original_id.clone());
                    if self.send_to_client(&waiter, response).is_err() {
                        failures += 1;
                    }
                }
                if failures > 0 {
                    bail!("initialize response failed for {failures} disconnected clients");
                }
                Ok(())
            }
            ServerMessageRoute::Response(route) => {
                let response = replace_id(message, route.original_id.clone());
                self.send_to_client(&route, response)
            }
            ServerMessageRoute::UnknownResponse => {
                bail!("app-server response has no pending route: {internal_id}")
            }
        }
    }

    fn route_server_request(&self, message: Value) -> Result<()> {
        let original_id = message["id"].clone();
        let (route, routed) = {
            let mut state = self.state()?;
            state.prune();
            let Some((client_id, client)) = state.clients.iter().next() else {
                bail!("app-server request has no connected side panel");
            };
            let route = PendingRoute {
                client_id: client_id.clone(),
                generation: client.generation,
                original_id,
                created_at: Instant::now(),
            };
            if state.server_pending.len() >= MAX_PENDING_REQUESTS {
                bail!("Too many pending app-server client requests");
            }
            let routed_id = state.next_id("server");
            state
                .server_pending
                .insert(routed_id.clone(), route.clone());
            (route, replace_id(message, Value::String(routed_id)))
        };
        self.send_to_client(&route, routed)
    }

    fn route_client_response(
        &self,
        client_id: &str,
        generation: u64,
        message: Value,
    ) -> Result<()> {
        let route = message.get("id").and_then(Value::as_str).and_then(|id| {
            self.state.lock().ok().and_then(|mut state| {
                let route = state.server_pending.get(id)?;
                if route.client_id != client_id || route.generation != generation {
                    return None;
                }
                state.server_pending.remove(id)
            })
        });
        let forwarded = route
            .map(|route| replace_id(message.clone(), route.original_id))
            .unwrap_or(message);
        self.send_child(forwarded)
    }

    fn broadcast(&self, message: Value) -> Result<()> {
        let routes = {
            let state = self.state()?;
            state
                .clients
                .iter()
                .map(|(client_id, client)| PendingRoute {
                    client_id: client_id.clone(),
                    generation: client.generation,
                    original_id: Value::Null,
                    created_at: Instant::now(),
                })
                .collect::<Vec<_>>()
        };
        if routes.is_empty() {
            bail!("app-server notification has no connected side panels");
        }
        let mut failures = 0;
        for route in routes {
            if self.send_to_client(&route, message.clone()).is_err() {
                failures += 1;
            }
        }
        if failures > 0 {
            bail!("notification delivery overloaded {failures} clients");
        }
        Ok(())
    }

    fn send_to_client(&self, route: &PendingRoute, message: Value) -> Result<()> {
        let target = {
            let state = self.state()?;
            state
                .clients
                .get(&route.client_id)
                .filter(|client| client.generation == route.generation)
                .map(|client| (client.sender.clone(), Arc::clone(&client.alive)))
        }
        .context("target side panel disconnected")?;
        match target.0.try_send(message) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                target.1.store(false, Ordering::Release);
                self.unregister(&route.client_id, route.generation);
                bail!("side panel output queue overloaded; client disconnected")
            }
            Err(TrySendError::Disconnected(_)) => {
                target.1.store(false, Ordering::Release);
                self.unregister(&route.client_id, route.generation);
                bail!("side panel output channel disconnected")
            }
        }
    }

    fn send_child(&self, message: Value) -> Result<()> {
        match self.child_input.try_send(message) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => bail!("app-server input queue overloaded"),
            Err(TrySendError::Disconnected(_)) => bail!("app-server input channel disconnected"),
        }
    }

    fn fail_initialize(&self, reason: &str) {
        let waiters = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.initialize.internal_id = None;
            std::mem::take(&mut state.initialize.waiters)
        };
        for waiter in waiters {
            let message = json!({
                "id": waiter.original_id,
                "error": {"code": -32603, "message": reason}
            });
            let _ = self.send_to_client(&waiter, message);
        }
    }

    fn ensure_current(&self, client_id: &str, generation: u64) -> Result<()> {
        self.state()?.ensure_current(client_id, generation)
    }

    fn state(&self) -> Result<std::sync::MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| anyhow::anyhow!("app-server broker mutex poisoned"))
    }

    #[cfg(test)]
    pub fn client_count(&self) -> usize {
        self.state.lock().unwrap().clients.len()
    }
}

impl State {
    fn ensure_current(&self, client_id: &str, generation: u64) -> Result<()> {
        if self
            .clients
            .get(client_id)
            .is_some_and(|client| client.generation == generation)
        {
            Ok(())
        } else {
            bail!("side panel connection was replaced")
        }
    }

    fn next_id(&mut self, direction: &str) -> String {
        let sequence = self.next_request;
        self.next_request = self.next_request.wrapping_add(1).max(1);
        format!("native-proxy-{direction}-{}-{sequence}", process::id())
    }

    fn remove_routes(&mut self, client_id: &str, generation: u64) {
        self.pending
            .retain(|_, route| route.client_id != client_id || route.generation != generation);
        self.server_pending
            .retain(|_, route| route.client_id != client_id || route.generation != generation);
        self.initialize
            .waiters
            .retain(|route| route.client_id != client_id || route.generation != generation);
    }

    fn prune(&mut self) {
        self.pending
            .retain(|_, route| route.created_at.elapsed() < PENDING_TTL);
        self.server_pending
            .retain(|_, route| route.created_at.elapsed() < PENDING_TTL);
        self.initialize
            .waiters
            .retain(|route| route.created_at.elapsed() < PENDING_TTL);
    }
}

pub(super) fn validate_client_id(client_id: &str) -> Result<()> {
    if client_id.is_empty()
        || client_id.len() > 128
        || !client_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("clientId contains unsupported characters");
    }
    Ok(())
}

fn is_response(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").is_none()
}

fn replace_id(mut message: Value, id: Value) -> Value {
    if let Some(object) = message.as_object_mut() {
        object.insert("id".to_string(), id);
    }
    message
}

#[cfg(test)]
#[path = "broker_tests.rs"]
mod tests;
