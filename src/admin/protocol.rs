use crate::operations::polling_control::PollingStateResult;
use crate::operations::rank_check::RankCheckResult;
use crate::operations::signout::SignoutResult;
use crate::operations::signup::SignupResult;
use crate::operations::{Game, OperationError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "command", rename_all = "kebab-case")]
pub enum AdminRequest {
    Signup {
        discord_user_id: u64,
        discord_name: String,
        riot_name: String,
        riot_tag: String,
    },
    Signout {
        discord_user_id: u64,
    },
    Pause,
    Resume,
    RankCheck {
        discord_user_id: u64,
        game: Game,
    },
    Status,
}

impl AdminRequest {
    pub fn command_name(&self) -> &'static str {
        match self {
            Self::Signup { .. } => "signup",
            Self::Signout { .. } => "signout",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::RankCheck { .. } => "rank-check",
            Self::Status => "status",
        }
    }

    pub fn discord_user_id(&self) -> Option<u64> {
        match self {
            Self::Signup {
                discord_user_id, ..
            }
            | Self::Signout { discord_user_id }
            | Self::RankCheck {
                discord_user_id, ..
            } => Some(*discord_user_id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdminResponse {
    pub ok: bool,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<AdminResponseData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AdminError>,
}

impl AdminResponse {
    pub fn success(command: impl Into<String>, data: AdminResponseData) -> Self {
        Self {
            ok: true,
            command: command.into(),
            data: Some(data),
            error: None,
        }
    }

    pub fn failure(command: impl Into<String>, error: OperationError) -> Self {
        Self {
            ok: false,
            command: command.into(),
            data: None,
            error: Some(AdminError {
                code: error.code.to_string(),
                message: error.message,
                exit_code: error.exit_code,
            }),
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::failure(
            "unknown",
            OperationError::new("invalid_request", message, 4),
        )
    }

    pub fn exit_code(&self) -> u8 {
        self.error.as_ref().map_or(0, |error| error.exit_code)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "value", rename_all = "kebab-case")]
pub enum AdminResponseData {
    Signup(SignupResult),
    Signout(SignoutResult),
    PollingState(PollingStateResult),
    RankCheck(RankCheckResult),
    Status(StatusResult),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdminError {
    pub code: String,
    pub message: String,
    pub exit_code: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StatusResult {
    pub socket_available: bool,
    pub tracked_accounts: usize,
    pub polling_paused: bool,
    pub database_path: String,
    pub schema_version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_and_response_round_trip() {
        let request = AdminRequest::RankCheck {
            discord_user_id: 123,
            game: Game::Val,
        };
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<AdminRequest>(&json).unwrap(),
            request
        );

        let response = AdminResponse::success(
            "status",
            AdminResponseData::Status(StatusResult {
                socket_available: true,
                tracked_accounts: 7,
                polling_paused: false,
                database_path: "/data/accounts.json".into(),
                schema_version: 1,
            }),
        );
        let json = serde_json::to_string(&response).unwrap();
        assert_eq!(
            serde_json::from_str::<AdminResponse>(&json).unwrap(),
            response
        );
    }
}
