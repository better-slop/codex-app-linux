use crate::rpc;
use serde_json::{Value, json};

pub(super) fn missing_runtime_get_version(message: &Value) -> bool {
    message
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .is_some_and(|message| message.contains("chrome.runtime.getVersion is not a function"))
}

pub(super) fn extension_info_response(id: Value, extension_id: Option<&str>) -> Value {
    let metadata = extension_id
        .map(|extension_id| json!({"extensionId": extension_id}))
        .unwrap_or_else(|| json!({}));
    rpc::result(
        id,
        json!({
            "name": "Chrome",
            "version": "unknown",
            "type": "extension",
            "capabilities": {
                "tab": [{
                    "id": "pageAssets",
                    "description": "List page assets and bundle selected assets into a temporary local artifact."
                }]
            },
            "metadata": metadata
        }),
    )
}
