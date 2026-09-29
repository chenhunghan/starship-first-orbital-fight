#!/bin/bash
# usage: tools/hangtest.sh "<extra query>"  -> prints sim time progression
export AGENT_BROWSER_SESSION=hang
pkill -9 -f "Google Chrome for Testing" 2>/dev/null; pkill -9 -f agent-browser-darwin 2>/dev/null; sleep 1
timeout 40 agent-browser --args "--use-angle=metal,--enable-gpu,--ignore-gpu-blocklist" open about:blank >/dev/null 2>&1
timeout 10 agent-browser set viewport 1280 720 >/dev/null 2>&1
timeout 20 agent-browser open "http://localhost:5173/?autostart&$1" >/dev/null 2>&1
for i in $(seq 1 ${N:-5}); do sleep 5; timeout 6 agent-browser eval "Math.round(window.__app?.sim.t)" 2>&1 | tr '\n' ' '; done; echo
