#!/usr/bin/env bash
# Launch "Job Application Manager" and open it in the default browser.

# Move into the script's own folder (the project root)
cd "$(dirname "$0")" || exit 1

URL="http://localhost:3000"

echo "==============================================="
echo "   Job Application Manager - starting..."
echo "==============================================="

# Make sure Node.js / npm is available
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: Node.js (npm) was not found."
  echo "Install Node.js from https://nodejs.org/ then try again."
  read -r -p "Press Enter to close..."
  exit 1
fi

# Start the server in the background
npm start &
SERVER_PID=$!

# Wait for the server to respond (up to ~20s)
echo "Waiting for the server at $URL ..."
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "$URL"; then
    break
  fi
  sleep 0.5
done

# Open the default browser (Windows)
echo "Opening the browser..."
powershell.exe -NoProfile -Command "Start-Process '$URL'" >/dev/null 2>&1

echo ""
echo "The app is running. Close this window to stop it."

# Keep the server in the foreground until the window is closed
wait $SERVER_PID
