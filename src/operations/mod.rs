pub mod polling_control;
pub mod rank_check;
pub mod signout;
pub mod signup;

use crate::db::{DatabaseAccount, DbError};
use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Game {
    Val,
    Lol,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AccountIdentity {
    pub discord_user_id: u64,
    pub discord_name: String,
    pub riot_name: String,
    pub riot_tag: String,
}

impl From<&DatabaseAccount> for AccountIdentity {
    fn from(account: &DatabaseAccount) -> Self {
        Self {
            discord_user_id: account.discord_user_id,
            discord_name: account.discord_name.clone(),
            riot_name: account.riot_name.clone(),
            riot_tag: account.riot_tag.clone(),
        }
    }
}

#[derive(Debug)]
pub struct OperationError {
    pub code: &'static str,
    pub message: String,
    pub exit_code: u8,
}

impl OperationError {
    pub fn new(code: &'static str, message: impl Into<String>, exit_code: u8) -> Self {
        Self {
            code,
            message: message.into(),
            exit_code,
        }
    }

    pub fn not_found(discord_user_id: u64) -> Self {
        Self::new(
            "not_found",
            format!("Discord user {discord_user_id} is not tracked"),
            4,
        )
    }

    pub fn upstream(message: impl Into<String>) -> Self {
        Self::new("upstream_unavailable", message, 5)
    }
}

impl From<DbError> for OperationError {
    fn from(error: DbError) -> Self {
        match error {
            DbError::DuplicateDiscordUserId { discord_user_id } => Self::new(
                "already_tracked",
                format!("Discord user {discord_user_id} is already tracked"),
                4,
            ),
            DbError::DuplicatePuuid { .. } => {
                Self::new("already_tracked", "Riot account is already tracked", 4)
            }
            DbError::NotFound { discord_user_id } => Self::not_found(discord_user_id),
            other => Self::new("database_error", other.to_string(), 5),
        }
    }
}

impl Display for OperationError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for OperationError {}
