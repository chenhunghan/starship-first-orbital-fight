#!/bin/bash
# usage: tools/shot.sh <name> <query> [targetT]
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-starship}
OUT=${SHOT_OUT:-/private/tmp/claude-502/-Users-chh-starship/c0331c4d-204b-49ec-a507-9131af449337/scratchpad}
if [ -z "$KEEP" ]; then
  agent-browser close >/dev/null 2>&1
  agent-browser --args "--use-angle=metal,--enable-gpu,--ignore-gpu-blocklist" open about:blank >/dev/null 2>&1
  agent-browser set viewport 1600 900 >/dev/null 2>&1
fi
agent-browser open "http://localhost:5173/?autostart&$2" >/dev/null 2>&1
for i in $(seq 1 40); do
  sleep 1
  R=$(agent-browser eval "(() => { const a = window.__app; if (!a) return 'no'; return a.seekingDone() ? 'ok' : 'wait'; })()" 2>/dev/null)
  [[ "$R" == *ok* ]] && break
done
sleep ${3:-1.5}
agent-browser eval "document.getElementById('ui').classList.add('hidden'); 1" >/dev/null 2>&1
sleep 0.3
agent-browser screenshot $OUT/$1.png >/dev/null 2>&1
agent-browser eval "JSON.stringify({q: location.search, t: window.__app.sim.t.toFixed(1), fps: document.getElementById('fps').textContent, n: window.__app.ps.count})"
agent-browser console 2>&1 | grep -iE "error|warn" | grep -v PCFSoft | head -5
