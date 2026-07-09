/* db for discord user's riot accounts will be accounts.json storing something like:
  [
    {
      "discord_user_id": "123456789",
      "riot_id": "SummonerName#NA1",
      "puuid": null,
      "added_at": "2026-06-14T12:00:00Z"
    }
  ]
*/
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt::Formatter;
use std::fs;
use std::path::PathBuf;

// cap on remembered match ids per game; must exceed the largest match-list window
// the apis return (20 for match-v5, ~10 for henrik) so an id can't fall out of the
// ring while the api can still return it
pub const REPORTED_MATCH_CAP: usize = 30;

// remember a match id we've reported so later polls never report it again, even if
// the api temporarily omits newer matches from its response; keeps newest ids first
// and drops the oldest past REPORTED_MATCH_CAP. ids are stored lowercased and
// compared case-insensitively so a casing change in an api response can't cause a
// re-report; the ring is never used to build api requests, only for these checks
pub fn remember_match(reported: &mut Vec<String>, matchid: &str) {
    if contains_match(reported, matchid) {
        return;
    }
    reported.insert(0, matchid.to_ascii_lowercase());
    reported.truncate(REPORTED_MATCH_CAP);
}

pub fn contains_match(reported: &[String], matchid: &str) -> bool {
    reported.iter().any(|id| id.eq_ignore_ascii_case(matchid))
}

// last-seen league-v4 standing for one ranked queue, kept so the next ranked
// match report can show the LP gained/lost since this snapshot
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LolRankSnapshot {
    pub tier: String,
    // division within the tier: "I".."IV"
    pub division: String,
    pub league_points: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DatabaseAccount {
    pub discord_user_id: u64,
    pub discord_name: String,
    pub riot_name: String,
    pub riot_tag: String,
    pub val_puuid: String,
    pub val_region: Option<String>,
    // an empty ring means the account hasn't been baselined yet; the polling loop
    // seeds it with the current match window instead of reporting existing history
    #[serde(default)]
    pub reported_val_match_ids: Vec<String>,
    pub lol_puuid: String,
    pub lol_region: Option<String>,
    #[serde(default)]
    pub reported_lol_match_ids: Vec<String>,
    // keyed by league-v4 queue type ("RANKED_SOLO_5x5" / "RANKED_FLEX_SR");
    // additive field, so #[serde(default)] covers old files without a bump
    #[serde(default)]
    pub lol_rank_snapshots: std::collections::HashMap<String, LolRankSnapshot>,
    pub added_at: DateTime<Utc>,
}

#[derive(Debug)]
pub enum DbError {
    Io(std::io::Error),
    Serde(serde_json::Error),
    DuplicatePuuid { puuid: String },
    DuplicateDiscordUserId { discord_user_id: u64 },
    NotFound { discord_user_id: u64 },
    UnsupportedSchema { version: u32 },
}
impl From<std::io::Error> for DbError {
    fn from(err: std::io::Error) -> Self {
        DbError::Io(err)
    }
}
impl From<serde_json::Error> for DbError {
    fn from(err: serde_json::Error) -> Self {
        DbError::Serde(err)
    }
}
impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Io(e) => write!(f, "io error: {e}"),
            DbError::Serde(e) => write!(f, "json error: {e}"),
            DbError::DuplicateDiscordUserId { discord_user_id } => {
                write!(f, "discord account already tracked: {discord_user_id}")
            }
            DbError::DuplicatePuuid { puuid } => write!(f, "riot account already tracked: {puuid}"),
            DbError::NotFound { discord_user_id } => {
                write!(f, "discord account not found: {discord_user_id}")
            }
            DbError::UnsupportedSchema { version } => {
                write!(
                    f,
                    "db schema version {version} has no migration path to version {SCHEMA_VERSION}"
                )
            }
        }
    }
}
impl std::error::Error for DbError {}

// current on-disk schema version; bump this when making a breaking change to
// DatabaseAccount (rename/retype/restructure) and add a matching step in migrate().
// purely additive changes don't need a bump, #[serde(default)] on the new field
// covers those
const SCHEMA_VERSION: u32 = 1;

// on-disk envelope; accounts stay raw json here so old schema versions can be
// migrated before they ever have to fit the current DatabaseAccount shape
#[derive(Deserialize)]
struct DatabaseFile {
    schema_version: u32,
    accounts: Vec<serde_json::Value>,
}

// applies one step per pass until the data reaches SCHEMA_VERSION, rewriting the
// raw account values in place
fn migrate(
    version: u32,
    accounts: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, DbError> {
    if version > SCHEMA_VERSION {
        // file written by a newer build (e.g. after a rollback); refuse rather
        // than guess at fields we don't know about
        return Err(DbError::UnsupportedSchema { version });
    }

    for step in version..SCHEMA_VERSION {
        match step {
            // one arm per breaking change, rewriting from `step` to `step + 1`, e.g.:
            // 1 => accounts = accounts.into_iter().map(rename_puuid_fields).collect(),
            _ => return Err(DbError::UnsupportedSchema { version: step }),
        }
    }

    Ok(accounts)
}

pub struct Database {
    path: PathBuf,
    accounts: Vec<DatabaseAccount>,
}
impl Database {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, DbError> {
        let path = path.into();

        let accounts = if path.exists() {
            let contents = fs::read_to_string(&path)?;
            let value: serde_json::Value = serde_json::from_str(&contents)?;

            // files predating the versioned envelope are a bare account array,
            // which is schema version 1 by definition
            let file = match value {
                serde_json::Value::Array(accounts) => DatabaseFile {
                    schema_version: 1,
                    accounts,
                },
                value => serde_json::from_value(value)?,
            };

            migrate(file.schema_version, file.accounts)?
                .into_iter()
                .map(|account| Ok(serde_json::from_value(account)?))
                .collect::<Result<Vec<DatabaseAccount>, DbError>>()?
        } else {
            Vec::new()
        };

        Ok(Self { path, accounts })
    }

    // rewrite all contents into temp file first in case of runtime errors during file
    pub fn save(&self) -> Result<(), DbError> {
        let contents = serde_json::to_string_pretty(&serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "accounts": self.accounts,
        }))?;
        let tmp_path = &self.path.with_extension("json.tmp");

        fs::write(&tmp_path, contents)?;
        fs::rename(tmp_path, &self.path)?;

        Ok(())
    }

    // add new discord/riot account to db
    pub fn add_account(&mut self, account: DatabaseAccount) -> Result<(), DbError> {
        // no dupe discord users
        let already_tracked_puuid = self
            .accounts
            .iter()
            .any(|acct| acct.discord_user_id == account.discord_user_id);
        if already_tracked_puuid {
            return Err(DbError::DuplicateDiscordUserId {
                discord_user_id: account.discord_user_id,
            });
        }

        // no dupe valorant users (empty puuid means no valorant account, so never a dupe)
        let already_tracked_val_puuid = !account.val_puuid.is_empty()
            && self
                .accounts
                .iter()
                .any(|acct| acct.val_puuid == account.val_puuid);
        if already_tracked_val_puuid {
            return Err(DbError::DuplicatePuuid {
                puuid: account.val_puuid,
            });
        }

        // no dupe lol users (empty puuid means no lol account, so never a dupe)
        let already_tracked_lol_puuid = !account.lol_puuid.is_empty()
            && self
                .accounts
                .iter()
                .any(|acct| acct.lol_puuid == account.lol_puuid);
        if already_tracked_lol_puuid {
            return Err(DbError::DuplicatePuuid {
                puuid: account.lol_puuid,
            });
        }

        self.accounts.push(account);
        self.save()
    }

    // remove all disord user's data from db
    pub fn delete_account(&mut self, discord_user_id: u64) -> Result<(), DbError> {
        let index = self
            .accounts
            .iter()
            .position(|acct| acct.discord_user_id == discord_user_id);

        match index {
            Some(i) => {
                self.accounts.remove(i);
                self.save()
            }
            None => Err(DbError::NotFound { discord_user_id }),
        }
    }

    pub fn get_accounts(&self) -> Vec<DatabaseAccount> {
        self.accounts.clone()
    }

    // overwrite an existing account's data, matched by discord_user_id
    pub fn update_account(&mut self, account: DatabaseAccount) -> Result<(), DbError> {
        let index = self
            .accounts
            .iter()
            .position(|acct| acct.discord_user_id == account.discord_user_id);

        match index {
            Some(i) => {
                self.accounts[i] = account;
                self.save()
            }
            None => Err(DbError::NotFound {
                discord_user_id: account.discord_user_id,
            }),
        }
    }
}
