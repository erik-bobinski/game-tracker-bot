use super::{Game, OperationError};
use crate::types::Data;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "game", rename_all = "lowercase")]
pub enum RankCheckResult {
    Val {
        discord_user_id: u64,
        discord_name: String,
        tier: String,
        rr: i32,
        image_url: String,
    },
    Lol {
        discord_user_id: u64,
        discord_name: String,
        tier: String,
        division: String,
        league_points: i32,
        queue: String,
        image_url: String,
    },
}

pub async fn run(
    data: &Data,
    discord_user_id: u64,
    game: Game,
) -> Result<RankCheckResult, OperationError> {
    let account = {
        let db = data.db.lock().await;
        db.get_accounts()
            .into_iter()
            .find(|account| account.discord_user_id == discord_user_id)
    }
    .ok_or_else(|| OperationError::not_found(discord_user_id))?;

    match game {
        Game::Val => valorant(data, account).await,
        Game::Lol => league(data, account).await,
    }
}

async fn valorant(
    data: &Data,
    account: crate::db::DatabaseAccount,
) -> Result<RankCheckResult, OperationError> {
    if account.val_puuid.is_empty() {
        return Err(OperationError::new(
            "platform_not_linked",
            format!(
                "{} doesn't have a Valorant account linked",
                account.discord_name
            ),
            4,
        ));
    }
    let region = account.val_region.as_deref().ok_or_else(|| {
        OperationError::new(
            "region_unknown",
            format!("{}'s Valorant region isn't known", account.discord_name),
            4,
        )
    })?;
    let mmr = data
        .henrik_client
        .get_current_mmr(&account.val_puuid, region)
        .await
        .map_err(|error| {
            OperationError::upstream(format!("Valorant rank lookup failed: {error}"))
        })?;

    Ok(RankCheckResult::Val {
        discord_user_id: account.discord_user_id,
        discord_name: account.discord_name,
        tier: mmr.current_data.currenttier_patched,
        rr: mmr.current_data.ranking_in_tier,
        image_url: mmr.current_data.images.large,
    })
}

async fn league(
    data: &Data,
    account: crate::db::DatabaseAccount,
) -> Result<RankCheckResult, OperationError> {
    if account.lol_puuid.is_empty() {
        return Err(OperationError::new(
            "platform_not_linked",
            format!(
                "{} doesn't have a League account linked",
                account.discord_name
            ),
            4,
        ));
    }
    let region = account.lol_region.as_deref().ok_or_else(|| {
        OperationError::new(
            "region_unknown",
            format!("{}'s League region isn't known", account.discord_name),
            4,
        )
    })?;

    let cached = match &account.lol_platform {
        Some(platform) => data
            .riot_client
            .get_league_entries(&account.lol_puuid, platform)
            .await
            .ok()
            .map(|entries| (platform.clone(), entries)),
        None => None,
    };
    let found = match cached {
        Some(found) => Some(found),
        None => {
            let found = data
                .riot_client
                .find_league_entries(&account.lol_puuid, region)
                .await
                .map_err(|error| {
                    OperationError::upstream(format!("League rank lookup failed: {error}"))
                })?;
            if let Some((platform, _)) = &found {
                let mut updated = account.clone();
                updated.lol_platform = Some(platform.clone());
                data.db.lock().await.update_account(updated)?;
            }
            found
        }
    };

    let (_, entries) = found.ok_or_else(|| {
        OperationError::upstream(format!(
            "Couldn't reach League servers for {}",
            account.discord_name
        ))
    })?;
    let solo = entries
        .iter()
        .find(|entry| entry.queue_type == "RANKED_SOLO_5x5");
    let flex = entries
        .iter()
        .find(|entry| entry.queue_type == "RANKED_FLEX_SR");
    let entry = solo.or(flex).ok_or_else(|| {
        OperationError::new(
            "unranked",
            format!("{} is unranked in League", account.discord_name),
            4,
        )
    })?;
    let queue = if solo.is_some() { "Solo/Duo" } else { "Flex" };
    let division = match entry.tier.as_str() {
        "MASTER" | "GRANDMASTER" | "CHALLENGER" => String::new(),
        _ => entry.rank.clone(),
    };

    Ok(RankCheckResult::Lol {
        discord_user_id: account.discord_user_id,
        discord_name: account.discord_name,
        tier: title_case(&entry.tier),
        division,
        league_points: entry.league_points,
        queue: queue.to_string(),
        image_url: format!(
            "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-{}.png",
            entry.tier.to_ascii_lowercase()
        ),
    })
}

pub fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}
