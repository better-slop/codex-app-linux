use crate::{assets::AssetStore, open_file::open_local_file, rpc, runtime::RuntimeManager};
use serde_json::{Value, json};
use std::path::Path;

pub struct ProtocolHost {
    runtime: RuntimeManager,
    assets: AssetStore,
}

impl ProtocolHost {
    pub fn new(runtime: RuntimeManager, assets: AssetStore) -> Self {
        Self { runtime, assets }
    }

    pub fn handles(message: &Value) -> bool {
        message
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method.starts_with("codexRuntime/"))
    }

    pub fn handle(&mut self, message: &Value) -> Value {
        let id = rpc::id(message);
        match self.handle_result(message) {
            Ok(result) => rpc::result(id, result),
            Err(error) => {
                let text = error.to_string();
                if text.starts_with("method not found:") {
                    return rpc::error(id, rpc::METHOD_NOT_FOUND, text);
                }
                let error_type = if text.contains("version_mismatch") {
                    "version_mismatch"
                } else if text.contains("path")
                    || text.contains("fileName")
                    || text.contains("assetId")
                    || text.contains("dataBase64")
                    || text.contains("constraints")
                {
                    "invalid_params"
                } else {
                    "app_server_runtime_error"
                };
                let code = if error_type == "invalid_params" {
                    rpc::INVALID_PARAMS
                } else {
                    rpc::SERVER_ERROR
                };
                rpc::typed_error(id, code, text, error_type)
            }
        }
    }

    pub fn shutdown(&self) {
        self.runtime.shutdown();
    }

    fn handle_result(&mut self, message: &Value) -> anyhow::Result<Value> {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing method"))?;
        let params = rpc::params(message);
        match method {
            "codexRuntime/hello" => {
                self.runtime.validate_request(params)?;
                Ok(self.runtime.hello())
            }
            "codexRuntime/ensure" => self.runtime.ensure(params, false),
            "codexRuntime/restart" => self.runtime.ensure(params, true),
            "codexRuntime/openLocalFile" => {
                let path = required_string(params, "path")?;
                open_local_file(Path::new(path))?;
                Ok(json!({}))
            }
            "codexRuntime/tabContextAsset/create" => {
                self.assets.create(required_string(params, "fileName")?)
            }
            "codexRuntime/tabContextAsset/appendChunk" => self.assets.append_chunk(
                required_string(params, "assetId")?,
                required_string(params, "dataBase64")?,
            ),
            "codexRuntime/tabContextAsset/finish" => {
                self.assets.finish(required_string(params, "assetId")?)
            }
            "codexRuntime/tabContextAsset/abort" => {
                self.assets.abort(required_string(params, "assetId")?)
            }
            "codexRuntime/tabContextAsset/remove" => {
                self.assets.remove(required_string(params, "assetId")?)
            }
            _ => anyhow::bail!("method not found: {method}"),
        }
    }
}

fn required_string<'a>(params: &'a Value, field: &str) -> anyhow::Result<&'a str> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing or invalid {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intercepts_only_runtime_namespace() {
        assert!(ProtocolHost::handles(
            &json!({"method":"codexRuntime/hello"})
        ));
        assert!(!ProtocolHost::handles(&json!({"method":"getTabs"})));
        assert!(!ProtocolHost::handles(&json!({"result":{}})));
    }

    #[test]
    fn required_strings_reject_empty_or_wrong_type() {
        assert_eq!(
            required_string(&json!({"path":"/tmp/report"}), "path").unwrap(),
            "/tmp/report"
        );
        assert!(required_string(&json!({"path":""}), "path").is_err());
        assert!(required_string(&json!({"path":1}), "path").is_err());
    }
}
