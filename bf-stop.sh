#!/bin/bash
if [ -f /tmp/bf-server.pid ]; then
    kill "$(cat /tmp/bf-server.pid)" 2>/dev/null
    rm -f /tmp/bf-server.pid
fi
pkill -f "vite preview" 2>/dev/null
