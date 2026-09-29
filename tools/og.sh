#!/bin/bash
# Render the social preview image (1200x630) from the live scene
export AGENT_BROWSER_SESSION=og
OUT=/Users/chh/starship/public
timeout 40 agent-browser --args "--use-angle=metal,--enable-gpu,--ignore-gpu-blocklist" open about:blank >/dev/null 2>&1
timeout 10 agent-browser set viewport 1200 630 >/dev/null 2>&1
timeout 20 agent-browser open "http://localhost:5173/?autostart&q=ultra&$1" >/dev/null 2>&1
for i in $(seq 1 30); do sleep 2; R=$(timeout 6 agent-browser eval "window.__app && window.__app.seekingDone() ? 'ok' : 'wait'" 2>/dev/null); [[ "$R" == *ok* ]] && break; done
sleep 4
timeout 8 agent-browser eval "document.getElementById('ui').classList.add('hidden'); 1" >/dev/null 2>&1
sleep 1
timeout 15 agent-browser screenshot /tmp/claude-502/og.png >/dev/null 2>&1
sips -s format jpeg -s formatOptions 88 /tmp/claude-502/og.png --out $OUT/og.jpg >/dev/null
timeout 10 agent-browser close >/dev/null 2>&1
ls -la $OUT/og.jpg
