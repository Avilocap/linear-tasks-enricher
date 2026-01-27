#!/bin/bash
SERVICE="com.zinkee.tasks-enricher"
PLIST="$HOME/Library/LaunchAgents/$SERVICE.plist"

launchctl bootout "gui/$(id -u)/$SERVICE" 2>/dev/null
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Service restarted"
