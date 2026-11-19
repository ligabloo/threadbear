// The Import from Claude Code sheet (File > Import from Claude Code…): lists the
// Claude Code sessions on this Mac that aren't threads yet (`sessions.importable`,
// docs/protocol.md "Importing Claude Code sessions"), and brings the ticked ones
// in one after another with `threads.import`. What it works out (the rows, the
// ticks, the params, the words) is threadbear_core::session_import; this draws
// it. GPUI-only: the Swift app is frozen and hasn't got it.
use crate::a11y::A11yRole as _;
use crate::app::Threadbear;
use crate::call;
use crate::spinner::Spinner;
use crate::style::{self, size};
use crate::tips::Tip as _;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::{h_flex, v_flex, Disableable as _, Sizable as _, StyledExt as _, WindowExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// Shadows gpui's px, so sizes here follow the app's zoom (style.rs).
use crate::style::px;
#[cfg(feature = "automation")]
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use threadbear_client::runner::{Client, Status};
use threadbear_core::session_import::{self as rules, ImportableSession, Picks, RowState};

impl Threadbear {
    /// File > Import from Claude Code…: the sheet, or the one that's up.
    pub(crate) fn open_import_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.import_sheet.is_some() {
            return;
        }
        let app = cx.entity().downgrade();
        let app_for_close = app.clone();
        // Handed the client, as the Move sheet is: it asks the runner as it's
        // made, inside this update.
        let client = self.client.clone();
        let view = cx.new(|cx| ImportSheet::new(app, client, cx));
        self.import_sheet = Some(view.clone());
        cx.notify();
        window.open_dialog(cx, move |dialog, _, _| {
            let app = app_for_close.clone();
            dialog
                .w(px(520.))
                .close_button(false)
                .child(view.clone())
                .footer(div())
                .on_close(move |_, _, cx| {
                    if let Some(app) = app.upgrade() {
                        app.update(cx, |app, cx| {
                            app.import_sheet = None;
                            cx.notify();
                        });
                    }
                })
        });
    }
}

/// The sheet's content.
pub(crate) struct ImportSheet {
    app: WeakEntity<Threadbear>,
    client: Arc<Client>,
    include_archived: bool,
    into_projects: bool,
    /// A ticked session brings the ones it started along (`withChildren`).
    with_children: bool,
    /// The list is being asked for.
    loading: bool,
    /// Why the list couldn't be read, in the runner's words.
    load_error: Option<String>,
    sessions: Vec<ImportableSession>,
    picks: Picks,
    /// How each session being imported stands, by session id.
    rows: HashMap<String, RowState>,
    running: bool,
    /// The newest list request; an older answer is ignored.
    asks: u64,
    scroll: ScrollHandle,
}

impl ImportSheet {
    fn new(app: WeakEntity<Threadbear>, client: Arc<Client>, cx: &mut Context<Self>) -> Self {
        let mut sheet = ImportSheet { app, client, include_archived: false, into_projects: false, with_children: true, loading: false, load_error: None, sessions: Vec::new(), picks: Picks::default(), rows: HashMap::new(), running: false, asks: 0, scroll: ScrollHandle::new() };
        sheet.load(cx);
        sheet
    }

    fn connected(&self, cx: &App) -> bool {
        self.app.upgrade().is_some_and(|a| matches!(a.read(cx).status, Status::Connected { .. }))
    }

    /// Asks the runner for the list again (the archived switch changed it).
    fn load(&mut self, cx: &mut Context<Self>) {
        self.asks += 1;
        let ask = self.asks;
        self.loading = true;
        self.load_error = None;
        cx.notify();
        let client = self.client.clone();
        let params = rules::list_params(self.include_archived);
        cx.spawn(async move |this, cx| {
            let answer = call(client, "sessions.importable", params).await;
            this.update(cx, |this, cx| {
                if this.asks != ask {
                    return;
                }
                this.loading = false;
                match answer {
                    Ok(value) => {
                        this.sessions = rules::decode_sessions(&value);
                        this.picks.keep_listed(&this.sessions);
                        // Rows that came in stay on show until the sheet closes.
                        this.rows.retain(|id, _| this.sessions.iter().any(|s| &s.session_id == id));
                    }
                    Err(e) => {
                        this.sessions.clear();
                        this.load_error = Some(e.message);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn set_archived(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.include_archived != on && !self.running {
            self.include_archived = on;
            self.load(cx);
        }
    }

    fn state_of(&self, id: &str) -> Option<&RowState> {
        self.rows.get(id)
    }

    /// Rows that come in with a ticked parent, shown ticked and left alone.
    fn implied(&self) -> Vec<String> {
        rules::plan(&self.picks, &self.sessions, self.with_children).implied
    }

    /// A row that's in already can't be ticked again.
    fn is_done(&self, id: &str) -> bool {
        self.state_of(id) == Some(&RowState::Done)
    }

    fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.running || self.is_done(id) || self.implied().iter().any(|i| i == id) {
            return;
        }
        self.picks.toggle(id);
        cx.notify();
    }

    fn toggle_all(&mut self, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        let open: Vec<ImportableSession> = self.sessions.iter().filter(|s| !self.is_done(&s.session_id)).cloned().collect();
        self.picks.toggle_all(&open);
        cx.notify();
    }

    fn can_import(&self, cx: &App) -> bool {
        !self.running && !self.picks.is_empty() && self.connected(cx)
    }

    fn close(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.close_dialog(cx);
        if let Some(app) = self.app.upgrade() {
            app.update(cx, |app, cx| {
                app.import_sheet = None;
                cx.notify();
            });
        }
    }

    /// Import: the ticked sessions one after another, each saying how it went
    /// under its row. A failure doesn't stop the rest.
    fn press_import(&mut self, cx: &mut Context<Self>) {
        if !self.can_import(cx) {
            return;
        }
        let plan = rules::plan(&self.picks, &self.sessions, self.with_children);
        for id in plan.roots.iter().chain(&plan.implied) {
            self.rows.insert(id.clone(), RowState::Waiting);
        }
        // What each call brings along with it, to say how those went too.
        let along: Vec<(String, Vec<String>)> = plan
            .roots
            .iter()
            .map(|r| (r.clone(), if self.with_children { rules::descendants(r, &self.sessions).into_iter().filter(|d| plan.implied.contains(d)).collect() } else { Vec::new() }))
            .collect();
        self.running = true;
        cx.notify();
        let (client, into_projects, with_children) = (self.client.clone(), self.into_projects, self.with_children);
        cx.spawn(async move |this, cx| {
            for (id, kids) in along {
                this.update(cx, |this, cx| {
                    this.rows.insert(id.clone(), RowState::Importing);
                    cx.notify();
                })
                .ok();
                let answer = call(client.clone(), "threads.import", rules::import_params(&id, into_projects, with_children)).await;
                this.update(cx, |this, cx| {
                    match answer {
                        Ok(value) => {
                            this.rows.insert(id.clone(), RowState::Done);
                            // In: it isn't offered to tick again.
                            this.picks.toggle(&id);
                            let skipped = rules::decode_skipped(&value);
                            for kid in kids {
                                let state = match skipped.iter().find(|(s, _)| *s == kid) {
                                    Some((_, why)) => RowState::Failed(why.clone()),
                                    None => RowState::Done,
                                };
                                this.rows.insert(kid, state);
                            }
                        }
                        Err(e) => {
                            this.rows.insert(id.clone(), RowState::Failed(e.message));
                            for kid in kids {
                                this.rows.insert(kid, RowState::Failed("Not imported: the session that started it didn't come in.".to_owned()));
                            }
                        }
                    }
                    cx.notify();
                })
                .ok();
            }
            this.update(cx, |this, cx| {
                this.running = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// What's under the list: the progress of an import that's begun.
    fn progress(&self) -> Option<String> {
        let states: Vec<RowState> = self.rows.values().cloned().collect();
        (!states.is_empty()).then(|| rules::progress_line(&states))
    }

    /// The dump's `importSheet`.
    #[cfg(feature = "automation")]
    pub(crate) fn dump(&self, cx: &App) -> Value {
        let implied = self.implied();
        let rows: Vec<Value> = rules::tree_order(&self.sessions)
            .iter()
            .map(|(s, depth)| {
                json!({
                    "id": s.session_id,
                    "depth": depth,
                    "implied": implied.contains(&s.session_id),
                    "title": s.display_title(),
                    "folder": s.folder(),
                    "desktop": s.desktop,
                    "archived": s.archived,
                    "picked": self.picks.contains(&s.session_id),
                    "state": match self.state_of(&s.session_id) {
                        None => "",
                        Some(RowState::Waiting) => "waiting",
                        Some(RowState::Importing) => "importing",
                        Some(RowState::Done) => "done",
                        Some(RowState::Failed(_)) => "failed",
                    },
                    "error": match self.state_of(&s.session_id) { Some(RowState::Failed(e)) => Value::String(e.clone()), _ => Value::Null },
                })
            })
            .collect();
        json!({
            "loading": self.loading,
            "loadError": self.load_error,
            "includeArchived": self.include_archived,
            "intoProjects": self.into_projects,
            "withChildren": self.with_children,
            "running": self.running,
            "canImport": self.can_import(cx),
            "button": rules::button_label(self.picks.count()),
            "progress": self.progress(),
            "empty": (!self.loading && self.load_error.is_none() && self.sessions.is_empty()).then(|| rules::empty_line(self.include_archived)),
            "rows": rows,
        })
    }

    fn render_row(&self, index: usize, s: &ImportableSession, depth: usize, implied: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let id = s.session_id.clone();
        let state = self.state_of(&id).cloned();
        let done = state == Some(RowState::Done);
        let picked = self.picks.contains(&id) || implied;
        let locked = self.running || done || implied;
        let toggle_id = id.clone();
        let box_id = id.clone();
        let detail = format!("{} · {}", s.folder(), s.date_label());
        let spawned = s.spawned_label();
        let badge = |text: &'static str| div().flex_none().px(px(5.)).rounded(px(4.)).border_1().border_color(style::hairline(cx)).text_size(px(size::LABEL - 1.)).text_color(style::secondary_text(cx)).child(text);
        let status: Option<AnyElement> = match &state {
            Some(RowState::Waiting) => Some(div().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child("Waiting").into_any_element()),
            Some(RowState::Importing) => Some(Spinner::new().color(style::quiet_text(cx)).with_size(px(12.)).into_any_element()),
            Some(RowState::Done) => Some(div().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child("Imported").into_any_element()),
            _ => None,
        };
        v_flex()
            .id(("import-row", index))
            .pl(px(8. + 22. * depth as f32))
            .pr(px(8.))
            .py(px(5.))
            .gap(px(2.))
            .rounded(px(6.))
            .when(!locked, |r| r.cursor_pointer().hover(|h| h.bg(style::button_fill(cx))))
            .tip(s.cwd.clone())
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(&toggle_id, cx)))
            .child(
                h_flex()
                    .gap(px(8.))
                    .items_center()
                    .child(Checkbox::new(("import-pick", index)).checked(picked || done).disabled(locked).small().on_click(cx.listener(move |this, _: &bool, _, cx| this.toggle(&box_id, cx))))
                    .child(div().flex_1().min_w_0().truncate().text_size(px(size::LABEL)).child(s.display_title()))
                    .when(s.desktop, |r| r.child(badge("Desktop")))
                    .when(s.archived, |r| r.child(badge("Archived")))
                    .when_some(spawned, |r, text| r.child(badge(text)))
                    .children(status),
            )
            .child(div().pl(px(26.)).min_w_0().truncate().text_size(px(size::LABEL - 1.)).text_color(style::secondary_text(cx)).child(detail))
            .when_some(
                match &state {
                    Some(RowState::Failed(e)) => Some(e.clone()),
                    _ => None,
                },
                |r, error| r.child(div().pl(px(26.)).text_size(px(size::LABEL - 1.)).text_color(style::failed(cx)).child(error)),
            )
    }
}

impl Render for ImportSheet {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let connected = self.connected(cx);
        let can_import = self.can_import(cx);
        let label = rules::button_label(self.picks.count());
        let all_picked = !self.sessions.is_empty() && self.sessions.iter().filter(|s| !self.is_done(&s.session_id)).all(|s| self.picks.contains(&s.session_id));
        let progress = self.progress();
        let any_done = self.rows.values().any(|r| *r == RowState::Done);

        let body: AnyElement = if self.loading {
            h_flex().gap(px(8.)).items_center().py(px(14.)).child(Spinner::new().color(style::quiet_text(cx)).with_size(px(12.))).child(div().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child(if connected { "Looking for Claude Code sessions…" } else { "Waiting for this Mac's runner…" })).into_any_element()
        } else if let Some(error) = &self.load_error {
            div().py(px(14.)).text_size(px(size::LABEL)).text_color(style::failed(cx)).child(error.clone()).into_any_element()
        } else if self.sessions.is_empty() {
            div().py(px(14.)).text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child(rules::empty_line(self.include_archived)).into_any_element()
        } else {
            let implied = self.implied();
            let rows: Vec<AnyElement> = rules::tree_order(&self.sessions).iter().enumerate().map(|(i, (s, depth))| self.render_row(i, s, *depth, implied.contains(&s.session_id), cx).into_any_element()).collect();
            div().id("import-list").max_h(px(300.)).overflow_y_scroll().track_scroll(&self.scroll).child(v_flex().gap(px(1.)).children(rows)).into_any_element()
        };

        v_flex()
            .gap(px(12.))
            .child(
                v_flex()
                    .gap(px(4.))
                    .child(div().text_size(px(size::CARD_TITLE)).font_semibold().child("Import from Claude Code"))
                    .child(div().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child("Tick the sessions to carry on here as threads. Claude Code itself isn't changed.")),
            )
            .child(
                h_flex()
                    .gap(px(14.))
                    .gap_y(px(6.))
                    .flex_wrap()
                    .items_center()
                    .child(
                        h_flex()
                            .id("import-archived")
                            .gap(px(6.))
                            .items_center()
                            .tip("Also list sessions the Claude desktop app archived")
                            .child(Checkbox::new("import-archived-box").checked(self.include_archived).disabled(self.running).small().on_click(cx.listener(|this, on: &bool, _, cx| this.set_archived(*on, cx))))
                            .child(div().text_size(px(size::LABEL)).child("Show archived")),
                    )
                    .child(
                        h_flex()
                            .id("import-projects")
                            .gap(px(6.))
                            .items_center()
                            .tip("Each thread joins a project for its folder, made if there isn't one")
                            .child(Checkbox::new("import-projects-box").checked(self.into_projects).disabled(self.running).small().on_click(cx.listener(|this, on: &bool, _, cx| {
                                this.into_projects = *on;
                                cx.notify();
                            })))
                            .child(div().text_size(px(size::LABEL)).child("Put in projects by folder")),
                    )
                    .when(rules::any_children(&self.sessions), |r| {
                        r.child(
                            h_flex()
                                .id("import-children")
                                .gap(px(6.))
                                .items_center()
                                .tip("A ticked session brings in the sessions it started, under it")
                                .child(Checkbox::new("import-children-box").checked(self.with_children).disabled(self.running).small().on_click(cx.listener(|this, on: &bool, _, cx| {
                                    this.with_children = *on;
                                    cx.notify();
                                })))
                                .child(div().text_size(px(size::LABEL)).child("Include the sessions it started")),
                        )
                    })
                    .child(div().flex_1())
                    .when(!self.sessions.is_empty() && !self.loading, |r| {
                        r.child(Button::new("import-all").label(if all_picked { "Select none" } else { "Select all" }).small().outline().disabled(self.running).tooltip("Tick every session in the list, or none").on_click(cx.listener(|this, _, _, cx| this.toggle_all(cx))))
                    }),
            )
            .child(body)
            .child(
                h_flex()
                    .gap(px(8.))
                    .items_center()
                    .when(self.running, |s| s.child(Spinner::new().color(style::quiet_text(cx)).with_size(px(12.))))
                    .when_some(progress, |s, line| s.child(div().flex_1().min_w_0().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child(line)))
                    .when(self.rows.is_empty(), |s| s.child(div().flex_1()))
                    .child(div().id("import-close").test_support().a11y_role(Role::GenericContainer).aria_label("Close the sheet".to_owned()).child(Button::new("import-close-button").label(if any_done { "Done" } else { "Cancel" }).small().outline().disabled(self.running).tooltip("Close the sheet").on_click(cx.listener(|this, _, window, cx| this.close(window, cx)))))
                    .child(
                        div().id("import-go").test_support().a11y_role(Role::GenericContainer).aria_label(if can_import { "Bring the ticked sessions in as threads".to_owned() } else { "Tick a session first".to_owned() }).child(
                            Button::new("import-go-button")
                                .label(label)
                                .small()
                                .primary()
                                .disabled(!can_import)
                                .tooltip(if can_import { "Bring the ticked sessions in as threads" } else { "Tick a session first" })
                                .on_click(cx.listener(|this, _, _, cx| this.press_import(cx))),
                        ),
                    ),
            )
    }
}

/// The `import` script command: opens the sheet; `pick` ticks a session by id
/// (or its title), `all: true` ticks every listed one, `archived`,
/// `projects` and `children` set the switches, `go: true` presses Import.
#[cfg(feature = "automation")]
pub(crate) fn automation(app: &Entity<Threadbear>, cmd: &Value, window: &mut Window, cx: &mut App) -> Result<Value, String> {
    if app.read(cx).import_sheet.is_none() {
        app.update(cx, |t, cx| t.open_import_sheet(window, cx));
    }
    let sheet = app.read(cx).import_sheet.clone().ok_or("no import sheet open")?;
    sheet.update(cx, |s, cx| {
        if let Some(on) = cmd["archived"].as_bool() {
            s.set_archived(on, cx);
        }
        if let Some(on) = cmd["projects"].as_bool() {
            s.into_projects = on;
        }
        if let Some(on) = cmd["children"].as_bool() {
            s.with_children = on;
        }
        if cmd["all"].as_bool() == Some(true) {
            s.toggle_all(cx);
        }
        if let Some(want) = cmd["pick"].as_str() {
            let id = s.sessions.iter().find(|x| x.session_id == want || x.display_title() == want).map(|x| x.session_id.clone());
            match id {
                Some(id) => s.toggle(&id, cx),
                None => return Err(format!("no session {want} in the list")),
            }
        }
        if cmd["go"].as_bool() == Some(true) {
            s.press_import(cx);
        }
        cx.notify();
        Ok(json!("ok"))
    })
}
