pub mod client;
pub mod protocol;
pub mod server;

use crate::operations::Game;
use clap::{Args, Parser, Subcommand, ValueEnum};
use protocol::AdminRequest;

pub const DEFAULT_SOCKET_PATH: &str = "/tmp/riot-tracker-bot-admin.sock";

#[derive(Debug, Parser)]
#[command(name = "riot-tracker-bot")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<RootCommand>,
}

#[derive(Debug, Subcommand)]
pub enum RootCommand {
    Admin(AdminArgs),
}

#[derive(Debug, Args)]
pub struct AdminArgs {
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: AdminCommand,
}

#[derive(Debug, Subcommand)]
pub enum AdminCommand {
    Signup {
        #[arg(long)]
        discord_user_id: u64,
        #[arg(long)]
        discord_name: String,
        #[arg(long)]
        riot_name: String,
        #[arg(long)]
        riot_tag: String,
    },
    Signout {
        #[arg(long)]
        discord_user_id: u64,
    },
    Pause,
    Resume,
    RankCheck {
        #[arg(long)]
        discord_user_id: u64,
        #[arg(long)]
        game: CliGame,
    },
    Status,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum CliGame {
    Val,
    Lol,
}

impl From<CliGame> for Game {
    fn from(game: CliGame) -> Self {
        match game {
            CliGame::Val => Game::Val,
            CliGame::Lol => Game::Lol,
        }
    }
}

impl AdminCommand {
    pub fn into_request(self) -> AdminRequest {
        match self {
            Self::Signup {
                discord_user_id,
                discord_name,
                riot_name,
                riot_tag,
            } => AdminRequest::Signup {
                discord_user_id,
                discord_name,
                riot_name,
                riot_tag,
            },
            Self::Signout { discord_user_id } => AdminRequest::Signout { discord_user_id },
            Self::Pause => AdminRequest::Pause,
            Self::Resume => AdminRequest::Resume,
            Self::RankCheck {
                discord_user_id,
                game,
            } => AdminRequest::RankCheck {
                discord_user_id,
                game: game.into(),
            },
            Self::Status => AdminRequest::Status,
        }
    }
}

pub fn socket_path() -> std::path::PathBuf {
    std::env::var_os("ADMIN_SOCKET_PATH")
        .map(Into::into)
        .unwrap_or_else(|| DEFAULT_SOCKET_PATH.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn parses_json_before_or_after_subcommand() {
        for args in [
            ["bot", "admin", "--json", "status"].as_slice(),
            ["bot", "admin", "status", "--json"].as_slice(),
        ] {
            let cli = Cli::try_parse_from(args).unwrap();
            let Some(RootCommand::Admin(admin)) = cli.command else {
                panic!("admin command not parsed");
            };
            assert!(admin.json);
        }
    }

    #[test]
    fn parses_all_mutating_commands() {
        Cli::try_parse_from([
            "bot",
            "admin",
            "signup",
            "--discord-user-id",
            "123",
            "--discord-name",
            "test",
            "--riot-name",
            "Riot",
            "--riot-tag",
            "NA1",
        ])
        .unwrap();
        Cli::try_parse_from(["bot", "admin", "signout", "--discord-user-id", "123"]).unwrap();
        Cli::try_parse_from(["bot", "admin", "pause"]).unwrap();
        Cli::try_parse_from(["bot", "admin", "resume"]).unwrap();
        Cli::try_parse_from([
            "bot",
            "admin",
            "rank-check",
            "--discord-user-id",
            "123",
            "--game",
            "val",
        ])
        .unwrap();
    }
}
