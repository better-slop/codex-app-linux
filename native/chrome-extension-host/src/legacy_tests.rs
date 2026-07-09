use super::*;

fn bridge() -> (
    LegacyBridge,
    mpsc::Receiver<Value>,
    SyncSender<Value>,
    mpsc::Receiver<Value>,
) {
    let (chrome_output, chrome_messages) = mpsc::sync_channel(32);
    let tracker = RolloutTracker::start_with_root(chrome_output.clone(), None);
    let (client_output, client_messages) = mpsc::sync_channel(32);
    let (shutdown, _peer) = UnixStream::pair().unwrap();
    let state = Arc::new(Mutex::new(State {
        chrome_output,
        extension_id: Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
        clients: HashMap::from([(
            7,
            Client {
                sender: client_output.clone(),
                shutdown,
            },
        )]),
        pending_chrome: HashMap::new(),
        pending_clients: HashMap::new(),
        next_client_id: 8,
        next_chrome_id: 1,
        next_client_request_id: 1,
    }));
    (
        LegacyBridge {
            state,
            _rollout_tracker: tracker,
        },
        chrome_messages,
        client_output,
        client_messages,
    )
}

#[test]
fn missing_runtime_method_is_the_only_get_info_fallback() {
    assert!(missing_runtime_get_version(&json!({
        "id": 1,
        "error": {"message":"chrome.runtime.getVersion is not a function"}
    })));
    assert!(!missing_runtime_get_version(&json!({
        "id": 1,
        "error": {"message":"permission denied"}
    })));
}

#[test]
fn extension_info_contains_discovery_metadata() {
    let response =
        extension_info_response(json!("request"), Some("abcdefghijklmnopabcdefghijklmnop"));
    assert_eq!(response["id"], "request");
    assert_eq!(response["result"]["type"], "extension");
    assert_eq!(
        response["result"]["metadata"]["extensionId"],
        "abcdefghijklmnopabcdefghijklmnop"
    );
}

#[test]
fn ping_is_answered_without_forwarding_to_chrome() {
    let (bridge, chrome_messages, _client_output, client_messages) = bridge();
    handle_client_message(
        &bridge.state,
        &bridge._rollout_tracker,
        7,
        json!({"jsonrpc":"2.0","id":"ping-1","method":"ping"}),
    );
    assert_eq!(
        client_messages
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        json!({"jsonrpc":"2.0","id":"ping-1","result":"pong"})
    );
    assert!(chrome_messages.try_recv().is_err());
}

#[test]
fn client_request_and_chrome_response_restore_original_id() {
    let (bridge, chrome_messages, _client_output, client_messages) = bridge();
    handle_client_message(
        &bridge.state,
        &bridge._rollout_tracker,
        7,
        json!({"jsonrpc":"2.0","id":"original","method":"getTabs","params":{"x":1}}),
    );
    let forwarded = chrome_messages
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert_eq!(forwarded["method"], "getTabs");
    assert_ne!(forwarded["id"], "original");
    bridge.handle_chrome_message(json!({
        "jsonrpc":"2.0",
        "id":forwarded["id"],
        "result":{"tabs":[]}
    }));
    let restored = client_messages
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert_eq!(restored["id"], "original");
    assert_eq!(restored["result"]["tabs"], json!([]));
}

#[test]
fn chrome_request_and_client_response_restore_original_id() {
    let (bridge, chrome_messages, _client_output, client_messages) = bridge();
    bridge.handle_chrome_message(
        json!({"jsonrpc":"2.0","id":"chrome-original","method":"tabContext"}),
    );
    let forwarded = client_messages
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert_ne!(forwarded["id"], "chrome-original");
    handle_client_message(
        &bridge.state,
        &bridge._rollout_tracker,
        7,
        json!({"jsonrpc":"2.0","id":forwarded["id"],"result":{"ok":true}}),
    );
    let restored = chrome_messages
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert_eq!(restored["id"], "chrome-original");
    assert_eq!(restored["result"]["ok"], true);
}

#[test]
fn bounded_legacy_queues_deliver_bursts_without_silent_drops() {
    let (bridge, chrome_messages, _client_output, client_messages) = bridge();
    let client_reader = std::thread::spawn(move || {
        (0..96)
            .map(|_| {
                client_messages.recv().unwrap()["sequence"]
                    .as_u64()
                    .unwrap()
            })
            .collect::<Vec<_>>()
    });
    for sequence in 0..96 {
        bridge.handle_chrome_message(json!({"sequence":sequence}));
    }
    assert_eq!(client_reader.join().unwrap(), (0..96).collect::<Vec<_>>());

    let chrome_reader = std::thread::spawn(move || {
        (0..96)
            .map(|_| {
                chrome_messages.recv().unwrap()["sequence"]
                    .as_u64()
                    .unwrap()
            })
            .collect::<Vec<_>>()
    });
    for sequence in 0..96 {
        handle_client_message(
            &bridge.state,
            &bridge._rollout_tracker,
            7,
            json!({"method":"notice","sequence":sequence}),
        );
    }
    assert_eq!(chrome_reader.join().unwrap(), (0..96).collect::<Vec<_>>());
}
