use crate::operations::signup as signup_operation;
use crate::types::{Context, Error};

/// Get your riot account's match results reported
#[poise::command(slash_command)]
pub async fn signup(
    ctx: Context<'_>,
    #[description = "before the # (e.g. syan)"] riot_name: String,
    #[description = "after the # (e.g. NA1)"] riot_tag: String,
) -> Result<(), Error> {
    ctx.defer().await?;

    let result = signup_operation::run(
        ctx.data(),
        ctx.author().id.get(),
        ctx.author().name.clone(),
        riot_name,
        riot_tag,
    )
    .await;

    if result
        .as_ref()
        .is_err_and(|error| error.code == "riot_account_not_found")
    {
        ctx.say("Couldn't find recent account data for that Riot ID :(")
            .await?;
        return Ok(());
    }
    result?;

    ctx.say(format!("**{}** just signed up!", ctx.author().name))
        .await?;
    Ok(())
}
