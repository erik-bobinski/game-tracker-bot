use super::protocol::{AdminRequest, AdminResponse, AdminResponseData, StatusResult};
use crate::db::SCHEMA_VERSION;
use crate::operations::{OperationError, polling_control, rank_check, signout, signup};
use crate::types::Data;
use std::fs::Permissions;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

pub async fn bind(path: &Path) -> std::io::Result<UnixListener> {
    if path.exists() {
        match UnixStream::connect(path).await {
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    format!("admin socket {} is already active", path.display()),
                ));
            }
            Err(_) => std::fs::remove_file(path)?,
        }
    }

    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, Permissions::from_mode(0o600))?;
    Ok(listener)
}

pub async fn run(listener: UnixListener, path: PathBuf, data: Data) {
    eprintln!("admin socket ready path={}", path.display());
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let data = data.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream, data).await {
                        eprintln!("admin connection error={error}");
                    }
                });
            }
            Err(error) => eprintln!("admin accept error={error}"),
        }
    }
}

async fn handle_connection(stream: UnixStream, data: Data) -> std::io::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut line = String::new();
    BufReader::new(reader).read_line(&mut line).await?;

    let response = match serde_json::from_str::<AdminRequest>(&line) {
        Ok(request) => dispatch(request, &data).await,
        Err(error) => AdminResponse::invalid_request(format!("Malformed request: {error}")),
    };
    let mut encoded = serde_json::to_vec(&response).map_err(std::io::Error::other)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    writer.shutdown().await
}

pub async fn dispatch(request: AdminRequest, data: &Data) -> AdminResponse {
    let started = Instant::now();
    let command = request.command_name();
    let discord_user_id = request.discord_user_id();

    let result: Result<AdminResponseData, OperationError> = match request {
        AdminRequest::Signup {
            discord_user_id,
            discord_name,
            riot_name,
            riot_tag,
        } => signup::run(data, discord_user_id, discord_name, riot_name, riot_tag)
            .await
            .map(AdminResponseData::Signup),
        AdminRequest::Signout { discord_user_id } => signout::run(data, discord_user_id)
            .await
            .map(AdminResponseData::Signout),
        AdminRequest::Pause => Ok(AdminResponseData::PollingState(
            polling_control::set_paused(data, true),
        )),
        AdminRequest::Resume => Ok(AdminResponseData::PollingState(
            polling_control::set_paused(data, false),
        )),
        AdminRequest::RankCheck {
            discord_user_id,
            game,
        } => rank_check::run(data, discord_user_id, game)
            .await
            .map(AdminResponseData::RankCheck),
        AdminRequest::Status => {
            let db = data.db.lock().await;
            Ok(AdminResponseData::Status(StatusResult {
                socket_available: true,
                tracked_accounts: db.get_accounts().len(),
                polling_paused: data.polling_paused.load(Ordering::Relaxed),
                database_path: db.path().display().to_string(),
                schema_version: SCHEMA_VERSION,
            }))
        }
    };

    let response = match result {
        Ok(data) => AdminResponse::success(command, data),
        Err(error) => AdminResponse::failure(command, error),
    };
    let target = discord_user_id
        .map(|id| format!(" discord_user_id={id}"))
        .unwrap_or_default();
    if response.ok {
        eprintln!(
            "admin command={command}{target} result=success duration_ms={}",
            started.elapsed().as_millis()
        );
    } else {
        let code = response
            .error
            .as_ref()
            .map(|error| error.code.as_str())
            .unwrap_or("internal_error");
        eprintln!(
            "admin command={command}{target} result=failure error_code={code} duration_ms={}",
            started.elapsed().as_millis()
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, DatabaseAccount};
    use crate::riot_api;
    use serenity::prelude::Mutex;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn replaces_a_stale_socket_and_sets_private_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("admin.sock");
        std::fs::write(&path, "stale").unwrap();

        let listener = bind(&path).await.unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        drop(listener);
    }

    #[tokio::test]
    async fn sequential_socket_commands_share_live_state_and_disk() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("accounts.json");
        let mut database = Database::load(&database_path).unwrap();
        database
            .add_account(DatabaseAccount {
                discord_user_id: 42,
                discord_name: "target".into(),
                riot_name: "Target".into(),
                riot_tag: "NA1".into(),
                added_at: chrono::Utc::now(),
                ..Default::default()
            })
            .unwrap();
        let data = Data {
            henrik_client: Arc::new(riot_api::valorant::HenrikClient::new("test".into())),
            riot_client: Arc::new(riot_api::lol::RiotClient::new("test".into())),
            db: Arc::new(Mutex::new(database)),
            polling_paused: Arc::new(AtomicBool::new(false)),
        };
        let socket_path = directory.path().join("admin.sock");
        let listener = bind(&socket_path).await.unwrap();
        let task = tokio::spawn(run(listener, socket_path.clone(), data));

        let signout = send(
            &socket_path,
            &AdminRequest::Signout {
                discord_user_id: 42,
            },
        )
        .await;
        assert!(signout.ok);

        let status = send(&socket_path, &AdminRequest::Status).await;
        let Some(AdminResponseData::Status(status)) = status.data else {
            panic!("expected status response");
        };
        assert_eq!(status.tracked_accounts, 0);
        assert_eq!(
            Database::load(&database_path).unwrap().get_accounts().len(),
            0
        );
        task.abort();
    }

    async fn send(path: &Path, request: &AdminRequest) -> AdminResponse {
        let stream = UnixStream::connect(path).await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut request = serde_json::to_vec(request).unwrap();
        request.push(b'\n');
        writer.write_all(&request).await.unwrap();
        writer.shutdown().await.unwrap();
        let mut line = String::new();
        BufReader::new(reader).read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap()
    }
}
