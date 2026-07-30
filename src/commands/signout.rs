use crate::operations::signout as signout_operation;
use crate::types::{Context, Error};

/// Stop tracking your riot account
#[poise::command(slash_command)]
pub async fn signout(ctx: Context<'_>) -> Result<(), Error> {
    signout_operation::run(ctx.data(), ctx.author().id.get()).await?;

    ctx.say(format!("**{}** just signed out!", ctx.author().name))
        .await?;
    Ok(())
}
