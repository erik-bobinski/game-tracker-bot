use crate::operations::polling_control;
use crate::types::{Context, Error};

/// Pause all match reports
#[poise::command(slash_command)]
pub async fn pause(ctx: Context<'_>) -> Result<(), Error> {
    polling_control::set_paused(ctx.data(), true);
    ctx.say("Polling paused.").await?;
    Ok(())
}
