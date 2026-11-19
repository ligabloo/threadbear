// What the Import from Claude Code sheet works out with no window in sight
// (docs/protocol.md, "Importing Claude Code sessions"): reading the runner's
// `sessions.importable` answer, which rows are picked, the params of each
// `threads.import`, and the words the sheet says. `desktop/gpui/src/
// import_sheet.rs` draws it.
use crate::inbox::folder_name;
use chrono::{Local, TimeZone};
use serde_json::{json, Value};

/// One session the runner offers (`ImportableSession`).
#[derive(Clone, Debug, PartialEq)]
pub struct ImportableSession {
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    /// Milliseconds since the epoch.
    pub last_activity_ms: i64,
    /// The Claude desktop app knows this session.
    pub desktop: bool,
    pub archived: bool,
    /// `side` for a side question, `agent` for work another session sent off.
    pub spawned_as: Option<String>,
    /// The session that started this one (its CLI id).
    pub parent_session_id: Option<String>,
}

impl ImportableSession {
    /// The title, or a word for one with none.
    pub fn display_title(&self) -> String {
        if self.title.trim().is_empty() {
            "Untitled".to_owned()
        } else {
            self.title.trim().to_owned()
        }
    }

    /// The folder's own name, with its whole path as the row's tooltip.
    pub fn folder(&self) -> String {
        folder_name(&self.cwd)
    }

    /// The word for a session another one started, if it was.
    pub fn spawned_label(&self) -> Option<&'static str> {
        match self.spawned_as.as_deref() {
            Some("side") => Some("Side question"),
            Some("agent") => Some("Sent off by another session"),
            _ => None,
        }
    }

    /// "Nov 12", in this Mac's time.
    pub fn date_label(&self) -> String {
        Local.timestamp_millis_opt(self.last_activity_ms).single().map_or_else(String::new, |t| t.format("%b %-d").to_string())
    }
}

/// The sessions in a `sessions.importable` answer, newest first as the runner
/// sent them; one with no id or folder is left out.
pub fn decode_sessions(answer: &Value) -> Vec<ImportableSession> {
    answer["sessions"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    Some(ImportableSession {
                        session_id: r["sessionId"].as_str()?.to_owned(),
                        cwd: r["cwd"].as_str()?.to_owned(),
                        title: r["title"].as_str().unwrap_or("").to_owned(),
                        last_activity_ms: r["lastActivityAt"].as_i64().unwrap_or(0),
                        desktop: r["source"].as_str() == Some("desktop"),
                        archived: r["archived"].as_bool().unwrap_or(false),
                        spawned_as: r["spawnedAs"].as_str().map(str::to_owned),
                        parent_session_id: r["parentSessionId"].as_str().map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `sessions.importable`'s params.
pub fn list_params(include_archived: bool) -> Value {
    json!({ "archived": include_archived })
}

/// `threads.import`'s params for one session; `with_children` brings in the
/// sessions it started too, the runner nesting each under its parent.
pub fn import_params(session_id: &str, into_projects: bool, with_children: bool) -> Value {
    json!({ "sessionId": session_id, "intoProject": into_projects, "withChildren": with_children })
}

/// The sessions `threads.import` couldn't bring in with a parent, and why
/// (`skipped` in its answer).
pub fn decode_skipped(answer: &Value) -> Vec<(String, String)> {
    answer["skipped"]
        .as_array()
        .map(|rows| rows.iter().filter_map(|r| Some((r["sessionId"].as_str()?.to_owned(), r["error"].as_str().unwrap_or("It couldn't be imported.").to_owned()))).collect())
        .unwrap_or_default()
}

/// The list as the sheet draws it: each session that started others with
/// them under it, one step in, and every other in the order the runner gave.
/// A session whose parent isn't in the list (already a thread, or gone) is
/// drawn on its own.
pub fn tree_order(listed: &[ImportableSession]) -> Vec<(ImportableSession, usize)> {
    fn add(out: &mut Vec<(ImportableSession, usize)>, listed: &[ImportableSession], s: &ImportableSession, depth: usize, seen: &mut Vec<String>) {
        if seen.contains(&s.session_id) {
            return;
        }
        seen.push(s.session_id.clone());
        out.push((s.clone(), depth));
        for child in listed.iter().filter(|c| c.parent_session_id.as_deref() == Some(s.session_id.as_str())) {
            add(out, listed, child, depth + 1, seen);
        }
    }
    let in_list = |id: &str| listed.iter().any(|s| s.session_id == id);
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for s in listed.iter().filter(|s| !s.parent_session_id.as_deref().is_some_and(in_list)) {
        add(&mut out, listed, s, 0, &mut seen);
    }
    out
}

/// Every listed session under this one, however deep.
pub fn descendants(id: &str, listed: &[ImportableSession]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut frontier = vec![id.to_owned()];
    while let Some(next) = frontier.pop() {
        for c in listed.iter().filter(|c| c.parent_session_id.as_deref() == Some(next.as_str())) {
            if c.session_id != id && !found.contains(&c.session_id) {
                found.push(c.session_id.clone());
                frontier.push(c.session_id.clone());
            }
        }
    }
    found
}

/// Whether any listed session started another.
pub fn any_children(listed: &[ImportableSession]) -> bool {
    listed.iter().any(|s| s.parent_session_id.as_deref().is_some_and(|p| listed.iter().any(|x| x.session_id == p)))
}

/// What Import will do for these ticks.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    /// The `threads.import` calls, parents before the sessions they started.
    pub roots: Vec<String>,
    /// Sessions that come in with a ticked parent (`withChildren`), not ticked themselves.
    pub implied: Vec<String>,
}

pub fn plan(picks: &Picks, listed: &[ImportableSession], with_children: bool) -> Plan {
    let ordered: Vec<ImportableSession> = tree_order(listed).into_iter().map(|(s, _)| s).collect();
    let picked: Vec<String> = ordered.iter().filter(|s| picks.contains(&s.session_id)).map(|s| s.session_id.clone()).collect();
    if !with_children {
        return Plan { roots: picked, implied: Vec::new() };
    }
    let mut implied: Vec<String> = Vec::new();
    for id in &picked {
        for d in descendants(id, listed) {
            if !implied.contains(&d) {
                implied.push(d);
            }
        }
    }
    let roots = picked.into_iter().filter(|id| !implied.contains(id)).collect();
    Plan { roots, implied }
}

/// Which rows are ticked, in the order they were listed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Picks {
    ids: Vec<String>,
}

impl Picks {
    pub fn contains(&self, id: &str) -> bool {
        self.ids.iter().any(|i| i == id)
    }

    pub fn toggle(&mut self, id: &str) {
        match self.ids.iter().position(|i| i == id) {
            Some(at) => {
                self.ids.remove(at);
            }
            None => self.ids.push(id.to_owned()),
        }
    }

    pub fn count(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// Every listed session ticked, or none when they all are already.
    pub fn toggle_all(&mut self, listed: &[ImportableSession]) {
        if !listed.is_empty() && listed.iter().all(|s| self.contains(&s.session_id)) {
            self.ids.clear();
        } else {
            self.ids = listed.iter().map(|s| s.session_id.clone()).collect();
        }
    }

    /// A new list (the archived switch changed it) keeps only the ticks still in it.
    pub fn keep_listed(&mut self, listed: &[ImportableSession]) {
        self.ids.retain(|id| listed.iter().any(|s| &s.session_id == id));
    }

    /// The ids to import, in the list's order.
    pub fn in_order(&self, listed: &[ImportableSession]) -> Vec<String> {
        listed.iter().filter(|s| self.contains(&s.session_id)).map(|s| s.session_id.clone()).collect()
    }
}

/// How one row stands while the sheet imports.
#[derive(Clone, Debug, PartialEq)]
pub enum RowState {
    Waiting,
    Importing,
    Done,
    /// The runner's own words, such as the session's folder not being on this Mac.
    Failed(String),
}

/// The line under the list while or after importing.
pub fn progress_line(rows: &[RowState]) -> String {
    let done = rows.iter().filter(|r| **r == RowState::Done).count();
    let failed = rows.iter().filter(|r| matches!(r, RowState::Failed(_))).count();
    let left = rows.len() - done - failed;
    match (left, failed) {
        (0, 0) => format!("Imported {}.", threads(done)),
        (0, _) => format!("Imported {} of {}. {} didn't come in; the reason is under each.", done, rows.len(), failed),
        _ => format!("Importing… {} of {} done.", done + failed, rows.len()),
    }
}

/// The empty list's words.
pub fn empty_line(include_archived: bool) -> &'static str {
    if include_archived {
        "Every Claude Code session on this Mac is already a thread."
    } else {
        "No Claude Code sessions to import. Ones already in Threadbear are left out. Show archived ones to see the rest."
    }
}

/// The Import button's label for what's ticked.
pub fn button_label(picked: usize) -> String {
    match picked {
        0 => "Import".to_owned(),
        1 => "Import 1 session".to_owned(),
        n => format!("Import {n} sessions"),
    }
}

fn threads(n: usize) -> String {
    if n == 1 {
        "1 thread".to_owned()
    } else {
        format!("{n} threads")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed() -> Vec<ImportableSession> {
        decode_sessions(&json!({ "sessions": [
            { "sessionId": "a", "cwd": "/Users/x/Developer/Stagehand", "title": "Stagehand", "lastActivityAt": 1_783_115_814_251i64, "source": "desktop", "archived": true, "spawnedAs": "side" },
            { "sessionId": "b", "cwd": "/tmp/x", "title": "  ", "lastActivityAt": 1_783_115_814_251i64, "source": "cli" },
            { "cwd": "/no/id" },
            { "sessionId": "c" }
        ]}))
    }

    fn tree() -> Vec<ImportableSession> {
        decode_sessions(&json!({ "sessions": [
            { "sessionId": "kid", "cwd": "/p", "title": "Kid", "parentSessionId": "boss", "spawnedAs": "agent" },
            { "sessionId": "solo", "cwd": "/p", "title": "Solo" },
            { "sessionId": "boss", "cwd": "/p", "title": "Boss" },
            { "sessionId": "grandkid", "cwd": "/p", "title": "Grandkid", "parentSessionId": "kid" },
            { "sessionId": "orphan", "cwd": "/p", "title": "Orphan", "parentSessionId": "already-a-thread" }
        ]}))
    }

    #[test]
    fn children_sit_under_their_parent() {
        let order: Vec<(String, usize)> = tree_order(&tree()).into_iter().map(|(s, d)| (s.session_id, d)).collect();
        assert_eq!(order, vec![("solo".into(), 0), ("boss".into(), 0), ("kid".into(), 1), ("grandkid".into(), 2), ("orphan".into(), 0)]);
        assert_eq!(descendants("boss", &tree()), vec!["kid", "grandkid"]);
        assert!(any_children(&tree()));
        assert!(!any_children(&listed()));
    }

    #[test]
    fn plan_imports_parents_first_and_lets_children_ride_along() {
        let t = tree();
        let mut p = Picks::default();
        p.toggle("grandkid");
        p.toggle("boss");
        p.toggle("solo");
        let own = plan(&p, &t, false);
        assert_eq!(own.roots, vec!["solo", "boss", "grandkid"], "parents before their children");
        assert!(own.implied.is_empty());
        let with = plan(&p, &t, true);
        assert_eq!(with.roots, vec!["solo", "boss"]);
        assert_eq!(with.implied, vec!["kid", "grandkid"]);
    }

    #[test]
    fn a_child_ticked_alone_is_its_own_call() {
        let mut p = Picks::default();
        p.toggle("kid");
        assert_eq!(plan(&p, &tree(), true).roots, vec!["kid"]);
    }

    #[test]
    fn skipped_rows_are_read() {
        let a = json!({ "thread": {}, "children": [], "skipped": [{ "sessionId": "kid", "error": "Its folder is gone." }, { "sessionId": "x" }] });
        assert_eq!(decode_skipped(&a), vec![("kid".to_owned(), "Its folder is gone.".to_owned()), ("x".to_owned(), "It couldn't be imported.".to_owned())]);
        assert!(decode_skipped(&json!({})).is_empty());
    }

    #[test]
    fn reads_what_the_runner_sends() {
        let s = listed();
        assert_eq!(s.len(), 2, "rows with no id or folder are left out");
        assert!(s[0].desktop && s[0].archived);
        assert!(!s[1].desktop && !s[1].archived);
        assert_eq!(s[0].spawned_label(), Some("Side question"));
        assert_eq!(s[1].spawned_label(), None);
        assert_eq!(s[0].folder(), "Stagehand");
        assert_eq!(s[1].display_title(), "Untitled");
        assert!(decode_sessions(&json!({})).is_empty());
    }

    #[test]
    fn params_match_the_protocol() {
        assert_eq!(list_params(true), json!({ "archived": true }));
        assert_eq!(import_params("a", false, true), json!({ "sessionId": "a", "intoProject": false, "withChildren": true }));
    }

    #[test]
    fn picks_toggle_and_keep_the_lists_order() {
        let s = listed();
        let mut p = Picks::default();
        p.toggle("b");
        p.toggle("a");
        assert_eq!(p.count(), 2);
        assert_eq!(p.in_order(&s), vec!["a", "b"]);
        p.toggle("a");
        assert!(!p.contains("a"));
    }

    #[test]
    fn select_all_then_none() {
        let s = listed();
        let mut p = Picks::default();
        p.toggle_all(&s);
        assert_eq!(p.count(), 2);
        p.toggle_all(&s);
        assert!(p.is_empty());
        p.toggle("a");
        p.toggle_all(&s);
        assert_eq!(p.count(), 2, "some ticked: all get ticked");
    }

    #[test]
    fn a_new_list_drops_ticks_that_are_gone() {
        let s = listed();
        let mut p = Picks::default();
        p.toggle_all(&s);
        p.keep_listed(&s[..1]);
        assert_eq!(p.in_order(&s), vec!["a"]);
    }

    #[test]
    fn progress_words() {
        use RowState::*;
        assert_eq!(progress_line(&[Done]), "Imported 1 thread.");
        assert_eq!(progress_line(&[Done, Done]), "Imported 2 threads.");
        assert_eq!(progress_line(&[Done, Importing, Waiting]), "Importing… 1 of 3 done.");
        assert_eq!(progress_line(&[Done, Failed("folder".into())]), "Imported 1 of 2. 1 didn't come in; the reason is under each.");
    }

    #[test]
    fn labels() {
        assert_eq!(button_label(0), "Import");
        assert_eq!(button_label(1), "Import 1 session");
        assert_eq!(button_label(3), "Import 3 sessions");
        assert!(empty_line(false).contains("archived"));
        assert!(!empty_line(true).contains("Show archived"));
    }
}
