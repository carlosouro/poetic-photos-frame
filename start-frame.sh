#!/bin/bash

# 1. Get the directory where this script is located
# This makes the script portable - it works wherever you clone the repo
PROJECT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# 2. Configure display and disable screen saver
# Supports X11 and Wayland / labwc environments
export DISPLAY="${DISPLAY:-:0}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if command -v xset &> /dev/null; then
    xset s noblank 2>/dev/null || true
    xset s off 2>/dev/null || true
    xset -dpms 2>/dev/null || true
fi

# 3. Navigate to project directory
cd "$PROJECT_DIR"

# 4. Load Configuration
# We default to port 3000, but try to read from .env if it exists
PORT=3000
if [ -f .env ]; then
    ENV_PORT=$(grep -E "^PORT=" .env | tail -n 1 | cut -d '=' -f2 | tr -d '[:space:]')
    if [ -n "$ENV_PORT" ]; then
        PORT=$ENV_PORT
    fi
fi

# 5. Wait briefly for Wayland compositor socket & NTP clock sync on boot
# Prevents Chromium NetworkService crashes caused by large RTC/NTP clock jumps during startup
if [ -n "$XDG_RUNTIME_DIR" ] && [ -n "$WAYLAND_DISPLAY" ]; then
    wl_wait=0
    while [ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && [ $wl_wait -lt 15 ]; do
        sleep 1
        wl_wait=$((wl_wait+1))
    done
fi

if command -v timedatectl &> /dev/null; then
    ntp_wait=0
    while [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != "yes" ] && [ $ntp_wait -lt 12 ]; do
        sleep 1
        ntp_wait=$((ntp_wait+1))
    done
fi

# 6. Log Management (Retain up to 10,000 lines across runs and reboots)
LOG_FILE="frame.log"
KIOSK_LOG="kiosk.log"
MAX_LOG_LINES=10000

if [ -f "$LOG_FILE" ]; then
    tail -n "$MAX_LOG_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
    echo "" >> "$LOG_FILE"
    echo "==========================================" >> "$LOG_FILE"
    echo "=== Session Started: $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$LOG_FILE"
    echo "==========================================" >> "$LOG_FILE"
else
    echo "==========================================" > "$LOG_FILE"
    echo "=== Session Started: $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$LOG_FILE"
    echo "==========================================" >> "$LOG_FILE"
fi

# Stop any stale server instance from a previous session
pkill -f "node dist/server.js" 2>/dev/null || true
sleep 0.5

# Ensure compiled server exists
if [ ! -f "dist/server.js" ]; then
    echo "dist/server.js missing, running npm run build..." >> "$LOG_FILE"
    npm run build >> "$LOG_FILE" 2>&1
fi

# 7. Start Node.js directly in background (avoids npm wrapper overhead and ensures clean trap cleanup)
node dist/server.js >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
    if kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# 8. SMART WAIT: Loop until the server responds
echo "Waiting for server to start on port $PORT (PID $SERVER_PID)..." >> "$LOG_FILE"

count=0
while ! curl -sf --max-time 2 "http://localhost:$PORT" > /dev/null; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "Server process exited unexpectedly! Check frame.log." >> "$LOG_FILE"
        exit 1
    fi
    sleep 1
    count=$((count+1))
    if [ $count -ge 60 ]; then
        echo "Server timeout! Launching browser anyway." >> "$LOG_FILE"
        break
    fi
done

echo "Server is UP! Preparing Chromium kiosk..." >> "$LOG_FILE"

# 9. Clean Chromium crash recovery state & stale singleton locks (after unclean power-off)
CHROMIUM_DIR="$HOME/.config/chromium"
CHROMIUM_PREFS="$CHROMIUM_DIR/Default/Preferences"
if ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then
    rm -f "$CHROMIUM_DIR/SingletonLock" "$CHROMIUM_DIR/SingletonSocket" "$CHROMIUM_DIR/SingletonCookie" 2>/dev/null || true
    if [ -f "$CHROMIUM_PREFS" ]; then
        sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g; s/"exited_cleanly":false/"exited_cleanly":true/g' "$CHROMIUM_PREFS" 2>/dev/null || true
    fi
fi

# 10. Determine Browser (Auto-detect)
if command -v chromium-browser &> /dev/null; then
    BROWSER="chromium-browser"
elif command -v chromium &> /dev/null; then
    BROWSER="chromium"
else
    BROWSER="chromium"
fi

echo "=== Kiosk Started: $(date '+%Y-%m-%d %H:%M:%S') ===" > "$KIOSK_LOG"

$BROWSER \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-session-crashed-bubble \
    --disable-component-update \
    --disable-background-networking \
    --disable-sync \
    --password-store=basic \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required \
    --ozone-platform=wayland \
    --enable-gpu-rasterization \
    --enable-zero-copy \
    --ignore-gpu-blocklist \
    "http://localhost:$PORT" >> "$KIOSK_LOG" 2>&1
