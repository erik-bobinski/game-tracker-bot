pub mod pause;
pub mod rank_check;
pub mod resume;
pub mod signout;
pub mod signup;

use crate::types::{Data, Error};

pub fn all() -> Vec<poise::Command<Data, Error>> {
    vec![
        signup::signup(),
        signout::signout(),
        pause::pause(),
        resume::resume(),
        rank_check::rank_check(),
    ]
}
