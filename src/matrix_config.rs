use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortLink {
    pub src: String,
    pub dst: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatrixNodeConn {
    pub src_node: String,
    pub dst_node: String,
    pub links: Vec<PortLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MatrixConfig {
    #[serde(default)]
    pub connections: Vec<MatrixNodeConn>,
}

impl MatrixConfig {
    fn config_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join(".config/audibian/matrix.toml")
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = toml::to_string_pretty(self) {
            let _ = std::fs::write(path, s);
        }
    }

    pub fn set_node_pair(&mut self, src_node: &str, dst_node: &str, links: Vec<PortLink>) {
        self.connections.retain(|c| !(c.src_node == src_node && c.dst_node == dst_node));
        if !links.is_empty() {
            self.connections.push(MatrixNodeConn {
                src_node: src_node.to_string(),
                dst_node: dst_node.to_string(),
                links,
            });
        }
    }

    pub fn connections_involving(&self, node_name: &str) -> Vec<&MatrixNodeConn> {
        self.connections.iter()
            .filter(|c| c.src_node == node_name || c.dst_node == node_name)
            .collect()
    }
}
