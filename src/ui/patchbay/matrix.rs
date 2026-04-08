use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;
use crate::audio::{AudioGraph, PwCommand, PwThread};

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
    
    // Build a vertical strip for each Node that has Output Ports
    for node in nodes {
        let out_ports = graph.output_ports_for_node(node.id);
        if out_ports.is_empty() {
            continue;
        }

        let frame = gtk4::Frame::builder()
            .label(node.display_name())
            .width_request(200)
            .build();
            
        let vbox = gtk4::Box::builder().orientation(gtk4::Orientation::Vertical).spacing(8).margin_top(8).margin_bottom(8).margin_start(8).margin_end(8).build();

        // 1. Existing Sends Box
        let sends_lbl = gtk4::Label::builder().label("Sends / Audio To").halign(gtk4::Align::Start).css_classes(["caption"]).build();
        vbox.append(&sends_lbl);

        let mut existing_node_targets = std::collections::HashSet::new();
        let mut active_sends = Vec::new(); // Store tuples of (link_ids: Vec<u32>, desc)
        
        // Group links by target node to show aggregated sends (like "Main (Stereo)")
        let mut target_to_links: std::collections::HashMap<u32, Vec<&crate::audio::graph::AudioLink>> = std::collections::HashMap::new();
        for link in graph.links.values() {
            if link.output_node_id == node.id {
                target_to_links.entry(link.input_node_id).or_default().push(link);
            }
        }

        for (target_id, links) in target_to_links {
            let mut tgt_name = format!("Node {}", target_id);
            if let Some(tn) = graph.nodes.get(&target_id) {
                tgt_name = tn.display_name().to_string();
            }
            existing_node_targets.insert(target_id);
            
            let l_ids: Vec<u32> = links.iter().map(|l| l.id).collect();
            let desc = format!("{} ({} cables)", tgt_name, links.len());
            active_sends.push((l_ids, desc));
        }

        for (l_ids, desc) in active_sends {
            let row = gtk4::Box::builder().orientation(gtk4::Orientation::Horizontal).spacing(4).build();
            let lbl = gtk4::Label::builder().label(&desc).ellipsize(gtk4::pango::EllipsizeMode::End).hexpand(true).halign(gtk4::Align::Start).build();
            let btn_rm = gtk4::Button::builder().label("✕").css_classes(["destructive-action", "circular"]).build();
            let pw_clone = pw.clone();
            btn_rm.connect_clicked(move |_| {
                for &id in &l_ids {
                    pw_clone.send(PwCommand::DestroyLink { link_id: id });
                }
            });
            row.append(&lbl);
            row.append(&btn_rm);
            vbox.append(&row);
        }

        // 2. New Send Section
        let sep = gtk4::Separator::new(gtk4::Orientation::Horizontal);
        vbox.append(&sep);

        // Target Node Dropdown
        let mut target_nodes = Vec::new();
        for n in graph.audio_nodes_sorted() {
            if n.id != node.id {
                target_nodes.push((n.id, n.display_name().to_string()));
            }
        }

        let node_str_refs: Vec<&str> = target_nodes.iter().map(|(_, name)| name.as_str()).collect();
        let node_ids: Vec<u32> = target_nodes.iter().map(|(id, _)| *id).collect();

        if !node_str_refs.is_empty() {
            let node_dropdown = gtk4::DropDown::from_strings(&node_str_refs);
            node_dropdown.set_hexpand(true);
            vbox.append(&node_dropdown);

            // Target Mode/Port Dropdown
            // We populate this based on the selected node. But GTK DropDown dynamic updates require 
            // replacing the model. For simplicity, we just include standard combinations.
            let modes = vec![
                "Ambos (Stereo L+R)",
                "Solo Izquierda (L)",
                "Solo Derecha (R)",
            ];
            // We could dynamically update `mode_dropdown` by listening to `node_dropdown` property changes,
            // but simply providing semantic mappings is sufficient.
            let mode_dropdown = gtk4::DropDown::from_strings(&modes);
            mode_dropdown.set_hexpand(true);
            vbox.append(&mode_dropdown);

            let btn_add = gtk4::Button::builder().label("Añadir Envío +").css_classes(["suggested-action"]).build();
            let pw_clone = pw.clone();
            let source_id = node.id;
            let out_ports: Vec<_> = out_ports.into_iter().map(|p| p.clone()).collect();
            // clone inner fields carefully
            let all_in_ports: Vec<_> = graph.ports.values().filter(|p| p.direction == crate::audio::Direction::Input).map(|p| p.clone()).collect();

            let target_ids_clone = node_ids.clone();
            let d_node = node_dropdown.clone();
            let d_mode = mode_dropdown.clone();

            btn_add.connect_clicked(move |_| {
                let tgt_idx = d_node.selected() as usize;
                let mode_idx = d_mode.selected() as usize;
                
                if let Some(&tgt_node_id) = target_ids_clone.get(tgt_idx) {
                    let mut target_in_ports: Vec<_> = all_in_ports.iter().filter(|p| p.node_id == tgt_node_id).collect();
                    // sort by port_index to ensure L is 0 and R is 1
                    target_in_ports.sort_by_key(|p| p.port_index);
                    
                    let mut my_out: Vec<_> = out_ports.iter().collect();
                    my_out.sort_by_key(|p| p.port_index);

                    let mut links_to_make = Vec::new(); // (out_port_id, in_port_id)
                    
                    match mode_idx {
                        0 => { // Ambos (Stereo L+R)
                            for (i, out_p) in my_out.iter().enumerate() {
                                if let Some(in_p) = target_in_ports.get(i) {
                                    links_to_make.push((out_p.id, in_p.id));
                                } else if let Some(in_p) = target_in_ports.first() {
                                    // If target is mono, mix to it
                                    links_to_make.push((out_p.id, in_p.id));
                                }
                            }
                        }
                        1 => { // Solo Izquierda (L)
                            if let Some(out_p) = my_out.first() {
                                if let Some(in_p) = target_in_ports.first() {
                                    links_to_make.push((out_p.id, in_p.id));
                                }
                            }
                        }
                        2 => { // Solo Derecha (R)
                            if let Some(out_p) = my_out.get(1).or_else(|| my_out.first()) {
                                if let Some(in_p) = target_in_ports.get(1).or_else(|| target_in_ports.first()) {
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
                }
            });

            vbox.append(&btn_add);
        }

        frame.set_child(Some(&vbox));
        container.append(&frame);
    }
}
