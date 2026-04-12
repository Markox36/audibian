/// Profile manager panel.
///
/// Lists saved profiles, allows saving/loading/deleting, setting a default
/// profile (applied on startup), and toggling system autostart.
use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;

use crate::audio::{AudioGraph, PwThread};
use crate::profiles::{
    apply::{apply_profile, snapshot_profile},
    config::AppConfig,
    ProfileStore,
};

#[derive(Clone)]
pub struct ProfilesView {
    root: gtk4::Box,
    graph: Rc<RefCell<AudioGraph>>,
    pw: Rc<PwThread>,
    store: Rc<RefCell<ProfileStore>>,
    list_box: gtk4::ListBox,
    name_entry: gtk4::Entry,
}

impl ProfilesView {
    pub fn new(
        graph: Rc<RefCell<AudioGraph>>,
        pw: Rc<PwThread>,
        store: Rc<RefCell<ProfileStore>>,
    ) -> Self {
        // ── Save row ──────────────────────────────────────────────────────
        let name_entry = gtk4::Entry::builder()
            .placeholder_text("Nombre del perfil...")
            .hexpand(true)
            .build();

        let save_btn = gtk4::Button::builder().label("Guardar estado actual").build();
        let entry_row = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Horizontal)
            .spacing(8)
            .build();
        entry_row.append(&name_entry);
        entry_row.append(&save_btn);

        // ── Profile list ─────────────────────────────────────────────────
        let list_box = gtk4::ListBox::builder()
            .selection_mode(gtk4::SelectionMode::Single)
            .vexpand(true)
            .build();
        list_box.add_css_class("boxed-list");

        let scrolled = gtk4::ScrolledWindow::builder()
            .child(&list_box)
            .vexpand(true)
            .build();

        // ── Action buttons ────────────────────────────────────────────────
        let load_btn = gtk4::Button::builder().label("Cargar").build();
        let default_btn = gtk4::Button::builder()
            .label("Predeterminado")
            .tooltip_text("Aplicar este perfil automáticamente al iniciar Audibian")
            .build();
        let delete_btn = gtk4::Button::builder()
            .label("Eliminar")
            .css_classes(["destructive-action"])
            .build();

        let action_row = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Horizontal)
            .spacing(8)
            .halign(gtk4::Align::End)
            .build();
        action_row.append(&load_btn);
        action_row.append(&default_btn);
        action_row.append(&delete_btn);

        // ── Status label ──────────────────────────────────────────────────
        let status_label = gtk4::Label::builder()
            .label("")
            .halign(gtk4::Align::Start)
            .build();

        // ── Settings section ──────────────────────────────────────────────
        let sep = gtk4::Separator::new(gtk4::Orientation::Horizontal);

        let settings_label = gtk4::Label::builder()
            .label("<b>Ajustes</b>")
            .use_markup(true)
            .halign(gtk4::Align::Start)
            .build();

        let autostart_row = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Horizontal)
            .spacing(8)
            .build();

        let autostart_lbl = gtk4::Label::builder()
            .label("Iniciar con el sistema")
            .hexpand(true)
            .halign(gtk4::Align::Start)
            .build();
        let autostart_hint = gtk4::Label::builder()
            .label("Crea una entrada XDG de autoarranque para esta sesión de escritorio")
            .halign(gtk4::Align::Start)
            .build();
        autostart_hint.add_css_class("dim-label");

        let autostart_switch = gtk4::Switch::new();
        autostart_switch.set_valign(gtk4::Align::Center);

        // Initialise switch state from saved config
        {
            let cfg = AppConfig::load();
            autostart_switch.set_active(cfg.autostart);
        }

        autostart_row.append(&autostart_lbl);
        autostart_row.append(&autostart_switch);

        let settings_box = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Vertical)
            .spacing(4)
            .build();
        settings_box.append(&settings_label);
        settings_box.append(&autostart_row);
        settings_box.append(&autostart_hint);

        // ── Root layout ───────────────────────────────────────────────────
        let root = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Vertical)
            .spacing(8)
            .margin_top(12)
            .margin_bottom(12)
            .margin_start(12)
            .margin_end(12)
            .build();

        root.append(&entry_row);
        root.append(&scrolled);
        root.append(&action_row);
        root.append(&status_label);
        root.append(&sep);
        root.append(&settings_box);

        let view = Self {
            root,
            graph,
            pw,
            store,
            list_box,
            name_entry,
        };

        // ── Signal connections ─────────────────────────────────────────────

        // Save
        {
            let v = view.clone();
            let status_ref = status_label.clone();
            save_btn.connect_clicked(move |_| {
                let name = v.name_entry.text().to_string();
                if name.trim().is_empty() {
                    status_ref.set_text("Escribe un nombre para el perfil.");
                    return;
                }
                let profile = snapshot_profile(&name, &v.graph.borrow());
                if v.store.borrow().save(&profile) {
                    status_ref.set_text(&format!("Perfil '{name}' guardado."));
                    v.refresh_list();
                } else {
                    status_ref.set_text("Error al guardar el perfil.");
                }
            });
        }

        // Load
        {
            let v = view.clone();
            let status_ref = status_label.clone();
            load_btn.connect_clicked(move |_| {
                if let Some(name) = v.selected_name() {
                    if let Some(profile) = v.store.borrow().load(&name) {
                        let result = apply_profile(&profile, &v.graph.borrow(), &*v.pw);
                        status_ref.set_text(&format!(
                            "Perfil '{name}' cargado: {} enlaces, {} sin resolver.",
                            result.links_applied,
                            result.unresolved_links.len()
                        ));
                    } else {
                        status_ref.set_text("No se pudo cargar el perfil.");
                    }
                } else {
                    status_ref.set_text("Selecciona un perfil de la lista.");
                }
            });
        }

        // Set / clear default
        {
            let v = view.clone();
            let status_ref = status_label.clone();
            default_btn.connect_clicked(move |_| {
                let Some(name) = v.selected_name() else {
                    status_ref.set_text("Selecciona un perfil de la lista.");
                    return;
                };
                let mut cfg = AppConfig::load();
                if cfg.default_profile.as_deref() == Some(&name) {
                    // Toggle off: clear default
                    cfg.default_profile = None;
                    cfg.save();
                    status_ref.set_text("Perfil predeterminado eliminado.");
                } else {
                    cfg.default_profile = Some(name.clone());
                    cfg.save();
                    status_ref.set_text(&format!(
                        "'{name}' se aplicará automáticamente al iniciar Audibian."
                    ));
                }
                v.refresh_list();
            });
        }

        // Delete
        {
            let v = view.clone();
            let status_ref = status_label.clone();
            delete_btn.connect_clicked(move |_| {
                if let Some(name) = v.selected_name() {
                    if v.store.borrow().delete(&name) {
                        // If it was the default, clear it
                        let mut cfg = AppConfig::load();
                        if cfg.default_profile.as_deref() == Some(&name) {
                            cfg.default_profile = None;
                            cfg.save();
                        }
                        status_ref.set_text(&format!("Perfil '{name}' eliminado."));
                        v.refresh_list();
                    }
                } else {
                    status_ref.set_text("Selecciona un perfil de la lista.");
                }
            });
        }

        // Autostart toggle
        {
            autostart_switch.connect_state_set(move |_, enabled| {
                let mut cfg = AppConfig::load();
                cfg.autostart = enabled;
                cfg.save();
                cfg.apply_autostart();
                glib::Propagation::Proceed
            });
        }

        view.refresh_list();
        view
    }

    pub fn widget(&self) -> &gtk4::Widget {
        self.root.upcast_ref()
    }

    // ── Private ───────────────────────────────────────────────────────────

    fn refresh_list(&self) {
        while let Some(row) = self.list_box.row_at_index(0) {
            self.list_box.remove(&row);
        }

        let default_profile = AppConfig::load().default_profile;
        let names = self.store.borrow().list();

        for name in &names {
            let is_default = default_profile.as_deref() == Some(name.as_str());

            // Row widget_name stores the profile name for selected_name()
            let row = gtk4::ListBoxRow::new();
            row.set_widget_name(name);

            let row_box = gtk4::Box::builder()
                .orientation(gtk4::Orientation::Horizontal)
                .spacing(8)
                .margin_top(6)
                .margin_bottom(6)
                .margin_start(8)
                .margin_end(8)
                .build();

            let label = gtk4::Label::builder()
                .label(name)
                .halign(gtk4::Align::Start)
                .hexpand(true)
                .build();

            row_box.append(&label);

            if is_default {
                let badge = gtk4::Label::new(Some("Predeterminado"));
                badge.add_css_class("dim-label");
                row_box.append(&badge);
            }

            row.set_child(Some(&row_box));
            self.list_box.append(&row);
        }
    }

    fn selected_name(&self) -> Option<String> {
        let row = self.list_box.selected_row()?;
        let name = row.widget_name().to_string();
        if name.is_empty() { None } else { Some(name) }
    }
}
