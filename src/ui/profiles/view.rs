/// Profile manager panel.
///
/// Lists saved profiles, allows saving the current graph state and loading a profile.
use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;

use crate::audio::{AudioGraph, PwThread};
use crate::profiles::{apply::{apply_profile, snapshot_profile}, ProfileStore};

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
        // --- Name entry + Save button ---
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

        // --- Profile list ---
        let list_box = gtk4::ListBox::builder()
            .selection_mode(gtk4::SelectionMode::Single)
            .vexpand(true)
            .build();
        list_box.add_css_class("boxed-list");

        let scrolled = gtk4::ScrolledWindow::builder()
            .child(&list_box)
            .vexpand(true)
            .build();

        // --- Action buttons ---
        let load_btn = gtk4::Button::builder().label("Cargar").build();
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
        action_row.append(&delete_btn);

        // --- Status label ---
        let status_label = gtk4::Label::builder()
            .label("")
            .halign(gtk4::Align::Start)
            .build();

        // --- Root layout ---
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

        let view = Self {
            root,
            graph,
            pw,
            store,
            list_box,
            name_entry,
        };

        // --- Connect signals ---
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
                let ok = v.store.borrow().save(&profile);
                if ok {
                    status_ref.set_text(&format!("Perfil '{name}' guardado."));
                    v.refresh_list();
                } else {
                    status_ref.set_text("Error al guardar el perfil.");
                }
            });
        }

        {
            let v = view.clone();
            let status_ref = status_label.clone();
            load_btn.connect_clicked(move |_| {
                if let Some(name) = v.selected_name() {
                    if let Some(profile) = v.store.borrow().load(&name) {
                        let result = apply_profile(&profile, &v.graph.borrow(), &*v.pw);
                        status_ref.set_text(&format!(
                            "Perfil '{name}' cargado: {} enlaces aplicados, {} no resueltos.",
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

        {
            let v = view.clone();
            let status_ref = status_label.clone();
            delete_btn.connect_clicked(move |_| {
                if let Some(name) = v.selected_name() {
                    let ok = v.store.borrow().delete(&name);
                    if ok {
                        status_ref.set_text(&format!("Perfil '{name}' eliminado."));
                        v.refresh_list();
                    }
                } else {
                    status_ref.set_text("Selecciona un perfil de la lista.");
                }
            });
        }

        view.refresh_list();
        view
    }

    pub fn widget(&self) -> &gtk4::Widget {
        self.root.upcast_ref()
    }

    fn refresh_list(&self) {
        // Clear
        while let Some(row) = self.list_box.row_at_index(0) {
            self.list_box.remove(&row);
        }

        let names = self.store.borrow().list();
        for name in &names {
            let row = gtk4::ListBoxRow::new();
            let label = gtk4::Label::builder()
                .label(name)
                .halign(gtk4::Align::Start)
                .margin_top(6)
                .margin_bottom(6)
                .margin_start(8)
                .margin_end(8)
                .build();
            row.set_child(Some(&label));
            self.list_box.append(&row);
        }
    }

    fn selected_name(&self) -> Option<String> {
        let row = self.list_box.selected_row()?;
        let child = row.child()?;
        let label = child.downcast::<gtk4::Label>().ok()?;
        Some(label.text().to_string())
    }
}
