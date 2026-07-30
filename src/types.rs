use crate::db::Database;
use crate::riot_api;
use serenity::prelude::Mutex;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

// fundamental types for discord bot
#[derive(Clone)]
pub struct Data {
    pub henrik_client: Arc<riot_api::valorant::HenrikClient>,
    pub riot_client: Arc<riot_api::lol::RiotClient>,
    pub db: Arc<Mutex<Database>>,
    pub polling_paused: Arc<AtomicBool>,
}
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Context<'a> = poise::Context<'a, Data, Error>;
