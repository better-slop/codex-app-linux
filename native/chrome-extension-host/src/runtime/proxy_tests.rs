use super::*;
use crate::config::HostConfig;
use serde_json::json;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tungstenite::{
    client::IntoClientRequest,
    http::{HeaderValue, Request as HttpRequest, header::ORIGIN},
};

const EXTENSION_ID: &str = "hehggadaopoacecdllhhajmbjkdcmajg";

fn request(uri: &str, origin: &str) -> HttpRequest<()> {
    HttpRequest::builder()
        .uri(uri)
        .header("origin", origin)
        .body(())
        .unwrap()
}

fn fixture() -> (PathBuf, HostConfig, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "codex-host-proxy-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let initialize_count = root.join("initialize-count");
    let process_count = root.join("process-count");
    let cli = root.join("codex");
    let script = format!(
        "#!/bin/sh\n\
         [ \"$1\" = app-server ] || exit 42\n\
         [ \"$2\" = --analytics-default-enabled ] || exit 43\n\
         [ \"$CODEX_CLI_PATH\" = \"$0\" ] || exit 44\n\
         [ \"$CODEX_EXTENSION_ID\" = \"{EXTENSION_ID}\" ] || exit 45\n\
         [ -n \"$CODEX_APP_SERVER_PROXY_HOST\" ] || exit 46\n\
         [ -n \"$CODEX_APP_SERVER_PROXY_PORT\" ] || exit 47\n\
         printf 'p\\n' >> \"{}\"\n\
         while IFS= read -r line; do\n\
           id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p')\n\
           case \"$line\" in\n\
             *'\"method\":\"initialize\"'*)\n\
               if [ -e \"{}\" ]; then\n\
                 printf '{{\"id\":\"%s\",\"error\":{{\"message\":\"duplicate initialize\"}}}}\\n' \"$id\"\n\
               else\n\
                 printf 'x\\n' >> \"{}\"\n\
                 sleep 0.1\n\
                 printf '{{\"id\":\"%s\",\"result\":{{\"server\":\"initialized\"}}}}\\n' \"$id\"\n\
               fi\n\
               ;;\n\
             *'\"method\":\"emitNotification\"'*)\n\
               printf '{{\"id\":\"%s\",\"result\":{{\"emitted\":true}}}}\\n' \"$id\"\n\
               printf '%s\\n' '{{\"method\":\"server/notice\",\"params\":{{\"sequence\":1}}}}'\n\
               ;;\n\
             *)\n\
               marker=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"marker\":\"\\([^\"]*\\)\".*/\\1/p')\n\
               printf '{{\"id\":\"%s\",\"result\":{{\"marker\":\"%s\"}}}}\\n' \"$id\" \"$marker\"\n\
               ;;\n\
           esac\n\
         done\n",
        process_count.display(),
        initialize_count.display(),
        initialize_count.display()
    );
    fs::write(&cli, script).unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
    let config = HostConfig {
        schema_version: 1,
        app_version: None,
        browser_client_path: Some(cli.clone()),
        channel: Some("prod".to_string()),
        codex_cli_path: cli.clone(),
        codex_home: None,
        cli_version: None,
        entry_id: None,
        extension_id: Some(EXTENSION_ID.to_string()),
        native_host_version: None,
        node_module_dirs: Vec::new(),
        node_path: cli.clone(),
        node_repl_path: Some(cli),
        proxy_host: "127.0.0.1".to_string(),
        proxy_port: 0,
        resources_path: None,
    };
    (root, config, initialize_count, process_count)
}

fn connect(url: &str, origin: &str) -> tungstenite::WebSocket<TcpStream> {
    let address = url
        .strip_prefix("ws://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
    tungstenite::client(request, stream).unwrap().0
}

fn read_json(websocket: &mut tungstenite::WebSocket<TcpStream>) -> Value {
    serde_json::from_str(websocket.read().unwrap().to_text().unwrap()).unwrap()
}

#[test]
fn upgrade_requires_matching_token_and_extension_origin() {
    let origin = format!("chrome-extension://{EXTENSION_ID}");
    assert!(authorize_upgrade(
        &request("/?token=secret&clientId=sidepanel-window-1", &origin),
        "secret",
        &origin
    ));
    assert!(!authorize_upgrade(
        &request("/?token=wrong", &origin),
        "secret",
        &origin
    ));
    assert!(!authorize_upgrade(
        &request("/?token=secret", "https://example.com"),
        "secret",
        &origin
    ));
}

#[test]
fn client_id_query_defaults_and_rejects_unsafe_values() {
    assert_eq!(
        requested_client_id(&request("/?token=secret", "ignored")).unwrap(),
        DEFAULT_CLIENT_ID
    );
    assert_eq!(
        requested_client_id(&request(
            "/?token=secret&clientId=sidepanel-window-9",
            "ignored"
        ))
        .unwrap(),
        "sidepanel-window-9"
    );
    assert!(requested_client_id(&request("/?clientId=../escape", "ignored")).is_err());
}

#[test]
fn websocket_proxy_multiplexes_clients_and_replays_one_initialize() {
    let (root, config, initialize_count, process_count) = fixture();
    let session = RuntimeSession::start(&config, EXTENSION_ID.to_string()).unwrap();
    let origin = format!("chrome-extension://{EXTENSION_ID}");
    let first_url = format!("{}&clientId=sidepanel-window-1", session.url());
    let second_url = format!("{}&clientId=sidepanel-window-2", session.url());
    let mut first = connect(&first_url, &origin);
    let mut second = connect(&second_url, &origin);
    first
        .send(Message::text(
            json!({"id":"init-first","method":"initialize"}).to_string(),
        ))
        .unwrap();
    second
        .send(Message::text(
            json!({"id":"init-second","method":"initialize"}).to_string(),
        ))
        .unwrap();
    let first_response = read_json(&mut first);
    let second_response = read_json(&mut second);
    assert_eq!(first_response["id"], "init-first");
    assert_eq!(second_response["id"], "init-second");
    assert_eq!(first_response["result"]["server"], "initialized");
    assert_eq!(second_response["result"]["server"], "initialized");

    first
        .send(Message::text(
            json!({"id":"collision","method":"echo","params":{"marker":"first"}}).to_string(),
        ))
        .unwrap();
    second
        .send(Message::text(
            json!({"id":"collision","method":"echo","params":{"marker":"second"}}).to_string(),
        ))
        .unwrap();
    assert_eq!(read_json(&mut first)["result"]["marker"], "first");
    assert_eq!(read_json(&mut second)["result"]["marker"], "second");

    first
        .send(Message::text(
            json!({"id":"emit","method":"emitNotification"}).to_string(),
        ))
        .unwrap();
    assert_eq!(read_json(&mut first)["id"], "emit");
    assert_eq!(read_json(&mut first)["method"], "server/notice");
    assert_eq!(read_json(&mut second)["method"], "server/notice");

    first.close(None).unwrap();
    thread::sleep(Duration::from_millis(100));
    let mut reconnect = connect(&first_url, &origin);
    reconnect
        .send(Message::text(
            json!({"id":"init-reconnect","method":"initialize"}).to_string(),
        ))
        .unwrap();
    assert_eq!(read_json(&mut reconnect)["id"], "init-reconnect");
    reconnect.close(None).unwrap();
    second.close(None).unwrap();
    thread::sleep(Duration::from_millis(100));

    assert_eq!(fs::read_to_string(initialize_count).unwrap(), "x\n");
    assert_eq!(fs::read_to_string(process_count).unwrap(), "p\n");
    session.stop();
    fs::remove_dir_all(root).unwrap();
}
