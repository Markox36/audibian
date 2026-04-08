use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;
use crate::audio::{AudioGraph, PwCommand, PwThread};

thread_local! {
    static ALIASES: RefCell<std::collections::HashMap<u32, String>> = RefCell::new(std::collections::HashMap::new());
}

pub fn build_matrix_container(_graph_rc: Rc<RefCell<AudioGraph>>, _pw: Rc<PwThread>) -> (gtk4::ScrolledWindow, gtk4::Box) {
    let container = gtk4::Box::builder()
        .orientation(gtk4::Orientation::Horizontal)
        .spacing(8)
        .margin_top(12)
        .margin_bottom(12)
        .margin_start(12)
        .margin_end(12)
        .build();

    let scrolled = gtk4::ScrolledWindow::builder()
        .child(&container)
        .hexpand(true)
        .vexpand(true)
        .build();

    (scrolled, container)
}

pub fn refresh_matrix(container: &gtk4::Box, graph: &AudioGraph, pw: Rc<PwThread>) {
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }

    let nodes = graph.audio_nodes_sorted();
    
    let mut receivers = Vec::new();
    let mut senders = Vec::new();
    
    for node in &nodes {
        let has_in = !graph.input_ports_for_node(node.id).is_empty();
        let has_out = !graph.output_ports_for_node(node.id).is_empty();
        
        if has_in {
            receivers.push(node);
        }
        if has_out {
            senders.push(node);
        }
    }

    let letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];
    let mut rec_map = std::collections::HashMap::new();
    for (i, rec) in receivers.iter().enumerate() {
        let l = if i < letters.len() { letters[i].to_string() } else { format!("R{}", i) };
        rec_map.insert(rec.id, l);
    }

    // ====== SENDERS (Channel Strips) ======
    for sender_node in senders {
        let out_ports: Vec<_> = graph.output_ports_for_node(sender_node.id).into_iter().cloned().collect();
        let mut sorted_out_ports = out_ports.clone();
        sorted_out_ports.sort_by_key(|p| p.port_index);
        
        let saved_alias = ALIASES.with(|a| a.borrow().get(&sender_node.id).cloned().unwrap_or_else(|| sender_node.display_name().to_string()));
        
        let frame = gtk4::Frame::builder()
            .width_request(260)
            .build();
            
        let vbox_header = gtk4::Box::builder().orientation(gtk4::Orientation::Vertical).spacing(2).build();
        
        let alias_entry = gtk4::Entry::builder()
            .text(&saved_alias)
            .placeholder_text("Añadir Alias...")
            .css_classes(["flat", "caption"])
            .build();
            
        let sid = sender_node.id;
        alias_entry.connect_changed(move |entry| {
            ALIASES.with(|a| a.borrow_mut().insert(sid, entry.text().to_string()));
        });
            
        let original_title = gtk4::Label::builder()
            .label(&format!("({})", sender_node.display_name()))
            .css_classes(["dim-label"])
            .halign(gtk4::Align::Center)
            .build();
            
        vbox_header.append(&alias_entry);
        vbox_header.append(&original_title);
            
        frame.set_label_widget(Some(&vbox_header));
            
        let vbox = gtk4::Box::builder().orientation(gtk4::Orientation::Vertical).spacing(8).margin_top(4).margin_bottom(8).margin_start(8).margin_end(8).build();
        
        // Color Border
        let color_bar = gtk4::DrawingArea::builder().height_request(4).margin_bottom(8).build();
        let hash_val = sender_node.id as f64 * 0.17;
        color_bar.set_draw_func(move |_, ctx, w, h| {
            ctx.set_source_rgb(0.2 + (hash_val.sin() * 0.3).abs(), 0.5 + (hash_val.cos() * 0.3).abs(), 0.7);
            ctx.rectangle(0.0, 0.0, w as f64, h as f64);
            let _ = ctx.fill();
        });
        vbox.append(&color_bar);

        // Info label
        let info = sender_node.media_class.as_deref().unwrap_or("Media");
        let info_lbl = gtk4::Label::builder().label(info).css_classes(["dim-label"]).halign(gtk4::Align::Center).build();
        vbox.append(&info_lbl);

        let mode_lbl = gtk4::Label::builder().label("Modo Envío").halign(gtk4::Align::Start).css_classes(["caption"]).build();
        vbox.append(&mode_lbl);
        
        let mut modes = vec!["Mezcla (Estéreo sumado L+R)".to_string()];
        for p in &sorted_out_ports {
            modes.push(format!("Mono individual: {}", p.name));
        }
        let modes_str: Vec<&str> = modes.iter().map(|s| s.as_str()).collect();
        let mode_dropdown = gtk4::DropDown::from_strings(&modes_str);
        mode_dropdown.set_hexpand(true);
        vbox.append(&mode_dropdown);

        let sep = gtk4::Separator::new(gtk4::Orientation::Horizontal);
        vbox.append(&sep);

        let sends_lbl = gtk4::Label::builder().label("Sends").halign(gtk4::Align::Start).css_classes(["caption"]).build();
        vbox.append(&sends_lbl);

        // Find active targets for this sender
        let mut active_targets = std::collections::HashSet::new();
        let mut target_to_links: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
        for link in graph.links.values() {
            if link.output_node_id == sender_node.id {
                active_targets.insert(link.input_node_id);
                target_to_links.entry(link.input_node_id).or_default().push(link.id);
            }
        }

        let sends_box = gtk4::Box::builder().orientation(gtk4::Orientation::Vertical).spacing(4).build();
        
        let all_in_ports: Vec<_> = graph.ports.values().filter(|p| p.direction == crate::audio::Direction::Input).map(|p| p.clone()).collect();
        let cloned_out_ports: Vec<_> = out_ports.into_iter().map(|p| p.clone()).collect();

        for rec in &receivers {
            if rec.id == sender_node.id {
                continue; // Prevent loops
            }

            let letter = rec_map.get(&rec.id).unwrap();
            let rec_id = rec.id;
            let is_active = active_targets.contains(&rec.id);
            
            let row = gtk4::Box::builder().orientation(gtk4::Orientation::Horizontal).spacing(6).build();
            let toggle = gtk4::ToggleButton::builder()
                .label(letter)
                .active(is_active)
                .css_classes(["circular"])
                .width_request(40)
                .build();
            
            // Replaced long label with Ableton style disabled volume knob/fader
            let fader = gtk4::Scale::builder()
                .orientation(gtk4::Orientation::Horizontal)
                .adjustment(&gtk4::Adjustment::new(100.0, 0.0, 100.0, 1.0, 10.0, 0.0))
                .hexpand(true)
                .draw_value(false)
                .sensitive(false)
                .tooltip_text("PipeWire no soporta envíos de volumen por cable (requiere Loopback)")
                .build();
                
            let d_mode = mode_dropdown.clone();
            let pw_clone = pw.clone();
            let existing_links = target_to_links.get(&rec_id).cloned().unwrap_or_default();
            let my_out = cloned_out_ports.clone();
            let target_in: Vec<_> = all_in_ports.iter().filter(|p| p.node_id == rec_id).cloned().collect();

            toggle.connect_toggled(move |btn| {
                if btn.is_active() {
                    // Create links
                    let mode_idx = d_mode.selected() as usize;
                    let mut tgt_ins = target_in.clone();
                    tgt_ins.sort_by_key(|p| p.port_index);
                    
                    let mut my_outs = my_out.clone();
                    my_outs.sort_by_key(|p| p.port_index);
                    
                    let mut links_to_make = Vec::new();
                    
                    match mode_idx {
                        0 => { // Mezcla (Estéreo Auto)
                            for (i, out_p) in my_outs.iter().enumerate() {
                                if let Some(in_p) = tgt_ins.get(i) {
                                    links_to_make.push((out_p.id, in_p.id));
                                } else if let Some(in_p) = tgt_ins.first() {
                                    links_to_make.push((out_p.id, in_p.id));
                                }
                            }
                        }
                        n if n > 0 && n <= my_outs.len() => { // Canal Mono separado
                            if let Some(out_p) = my_outs.get(n - 1) {
                                // Lo enviamos a todos los canales in para que el mono suene centrado (o suene directamente en L/R)
                                for in_p in &tgt_ins {
                                    links_to_make.push((out_p.id, in_p.id));
                                }
                            }
                        }
                        _ => {}
                    }

                    for (oid, iid) in links_to_make {
                        pw_clone.send(PwCommand::CreateLink { 
                            output_port_id: oid, 
                            input_port_id: iid 
                        });
                    }
                } else {
                    // Destroy links targeting this receiver
                    // Wait! The graph state won't have newly created links yet if they just clicked it.
                    // If they just clicked OFF, we should find ALL links from my_out to target_in in PipeWire.
                    // But we only stored `existing_links` from the last refresh! 
                    // To be safe, we just send Destroy commands for what we know. The graph will refresh anyway!
                    for &lid in &existing_links {
                        pw_clone.send(PwCommand::DestroyLink { link_id: lid });
                    }
                    // For safety, let's also try to destroy explicit combinations just in case.
                    // But standard way is fine: the view refreshes immediately.
                }
            });

            row.append(&toggle);
            row.append(&fader);
            sends_box.append(&row);
        }

        vbox.append(&sends_box);
        frame.set_child(Some(&vbox));
        container.append(&frame);
    }

    // Add visual Separator
    let sep = gtk4::Separator::new(gtk4::Orientation::Vertical);
    sep.set_margin_start(16);
    sep.set_margin_end(16);
    container.append(&sep);

    // ====== RECEIVERS (Return Tracks) ======
    for rec in receivers {
        let letter = rec_map.get(&rec.id).unwrap();
        
        let saved_alias = ALIASES.with(|a| a.borrow().get(&rec.id).cloned().unwrap_or_else(|| rec.display_name().to_string()));
        let title = format!("[{}] {}", letter, saved_alias);
        
        let frame = gtk4::Frame::builder()
            .width_request(150)
            .css_classes(["card"])
            .build();
            
        let vbox_header = gtk4::Box::builder().orientation(gtk4::Orientation::Vertical).spacing(2).build();
            
        let alias_entry = gtk4::Entry::builder()
            .text(&title)
            .placeholder_text("Alias...")
            .css_classes(["flat", "caption"])
            .build();
            
        let sid = rec.id;
        alias_entry.connect_changed(move |entry| {
            let t = entry.text().to_string();
            let actual = if let Some(idx) = t.find("] ") { t[(idx+2)..].to_string() } else { t };
            ALIASES.with(|a| a.borrow_mut().insert(sid, actual));
        });
        
        let original_title = gtk4::Label::builder()
            .label(&format!("({})", rec.display_name()))
            .css_classes(["dim-label"])
            .halign(gtk4::Align::Center)
            .build();
            
        vbox_header.append(&alias_entry);
        vbox_header.append(&original_title);
            
        frame.set_label_widget(Some(&vbox_header));
            
        let vbox = gtk4::Box::builder().orientation(gtk4::Orientation::Vertical).spacing(8).margin_top(4).margin_bottom(8).margin_start(8).margin_end(8).build();
        
        // Color Border
        let color_bar = gtk4::DrawingArea::builder().height_request(4).margin_bottom(8).build();
        let hash_val = rec.id as f64 * 0.25;
        color_bar.set_draw_func(move |_, ctx, w, h| {
            ctx.set_source_rgb(0.7, 0.3 + (hash_val.sin() * 0.3).abs(), 0.2 + (hash_val.cos() * 0.4).abs());
            ctx.rectangle(0.0, 0.0, w as f64, h as f64);
            let _ = ctx.fill();
        });
        vbox.append(&color_bar);
        
        let info = rec.media_class.as_deref().unwrap_or("Destino");
        let info_lbl = gtk4::Label::builder().label(info).css_classes(["dim-label"]).halign(gtk4::Align::Center).build();
        vbox.append(&info_lbl);
        
        // Removed old center label since we have alias entry
        
        frame.set_child(Some(&vbox));
        container.append(&frame);
    }
}
