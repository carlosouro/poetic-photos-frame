#!/bin/bash

# 1. Get the directory where this script is located
# This makes the script portable - it works wherever you clone the repo
PROJECT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# 2. Disable screen saver
# (Only works if a display is attached)
export DISPLAY=:0
xset s noblank
xset s off
xset -dpms

# 3. Navigate to project directory
cd "$PROJECT_DIR"

# 4. Load Configuration
# We default to port 3000, but try to read from .env if it exists
PORT=3000
if [ -f .env ]; then
    # We grab the PORT line and strip the "PORT=" part
    ENV_PORT=$(grep "^PORT=" .env | cut -d '=' -f2)
    if [ -n "$ENV_PORT" ]; then
        PORT=$ENV_PORT
    fi
fi

# 5. Log Management (Retain up to 10,000 lines across runs and reboots)
LOG_FILE="frame.log"
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

# 6. Start Node.js in background (appending to log)
npm start >> "$LOG_FILE" 2>&1 &

# 7. SMART WAIT: Loop until the server responds
echo "Waiting for server to start on port $PORT..." >> "$LOG_FILE"

count=0
while ! curl -s "http://localhost:$PORT" > /dev/null; do
    sleep 1
    count=$((count+1))
    if [ $count -ge 60 ]; then
        echo "Server timeout! Launching browser anyway." >> "$LOG_FILE"
        break
    fi
done

echo "Server is UP! Launching browser." >> "$LOG_FILE"

# 8. Determine Browser (Auto-detect)
if command -v chromium-browser &> /dev/null; then
    BROWSER="chromium-browser"
elif command -v chromium &> /dev/null; then
    BROWSER="chromium"
else
    BROWSER="chromium"
fi

# 9. Launch Browser
# Using the dynamic PORT variable
$BROWSER --kiosk --noerrdialogs --disable-infobars --password-store=basic --check-for-update-interval=31536000 "http://localhost:$PORT"