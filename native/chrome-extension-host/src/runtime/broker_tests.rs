use super::*;
use std::sync::mpsc;

fn broker() -> (Broker, mpsc::Receiver<Value>) {
    let (child_input, child_messages) = mpsc::sync_channel(256);
    (Broker::new(child_input), child_messages)
}

#[test]
fn colliding_client_ids_are_rewritten_and_restored() {
    let (broker, child) = broker();
    let first = broker.register("window-1".to_string()).unwrap();
    let second = broker.register("window-2".to_string()).unwrap();
    for (connection, marker) in [(&first, "first"), (&second, "second")] {
        broker
            .route_client_message(
                &connection.client_id,
                connection.generation,
                json!({"id":"collision","method":"echo","params":{"marker":marker}}),
            )
            .unwrap();
    }
    let first_forwarded = child.recv().unwrap();
    let second_forwarded = child.recv().unwrap();
    assert_ne!(first_forwarded["id"], second_forwarded["id"]);
    broker
        .route_server_message(json!({
            "id": first_forwarded["id"],
            "result": {"marker": first_forwarded["params"]["marker"]}
        }))
        .unwrap();
    broker
        .route_server_message(json!({
            "id": second_forwarded["id"],
            "result": {"marker": second_forwarded["params"]["marker"]}
        }))
        .unwrap();
    assert_eq!(first.receiver.recv().unwrap()["id"], "collision");
    assert_eq!(second.receiver.recv().unwrap()["id"], "collision");
}

#[test]
fn notifications_fan_out_to_all_clients() {
    let (broker, _child) = broker();
    let first = broker.register("window-1".to_string()).unwrap();
    let second = broker.register("window-2".to_string()).unwrap();
    let notification = json!({"method":"server/notice","params":{"sequence":1}});
    broker.route_server_message(notification.clone()).unwrap();
    assert_eq!(first.receiver.recv().unwrap(), notification);
    assert_eq!(second.receiver.recv().unwrap(), notification);
}

#[test]
fn initialize_inflight_waiters_and_cached_reconnect_each_receive_own_id() {
    let (broker, child) = broker();
    let first = broker.register("window-1".to_string()).unwrap();
    broker
        .route_client_message(
            &first.client_id,
            first.generation,
            json!({"id":"init-first","method":"initialize"}),
        )
        .unwrap();
    let initialize = child.recv().unwrap();

    let second = broker.register("window-2".to_string()).unwrap();
    broker
        .route_client_message(
            &second.client_id,
            second.generation,
            json!({"id":"init-second","method":"initialize"}),
        )
        .unwrap();
    assert!(child.try_recv().is_err());
    broker
        .route_server_message(json!({"id":initialize["id"],"result":{"ready":true}}))
        .unwrap();
    assert_eq!(first.receiver.recv().unwrap()["id"], "init-first");
    assert_eq!(second.receiver.recv().unwrap()["id"], "init-second");

    let reconnect = broker.register("window-1".to_string()).unwrap();
    broker
        .route_client_message(
            &reconnect.client_id,
            reconnect.generation,
            json!({"id":"init-reconnect","method":"initialize"}),
        )
        .unwrap();
    assert_eq!(reconnect.receiver.recv().unwrap()["id"], "init-reconnect");
    assert!(child.try_recv().is_err());
}

#[test]
fn burst_beyond_old_eight_message_queue_is_lossless() {
    let (broker, child) = broker();
    let client = broker.register("window-1".to_string()).unwrap();
    for sequence in 0..32 {
        broker
            .route_client_message(
                &client.client_id,
                client.generation,
                json!({"id":sequence,"method":"echo"}),
            )
            .unwrap();
    }
    for sequence in 0..32 {
        let forwarded = child.recv().unwrap();
        broker
            .route_server_message(json!({"id":forwarded["id"],"result":{"sequence":sequence}}))
            .unwrap();
    }
    for sequence in 0..32 {
        let response = client.receiver.recv().unwrap();
        assert_eq!(response["id"], sequence);
        assert_eq!(response["result"]["sequence"], sequence);
    }
}

#[test]
fn full_client_queue_disconnects_and_returns_an_error() {
    let (broker, _child) = broker();
    let _client = broker.register("window-1".to_string()).unwrap();
    for sequence in 0..CLIENT_QUEUE_CAPACITY {
        broker
            .route_server_message(json!({"method":"notice","params":{"sequence":sequence}}))
            .unwrap();
    }
    let error = broker
        .route_server_message(json!({"method":"notice","params":{"sequence":"overflow"}}))
        .unwrap_err();
    assert!(error.to_string().contains("overloaded"));
    assert_eq!(broker.client_count(), 0);
}
#[test]
fn broker_health_can_invalidate_an_alive_child_process() {
    let (child, _receiver) = mpsc::sync_channel(1);
    let broker = Broker::new(child);
    assert!(broker.is_healthy());
    broker.mark_unhealthy();
    assert!(!broker.is_healthy());
}
