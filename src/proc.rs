//! Fire-and-forget subprocess helpers.
//!
//! `std::process::Child` does not reap the child when it is dropped — the
//! standard library documents this explicitly. Every `let _ = Command::spawn()`
//! therefore leaves a zombie behind for as long as Audibian runs. That adds up
//! fast: one `pw-link` per routing change, one `pactl` per mixer action.
//!
//! [`CommandExt::spawn_detached`] parks the child in a registry and sweeps the
//! finished ones on the next call, so the table stays bounded without a
//! dedicated reaper thread and without blocking the caller.
//!
//! Long-lived children the caller needs to keep or kill later — the
//! filter-chain processes in [`crate::audio::effects`] and
//! [`crate::audio::strip_eq`], the soundboard `paplay`/`ffmpeg` pipes — keep
//! using `Command::spawn` directly and own their handle.

use std::process::{Child, Command};
use std::sync::Mutex;

use log::warn;

/// Children spawned via [`CommandExt::spawn_detached`] that have not exited yet.
static PENDING: Mutex<Vec<Child>> = Mutex::new(Vec::new());

pub trait CommandExt {
    /// Spawn the command without waiting for it, reaping whatever finished
    /// since the last call.
    ///
    /// Failures are logged rather than returned: every call site is a
    /// best-effort side effect on the audio graph.
    fn spawn_detached(&mut self);
}

impl CommandExt for Command {
    fn spawn_detached(&mut self) {
        // A poisoned lock only means some other thread panicked mid-sweep; the
        // vector itself is still usable, and dropping reaping duties here would
        // reintroduce the leak.
        let mut pending = match PENDING.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        // `try_wait` never blocks. `Ok(None)` means still running, so keep it;
        // anything else is either reaped or unwaitable and can be dropped.
        pending.retain_mut(|child| matches!(child.try_wait(), Ok(None)));

        match self.spawn() {
            Ok(child) => pending.push(child),
            Err(e) => warn!("failed to spawn {:?}: {e}", self.get_program()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Count this process' children still sitting in zombie state.
    fn zombie_children() -> usize {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return 0;
        };
        let me = std::process::id();
        entries
            .filter_map(Result::ok)
            .filter(|e| {
                let Ok(status) = std::fs::read_to_string(e.path().join("status")) else {
                    return false;
                };
                let zombie = status
                    .lines()
                    .any(|l| l.starts_with("State:") && l.contains('Z'));
                let ours = status
                    .lines()
                    .any(|l| l.strip_prefix("PPid:").is_some_and(|p| p.trim() == me.to_string()));
                zombie && ours
            })
            .count()
    }

    #[test]
    fn detached_children_do_not_pile_up_as_zombies() {
        for _ in 0..20 {
            Command::new("true").spawn_detached();
        }

        // `true` exits immediately, but reaping only happens on the next call,
        // so give the children time to die and then trigger one sweep.
        std::thread::sleep(std::time::Duration::from_millis(300));
        Command::new("true").spawn_detached();

        let leaked = zombie_children();
        assert!(leaked <= 1, "expected at most the just-spawned child, found {leaked} zombies");

        let tracked = PENDING.lock().unwrap().len();
        assert!(tracked <= 2, "registry grew to {tracked} entries");
    }
}
