//! Chrome native-messaging framing.
//!
//! Chrome uses a four-byte little-endian length prefix. Hosts may receive up
//! to 64 MiB and may send at most 1 MiB. See Chrome's native messaging docs.

use serde_json::Value;
use std::io::{self, ErrorKind, Read, Write};

pub const MAX_INBOUND_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_OUTBOUND_BYTES: usize = 1024 * 1024;

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Value>> {
    read_frame_with_limit(reader, MAX_INBOUND_BYTES)
}

pub fn read_frame_with_limit(
    reader: &mut impl Read,
    maximum_bytes: usize,
) -> io::Result<Option<Value>> {
    let mut header = [0_u8; 4];
    let mut header_bytes = 0;
    while header_bytes < header.len() {
        match reader.read(&mut header[header_bytes..]) {
            Ok(0) if header_bytes == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "native message ended inside its length prefix",
                ));
            }
            Ok(count) => header_bytes += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }

    let length = u32::from_le_bytes(header) as usize;
    if length > maximum_bytes {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("native message is {length} bytes; limit is {maximum_bytes}"),
        ));
    }

    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body).map(Some).map_err(|error| {
        io::Error::new(
            ErrorKind::InvalidData,
            format!("invalid JSON frame: {error}"),
        )
    })
}

pub fn write_frame(writer: &mut impl Write, message: &Value) -> io::Result<()> {
    write_frame_with_limit(writer, message, MAX_OUTBOUND_BYTES)
}

pub fn write_frame_with_limit(
    writer: &mut impl Write,
    message: &Value,
    maximum_bytes: usize,
) -> io::Result<()> {
    let body = serde_json::to_vec(message).map_err(io::Error::other)?;
    if body.len() > maximum_bytes {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            format!(
                "native message is {} bytes; outbound limit is {maximum_bytes}",
                body.len()
            ),
        ));
    }
    let length = u32::try_from(body.len()).map_err(|_| {
        io::Error::new(ErrorKind::InvalidInput, "message does not fit a u32 prefix")
    })?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_uses_little_endian_prefix() {
        let message = json!({"jsonrpc": "2.0", "id": 1, "method": "ping"});
        let mut encoded = Vec::new();
        write_frame(&mut encoded, &message).unwrap();
        assert_eq!(
            u32::from_le_bytes(encoded[..4].try_into().unwrap()) as usize,
            encoded.len() - 4
        );
        assert_eq!(
            read_frame(&mut io::Cursor::new(encoded)).unwrap(),
            Some(message)
        );
    }

    #[test]
    fn clean_eof_differs_from_truncated_header() {
        assert_eq!(
            read_frame(&mut io::Cursor::new(Vec::<u8>::new())).unwrap(),
            None
        );
        let error = read_frame(&mut io::Cursor::new(vec![1, 0])).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::UnexpectedEof);
    }

    #[test]
    fn rejects_oversized_input_before_allocating_body() {
        let encoded = ((MAX_INBOUND_BYTES + 1) as u32).to_le_bytes();
        let error = read_frame(&mut io::Cursor::new(encoded)).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_oversized_output() {
        let message = Value::String("x".repeat(32));
        let error = write_frame_with_limit(&mut Vec::new(), &message, 8).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
    }
}
