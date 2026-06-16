PREFIX  ?= /usr/local
BINDIR  := $(PREFIX)/bin
DATADIR := $(PREFIX)/share

ICON_SIZES := 16 24 32 48 64 128 256

.PHONY: all build release dev run kill install uninstall install-autostart uninstall-autostart install-systemd uninstall-systemd icons deb rpm arch arch-docker appimage clean

# ── Build ──────────────────────────────────────────────────────────────────

all: build

build:
	cargo build

release:
	cargo build --release

# ── Run ────────────────────────────────────────────────────────────────────
# `make dev`  — hot-reload workflow. Spawns vite via tauri.conf.json's
#               beforeDevCommand, then the rust binary connects to it on
#               localhost:5173. Kills any stale audibian process first so
#               we never end up with two GUI instances fighting for state.
# `make run`  — single-shot launch. Builds the UI to ui/dist and runs the
#               release binary against the bundled assets — no vite, no
#               localhost dependency, no "Connection refused".

kill:
	-pkill -x audibian 2>/dev/null || true
	-pkill -f 'target/debug/audibian' 2>/dev/null || true
	-pkill -f 'target/release/audibian' 2>/dev/null || true
	@sleep 0.3

dev: kill
	cargo tauri dev

# Build UI bundle FIRST so tauri's release binary serves the latest
# ui/dist at runtime. Then build the rust release binary. Then launch.
# Order matters: a stale ui/dist results in the webview loading old assets.
run: kill
	cd ui && pnpm install --frozen-lockfile && pnpm run build
	cargo build --release
	./target/release/audibian

# ── Icons (PNG from SVG — requires rsvg-convert or inkscape) ───────────────

icons: data/icons/scalable/apps/audibian.svg
	@command -v rsvg-convert >/dev/null 2>&1 || \
	  { echo "ERROR: rsvg-convert not found. Install: sudo apt install librsvg2-bin"; exit 1; }
	@for size in $(ICON_SIZES); do \
	  dir=data/icons/$${size}x$${size}/apps; \
	  mkdir -p $$dir; \
	  rsvg-convert -w $$size -h $$size \
	    data/icons/scalable/apps/audibian.svg \
	    -o $$dir/audibian.png; \
	  echo "  → $${size}x$${size}"; \
	done
	@echo "Icons generated."

# ── Install / Uninstall ───────────────────────────────────────────────────

install:
	@test -f target/release/audibian || { \
	  echo "ERROR: target/release/audibian not found."; \
	  echo "Run 'make release' first (as your user, NOT sudo)."; \
	  exit 1; }
	install -Dm755 target/release/audibian           $(DESTDIR)$(BINDIR)/audibian
	install -Dm644 data/audibian.desktop             $(DESTDIR)$(DATADIR)/applications/audibian.desktop
	install -Dm644 data/icons/scalable/apps/audibian.svg \
	                                                 $(DESTDIR)$(DATADIR)/icons/hicolor/scalable/apps/audibian.svg
	@for size in $(ICON_SIZES); do \
	  src=data/icons/$${size}x$${size}/apps/audibian.png; \
	  if [ -f "$$src" ]; then \
	    install -Dm644 $$src \
	      $(DESTDIR)$(DATADIR)/icons/hicolor/$${size}x$${size}/apps/audibian.png; \
	    echo "  installed $${size}x$${size} icon"; \
	  fi; \
	done
	gtk-update-icon-cache -f -t $(DESTDIR)$(DATADIR)/icons/hicolor 2>/dev/null || true
	update-desktop-database $(DESTDIR)$(DATADIR)/applications 2>/dev/null || true
	@echo "Audibian installed to $(PREFIX)."

uninstall:
	rm -f  $(DESTDIR)$(BINDIR)/audibian
	rm -f  $(DESTDIR)$(DATADIR)/applications/audibian.desktop
	rm -f  $(DESTDIR)$(DATADIR)/icons/hicolor/scalable/apps/audibian.svg
	@for size in $(ICON_SIZES); do \
	  rm -f $(DESTDIR)$(DATADIR)/icons/hicolor/$${size}x$${size}/apps/audibian.png; \
	done
	gtk-update-icon-cache -f -t $(DESTDIR)$(DATADIR)/icons/hicolor 2>/dev/null || true
	@echo "Audibian uninstalled."

# ── Autostart (per-user XDG autostart) ────────────────────────────────────
# Copies the .desktop entry into ~/.config/autostart so Audibian launches
# on login. Per-user; does not require root.

AUTOSTART_DIR := $(HOME)/.config/autostart

install-autostart:
	@mkdir -p $(AUTOSTART_DIR)
	@install -m644 data/audibian.desktop $(AUTOSTART_DIR)/audibian.desktop
	@grep -q '^X-GNOME-Autostart-enabled=' $(AUTOSTART_DIR)/audibian.desktop || \
	  echo 'X-GNOME-Autostart-enabled=true' >> $(AUTOSTART_DIR)/audibian.desktop
	@echo "Autostart enabled at $(AUTOSTART_DIR)/audibian.desktop"

uninstall-autostart:
	@rm -f $(AUTOSTART_DIR)/audibian.desktop
	@echo "Autostart disabled."

# ── systemd user service (headless persistent state) ─────────────────────
# Runs `audibian --apply-persistent` on graphical-session start so the
# audio routing graph (virtual sinks, returns, EQ, loopbacks) exists from
# login without the GUI running. The GUI is independent of this service.

SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user

install-systemd:
	@mkdir -p $(SYSTEMD_USER_DIR)
	@install -m644 data/audibian-apply.service $(SYSTEMD_USER_DIR)/audibian-apply.service
	@systemctl --user daemon-reload
	@systemctl --user enable audibian-apply.service
	@echo "Systemd user service installed and enabled."
	@echo "Start now with: systemctl --user start audibian-apply.service"

uninstall-systemd:
	@systemctl --user disable audibian-apply.service 2>/dev/null || true
	@systemctl --user stop audibian-apply.service 2>/dev/null || true
	@rm -f $(SYSTEMD_USER_DIR)/audibian-apply.service
	@systemctl --user daemon-reload
	@echo "Systemd user service removed."

# ── Package: .deb ─────────────────────────────────────────────────────────
# Requires: cargo install cargo-deb

deb: release
	@command -v cargo-deb >/dev/null 2>&1 || \
	  { echo "Install with: cargo install cargo-deb"; exit 1; }
	cargo deb
	@echo "Package ready in target/debian/"

# ── Package: .rpm ─────────────────────────────────────────────────────────
# Requires: cargo install cargo-generate-rpm

rpm: release
	@command -v cargo-generate-rpm >/dev/null 2>&1 || \
	  { echo "Install with: cargo install cargo-generate-rpm"; exit 1; }
	cargo generate-rpm
	@echo "Package ready in target/generate-rpm/"

# ── Package: Arch (pacman .pkg.tar.zst) ───────────────────────────────────
# Requires: base-devel (makepkg). Run on an Arch host or in an Arch container.

arch: icons
	@command -v makepkg >/dev/null 2>&1 || \
	  { echo "makepkg not found. Run inside Arch Linux (pacman -S base-devel)."; exit 1; }
	cd packaging/arch && makepkg -f -p PKGBUILD.local
	@echo "Package ready in packaging/arch/*.pkg.tar.zst"

# Build the Arch package on non-Arch hosts via Docker.
arch-docker: icons
	@command -v docker >/dev/null 2>&1 || { echo "docker not found."; exit 1; }
	docker run --rm -v "$(CURDIR)":/src -w /src archlinux:latest bash -c '\
	  pacman -Syu --noconfirm --needed base-devel rust pnpm nodejs pkgconf \
	    webkit2gtk-4.1 gtk3 librsvg pipewire pipewire-pulse && \
	  useradd -m builder && chown -R builder /src && \
	  su builder -c "cd /src/packaging/arch && makepkg -f -p PKGBUILD.local"'
	@echo "Package ready in packaging/arch/*.pkg.tar.zst"

# ── Package: AppImage ─────────────────────────────────────────────────────

appimage: release
	@bash packaging/build-appimage.sh

# ── Clean ─────────────────────────────────────────────────────────────────

clean:
	cargo clean
	rm -rf packaging/AppDir packaging/*.AppImage
