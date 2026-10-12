//! Dynamic shelf membership; definitions are persisted, results are derived.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub field: Field,
    pub operator: Operator,
    pub value: Box<str>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    Author,
    Series,
    Tag,
    Category,
    Format,
    Status,
    Favorite,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Operator {
    Equals,
    Contains,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchMode {
    All,
    Any,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Definition {
    pub mode: MatchMode,
    pub conditions: Box<[Rule]>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub id: Box<str>,
    pub definition: Definition,
}
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Author {
    Single(Box<str>),
    Multiple(Box<[Box<str>]>),
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: Box<str>,
    pub author: Author,
    pub series: Option<Box<str>>,
    pub tags: Box<[Box<str>]>,
    pub category: Option<Box<str>>,
    pub format: Box<str>,
    pub progress: f64,
    pub completed_at: Option<Box<str>>,
    pub manual_completion_state: Option<Box<str>>,
    pub is_favorite: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub id: Box<str>,
    pub book_ids: Box<[Box<str>]>,
}

impl Definition {
    pub fn validate(&self) -> Result<(), String> {
        if self.conditions.is_empty() || self.conditions.len() > 32 {
            return Err("A smart shelf needs between 1 and 32 rules".into());
        }
        for rule in &self.conditions {
            let value = rule.value.trim();
            if value.is_empty() || value.chars().count() > 256 {
                return Err("Rule values must contain between 1 and 256 characters".into());
            }
            match rule.field {
                Field::Status if !matches!(value, "unread" | "reading" | "completed") => {
                    return Err("Invalid reading status".into())
                }
                Field::Favorite if !matches!(value, "true" | "false") => {
                    return Err("Invalid favorite value".into())
                }
                Field::Format
                    if !matches!(
                        value,
                        "epub" | "pdf" | "mobi" | "azw" | "azw3" | "fb2" | "cbz" | "cbr"
                    ) =>
                {
                    return Err("Invalid book format".into())
                }
                _ => {}
            }
            if matches!(rule.field, Field::Status | Field::Favorite | Field::Format)
                && !matches!(rule.operator, Operator::Equals)
            {
                return Err("This rule requires an exact match".into());
            }
        }
        Ok(())
    }
}

fn matches_rule(book: &Book, rule: &Rule, needle: &str) -> bool {
    let matches_text = |text: &str| {
        let text = text.trim().to_lowercase();
        match rule.operator {
            Operator::Equals => text == needle,
            Operator::Contains => text.contains(needle),
        }
    };
    match rule.field {
        Field::Author => match &book.author {
            Author::Single(author) => matches_text(author),
            Author::Multiple(authors) => authors.iter().any(|author| matches_text(author)),
        },
        Field::Series => book.series.as_deref().is_some_and(matches_text),
        Field::Category => book.category.as_deref().is_some_and(matches_text),
        Field::Tag => book.tags.iter().any(|tag| matches_text(tag)),
        Field::Format => matches_text(&book.format),
        Field::Favorite => book.is_favorite == (needle == "true"),
        Field::Status => {
            let completed = match book.manual_completion_state.as_deref() {
                Some("read") => true,
                Some("unread") => false,
                _ => book.completed_at.is_some() || book.progress >= 0.99,
            };
            let status = if completed {
                "completed"
            } else if book.progress > 0.0 {
                "reading"
            } else {
                "unread"
            };
            needle == status
        }
    }
}

pub fn evaluate(books: &[Book], shelves: &[Shelf]) -> Result<Box<[Membership]>, String> {
    shelves
        .iter()
        .map(|shelf| {
            shelf.definition.validate()?;
            let rules: Vec<_> = shelf
                .definition
                .conditions
                .iter()
                .map(|rule| (rule, rule.value.trim().to_lowercase()))
                .collect();
            let book_ids = books
                .iter()
                .filter(|book| {
                    if book.tags.iter().any(|tag| tag.as_ref() == "rss") {
                        return false;
                    }
                    match shelf.definition.mode {
                        MatchMode::All => rules
                            .iter()
                            .all(|(rule, value)| matches_rule(book, rule, value)),
                        MatchMode::Any => rules
                            .iter()
                            .any(|(rule, value)| matches_rule(book, rule, value)),
                    }
                })
                .map(|book| book.id.clone())
                .collect::<Vec<_>>()
                .into_boxed_slice();
            Ok(Membership {
                id: shelf.id.clone(),
                book_ids,
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Vec::into_boxed_slice)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn book() -> Book {
        serde_json::from_value(
            serde_json::json!({"id":"b", "author":["Ursula Le Guin", "Another Author"],
            "tags":["Fantasy"], "category":"Fiction", "series":"Earthsea", "format":"epub",
            "progress":0.5, "isFavorite":true}),
        )
        .unwrap()
    }
    fn shelf(mode: MatchMode, conditions: &[(&str, &str, &str)]) -> Shelf {
        let conditions = conditions
            .iter()
            .map(
                |(field, op, value)| serde_json::json!({"field":field,"operator":op,"value":value}),
            )
            .collect::<Vec<_>>();
        Shelf {
            id: "s".into(),
            definition: Definition {
                mode,
                conditions: serde_json::from_value(serde_json::Value::Array(conditions)).unwrap(),
            },
        }
    }
    #[test]
    fn all_any_unicode_and_multi_author() {
        let mut b = book();
        b.series = Some("École".into());
        let s = shelf(
            MatchMode::All,
            &[
                ("author", "contains", " le GUIN "),
                ("series", "equals", "école"),
                ("tag", "equals", "FANTASY"),
            ],
        );
        assert_eq!(evaluate(&[b], &[s]).unwrap()[0].book_ids.len(), 1);
        assert!(evaluate(
            &[book()],
            &[shelf(
                MatchMode::All,
                &[("tag", "equals", "fantasy"), ("format", "equals", "pdf")]
            )]
        )
        .unwrap()[0]
            .book_ids
            .is_empty());
        assert_eq!(
            evaluate(
                &[book()],
                &[shelf(
                    MatchMode::Any,
                    &[("tag", "equals", "missing"), ("favorite", "equals", "true")]
                )]
            )
            .unwrap()[0]
                .book_ids
                .len(),
            1
        );
    }
    #[test]
    fn progress_overrides_and_membership_updates() {
        let s = shelf(MatchMode::All, &[("status", "equals", "completed")]);
        let mut b = book();
        b.progress = 0.99;
        assert_eq!(
            evaluate(std::slice::from_ref(&b), std::slice::from_ref(&s)).unwrap()[0]
                .book_ids
                .len(),
            1
        );
        b.manual_completion_state = Some("unread".into());
        assert!(
            evaluate(std::slice::from_ref(&b), std::slice::from_ref(&s)).unwrap()[0]
                .book_ids
                .is_empty()
        );
        b.manual_completion_state = Some("read".into());
        b.progress = 0.0;
        assert_eq!(evaluate(&[b], &[s]).unwrap()[0].book_ids.len(), 1);
    }
    #[test]
    fn invalid_rules_fail_closed() {
        for s in [
            shelf(MatchMode::All, &[]),
            shelf(MatchMode::Any, &[("tag", "contains", " ")]),
            shelf(MatchMode::All, &[("status", "equals", "unknown")]),
            shelf(MatchMode::All, &[("favorite", "contains", "true")]),
        ] {
            assert!(evaluate(&[book()], &[s]).is_err());
        }
    }
    #[test]
    fn missing_metadata_rss_and_empty_library() {
        let mut b = book();
        b.series = None;
        b.category = None;
        b.tags = vec!["rss".into()].into_boxed_slice();
        let s = shelf(MatchMode::All, &[("favorite", "equals", "true")]);
        assert!(evaluate(&[b], std::slice::from_ref(&s)).unwrap()[0]
            .book_ids
            .is_empty());
        assert!(evaluate(&[], &[s]).unwrap()[0].book_ids.is_empty());
    }
}
