use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;

use log::debug;
use midir::{Ignore, MidiInput, MidiInputConnection};
use vst3_host::{midi::MidiEvent, plugin::Plugin};

use super::host::PluginHostHandle;

pub struct MidiInputRouterHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for MidiInputRouterHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl MidiInputRouterHandle {
    pub fn start(plugin_hosts: Arc<Mutex<HashMap<u32, PluginHostHandle>>>) -> Option<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let thread = std::thread::Builder::new()
            .name("audibian-midi-in".into())
            .spawn(move || run(plugin_hosts, stop_clone))
            .ok()?;

        Some(Self {
            stop,
            thread: Some(thread),
        })
    }
}

fn run(plugin_hosts: Arc<Mutex<HashMap<u32, PluginHostHandle>>>, stop: Arc<AtomicBool>) {
    let mut midi_in = match MidiInput::new("audibian-midi-in") {
        Ok(input) => input,
        Err(e) => {
            debug!("midi-in: init failed: {e}");
            return;
        }
    };
    midi_in.ignore(Ignore::None);

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let mut connected_ports = HashSet::<String>::new();
    let mut connections: Vec<MidiInputConnection<()>> = Vec::new();

    connect_ports(&midi_in, &tx, &mut connected_ports, &mut connections);

    let poll_interval = Duration::from_millis(250);
    while !stop.load(Ordering::Relaxed) {
        match rx.recv_timeout(poll_interval) {
            Ok(bytes) => dispatch_bytes(&plugin_hosts, &bytes),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                connect_ports(&midi_in, &tx, &mut connected_ports, &mut connections);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(connections);
}

fn connect_ports(
    midi_in: &MidiInput,
    tx: &mpsc::Sender<Vec<u8>>,
    connected_ports: &mut HashSet<String>,
    connections: &mut Vec<MidiInputConnection<()>>,
) {
    for (index, port) in midi_in.ports().into_iter().enumerate() {
        let port_name = midi_in
            .port_name(&port)
            .unwrap_or_else(|_| format!("port-{index}"));
        let key = format!("{index}:{port_name}");
        if connected_ports.contains(&key) {
            continue;
        }

        let connection_name = format!("audibian-midi-{index}");
        let sender = tx.clone();
        let mut input = match MidiInput::new("audibian-midi-in") {
            Ok(input) => input,
            Err(e) => {
                debug!("midi-in: failed to open {connection_name} ({port_name}): {e}");
                continue;
            }
        };
        input.ignore(Ignore::None);

        match input.connect(
            &port,
            &connection_name,
            move |_stamp, message, _| {
                let _ = sender.send(message.to_vec());
            },
            (),
        ) {
            Ok(connection) => {
                debug!("midi-in: connected {connection_name} ({port_name})");
                connected_ports.insert(key);
                connections.push(connection);
            }
            Err(e) => {
                debug!("midi-in: failed to connect {connection_name} ({port_name}): {e}");
            }
        }
    }
}

fn dispatch_bytes(plugin_hosts: &Arc<Mutex<HashMap<u32, PluginHostHandle>>>, bytes: &[u8]) {
    let Some(event) = MidiEvent::from_midi_bytes(bytes) else { return };

    let plugins: Vec<Arc<Mutex<Plugin>>> = {
        let hosts = plugin_hosts.lock().unwrap();
        hosts.values().map(|handle| handle.plugin.clone()).collect()
    };

    for plugin in plugins {
        if let Ok(mut plugin) = plugin.lock() {
            let _ = plugin.send_midi_event(event);
        }
    }
}