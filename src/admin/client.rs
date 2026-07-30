use super::AdminArgs;
use super::protocol::{AdminResponse, AdminResponseData};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub async fn run(args: AdminArgs, socket_path: &Path) -> u8 {
    let request = args.command.into_request();
    let stream = match UnixStream::connect(socket_path).await {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!(
                "Admin socket unavailable at {}: {error}",
                socket_path.display()
            );
            return 3;
        }
    };
    let (reader, mut writer) = stream.into_split();
    let mut encoded = match serde_json::to_vec(&request) {
        Ok(encoded) => encoded,
        Err(error) => {
            eprintln!("Failed to encode admin request: {error}");
            return 5;
        }
    };
    encoded.push(b'\n');
    if let Err(error) = writer.write_all(&encoded).await {
        eprintln!("Failed to send admin request: {error}");
        return 3;
    }
    if let Err(error) = writer.shutdown().await {
        eprintln!("Failed to finish admin request: {error}");
        return 3;
    }

    let mut line = String::new();
    if let Err(error) = BufReader::new(reader).read_line(&mut line).await {
        eprintln!("Failed to read admin response: {error}");
        return 3;
    }
    let response = match serde_json::from_str::<AdminResponse>(&line) {
        Ok(response) => response,
        Err(error) => {
            eprintln!("Bot returned an invalid admin response: {error}");
            return 5;
        }
    };

    if args.json {
        match serde_json::to_string_pretty(&response) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("Failed to format admin response: {error}");
                return 5;
            }
        }
    } else {
        print_human(&response);
    }
    response.exit_code()
}

fn print_human(response: &AdminResponse) {
    if let Some(error) = &response.error {
        eprintln!("{}: {}", error.code, error.message);
        return;
    }
    match response.data.as_ref() {
        Some(AdminResponseData::Signup(result)) => println!(
            "Signed up {} (Discord ID {}) as {}#{}.\nTracked accounts: {}",
            result.account.discord_name,
            result.account.discord_user_id,
            result.account.riot_name,
            result.account.riot_tag,
            result.tracked_accounts
        ),
        Some(AdminResponseData::Signout(result)) => println!(
            "Signed out {} (Discord ID {}).\nTracked accounts: {}",
            result.account.discord_name, result.account.discord_user_id, result.tracked_accounts
        ),
        Some(AdminResponseData::PollingState(result)) => println!(
            "Polling {}.",
            if result.polling_paused {
                "paused"
            } else {
                "resumed"
            }
        ),
        Some(AdminResponseData::RankCheck(result)) => match result {
            crate::operations::rank_check::RankCheckResult::Val {
                discord_name,
                tier,
                rr,
                ..
            } => println!("{discord_name}: {tier} · {rr} RR"),
            crate::operations::rank_check::RankCheckResult::Lol {
                discord_name,
                tier,
                division,
                league_points,
                queue,
                ..
            } => {
                let division = if division.is_empty() {
                    String::new()
                } else {
                    format!(" {division}")
                };
                println!("{discord_name}: {tier}{division} · {league_points} LP ({queue})");
            }
        },
        Some(AdminResponseData::Status(result)) => println!(
            "Admin socket: available\nTracked accounts: {}\nPolling: {}\nDatabase: {}\nSchema version: {}",
            result.tracked_accounts,
            if result.polling_paused {
                "paused"
            } else {
                "active"
            },
            result.database_path,
            result.schema_version
        ),
        None => println!("Command completed."),
    }
}
