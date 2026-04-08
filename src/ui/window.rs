use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;
use libadwaita::prelude::*;

use crate::audio::{AudioGraph, PwThread};
use crate::profiles::ProfileStore;

use super::effects::EffectsView;
use super::mixer::MixerView;
use super::patchbay::PatchbayView;
use super::profiles::ProfilesView;

/// The application's main window.
#[derive(Clone)]
pub struct MainWindow {
    pub window: libadwaita::ApplicationWindow,
    patchbay: PatchbayView,
    mixer: MixerView,
    effects: EffectsView,
    #[allow(dead_code)]
    profiles_view: ProfilesView,
    disconnected_banner: libadwaita::Banner,
}

impl MainWindow {
    pub fn new(
        app: &libadwaita::Application,
        graph: Rc<RefCell<AudioGraph>>,
        pw: Rc<PwThread>,
        profile_store: Rc<RefCell<ProfileStore>>,
    ) -> Self {
        let window = libadwaita::ApplicationWindow::builder()
            .application(app)
            .title("Audibian")
            .default_width(1100)
            .default_height(700)
            .build();

        // --- Disconnected banner ---
        let disconnected_banner = libadwaita::Banner::builder()
            .title("PipeWire disconnected")
            .revealed(false)
            .build();

        // --- Tab views ---
        let patchbay = PatchbayView::new(graph.clone(), pw.clone());
        let mixer = MixerView::new(graph.clone(), pw.clone());
        let effects = EffectsView::new(graph.clone());
        let profiles_view = ProfilesView::new(graph.clone(), pw.clone(), profile_store.clone());

        // --- ViewStack (tabs) ---
        let stack = libadwaita::ViewStack::new();
        stack.add_titled_with_icon(patchbay.widget(), Some("patchbay"), "Patchbay", "network-wireless-symbolic");
        stack.add_titled_with_icon(mixer.widget(), Some("mixer"), "Mixer", "audio-volume-high-symbolic");
        stack.add_titled_with_icon(effects.widget(), Some("effects"), "Efectos / EQ", "media-eq-symbolic");
        stack.add_titled_with_icon(profiles_view.widget(), Some("profiles"), "Perfiles", "bookmark-new-symbolic");

        // --- Tab bar ---
        let switcher_bar = libadwaita::ViewSwitcherBar::builder()
            .stack(&stack)
            .reveal(true)
            .build();

        // --- Header bar ---
        let header = libadwaita::HeaderBar::new();
        let switcher = libadwaita::ViewSwitcher::builder()
            .stack(&stack)
            .policy(libadwaita::ViewSwitcherPolicy::Wide)
            .build();
        header.set_title_widget(Some(&switcher));

        // --- Layout ---
        let vbox = gtk4::Box::new(gtk4::Orientation::Vertical, 0);
        vbox.append(&header);
        vbox.append(&disconnected_banner);
        vbox.append(&stack);
        vbox.append(&switcher_bar);

        window.set_content(Some(&vbox));

        Self {
            window,
            patchbay,
            mixer,
            effects,
            profiles_view,
            disconnected_banner,
        }
    }

    pub fn present(&self) {
        self.window.present();
    }

    pub fn refresh_patchbay(&self) {
        self.patchbay.refresh();
    }

    pub fn refresh_mixer(&self) {
        self.mixer.refresh();
    }

    pub fn refresh_effects(&self) {
        self.effects.refresh_sinks();
    }

    pub fn show_disconnected_banner(&self) {
        self.disconnected_banner.set_revealed(true);
    }
}
