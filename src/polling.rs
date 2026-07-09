use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serenity::builder::CreateMessage;
use std::collections::HashMap;

use crate::db::{self, Database};
use crate::discord;
use crate::riot_api::{
    lol::RiotClient,
    valorant::{self, HenrikClient},
};

pub async fn run(
    http: Arc<serenity::http::Http>,
    db: Arc<tokio::sync::Mutex<Database>>,
    henrik_client: Arc<HenrikClient>,
    riot_client: Arc<RiotClient>,
    notification_channel_id: serenity::model::id::ChannelId,
    paused: Arc<AtomicBool>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));

    loop {
        interval.tick().await;

        if paused.load(Ordering::Relaxed) {
            continue;
        }

        let mut accounts = db.lock().await.get_accounts();

        // matches discovered this cycle that still need reporting, deduped across
        // accounts so a match shared by several tracked users is reported once,
        // naming everyone involved
        let mut pending_val_matches: Vec<valorant::MatchSummary> = Vec::new();
        let mut pending_lol_matches: Vec<(String, String)> = Vec::new(); // (match id, region)

        for account in &mut accounts {
            // henrik can't resolve an account with no match history yet, so a riot id
            // entered at signup may still be unresolved; retry it here now that the
            // player may have finished a game since then
            if account.val_region.is_none() {
                if let Ok(valorant_account) = henrik_client
                    .get_account(&account.riot_name, &account.riot_tag)
                    .await
                {
                    account.val_puuid = valorant_account.puuid;
                    account.val_region = Some(valorant_account.region);
                }
            }

            // user has val_region only if they play valorant
            if let Some(val_region) = account.val_region.clone() {
                let val_matches = match henrik_client
                    .get_matches(&account.val_puuid, &val_region)
                    .await
                {
                    Ok(matches) => matches,
                    Err(_) => Vec::new(),
                };

                if account.reported_val_match_ids.is_empty() {
                    // first fetch for this account: baseline to the current window
                    // instead of reporting the player's existing history
                    account.reported_val_match_ids = val_matches
                        .iter()
                        .map(|m| m.metadata.matchid.to_ascii_lowercase())
                        .collect();
                    account.reported_val_match_ids.truncate(db::REPORTED_MATCH_CAP);
                } else {
                    for m in val_matches {
                        if db::contains_match(&account.reported_val_match_ids, &m.metadata.matchid)
                        {
                            continue;
                        }
                        let already_pending = pending_val_matches.iter().any(|p| {
                            p.metadata.matchid.eq_ignore_ascii_case(&m.metadata.matchid)
                        });
                        if !already_pending {
                            pending_val_matches.push(m);
                        }
                    }
                }
            }

            // lol region can't be detected until the account has match history, so it
            // may still be unresolved from signup; retry it here now that the player
            // may have finished a game since then
            if account.lol_region.is_none() {
                // the account lookup itself may also have failed at signup
                if account.lol_puuid.is_empty() {
                    if let Ok(lol_account) = riot_client
                        .get_account(&account.riot_name, &account.riot_tag)
                        .await
                    {
                        account.lol_puuid = lol_account.puuid;
                    }
                }

                if !account.lol_puuid.is_empty() {
                    if let Ok(Some(region)) =
                        riot_client.detect_region(&account.lol_puuid).await
                    {
                        account.lol_region = Some(region);
                    }
                }
            }

            // user has lol_region only if they play lol
            if let Some(lol_region) = &account.lol_region {
                let lol_match_ids = match riot_client
                    .get_match_ids(&account.lol_puuid, lol_region)
                    .await
                {
                    Ok(ids) => ids,
                    Err(_) => Vec::new(),
                };

                if account.reported_lol_match_ids.is_empty() {
                    // first fetch for this account: baseline to the current window
                    // instead of reporting the player's existing history
                    account.reported_lol_match_ids = lol_match_ids
                        .iter()
                        .map(|id| id.to_ascii_lowercase())
                        .collect();
                    account.reported_lol_match_ids.truncate(db::REPORTED_MATCH_CAP);
                } else {
                    for match_id in lol_match_ids {
                        if db::contains_match(&account.reported_lol_match_ids, &match_id) {
                            continue;
                        }
                        let already_pending = pending_lol_matches
                            .iter()
                            .any(|(id, _)| id.eq_ignore_ascii_case(&match_id));
                        if !already_pending {
                            pending_lol_matches.push((match_id, lol_region.clone()));
                        }
                    }
                }
            }
        }

        for m in &pending_val_matches {
            // every tracked account in the lobby, in tracked-account order; the
            // first one's team decides which side the report calls "own"
            let involved: Vec<usize> = accounts
                .iter()
                .enumerate()
                .filter(|(_, a)| {
                    !a.val_puuid.is_empty()
                        && m.players.all_players.iter().any(|p| p.puuid == a.val_puuid)
                })
                .map(|(i, _)| i)
                .collect();
            if involved.is_empty() {
                continue;
            }

            // RR changes for tracked players, joined from mmr history by match id;
            // only competitive games appear there, so other modes skip the calls
            let mut rank_updates: HashMap<String, discord::RankUpdate> = HashMap::new();
            if m.metadata.mode.eq_ignore_ascii_case("competitive") {
                for &i in &involved {
                    let Some(region) = accounts[i].val_region.clone() else {
                        continue;
                    };
                    let history = match henrik_client
                        .get_mmr_history(&accounts[i].val_puuid, &region)
                        .await
                    {
                        Ok(history) => history,
                        Err(_) => continue,
                    };

                    if let Some(entry) = history
                        .iter()
                        .find(|e| e.match_id.eq_ignore_ascii_case(&m.metadata.matchid))
                    {
                        rank_updates.insert(
                            accounts[i].val_puuid.clone(),
                            discord::RankUpdate {
                                delta: Some(entry.mmr_change_to_last_game),
                                current: Some(entry.currenttier_patched.clone()),
                                unit: "RR",
                            },
                        );
                    }
                }
            }

            let names: Vec<&str> = involved
                .iter()
                .map(|&i| accounts[i].discord_name.as_str())
                .collect();
            let puuids: Vec<&str> = involved
                .iter()
                .map(|&i| accounts[i].val_puuid.as_str())
                .collect();

            let embed = discord::build_match_embed(
                &names,
                &discord::val_match_to_result(m, &puuids, &rank_updates),
            );

            if let Err(e) = notification_channel_id
                .send_message(&http, CreateMessage::new().embed(embed))
                .await
            {
                eprintln!("failed to send val match notification: {e}");
            }

            for &i in &involved {
                // an empty ring means the account hasn't been baselined yet; leave it
                // empty so a single remembered id can't masquerade as a baseline
                if !accounts[i].reported_val_match_ids.is_empty() {
                    db::remember_match(
                        &mut accounts[i].reported_val_match_ids,
                        &m.metadata.matchid,
                    );
                }
            }
        }

        for (match_id, region) in &pending_lol_matches {
            let summary = match riot_client.get_match(match_id, region).await {
                Ok(summary) => summary,
                // not remembered, so the next poll retries this match
                Err(_) => continue,
            };

            // every tracked account in the lobby, in tracked-account order; the
            // first one's team decides which side the report calls "own"
            let involved: Vec<usize> = accounts
                .iter()
                .enumerate()
                .filter(|(_, a)| {
                    !a.lol_puuid.is_empty()
                        && summary
                            .info
                            .participants
                            .iter()
                            .any(|p| p.puuid == a.lol_puuid)
                })
                .map(|(i, _)| i)
                .collect();
            if involved.is_empty() {
                continue;
            }

            // LP changes for tracked players in ranked queues, diffed against the
            // last league-v4 snapshot stored for that queue
            let mut rank_updates: HashMap<String, discord::RankUpdate> = HashMap::new();
            let ranked_queue = match summary.info.queue_id {
                420 => Some("RANKED_SOLO_5x5"),
                440 => Some("RANKED_FLEX_SR"),
                _ => None,
            };
            if let Some(queue_type) = ranked_queue {
                // league-v4 wants the platform host (na1, euw1, ...), which the
                // match itself names
                let platform = summary.info.platform_id.to_ascii_lowercase();

                for &i in &involved {
                    let entries = match riot_client
                        .get_league_entries(&accounts[i].lol_puuid, &platform)
                        .await
                    {
                        Ok(entries) => entries,
                        Err(_) => continue,
                    };
                    let Some(entry) = entries.into_iter().find(|e| e.queue_type == queue_type)
                    else {
                        continue;
                    };

                    // LP is only comparable within the same tier+division; across a
                    // promotion/demotion just show the new standing without a delta
                    let previous = accounts[i].lol_rank_snapshots.get(queue_type);
                    let delta = previous.and_then(|prev| {
                        (prev.tier == entry.tier && prev.division == entry.rank)
                            .then(|| entry.league_points - prev.league_points)
                    });
                    let current = match delta {
                        Some(_) => format!("{} {}", title_case(&entry.tier), entry.rank),
                        None => format!(
                            "{} {} · {} LP",
                            title_case(&entry.tier),
                            entry.rank,
                            entry.league_points
                        ),
                    };

                    rank_updates.insert(
                        accounts[i].lol_puuid.clone(),
                        discord::RankUpdate {
                            delta,
                            current: Some(current),
                            unit: "LP",
                        },
                    );
                    accounts[i].lol_rank_snapshots.insert(
                        queue_type.to_string(),
                        db::LolRankSnapshot {
                            tier: entry.tier,
                            division: entry.rank,
                            league_points: entry.league_points,
                        },
                    );
                }
            }

            let names: Vec<&str> = involved
                .iter()
                .map(|&i| accounts[i].discord_name.as_str())
                .collect();
            let puuids: Vec<&str> = involved
                .iter()
                .map(|&i| accounts[i].lol_puuid.as_str())
                .collect();

            let embed = discord::build_match_embed(
                &names,
                &discord::lol_match_to_result(&summary, &puuids, &rank_updates),
            );

            if let Err(e) = notification_channel_id
                .send_message(&http, CreateMessage::new().embed(embed))
                .await
            {
                eprintln!("failed to send lol match notification: {e}");
            }

            for &i in &involved {
                // an empty ring means the account hasn't been baselined yet; leave it
                // empty so a single remembered id can't masquerade as a baseline
                if !accounts[i].reported_lol_match_ids.is_empty() {
                    db::remember_match(&mut accounts[i].reported_lol_match_ids, match_id);
                }
            }
        }

        // persist the updated reported-match rings and rank snapshots
        for account in accounts {
            if let Err(e) = db.lock().await.update_account(account) {
                eprintln!("failed to persist updated account: {e}");
            }
        }
    }
}

// league-v4 tiers arrive ALL CAPS ("EMERALD"); prettify for display
fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}
