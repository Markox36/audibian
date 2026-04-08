mod audio;
mod profiles;
mod ui;

use ui::app::AudibianApp;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    pipewire::init();

    let app = AudibianApp::new();
    app.run();
}
