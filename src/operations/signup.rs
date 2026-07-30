use super::{AccountIdentity, OperationError};
use crate::db::DatabaseAccount;
use crate::types::Data;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SignupResult {
    #[serde(flatten)]
    pub account: AccountIdentity,
    pub tracked_accounts: usize,
}

pub async fn run(
    data: &Data,
    discord_user_id: u64,
    discord_name: String,
    riot_name: String,
    riot_tag: String,
) -> Result<SignupResult, OperationError> {
    let valorant_account = data
        .henrik_client
        .get_account(&riot_name, &riot_tag)
        .await
        .ok();
    let lol_account = data
        .riot_client
        .get_account(&riot_name, &riot_tag)
        .await
        .ok();

    if valorant_account.is_none() && lol_account.is_none() {
        return Err(OperationError::new(
            "riot_account_not_found",
            "Couldn't find recent account data for that Riot ID",
            4,
        ));
    }

    let (val_puuid, val_region) = valorant_account
        .map(|account| (account.puuid, Some(account.region)))
        .unwrap_or_default();

    let (lol_puuid, lol_region) = match lol_account {
        Some(account) => {
            let region = data
                .riot_client
                .detect_region(&account.puuid)
                .await
                .map_err(|error| {
                    OperationError::upstream(format!(
                        "Couldn't detect the League account region: {error}"
                    ))
                })?;
            (account.puuid, region)
        }
        None => (String::new(), None),
    };

    let account = DatabaseAccount {
        discord_user_id,
        discord_name,
        riot_name,
        riot_tag,
        val_puuid,
        val_region,
        lol_puuid,
        lol_region,
        added_at: chrono::Utc::now(),
        ..Default::default()
    };
    let identity = AccountIdentity::from(&account);

    let mut db = data.db.lock().await;
    db.add_account(account)?;

    Ok(SignupResult {
        account: identity,
        tracked_accounts: db.get_accounts().len(),
    })
}
