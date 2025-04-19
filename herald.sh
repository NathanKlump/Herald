#!/bin/bash

# Change to the current dir of the script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Get the PID of the running node process
get_pid() {
    echo $(pgrep -f "node index.js")
}

case "$1" in
    start)
        if [ -z "$(get_pid)" ]; then
            # Start the server
            nohup node index.js > /dev/null 2>&1 &
            echo "Server started."
        else
            echo "Server is already running."
        fi
        ;;
    
    stop)
        PID=$(get_pid)
        if [ -n "$PID" ]; then
            # Stop the server
            kill "$PID"
            echo "Server stopped."
        else
            echo "Server is not running."
        fi
        ;;
    
    restart)
        PID=$(get_pid)
        if [ -n "$PID" ]; then
            # Stop the server
            kill "$PID"
            echo "Server stopped."
        fi
        # Start the server
        nohup node index.js > /dev/null 2>&1 &
        echo "Server restarted."
        ;;
    
    *)
        echo "Usage: $0 {start|stop|restart}"
        exit 1
        ;;
esac









