use crate::types::Data;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PollingStateResult {
    pub polling_paused: bool,
}

pub fn set_paused(data: &Data, paused: bool) -> PollingStateResult {
    data.polling_paused.store(paused, Ordering::Relaxed);
    PollingStateResult {
        polling_paused: paused,
    }
}
