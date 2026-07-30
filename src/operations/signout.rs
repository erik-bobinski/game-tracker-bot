use super::{AccountIdentity, OperationError};
use crate::types::Data;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SignoutResult {
    #[serde(flatten)]
    pub account: AccountIdentity,
    pub tracked_accounts: usize,
}

pub async fn run(data: &Data, discord_user_id: u64) -> Result<SignoutResult, OperationError> {
    let mut db = data.db.lock().await;
    let account = db
        .get_accounts()
        .into_iter()
        .find(|account| account.discord_user_id == discord_user_id)
        .ok_or_else(|| OperationError::not_found(discord_user_id))?;

    db.delete_account(discord_user_id)?;

    Ok(SignoutResult {
        account: AccountIdentity::from(&account),
        tracked_accounts: db.get_accounts().len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, DatabaseAccount, DbError};
    use crate::riot_api;
    use serenity::prelude::Mutex;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    #[tokio::test]
    async fn removes_from_memory_and_disk_without_resurrection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("accounts.json");
        let mut database = Database::load(&path).unwrap();
        let removed = DatabaseAccount {
            discord_user_id: 42,
            discord_name: "target".into(),
            riot_name: "Target".into(),
            riot_tag: "NA1".into(),
            added_at: chrono::Utc::now(),
            ..Default::default()
        };
        let retained = DatabaseAccount {
            discord_user_id: 43,
            discord_name: "retained".into(),
            riot_name: "Retained".into(),
            riot_tag: "NA1".into(),
            added_at: chrono::Utc::now(),
            ..Default::default()
        };
        database.add_account(removed.clone()).unwrap();
        database.add_account(retained.clone()).unwrap();
        let data = Data {
            henrik_client: Arc::new(riot_api::valorant::HenrikClient::new("test".into())),
            riot_client: Arc::new(riot_api::lol::RiotClient::new("test".into())),
            db: Arc::new(Mutex::new(database)),
            polling_paused: Arc::new(AtomicBool::new(false)),
        };

        let result = run(&data, 42).await.unwrap();
        assert_eq!(result.tracked_accounts, 1);
        assert_eq!(result.account.discord_name, "target");

        let mut db = data.db.lock().await;
        assert_eq!(db.get_accounts(), vec![retained]);
        assert!(matches!(
            db.update_account(removed),
            Err(DbError::NotFound {
                discord_user_id: 42
            })
        ));
        drop(db);

        let reloaded = Database::load(&path).unwrap();
        assert_eq!(reloaded.get_accounts().len(), 1);
        assert_eq!(reloaded.get_accounts()[0].discord_user_id, 43);
    }

    #[tokio::test]
    async fn unknown_user_is_typed_not_found() {
        let directory = tempfile::tempdir().unwrap();
        let data = Data {
            henrik_client: Arc::new(riot_api::valorant::HenrikClient::new("test".into())),
            riot_client: Arc::new(riot_api::lol::RiotClient::new("test".into())),
            db: Arc::new(Mutex::new(
                Database::load(directory.path().join("accounts.json")).unwrap(),
            )),
            polling_paused: Arc::new(AtomicBool::new(false)),
        };

        let error = run(&data, 999).await.unwrap_err();
        assert_eq!(error.code, "not_found");
        assert_eq!(error.exit_code, 4);
    }
}
