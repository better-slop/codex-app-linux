use std::{
    io::{self, Read, Write},
    net::TcpStream,
    time::Duration,
};

const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
const HEADER_DELIMITER: &[u8] = b"\r\n\r\n";

/// Limits only the HTTP upgrade headers. Once the delimiter is observed,
/// WebSocket frames pass through without counting against the header budget.
pub(super) struct HeaderLimitedStream<S> {
    inner: S,
    header_bytes: usize,
    delimiter_state: usize,
    complete: bool,
}

impl<S> HeaderLimitedStream<S> {
    pub(super) fn new(inner: S) -> Self {
        Self {
            inner,
            header_bytes: 0,
            delimiter_state: 0,
            complete: false,
        }
    }
}

impl<S: Read> Read for HeaderLimitedStream<S> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        if self.complete {
            return Ok(count);
        }
        for byte in &buffer[..count] {
            self.header_bytes += 1;
            if self.header_bytes > MAX_HTTP_HEADER_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "WebSocket HTTP headers exceeded 64KiB",
                ));
            }
            if *byte == HEADER_DELIMITER[self.delimiter_state] {
                self.delimiter_state += 1;
                if self.delimiter_state == HEADER_DELIMITER.len() {
                    self.complete = true;
                    break;
                }
            } else {
                self.delimiter_state = usize::from(*byte == HEADER_DELIMITER[0]);
            }
        }
        Ok(count)
    }
}

impl<S: Write> Write for HeaderLimitedStream<S> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.inner.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl HeaderLimitedStream<TcpStream> {
    pub(super) fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner.set_read_timeout(timeout)
    }

    pub(super) fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner.set_write_timeout(timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_large_websocket_body_after_small_headers() {
        let mut bytes = b"GET / HTTP/1.1\r\n\r\n".to_vec();
        bytes.extend(vec![b'x'; MAX_HTTP_HEADER_BYTES + 1]);
        let mut stream = HeaderLimitedStream::new(io::Cursor::new(bytes.clone()));
        let mut output = Vec::new();
        stream.read_to_end(&mut output).unwrap();
        assert_eq!(output, bytes);
    }

    #[test]
    fn rejects_headers_larger_than_64_kib() {
        let bytes = vec![b'x'; MAX_HTTP_HEADER_BYTES + 1];
        let mut stream = HeaderLimitedStream::new(io::Cursor::new(bytes));
        let mut output = Vec::new();
        assert_eq!(
            stream.read_to_end(&mut output).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
