use serde::Deserialize;

pub struct HenrikClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}
impl HenrikClient {
    pub fn new(api_key: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: String::from("https://api.henrikdev.xyz"),
            api_key,
        }
    }

    pub async fn get_account(&self, name: &str, tag: &str) -> Result<AccountData, reqwest::Error> {
        let url = format!("{}/valorant/v2/account/{}/{}", self.base_url, name, tag);

        Ok(self
            .http
            .get(url)
            .header("Authorization", &self.api_key)
            .send()
            .await?
            .error_for_status()?
            .json::<HenrikResponse<AccountData>>()
            .await?
            .data)
    }

    pub async fn get_matches(
        &self,
        puuid: &str,
        region: &str,
    ) -> Result<Vec<MatchSummary>, reqwest::Error> {
        let url = format!(
            "{}/valorant/v3/by-puuid/matches/{}/{}",
            self.base_url, region, puuid
        );

        // filter out henrik match results that are still being processed by riot's APIs
        Ok(self
            .http
            .get(url)
            .header("Authorization", &self.api_key)
            .send()
            .await?
            .error_for_status()?
            .json::<HenrikResponse<Vec<RawMatchSummary>>>()
            .await?
            .data
            .into_iter()
            .filter_map(|m| match (m.metadata, m.players, m.teams) {
                (Some(metadata), Some(players), Some(teams)) if m.is_available => {
                    Some(MatchSummary {
                        metadata,
                        players,
                        teams,
                    })
                }
                _ => None,
            })
            .collect())
    }

    // current competitive standing, including the rank emblem image urls used
    // to make /rank-check's output legible at a glance
    pub async fn get_current_mmr(&self, puuid: &str, region: &str) -> Result<CurrentMmr, reqwest::Error> {
        let url = format!("{}/valorant/v2/by-puuid/mmr/{}/{}", self.base_url, region, puuid);

        Ok(self
            .http
            .get(url)
            .header("Authorization", &self.api_key)
            .send()
            .await?
            .error_for_status()?
            .json::<HenrikResponse<CurrentMmr>>()
            .await?
            .data)
    }

    // recent competitive games with the RR change each caused; callers join
    // entries back to a reported match by match_id. only competitive matches
    // appear here, so a missing entry just means the match wasn't ranked (or
    // henrik hasn't processed it yet)
    pub async fn get_mmr_history(
        &self,
        puuid: &str,
        region: &str,
    ) -> Result<Vec<MmrHistoryEntry>, reqwest::Error> {
        let url = format!(
            "{}/valorant/v1/by-puuid/mmr-history/{}/{}",
            self.base_url, region, puuid
        );

        Ok(self
            .http
            .get(url)
            .header("Authorization", &self.api_key)
            .send()
            .await?
            .error_for_status()?
            .json::<HenrikResponse<Vec<MmrHistoryEntry>>>()
            .await?
            .data)
    }
}

// general henrik response shape
#[derive(Debug, Deserialize)]
pub struct HenrikResponse<T> {
    pub status: u16,
    pub data: T,
}

// response from /valorant/v2/account/{name}/{tag}
#[derive(Debug, Deserialize)]
pub struct AccountData {
    pub puuid: String,
    pub region: String,
}

// response item from /valorant/v3/by-puuid/matches/{region}/{puuid}; matches still
// being processed have is_available: false and null data fields
#[derive(Debug, Deserialize)]
struct RawMatchSummary {
    is_available: bool,
    metadata: Option<MatchMetadata>,
    players: Option<MatchPlayers>,
    teams: Option<MatchTeams>,
}

// a fully processed match, as returned to callers
#[derive(Debug)]
pub struct MatchSummary {
    pub metadata: MatchMetadata,
    pub players: MatchPlayers,
    pub teams: MatchTeams,
}

#[derive(Debug, Deserialize)]
pub struct MatchMetadata {
    pub map: String,
    pub mode: String,
    pub game_length: u64,
    // unix seconds when the match started; defaulted (like rounds_played) so an
    // edge-case mode omitting it can't fail the whole match-list deserialization
    #[serde(default)]
    pub game_start: u64,
    #[serde(default)]
    pub rounds_played: u32,
    region: String,
    pub matchid: String,
}

// red/blue are null for free-for-all modes (deathmatch), which have no team
// results; keeping them optional stops one such match from failing the whole
// match-list deserialization
#[derive(Debug, Deserialize)]
pub struct MatchTeams {
    pub red: Option<TeamStats>,
    pub blue: Option<TeamStats>,
}

#[derive(Debug, Deserialize)]
pub struct TeamStats {
    pub rounds_won: u32,
    pub rounds_lost: u32,
    // None when absent, so a missing field renders as "no result" rather
    // than silently flipping a win into a defeat
    pub has_won: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct MatchPlayers {
    pub all_players: Vec<MatchPlayer>,
}

#[derive(Debug, Deserialize)]
pub struct MatchPlayer {
    pub puuid: String,
    pub name: String,
    pub tag: String,
    pub team: String,
    pub character: String,
    currenttier_patched: String,
    player_card: String,
    #[serde(default)]
    pub assets: PlayerAssets,
    pub stats: PlayerStats,
}

// image urls henrik bundles per player; agent portraits make good embed thumbnails
#[derive(Debug, Default, Deserialize)]
pub struct PlayerAssets {
    #[serde(default)]
    pub agent: AgentAssets,
}

#[derive(Debug, Default, Deserialize)]
pub struct AgentAssets {
    #[serde(default)]
    pub small: String,
}

#[derive(Debug, Deserialize)]
pub struct PlayerStats {
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    // total combat score across the match; divide by rounds_played for ACS
    pub score: u32,
    #[serde(default)]
    pub headshots: u32,
    #[serde(default)]
    pub bodyshots: u32,
    #[serde(default)]
    pub legshots: u32,
}

// entry from /valorant/v1/by-puuid/mmr-history/{region}/{puuid}
#[derive(Debug, Deserialize)]
pub struct MmrHistoryEntry {
    pub match_id: String,
    pub mmr_change_to_last_game: i32,
    // unlike the match endpoint's currenttier_patched, v1 mmr-history
    // spells this without the underscore
    #[serde(rename = "currenttierpatched")]
    pub currenttier_patched: String,
}

// response from /valorant/v2/by-puuid/mmr/{region}/{puuid}
#[derive(Debug, Deserialize)]
pub struct CurrentMmr {
    pub current_data: CurrentMmrData,
}

#[derive(Debug, Deserialize)]
pub struct CurrentMmrData {
    // unranked players still get a row here with currenttier 0 ("Unrated") and
    // no images, so callers don't need a separate "no rank yet" branch
    #[serde(rename = "currenttierpatched")]
    pub currenttier_patched: String,
    #[serde(default)]
    pub ranking_in_tier: i32,
    #[serde(default)]
    pub images: MmrImages,
}

// rank emblem urls henrik bundles per tier; large makes a good embed thumbnail
#[derive(Debug, Default, Deserialize)]
pub struct MmrImages {
    #[serde(default)]
    pub large: String,
}
