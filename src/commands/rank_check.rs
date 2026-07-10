use crate::db::DatabaseAccount;
use crate::types::{Context, Error};
use serenity::builder::CreateEmbed;
use serenity::model::user::User;

#[derive(Debug, poise::ChoiceParameter)]
pub enum Game {
    #[name = "val"]
    Valorant,
    #[name = "lol"]
    LeagueOfLegends,
}

/// Check a signed-up user's Valorant or League rank
#[poise::command(slash_command)]
pub async fn rank_check(
    ctx: Context<'_>,
    #[description = "the discord user to check"] user: User,
    #[description = "which game's rank to check(Val or LoL)"] game: Game,
) -> Result<(), Error> {
    ctx.defer().await?;

    let account = {
        let db = ctx.data().db.lock().await;
        db.get_accounts()
            .into_iter()
            .find(|acct| acct.discord_user_id == user.id.get())
    };

    let Some(account) = account else {
        ctx.say(format!("**{}** hasn't signed up yet.", user.name))
            .await?;
        return Ok(());
    };

    match game {
        Game::Valorant => valorant_rank(&ctx, &account, &user).await,
        Game::LeagueOfLegends => lol_rank(&ctx, &account, &user).await,
    }
}

async fn valorant_rank(
    ctx: &Context<'_>,
    account: &DatabaseAccount,
    user: &User,
) -> Result<(), Error> {
    if account.val_puuid.is_empty() {
        ctx.say(format!(
            "**{}** doesn't have a Valorant account linked.",
            user.name
        ))
        .await?;
        return Ok(());
    }

    let Some(region) = &account.val_region else {
        ctx.say(format!(
            "**{}**'s Valorant region isn't known yet.",
            user.name
        ))
        .await?;
        return Ok(());
    };

    let mmr = ctx
        .data()
        .henrik_client
        .get_current_mmr(&account.val_puuid, region)
        .await?;
    let current = &mmr.current_data;

    let mut description = format!("**{}**", current.currenttier_patched);
    if current.ranking_in_tier > 0 {
        description.push_str(&format!(" · {} RR", current.ranking_in_tier));
    }

    let mut embed = CreateEmbed::new()
        .title(format!("{}'s Valorant Rank", user.name))
        .description(description)
        .colour(0xFF4655); // valorant red

    if !current.images.large.is_empty() {
        embed = embed.thumbnail(&current.images.large);
    }

    ctx.send(poise::CreateReply::default().embed(embed)).await?;
    Ok(())
}

async fn lol_rank(ctx: &Context<'_>, account: &DatabaseAccount, user: &User) -> Result<(), Error> {
    if account.lol_puuid.is_empty() {
        ctx.say(format!(
            "**{}** doesn't have a League account linked.",
            user.name
        ))
        .await?;
        return Ok(());
    }

    let Some(region) = &account.lol_region else {
        ctx.say(format!(
            "**{}**'s League region isn't known yet.",
            user.name
        ))
        .await?;
        return Ok(());
    };

    // a cached platform (learned from a prior match report, or a prior
    // /rank-check) skips the multi-platform probe entirely; fall back to
    // probing if it's missing or turns out stale
    let cached = match &account.lol_platform {
        Some(platform) => ctx
            .data()
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
            let found = ctx
                .data()
                .riot_client
                .find_league_entries(&account.lol_puuid, region)
                .await?;

            // persist whatever platform the probe found so future lookups
            // (this command or match polling) skip straight to it
            if let Some((platform, _)) = &found {
                let mut updated = account.clone();
                updated.lol_platform = Some(platform.clone());
                if let Err(e) = ctx.data().db.lock().await.update_account(updated) {
                    eprintln!("failed to persist discovered lol platform: {e}");
                }
            }

            found
        }
    };

    let Some((_platform, entries)) = found else {
        ctx.say(format!(
            "Couldn't reach League servers for **{}**.",
            user.name
        ))
        .await?;
        return Ok(());
    };

    let solo = entries.iter().find(|e| e.queue_type == "RANKED_SOLO_5x5");
    let flex = entries.iter().find(|e| e.queue_type == "RANKED_FLEX_SR");
    let Some(entry) = solo.or(flex) else {
        ctx.say(format!("**{}** is unranked in League.", user.name))
            .await?;
        return Ok(());
    };

    let queue_label = if solo.is_some() { "Solo/Duo" } else { "Flex" };
    // apex tiers (master+) have no meaningful division
    let division = match entry.tier.as_str() {
        "MASTER" | "GRANDMASTER" | "CHALLENGER" => String::new(),
        _ => format!(" {}", entry.rank),
    };

    let embed = CreateEmbed::new()
        .title(format!("{}'s League Rank", user.name))
        .description(format!(
            "**{}{}** · {} LP ({})",
            title_case(&entry.tier),
            division,
            entry.league_points,
            queue_label
        ))
        .colour(0x0AC8B9) // league teal
        .image(format!(
            "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-{}.png",
            entry.tier.to_ascii_lowercase()
        ));

    ctx.send(poise::CreateReply::default().embed(embed)).await?;
    Ok(())
}

// "GOLD" -> "Gold"
fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => {
            first.to_uppercase().collect::<String>() + &chars.as_str().to_ascii_lowercase()
        }
        None => String::new(),
    }
}
