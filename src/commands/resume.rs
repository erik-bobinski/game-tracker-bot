use crate::operations::polling_control;
use crate::types::{Context, Error};

/// Resume all match reports
#[poise::command(slash_command)]
pub async fn resume(ctx: Context<'_>) -> Result<(), Error> {
    polling_control::set_paused(ctx.data(), false);
    ctx.say("Polling resumed.").await?;
    Ok(())
}
