//! Versioned reading habits. Grow-only source counters and award identities make replay safe.
use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RhythmError {
    InvalidDate,
    UnsupportedVersion,
    ReadingBeforeActivation,
    InvalidCounter,
    InvalidGoal,
    InvalidAward,
}

impl std::fmt::Display for RhythmError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDate => "Invalid reading date",
            Self::UnsupportedVersion => "Unsupported reading rhythm version",
            Self::ReadingBeforeActivation => "Reading predates activation",
            Self::InvalidCounter => "Invalid reading counter",
            Self::InvalidGoal => "Invalid weekly goal",
            Self::InvalidAward => "Invalid reading award",
        })
    }
}
impl std::error::Error for RhythmError {}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RhythmState {
    pub version: u8,
    pub activated_on: Box<str>,
    pub days: BTreeMap<Box<str>, BTreeMap<Box<str>, u32>>,
    pub goals: BTreeMap<Box<str>, Goal>,
    pub awards: BTreeMap<Box<str>, u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Goal {
    pub stamp: Box<str>,
    pub id: Box<str>,
    pub days: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingCounter {
    pub date: Box<str>,
    pub source: Box<str>,
    pub seconds: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyReadingDay {
    pub date: Box<str>,
    pub minutes: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RhythmRequest {
    pub today: Box<str>,
    pub state: Option<RhythmState>,
    pub incoming: Option<RhythmState>,
    pub goal: Option<Goal>,
    pub reading: Option<ReadingCounter>,
    #[serde(default)]
    pub legacy_activity: Vec<LegacyReadingDay>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmProgress {
    pub state: RhythmState,
    pub week_start: Box<str>,
    pub week_end: Box<str>,
    pub qualifying_days: u8,
    pub target_days: u8,
    pub next_target_days: u8,
    pub today_seconds: u32,
    pub xp: u32,
    pub level: u32,
}

fn date(key: &str) -> Result<NaiveDate, RhythmError> {
    let parsed =
        NaiveDate::parse_from_str(key, "%Y-%m-%d").map_err(|_| RhythmError::InvalidDate)?;
    if parsed.format("%Y-%m-%d").to_string() != key || !(1..=9999).contains(&parsed.year()) {
        return Err(RhythmError::InvalidDate);
    }
    Ok(parsed)
}

fn week(day: NaiveDate) -> NaiveDate {
    day - Duration::days(i64::from(day.weekday().num_days_from_monday()))
}

fn key(day: NaiveDate) -> Box<str> {
    day.format("%Y-%m-%d").to_string().into_boxed_str()
}

fn target(state: &RhythmState, start: &str) -> u8 {
    state
        .goals
        .range(..=Box::<str>::from(start))
        .next_back()
        .map_or(0, |(_, goal)| goal.days)
}

fn seconds(sources: &BTreeMap<Box<str>, u32>) -> u32 {
    // The legacy marker is a lower bound, not another independent reader.
    let recorded = sources
        .iter()
        .filter(|(source, _)| source.as_ref() != "legacy-daily-activity")
        .fold(0_u32, |total, (_, value)| total.saturating_add(*value));
    recorded
        .max(sources.get("legacy-daily-activity").copied().unwrap_or(0))
        .min(86_400)
}

fn valid_goal(goal: &Goal) -> bool {
    goal.days <= 7
        && !goal.id.is_empty()
        && goal.id.len() <= 128
        && chrono::DateTime::parse_from_rfc3339(&goal.stamp).is_ok_and(|stamp| {
            stamp
                .to_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                == goal.stamp.as_ref()
        })
}

fn validate(state: &RhythmState) -> Result<(), RhythmError> {
    if state.version != 1 {
        return Err(RhythmError::UnsupportedVersion);
    }
    date(&state.activated_on)?;
    for (day, sources) in &state.days {
        date(day)?;
        if day < &state.activated_on {
            return Err(RhythmError::ReadingBeforeActivation);
        }
        for (source, value) in sources {
            if source.is_empty() || source.len() > 128 || *value > 86_400 {
                return Err(RhythmError::InvalidCounter);
            }
        }
    }
    for (start, goal) in &state.goals {
        if week(date(start)?) != date(start)? || !valid_goal(goal) {
            return Err(RhythmError::InvalidGoal);
        }
    }
    for (award, value) in &state.awards {
        if let Some(day) = award.strip_prefix("day:") {
            date(day)?;
            if *value != 10
                || day < state.activated_on.as_ref()
                || state.days.get(day).map_or(0, seconds) < 300
            {
                return Err(RhythmError::InvalidAward);
            }
        } else if let Some(start) = award.strip_prefix("week:") {
            if week(date(start)?) != date(start)?
                || *value != 20
                || date(start)? < week(date(&state.activated_on)?)
            {
                return Err(RhythmError::InvalidAward);
            }
        } else {
            return Err(RhythmError::InvalidAward);
        }
    }
    Ok(())
}

/// Evaluate locally or merge a peer state. Counters merge by max per source, awards by union.
/// Simultaneous reading on separate devices is additive, capped at one day of time per date.
/// Award amounts are fixed for version 1 and cannot be supplied as arbitrary peer XP totals.
pub fn evaluate(request: RhythmRequest) -> Result<RhythmProgress, RhythmError> {
    let today = date(&request.today)?;
    date(&key(today + Duration::days(13)))?;
    let mut state = request.state.unwrap_or_else(|| RhythmState {
        version: 1,
        activated_on: request.today.clone(),
        ..Default::default()
    });
    validate(&state)?;
    if !request.legacy_activity.is_empty() {
        let oldest = request
            .legacy_activity
            .iter()
            .map(|day| day.date.as_ref())
            .min();
        if let Some(oldest) = oldest {
            date(oldest)?;
            state.activated_on = state.activated_on.min(oldest.to_owned().into_boxed_str());
        }
        for activity in request.legacy_activity {
            date(&activity.date)?;
            if activity.date < state.activated_on
                || !activity.minutes.is_finite()
                || activity.minutes > 1440.0
                || activity.minutes < 0.0
            {
                return Err(RhythmError::InvalidCounter);
            }
            // Legacy time can overlap native source counters. Only import a
            // qualifying-day marker: it cannot manufacture a threshold crossing
            // from two overlapping sub-threshold histories on different peers.
            if activity.minutes >= 5.0 && activity.date.as_ref() <= request.today.as_ref() {
                state
                    .days
                    .entry(activity.date)
                    .or_default()
                    .insert("legacy-daily-activity".into(), 300);
            }
        }
    }
    validate(&state)?;
    if let Some(incoming) = request.incoming {
        validate(&incoming)?;
        state.activated_on = state.activated_on.min(incoming.activated_on);
        for (day, sources) in incoming.days {
            let local = state.days.entry(day).or_default();
            for (source, count) in sources {
                let value = local.entry(source).or_default();
                *value = (*value).max(count);
            }
        }
        for (start, goal) in incoming.goals {
            let entry = state.goals.entry(start).or_insert_with(|| goal.clone());
            if goal > *entry {
                *entry = goal;
            }
        }
        state.awards.extend(incoming.awards);
    }
    let start = week(today);
    if let Some(goal) = request.goal {
        if !valid_goal(&goal) {
            return Err(RhythmError::InvalidGoal);
        }
        let effective = if state.goals.is_empty() {
            start
        } else {
            start + Duration::days(7)
        };
        let entry = state
            .goals
            .entry(key(effective))
            .or_insert_with(|| goal.clone());
        if goal > *entry {
            *entry = goal;
        }
    }
    if let Some(reading) = request.reading {
        date(&reading.date)?;
        if reading.source.is_empty() || reading.source.len() > 128 || reading.seconds > 86_400 {
            return Err(RhythmError::InvalidCounter);
        }
        // Travel or a clock correction may move the local date backwards. These
        // are newly recorded counters, not a backfill from legacy statistics.
        state.activated_on = state.activated_on.min(reading.date.clone());
        let value = state
            .days
            .entry(reading.date)
            .or_default()
            .entry(reading.source)
            .or_default();
        *value = (*value).max(reading.seconds);
    }
    let mut weeks: BTreeMap<Box<str>, u8> = BTreeMap::new();
    for (day, sources) in &state.days {
        if seconds(sources) >= 300 {
            state
                .awards
                .insert(format!("day:{day}").into_boxed_str(), 10);
            *weeks.entry(key(week(date(day)?))).or_default() += 1;
        }
    }
    for (start, count) in &weeks {
        let goal = target(&state, start);
        if goal > 0 && *count >= goal {
            state
                .awards
                .insert(format!("week:{start}").into_boxed_str(), 20);
        }
    }
    let start_key = key(start);
    let xp = state
        .awards
        .values()
        .fold(0_u32, |sum, value| sum.saturating_add(*value));
    Ok(RhythmProgress {
        qualifying_days: weeks.get(&start_key).copied().unwrap_or(0),
        target_days: target(&state, &start_key),
        next_target_days: target(&state, &key(start + Duration::days(7))),
        today_seconds: state.days.get(&request.today).map_or(0, seconds),
        week_start: start_key,
        week_end: key(start + Duration::days(6)),
        xp,
        level: 1 + xp / 100,
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(value: serde_json::Value) -> RhythmRequest {
        serde_json::from_value(value).unwrap()
    }
    fn goal() -> serde_json::Value {
        serde_json::json!({"stamp":"2026-10-26T00:00:00.000Z", "id":"a", "days":4})
    }

    #[test]
    fn legacy_activity_accepts_fractional_minutes_and_book_metadata() {
        let activity: Vec<_> = (26..=31)
            .map(|day| {
                serde_json::json!({
                    "date":format!("2026-10-{day}"),"minutes":5.5,"booksRead":["book"]
                })
            })
            .collect();
        let progress = evaluate(request(serde_json::json!({
            "today":"2026-10-31", "legacyActivity":activity
        })))
        .unwrap();
        assert_eq!(progress.xp, 60);
        assert_eq!(progress.qualifying_days, 6);
        assert_eq!(progress.state.activated_on.as_ref(), "2026-10-26");
    }

    #[test]
    fn legacy_days_backfill_existing_rhythm_without_duplicate_awards() {
        let initial = evaluate(request(
            serde_json::json!({"today":"2026-10-31","goal":goal()}),
        ))
        .unwrap();
        let activity: Vec<_> = (26..=31)
            .map(|day| {
                serde_json::json!({
                    "date":format!("2026-10-{day}"),"minutes":5.5,"booksRead":["book"]
                })
            })
            .collect();
        let migrated = evaluate(request(serde_json::json!({
            "today":"2026-10-31","state":initial.state,"legacyActivity":activity,
            "reading":{"date":"2026-10-31","source":"reader","seconds":300}
        })))
        .unwrap();
        assert_eq!(migrated.xp, 80);
        assert_eq!(migrated.today_seconds, 300);
        let replay = evaluate(request(serde_json::json!({
            "today":"2026-10-31","state":migrated.state,"incoming":migrated.state,"legacyActivity":activity
        }))).unwrap();
        assert_eq!(replay.xp, 80);
        assert_eq!(replay.today_seconds, 300);
    }

    #[test]
    fn threshold_replay_and_weekly_bonus() {
        let mut state = evaluate(request(
            serde_json::json!({"today":"2026-10-26","goal":goal()}),
        ))
        .unwrap()
        .state;
        for day in 26..=29 {
            for count in [299, 300, 300] {
                state = evaluate(request(serde_json::json!({"today":format!("2026-10-{day}"),"state":state,"reading":{"date":format!("2026-10-{day}"),"source":"a","seconds":count}}))).unwrap().state;
            }
        }
        let progress = evaluate(request(
            serde_json::json!({"today":"2026-10-29","state":state}),
        ))
        .unwrap();
        assert_eq!(progress.xp, 60);
        assert_eq!(progress.qualifying_days, 4);
        assert_eq!(progress.state.awards.len(), 5);
    }

    #[test]
    fn merging_sources_is_commutative_and_idempotent() {
        let a = evaluate(request(serde_json::json!({"today":"2026-10-31","goal":goal(),"reading":{"date":"2026-10-31","source":"a","seconds":180}}))).unwrap().state;
        let b = evaluate(request(serde_json::json!({"today":"2026-10-31","goal":goal(),"reading":{"date":"2026-10-31","source":"b","seconds":120}}))).unwrap().state;
        let ab = evaluate(request(
            serde_json::json!({"today":"2026-10-31","state":a,"incoming":b}),
        ))
        .unwrap();
        let ba = evaluate(request(
            serde_json::json!({"today":"2026-10-31","state":b,"incoming":a}),
        ))
        .unwrap();
        assert_eq!(ab.state, ba.state);
        assert_eq!(ab.xp, 10);
        let replay = evaluate(request(
            serde_json::json!({"today":"2026-10-31","state":ab.state,"incoming":a}),
        ))
        .unwrap();
        assert_eq!(replay.state, ba.state);
    }

    #[test]
    fn goal_edits_apply_next_week_and_xp_survives_missing_weeks() {
        let initial = evaluate(request(serde_json::json!({"today":"2026-12-31","goal":goal(),"reading":{"date":"2026-12-31","source":"a","seconds":300}}))).unwrap();
        let changed = evaluate(request(serde_json::json!({"today":"2026-12-31","state":initial.state,"goal":{"days":1,"stamp":"2026-12-31T01:00:00.000Z","id":"b"}}))).unwrap();
        assert_eq!((changed.target_days, changed.next_target_days), (4, 1));
        let later = evaluate(request(
            serde_json::json!({"today":"2027-01-20","state":changed.state}),
        ))
        .unwrap();
        assert_eq!(later.xp, 10);
        assert_eq!(later.qualifying_days, 0);
    }

    #[test]
    fn invalid_dates_versions_and_counters_are_rejected() {
        for day in ["2026-02-30", "2026-1-01", "", "9999-12-31"] {
            assert!(evaluate(request(serde_json::json!({"today":day}))).is_err());
        }
        for counter in [
            serde_json::json!({"date":"2026-10-31","source":"","seconds":1}),
            serde_json::json!({"date":"2026-10-31","source":"a","seconds":86401}),
        ] {
            assert!(evaluate(request(
                serde_json::json!({"today":"2026-10-31","reading":counter})
            ))
            .is_err());
        }
        let mut state = evaluate(request(serde_json::json!({"today":"2026-10-31"})))
            .unwrap()
            .state;
        state.version = 2;
        assert!(evaluate(request(
            serde_json::json!({"today":"2026-10-31","state":state})
        ))
        .is_err());
    }

    #[test]
    fn epoch_week_round_trips_and_corrupted_awards_are_rejected() {
        let initial = evaluate(request(
            serde_json::json!({"today":"1970-01-01","goal":goal()}),
        ))
        .unwrap();
        let restored = evaluate(request(
            serde_json::json!({"today":"1970-01-01","state":initial.state}),
        ))
        .unwrap();
        assert_eq!(restored.week_start.as_ref(), "1969-12-29");
        let mut corrupt = restored.state;
        corrupt.awards.insert("day:1970-01-01".into(), 10);
        assert_eq!(
            evaluate(request(
                serde_json::json!({"today":"1970-01-01","state":corrupt})
            ))
            .unwrap_err(),
            RhythmError::InvalidAward
        );
    }

    #[test]
    fn reading_after_travel_or_clock_correction_keeps_earlier_local_day() {
        let initial = evaluate(request(
            serde_json::json!({"today":"2026-11-01","goal":goal()}),
        ))
        .unwrap();
        let earlier = evaluate(request(
            serde_json::json!({"today":"2026-10-31","state":initial.state,
            "reading":{"date":"2026-10-31","source":"travel","seconds":300}}),
        ))
        .unwrap();
        assert_eq!(earlier.state.activated_on.as_ref(), "2026-10-31");
        assert_eq!(earlier.state.awards.get("day:2026-10-31"), Some(&10));
    }

    #[test]
    fn disabled_goals_do_not_award_weekly_bonus_and_level_boundary_is_exact() {
        let mut state = evaluate(request(
            serde_json::json!({"today":"2026-10-01","goal":{"days":0,"stamp":"2026-10-01T00:00:00.000Z","id":"a"}}),
        ))
        .unwrap()
        .state;
        for day in 1..=10 {
            state = evaluate(request(serde_json::json!({"today":format!("2026-10-{day:02}"),"state":state,"reading":{"date":format!("2026-10-{day:02}"),"source":"a","seconds":300}}))).unwrap().state;
        }
        let progress = evaluate(request(
            serde_json::json!({"today":"2026-10-10","state":state}),
        ))
        .unwrap();
        assert_eq!((progress.xp, progress.level), (100, 2));
        assert_eq!(progress.target_days, 0);
    }
}
