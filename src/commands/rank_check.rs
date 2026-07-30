use crate::operations::Game as OperationGame;
use crate::operations::rank_check::{self, RankCheckResult};
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
    let operation_game = match game {
        Game::Valorant => OperationGame::Val,
        Game::LeagueOfLegends => OperationGame::Lol,
    };

    let result = match rank_check::run(ctx.data(), user.id.get(), operation_game).await {
        Ok(result) => result,
        Err(error) if error.code == "not_found" => {
            ctx.say(format!("**{}** hasn't signed up yet.", user.name))
                .await?;
            return Ok(());
        }
        Err(error) if error.code == "platform_not_linked" => {
            let game = match operation_game {
                OperationGame::Val => "Valorant",
                OperationGame::Lol => "League",
            };
            ctx.say(format!(
                "**{}** doesn't have a {game} account linked.",
                user.name
            ))
            .await?;
            return Ok(());
        }
        Err(error) if error.code == "region_unknown" => {
            let game = match operation_game {
                OperationGame::Val => "Valorant",
                OperationGame::Lol => "League",
            };
            ctx.say(format!(
                "**{}**'s {game} region isn't known yet.",
                user.name
            ))
            .await?;
            return Ok(());
        }
        Err(error) if error.code == "unranked" => {
            ctx.say(format!("**{}** is unranked in League.", user.name))
                .await?;
            return Ok(());
        }
        Err(error)
            if error.code == "upstream_unavailable" && operation_game == OperationGame::Lol =>
        {
            ctx.say(format!(
                "Couldn't reach League servers for **{}**.",
                user.name
            ))
            .await?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };

    let embed = match result {
        RankCheckResult::Val {
            tier,
            rr,
            image_url,
            ..
        } => {
            let mut description = format!("**{tier}**");
            if rr > 0 {
                description.push_str(&format!(" · {rr} RR"));
            }
            let mut embed = CreateEmbed::new()
                .title(format!("{}'s Valorant Rank", user.name))
                .description(description)
                .colour(0xFF4655);
            if !image_url.is_empty() {
                embed = embed.thumbnail(image_url);
            }
            embed
        }
        RankCheckResult::Lol {
            tier,
            division,
            league_points,
            queue,
            image_url,
            ..
        } => {
            let division = if division.is_empty() {
                String::new()
            } else {
                format!(" {division}")
            };
            CreateEmbed::new()
                .title(format!("{}'s League Rank", user.name))
                .description(format!(
                    "**{tier}{division}** · {league_points} LP ({queue})"
                ))
                .colour(0x0AC8B9)
                .image(image_url)
        }
    };

    ctx.send(poise::CreateReply::default().embed(embed)).await?;
    Ok(())
}
