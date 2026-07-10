use serde::Deserialize;

// Match-V5 continental routing values. A player's account lives behind
// exactly one of these; there's no way to know which without asking or probing.
const MATCH_REGIONS: [&str; 4] = ["americas", "asia", "europe", "sea"];

// League-V4 platform hosts grouped by the continental cluster they route
// through, so a continental region (the only region a stored account carries)
// can be probed for the platform it actually belongs to.
const PLATFORMS_BY_CONTINENT: [(&str, &[&str]); 4] = [
    ("americas", &["na1", "br1", "la1", "la2"]),
    ("asia", &["kr", "jp1"]),
    ("europe", &["euw1", "eun1", "tr1", "ru"]),
    ("sea", &["oc1", "ph2", "sg2", "th2", "tw2", "vn2"]),
];

pub struct RiotClient {
    http: reqwest::Client,
    api_key: String,
}
impl RiotClient {
    pub fn new(api_key: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key,
        }
    }

    // Account-V1 can be queried from any regional cluster for any account,
    // so we always route through the cluster nearest our deployment (Virginia).
    pub async fn get_account(&self, name: &str, tag: &str) -> Result<AccountData, reqwest::Error> {
        let url = format!(
            "https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{}/{}",
            name, tag
        );

        self.http
            .get(url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await?
            .json::<AccountData>()
            .await
    }

    pub async fn get_match_ids(
        &self,
        puuid: &str,
        region: &str,
    ) -> Result<Vec<String>, reqwest::Error> {
        let url = format!(
            "https://{}.api.riotgames.com/lol/match/v5/matches/by-puuid/{}/ids",
            region, puuid
        );

        self.http
            .get(url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await?
            .json::<Vec<String>>()
            .await
    }

    pub async fn get_match(
        &self,
        match_id: &str,
        region: &str,
    ) -> Result<MatchSummary, reqwest::Error> {
        let url = format!(
            "https://{}.api.riotgames.com/lol/match/v5/matches/{}",
            region, match_id
        );

        self.http
            .get(url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await?
            .json::<MatchSummary>()
            .await
    }

    pub async fn get_matches(
        &self,
        puuid: &str,
        region: &str,
    ) -> Result<Vec<MatchSummary>, reqwest::Error> {
        let match_ids = self.get_match_ids(puuid, region).await?;

        let mut matches = Vec::with_capacity(match_ids.len());
        for match_id in match_ids {
            matches.push(self.get_match(&match_id, region).await?);
        }

        Ok(matches)
    }

    // League-V4 is platform-routed (na1, euw1, ...) rather than continental;
    // callers get the platform from the match they're reporting (info.platform_id)
    pub async fn get_league_entries(
        &self,
        puuid: &str,
        platform: &str,
    ) -> Result<Vec<LeagueEntry>, reqwest::Error> {
        let url = format!(
            "https://{}.api.riotgames.com/lol/league/v4/entries/by-puuid/{}",
            platform, puuid
        );

        self.http
            .get(url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await?
            .json::<Vec<LeagueEntry>>()
            .await
    }

    // League-v4 is platform-routed and a stored account only knows its
    // continental region (never a match's platform_id), so this probes each
    // platform in that continent until one accepts the puuid. Returns None if
    // the account doesn't belong to any known platform in the continent.
    pub async fn find_league_entries(
        &self,
        puuid: &str,
        continental_region: &str,
    ) -> Result<Option<(String, Vec<LeagueEntry>)>, reqwest::Error> {
        let platforms = PLATFORMS_BY_CONTINENT
            .iter()
            .find(|(region, _)| *region == continental_region)
            .map(|(_, platforms)| *platforms)
            .unwrap_or(&[]);

        for platform in platforms {
            let url = format!(
                "https://{}.api.riotgames.com/lol/league/v4/entries/by-puuid/{}",
                platform, puuid
            );
            let response = self
                .http
                .get(url)
                .header("X-Riot-Token", &self.api_key)
                .send()
                .await?;

            if response.status().is_success() {
                let entries = response.json::<Vec<LeagueEntry>>().await?;
                return Ok(Some((platform.to_string(), entries)));
            }
        }

        Ok(None)
    }

    // Unlike account-v1, match-v5 results only come back non-empty from the
    // continental cluster the account's platform actually belongs to, so we
    // have to probe each one. Returns None if the account has no match history
    // in any cluster yet (nothing to detect from).
    pub async fn detect_region(&self, puuid: &str) -> Result<Option<String>, reqwest::Error> {
        for region in MATCH_REGIONS {
            let match_ids = self.get_match_ids(puuid, region).await?;
            if !match_ids.is_empty() {
                return Ok(Some(region.to_string()));
            }
        }

        Ok(None)
    }
}

// response from /riot/account/v1/accounts/by-riot-id/{name}/{tag}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountData {
    pub puuid: String,
    pub game_name: String,
    pub tag_line: String,
}

// response from /lol/match/v5/matches/{matchId}
#[derive(Debug, Deserialize)]
pub struct MatchSummary {
    pub metadata: MatchMetadata,
    pub info: MatchInfo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchMetadata {
    pub match_id: String,
    pub participants: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchInfo {
    pub game_mode: String,
    pub game_duration: u64,
    // epoch millis when the game started
    pub game_start_timestamp: u64,
    // distinguishes ranked solo vs flex vs normals, which game_mode can't
    pub queue_id: u32,
    pub platform_id: String,
    pub participants: Vec<MatchParticipant>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchParticipant {
    pub puuid: String,
    pub riot_id_game_name: String,
    pub riot_id_tagline: String,
    pub team_id: u32,
    pub champion_name: String,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub win: bool,
    pub total_minions_killed: u32,
    pub neutral_minions_killed: u32,
    pub total_damage_dealt_to_champions: u32,
    pub largest_multi_kill: u32,
    #[serde(default)]
    pub game_ended_in_surrender: bool,
}

// entry from /lol/league/v4/entries/by-puuid/{puuid}; one per ranked queue
// the player has placed in this season
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeagueEntry {
    // "RANKED_SOLO_5x5" or "RANKED_FLEX_SR"
    pub queue_type: String,
    pub tier: String,
    // division within the tier: "I".."IV"
    pub rank: String,
    pub league_points: i32,
}
