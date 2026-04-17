#!/bin/bash
cd /home/raspberry/betaflight-configurator
npx vite build > /dev/null 2>&1
nohup npx vite preview > /tmp/bf-server.log 2>&1 &
echo $! > /tmp/bf-server.pid
