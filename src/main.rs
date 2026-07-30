use crate::db::Database;
use crate::types::Data;
use clap::Parser;
use serenity::prelude::*;
use std::env;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

mod admin;
mod commands;
mod db;
mod discord;
mod operations;
mod polling;
mod riot_api;
mod types;

#[tokio::main]
async fn main() {
    let cli = admin::Cli::parse();
    if let Some(admin::RootCommand::Admin(args)) = cli.command {
        let exit_code = admin::client::run(args, &admin::socket_path()).await;
        std::process::exit(exit_code.into());
    }

    let token = env::var("DISCORD_TOKEN").unwrap_or_else(|_| {
        dotenv::dotenv().ok();
        env::var("DISCORD_TOKEN").expect("Expected a discord bot env var in environment")
    });

    let intents = GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;

    let framework = poise::Framework::builder()
        .options(poise::FrameworkOptions {
            commands: commands::all(),
            ..Default::default()
        })
        .setup(|ctx, _ready, framework| {
            Box::pin(async move {
                poise::builtins::register_globally(ctx, &framework.options().commands).await?;

                let henrik_api_key =
                    env::var("HENRIK_API_KEY").expect("Expected HENRIK_API_KEY in environment");
                let riot_api_key =
                    env::var("RIOT_API_KEY").expect("Expected RIOT_API_KEY in environment");
                let db_path = env::var("DB_PATH").unwrap_or_else(|_| "accounts.json".to_string());
                let notification_channel_id = env::var("NOTIFICATION_CHANNEL_ID")
                    .expect("Expected NOTIFICATION_CHANNEL_ID in environment")
                    .parse::<u64>()
                    .expect("NOTIFICATION_CHANNEL_ID must be a valid channel id");
                let notification_channel_id =
                    serenity::model::id::ChannelId::new(notification_channel_id);

                let db = Database::load(&db_path)?;
                let db = Arc::new(Mutex::new(db));
                let henrik_client = Arc::new(riot_api::valorant::HenrikClient::new(henrik_api_key));
                let riot_client = Arc::new(riot_api::lol::RiotClient::new(riot_api_key));
                let polling_paused = Arc::new(AtomicBool::new(false));
                let data = Data {
                    henrik_client,
                    riot_client,
                    db,
                    polling_paused,
                };

                tokio::spawn(polling::run(
                    ctx.http.clone(),
                    data.db.clone(),
                    data.henrik_client.clone(),
                    data.riot_client.clone(),
                    notification_channel_id,
                    data.polling_paused.clone(),
                ));

                let admin_socket_path = admin::socket_path();
                let admin_listener = admin::server::bind(&admin_socket_path).await?;
                tokio::spawn(admin::server::run(
                    admin_listener,
                    admin_socket_path,
                    data.clone(),
                ));

                Ok(data)
            })
        })
        .build();

    let client = Client::builder(&token, intents).framework(framework).await;
    client.unwrap().start().await.unwrap();
}
