PREFIX  ?= /usr/local
BINDIR  := $(PREFIX)/bin
DATADIR := $(PREFIX)/share

ICON_SIZES := 16 24 32 48 64 128 256

.PHONY: all build release install uninstall icons deb rpm appimage clean

# ── Build ──────────────────────────────────────────────────────────────────

all: build

build:
	cargo build

release:
	cargo build --release

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

install: release
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

# ── Package: AppImage ─────────────────────────────────────────────────────

appimage: release
	@bash packaging/build-appimage.sh

# ── Clean ─────────────────────────────────────────────────────────────────

clean:
	cargo clean
	rm -rf packaging/AppDir packaging/*.AppImage
