//! Embed external X11 windows (Carla plugin GUIs) inside audibian's
//! Tauri toplevel. Phase 2 of the in-app plugin rack: after Carla shows
//! a plugin's native window via OSC `/Carla/<id>/show_custom_ui`, we
//! locate that window by matching its `_NET_WM_PID` against the Carla
//! child process and reparent it under audibian. Coordinates are driven
//! by the UI (a placeholder div reports its on-screen rect each frame).
//!
//! X11 only. Wayland handling lives in a separate fallback.

use std::collections::VecDeque;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ConfigureWindowAux, ConnectionExt, EventMask,
    PropMode, Window,
};
use x11rb::rust_connection::RustConnection;
use x11rb::COPY_DEPTH_FROM_PARENT;

pub struct X11 {
    conn: RustConnection,
    root: Window,
    atom_net_wm_pid: u32,
    atom_motif_hints: u32,
}

impl X11 {
    pub fn connect() -> Option<Self> {
        let (conn, screen_num) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots[screen_num].root;
        let pid_atom = conn.intern_atom(false, b"_NET_WM_PID").ok()?.reply().ok()?.atom;
        let motif = conn.intern_atom(false, b"_MOTIF_WM_HINTS").ok()?.reply().ok()?.atom;
        Some(Self {
            conn,
            root,
            atom_net_wm_pid: pid_atom,
            atom_motif_hints: motif,
        })
    }

    /// Walk the X window tree under root, return all windows whose
    /// `_NET_WM_PID` equals `pid`. Plugins typically map one toplevel
    /// per UI; Carla's own rack window also matches the pid, so the
    /// caller filters by name.
    pub fn find_windows_by_pid(&self, pid: u32) -> Vec<Window> {
        let mut hits = Vec::new();
        let mut queue: VecDeque<Window> = VecDeque::new();
        queue.push_back(self.root);
        while let Some(w) = queue.pop_front() {
            if let Ok(prop) = self.conn.get_property(false, w, self.atom_net_wm_pid, AtomEnum::CARDINAL, 0, 1) {
                if let Ok(reply) = prop.reply() {
                    if let Some(mut vals) = reply.value32() {
                        if let Some(found) = vals.next() {
                            if found == pid {
                                hits.push(w);
                            }
                        }
                    }
                }
            }
            if let Ok(tree) = self.conn.query_tree(w) {
                if let Ok(reply) = tree.reply() {
                    for c in reply.children { queue.push_back(c); }
                }
            }
        }
        hits
    }

    /// Read WM_NAME (UTF-8 first, falling back to legacy STRING) for a
    /// window. Used to skip Carla's own toplevel ("Carla") when picking
    /// the plugin window.
    pub fn window_name(&self, w: Window) -> String {
        let utf8 = self.conn.intern_atom(false, b"_NET_WM_NAME").ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.atom)
            .unwrap_or(0);
        if utf8 != 0 {
            if let Ok(p) = self.conn.get_property(false, w, utf8, AtomEnum::ANY, 0, 1024) {
                if let Ok(r) = p.reply() {
                    if !r.value.is_empty() {
                        return String::from_utf8_lossy(&r.value).into_owned();
                    }
                }
            }
        }
        if let Ok(p) = self.conn.get_property(false, w, AtomEnum::WM_NAME, AtomEnum::ANY, 0, 1024) {
            if let Ok(r) = p.reply() {
                return String::from_utf8_lossy(&r.value).into_owned();
            }
        }
        String::new()
    }

    /// Strip window-manager decorations via `_MOTIF_WM_HINTS`. Required
    /// because the plugin window arrives as a normal decorated toplevel
    /// and the title bar / borders look broken once reparented.
    pub fn strip_decorations(&self, w: Window) {
        // struct MotifWmHints { flags, functions, decorations, input_mode, status }
        // flags bit 1 = MWM_HINTS_DECORATIONS; decorations=0 means none.
        let hints: [u32; 5] = [2, 0, 0, 0, 0];
        let bytes: Vec<u8> = hints.iter().flat_map(|v| v.to_ne_bytes()).collect();
        let _ = self.conn.change_property(
            PropMode::REPLACE,
            w,
            self.atom_motif_hints,
            self.atom_motif_hints,
            32,
            5,
            &bytes,
        );
        let _ = self.conn.flush();
    }

    /// Reparent `child` under `parent` at the given offset, then map it
    /// so the WM picks up the new geometry. Selects StructureNotify so
    /// further geometry changes flow back to us if needed.
    pub fn reparent(&self, child: Window, parent: Window, x: i16, y: i16) -> bool {
        let _ = self.conn.change_window_attributes(
            child,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
        );
        if self.conn.reparent_window(child, parent, x, y).is_err() {
            return false;
        }
        let _ = self.conn.map_window(child);
        self.conn.flush().is_ok()
    }

    pub fn move_resize(&self, w: Window, x: i32, y: i32, width: u32, height: u32) {
        let _ = self.conn.configure_window(
            w,
            &ConfigureWindowAux::new()
                .x(x)
                .y(y)
                .width(width)
                .height(height),
        );
        let _ = self.conn.flush();
    }

    /// Reverse of `reparent`: lift back to root so the plugin window
    /// becomes a normal toplevel again when the user closes the embed.
    pub fn unparent_to_root(&self, child: Window) {
        let _ = self.conn.reparent_window(child, self.root, 0, 0);
        let _ = self.conn.flush();
    }
}

// Silence unused warning when COPY_DEPTH_FROM_PARENT isn't referenced.
#[allow(dead_code)]
const _: u8 = COPY_DEPTH_FROM_PARENT;
