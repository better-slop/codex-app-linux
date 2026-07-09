use serde_json::{Value, json};

pub const INTERNAL_ERROR: i64 = -32603;
pub const INVALID_PARAMS: i64 = -32602;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const SERVER_ERROR: i64 = -32000;

pub fn is_request(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").and_then(Value::as_str).is_some()
}

pub fn is_response(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").is_none()
}

pub fn id(message: &Value) -> Value {
    message.get("id").cloned().unwrap_or(Value::Null)
}

pub fn string_id(message: &Value) -> Option<&str> {
    message.get("id").and_then(Value::as_str)
}

pub fn replace_id(mut message: Value, id: Value) -> Value {
    if let Value::Object(object) = &mut message {
        object.insert("id".to_string(), id);
    }
    message
}

pub fn result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message.into()}
    })
}

pub fn typed_error(id: Value, code: i64, message: impl Into<String>, error_type: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into(),
            "data": {"type": error_type, "errorType": error_type}
        }
    })
}

pub fn params(message: &Value) -> &Value {
    message.get("params").unwrap_or(&Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_preserves_request() {
        assert_eq!(
            replace_id(json!({"id": 1, "method": "getTabs"}), json!("routed")),
            json!({"id": "routed", "method": "getTabs"})
        );
    }
}
