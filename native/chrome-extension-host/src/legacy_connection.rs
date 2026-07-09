use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

pub(super) const MAX_CLIENT_CONNECTIONS: usize = 8;

/// Bounds same-UID clients before they can hold a thread or native frame buffer.
pub(super) struct ConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl ConnectionPermit {
    pub(super) fn acquire(active: Arc<AtomicUsize>) -> Option<Self> {
        if active.fetch_add(1, Ordering::AcqRel) >= MAX_CLIENT_CONNECTIONS {
            active.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Self { active })
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}
