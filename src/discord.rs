use crate::riot_api::{lol, valorant};
use serenity::builder::CreateEmbed;
use std::collections::HashMap;

// shared shape both games get adapted into, so the leaderboard
// formatting logic only has to be written once
pub struct PlayerLine {
    pub riot_name: String,
    pub riot_tag: String,
    pub character: String,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    // per-game extra stats, already formatted (e.g. "231 ACS · 28% HS")
    pub stat: Option<String>,
    // rare feats worth calling out on the row (e.g. "🔥 Penta Kill")
    pub flair: Option<String>,
    // ranked standing/change, present only for tracked users
    pub rank: Option<String>,
    // descending leaderboard order within the team (ACS for valorant, KDA for lol)
    pub sort_key: f64,
    pub is_tracked_user: bool,
}

pub struct MatchResult {
    pub game_name: &'static str,
    pub game_mode: String,
    pub map: Option<String>,
    pub duration_secs: Option<u64>,
    // unix seconds; rendered as a discord timestamp so every viewer sees their local time
    pub start_epoch_secs: Option<u64>,
    pub round_score: Option<(u32, u32)>,
    // whether the first tracked user's team won; None for modes with no team win
    pub won: Option<bool>,
    pub surrendered: bool,
    pub thumbnail_url: Option<String>,
    pub own_team: Vec<PlayerLine>,
    pub enemy_team: Vec<PlayerLine>,
}

// ranked standing fetched separately from the match itself (mmr-history for
// valorant, league-v4 for lol); keyed by puuid in the maps the adapters take
pub struct RankUpdate {
    // RR/LP this match gained or lost; None when unknown (first snapshot, or a
    // promotion/demotion made the LP numbers incomparable)
    pub delta: Option<i32>,
    // rank after the match, e.g. "Gold 1" or "Emerald II"
    pub current: Option<String>,
    // "RR" for valorant, "LP" for lol
    pub unit: &'static str,
}

fn format_rank_update(update: &RankUpdate) -> Option<String> {
    match (update.delta, update.current.as_deref()) {
        (Some(delta), Some(current)) => {
            Some(format!("{:+} {} ({})", delta, update.unit, current))
        }
        (Some(delta), None) => Some(format!("{:+} {}", delta, update.unit)),
        (None, Some(current)) => Some(current.to_string()),
        (None, None) => None,
    }
}

pub fn val_match_to_result(
    match_summary: &valorant::MatchSummary,
    tracked_puuids: &[&str],
    rank_updates: &HashMap<String, RankUpdate>,
) -> MatchResult {
    // tracked users may end up on both sides; the first one's team is "own"
    let tracked_team = tracked_puuids.iter().find_map(|puuid| {
        match_summary
            .players
            .all_players
            .iter()
            .find(|p| &p.puuid == puuid)
            .map(|p| p.team.clone())
    });

    let (own_team, enemy_team): (Vec<_>, Vec<_>) = match_summary
        .players
        .all_players
        .iter()
        .partition(|p| Some(&p.team) == tracked_team.as_ref());

    let rounds_played = match_summary.metadata.rounds_played.max(1);
    let to_line = |p: &valorant::MatchPlayer| {
        let acs = p.stats.score / rounds_played;
        let shots = p.stats.headshots + p.stats.bodyshots + p.stats.legshots;
        let stat = if shots > 0 {
            format!("{} ACS · {}% HS", acs, p.stats.headshots * 100 / shots)
        } else {
            format!("{} ACS", acs)
        };

        PlayerLine {
            riot_name: p.name.clone(),
            riot_tag: p.tag.clone(),
            character: p.character.clone(),
            kills: p.stats.kills,
            deaths: p.stats.deaths,
            assists: p.stats.assists,
            stat: Some(stat),
            flair: None,
            rank: rank_updates.get(&p.puuid).and_then(format_rank_update),
            sort_key: acs as f64,
            is_tracked_user: tracked_puuids.contains(&p.puuid.as_str()),
        }
    };

    // free-for-all modes (deathmatch) have no team results at all
    let tracked_team_stats = tracked_team.as_deref().and_then(|team| {
        if team.eq_ignore_ascii_case("red") {
            match_summary.teams.red.as_ref()
        } else {
            match_summary.teams.blue.as_ref()
        }
    });

    // the first tracked player's agent portrait, from henrik's bundled asset urls
    let thumbnail_url = tracked_puuids
        .iter()
        .find_map(|puuid| {
            match_summary
                .players
                .all_players
                .iter()
                .find(|p| &p.puuid == puuid)
        })
        .map(|p| p.assets.agent.small.clone())
        .filter(|url| !url.is_empty());

    MatchResult {
        game_name: "Valorant",
        game_mode: match_summary.metadata.mode.clone(),
        map: Some(match_summary.metadata.map.clone()),
        duration_secs: Some(match_summary.metadata.game_length),
        // a defaulted game_start would render as 1970; omit the line instead
        start_epoch_secs: (match_summary.metadata.game_start > 0)
            .then_some(match_summary.metadata.game_start),
        round_score: tracked_team_stats.map(|s| (s.rounds_won, s.rounds_lost)),
        won: tracked_team_stats.and_then(|s| s.has_won),
        surrendered: false,
        thumbnail_url,
        own_team: own_team.into_iter().map(to_line).collect(),
        enemy_team: enemy_team.into_iter().map(to_line).collect(),
    }
}

pub fn lol_match_to_result(
    match_summary: &lol::MatchSummary,
    tracked_puuids: &[&str],
    rank_updates: &HashMap<String, RankUpdate>,
) -> MatchResult {
    // tracked users may end up on both sides; the first one's team is "own"
    let tracked_team_id = tracked_puuids.iter().find_map(|puuid| {
        match_summary
            .info
            .participants
            .iter()
            .find(|p| &p.puuid == puuid)
            .map(|p| p.team_id)
    });

    let (own_team, enemy_team): (Vec<_>, Vec<_>) = match_summary
        .info
        .participants
        .iter()
        .partition(|p| Some(p.team_id) == tracked_team_id);

    let to_line = |p: &lol::MatchParticipant| {
        let cs = p.total_minions_killed + p.neutral_minions_killed;
        let flair = match p.largest_multi_kill {
            5.. => Some("🔥 Penta Kill".to_string()),
            4 => Some("Quadra Kill".to_string()),
            _ => None,
        };

        PlayerLine {
            riot_name: p.riot_id_game_name.clone(),
            riot_tag: p.riot_id_tagline.clone(),
            character: p.champion_name.clone(),
            kills: p.kills,
            deaths: p.deaths,
            assists: p.assists,
            stat: Some(format!(
                "{} CS · {} dmg",
                cs,
                format_compact(p.total_damage_dealt_to_champions)
            )),
            flair,
            rank: rank_updates.get(&p.puuid).and_then(format_rank_update),
            sort_key: (p.kills + p.assists) as f64 / p.deaths.max(1) as f64,
            is_tracked_user: tracked_puuids.contains(&p.puuid.as_str()),
        }
    };

    let first_own = own_team.first();

    // the first tracked player's champion icon; community dragon serves these
    // keyless by champion name
    let thumbnail_url = tracked_puuids
        .iter()
        .find_map(|puuid| {
            match_summary
                .info
                .participants
                .iter()
                .find(|p| &p.puuid == puuid)
        })
        .map(|p| {
            format!(
                "https://cdn.communitydragon.org/latest/champion/{}/square",
                p.champion_name
            )
        });

    MatchResult {
        game_name: "League of Legends",
        game_mode: queue_label(match_summary.info.queue_id, &match_summary.info.game_mode),
        map: None,
        duration_secs: Some(match_summary.info.game_duration),
        start_epoch_secs: Some(match_summary.info.game_start_timestamp / 1000),
        round_score: None,
        won: first_own.map(|p| p.win),
        surrendered: first_own.is_some_and(|p| p.game_ended_in_surrender),
        thumbnail_url,
        own_team: own_team.iter().map(|p| to_line(p)).collect(),
        enemy_team: enemy_team.iter().map(|p| to_line(p)).collect(),
    }
}

// queue ids name the playlist far better than game_mode ("CLASSIC") can;
// unknown ids fall back to the raw mode string
fn queue_label(queue_id: u32, game_mode: &str) -> String {
    let label = match queue_id {
        400 => "Normal Draft",
        420 => "Ranked Solo/Duo",
        430 => "Normal Blind",
        440 => "Ranked Flex",
        450 => "ARAM",
        480 => "Swiftplay",
        490 => "Quickplay",
        700 => "Clash",
        830..=890 => "Co-op vs AI",
        900 | 1900 => "URF",
        1020 => "One for All",
        1300 => "Nexus Blitz",
        1700 | 1710 => "Arena",
        _ => return game_mode.to_string(),
    };
    label.to_string()
}

pub fn build_match_embed(discord_names: &[&str], result: &MatchResult) -> CreateEmbed {
    let (verdict, color) = match result.won {
        Some(true) => ("Victory", 0x57F287),  // discord green
        Some(false) => ("Defeat", 0xED4245),  // discord red
        None => ("Match complete", 0x95A5A6), // neutral gray
    };

    let mut title = format!("{} — {}", verdict, result.game_mode);
    if let Some(map) = &result.map {
        title.push_str(&format!(" · {}", map));
    }

    let mut info_parts = Vec::new();
    if let Some(start) = result.start_epoch_secs {
        // <t:...:t> renders in each viewer's local timezone
        info_parts.push(format!("Started <t:{}:t>", start));
    }
    if let Some(duration_secs) = result.duration_secs {
        let mut duration = format_duration(duration_secs);
        if result.surrendered {
            duration.push_str(" (surrender)");
        }
        info_parts.push(duration);
    }
    if let Some((rounds_won, rounds_lost)) = result.round_score {
        info_parts.push(format!("{}–{}", rounds_won, rounds_lost));
    }

    // free-for-all modes put everyone on one side; skip the empty block
    let leaderboards: Vec<String> = [&result.own_team, &result.enemy_team]
        .into_iter()
        .filter(|team| !team.is_empty())
        .map(|team| format_leaderboard(team))
        .collect();

    let description = format!(
        "{} just finished a **{}** game\n{}\n\n{}",
        format_name_list(discord_names),
        result.game_name,
        info_parts.join(" · "),
        leaderboards.join("\n\n"),
    );

    let mut embed = CreateEmbed::new()
        .title(title)
        .description(description)
        .colour(color);
    if let Some(url) = &result.thumbnail_url {
        embed = embed.thumbnail(url);
    }
    embed
}

// "**A**", "**A** and **B**", "**A**, **B** and **C**", ...
fn format_name_list(names: &[&str]) -> String {
    let bolded: Vec<String> = names.iter().map(|name| format!("**{}**", name)).collect();

    match bolded.split_last() {
        Some((last, rest)) if !rest.is_empty() => {
            format!("{} and {}", rest.join(", "), last)
        }
        _ => bolded.concat(),
    }
}

fn format_leaderboard(players: &[PlayerLine]) -> String {
    let mut sorted: Vec<&PlayerLine> = players.iter().collect();
    sorted.sort_by(|a, b| b.sort_key.partial_cmp(&a.sort_key).unwrap());

    sorted
        .into_iter()
        .map(|p| {
            let name = format!("{}#{}", p.riot_name, p.riot_tag);
            let name = if p.is_tracked_user {
                format!("**{}**", name)
            } else {
                name
            };

            let mut line = format!(
                "{} ({}) {}/{}/{}",
                name, p.character, p.kills, p.deaths, p.assists
            );
            for extra in [&p.stat, &p.rank, &p.flair].into_iter().flatten() {
                line.push_str(&format!(" · {}", extra));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_compact(n: u32) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

fn format_duration(total_secs: u64) -> String {
    format!("{}m {}s", total_secs / 60, total_secs % 60)
}
