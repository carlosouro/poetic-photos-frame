#!/bin/bash

# 1. Resolve portable project directory
PROJECT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# 2. Configure display and disable screen blanking (X11 + Wayland/labwc)
export DISPLAY="${DISPLAY:-:0}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if command -v xset &> /dev/null; then
    xset s noblank 2>/dev/null || true
    xset s off 2>/dev/null || true
    xset -dpms 2>/dev/null || true
fi

cd "$PROJECT_DIR"

# 3. Load Port Configuration
PORT=3000
if [ -f .env ]; then
    ENV_PORT=$(grep -E "^PORT=" .env | tail -n 1 | cut -d '=' -f2 | tr -d '[:space:]')
    if [ -n "$ENV_PORT" ]; then
        PORT=$ENV_PORT
    fi
fi

# 4. Wait briefly for Wayland compositor socket & NTP clock sync on boot
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

# 5. Rolling Log Management (Retain up to 10,000 lines across runs and reboots)
LOG_FILE="frame.log"
KIOSK_LOG="kiosk.log"
MAX_LOG_LINES=10000
EXIT_SENTINEL="/tmp/poetic-frame.exit"

rm -f "$EXIT_SENTINEL"

trim_log() {
    if [ -f "$LOG_FILE" ]; then
        tail -n "$MAX_LOG_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
}

trim_log
{
    echo ""
    echo "=========================================="
    echo "=== Session Started: $(date '+%Y-%m-%d %H:%M:%S') ==="
    echo "=========================================="
} >> "$LOG_FILE"

# Stop any stale server instance from a previous session
pkill -f "node dist/server.js" 2>/dev/null || true
sleep 0.5

# Ensure compiled build exists
if [ ! -f "dist/server.js" ]; then
    echo "dist/server.js missing, running npm run build..." >> "$LOG_FILE"
    npm run build >> "$LOG_FILE" 2>&1
fi

# 6. Supervised Node.js Backend Loop (auto-recovers on unexpected crashes)
SERVER_SUPERVISOR_PID=""
run_server_supervisor() {
    while [ ! -f "$EXIT_SENTINEL" ]; do
        node dist/server.js >> "$LOG_FILE" 2>&1 &
        local child_pid=$!
        wait "$child_pid"
        local status=$?
        if [ -f "$EXIT_SENTINEL" ]; then
            break
        fi
        echo "⚠️ Server exited unexpectedly (code $status) at $(date '+%Y-%m-%d %H:%M:%S'). Restarting in 3s..." >> "$LOG_FILE"
        trim_log
        sleep 3
    done
}

run_server_supervisor &
SERVER_SUPERVISOR_PID=$!

cleanup() {
    touch "$EXIT_SENTINEL" 2>/dev/null || true
    if [ -n "$SERVER_SUPERVISOR_PID" ] && kill -0 "$SERVER_SUPERVISOR_PID" 2>/dev/null; then
        kill "$SERVER_SUPERVISOR_PID" 2>/dev/null || true
    fi
    pkill -f "node dist/server.js" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 7. Wait for backend server to respond
echo "Waiting for server on port $PORT..." >> "$LOG_FILE"
count=0
while ! curl -sf --max-time 2 "http://localhost:$PORT/api/config" > /dev/null; do
    if [ -f "$EXIT_SENTINEL" ]; then
        exit 0
    fi
    sleep 1
    count=$((count+1))
    if [ $count -ge 60 ]; then
        echo "Server timeout! Launching browser anyway." >> "$LOG_FILE"
        break
    fi
done

echo "Server is UP! Starting supervised Chromium kiosk..." >> "$LOG_FILE"

clean_chromium_state() {
    local CHROMIUM_DIR="$HOME/.config/chromium"
    local CHROMIUM_PREFS="$CHROMIUM_DIR/Default/Preferences"
    if ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then
        rm -f "$CHROMIUM_DIR/SingletonLock" "$CHROMIUM_DIR/SingletonSocket" "$CHROMIUM_DIR/SingletonCookie" 2>/dev/null || true
        if [ -f "$CHROMIUM_PREFS" ]; then
            sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g; s/"exited_cleanly":false/"exited_cleanly":true/g' "$CHROMIUM_PREFS" 2>/dev/null || true
        fi
    fi
}

if command -v chromium-browser &> /dev/null; then
    BROWSER="chromium-browser"
else
    BROWSER="chromium"
fi

# 8. Supervised Chromium Kiosk Loop (restarts Chromium if it crashes, exits cleanly on /api/exit)
while [ ! -f "$EXIT_SENTINEL" ]; do
    clean_chromium_state
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

    if [ -f "$EXIT_SENTINEL" ]; then
        echo "Intentional exit requested. Shutting down kiosk." >> "$LOG_FILE"
        break
    fi

    echo "⚠️ Chromium exited unexpectedly at $(date '+%Y-%m-%d %H:%M:%S'). Restarting in 3s..." >> "$LOG_FILE"
    sleep 3
done
