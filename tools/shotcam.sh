#!/bin/bash
# usage: tools/shotcam.sh <name> <query> "<x,y,z>" "<tx,ty,tz>" <fov> [wait]
# free camera at a given position / target (e.g. to match a reference photo)
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-starship}
OUT=${SHOT_OUT:-.}
if [ -z "$KEEP" ]; then
  agent-browser close >/dev/null 2>&1
  agent-browser --args "--use-angle=metal,--enable-gpu,--ignore-gpu-blocklist" open about:blank >/dev/null 2>&1
  agent-browser set viewport ${VW:-1600} ${VH:-900} >/dev/null 2>&1
fi
agent-browser open "http://localhost:5173/?autostart&cam=orbit&$2" >/dev/null 2>&1
for i in $(seq 1 60); do
  sleep 1
  R=$(agent-browser eval "(() => { const a = window.__app; if (!a) return 'no'; return a.seekingDone() ? 'ok' : 'wait'; })()" 2>/dev/null)
  [[ "$R" == *ok* ]] && break
done
agent-browser eval "(() => { const a = window.__app; a.camera.position.set($3); a.controls.target.set($4); a.camera.fov = $5; a.camera.updateProjectionMatrix(); a.controls.update(); document.getElementById('ui').classList.add('hidden'); return 1; })()" >/dev/null 2>&1
sleep ${6:-2}
agent-browser screenshot $OUT/$1.png >/dev/null 2>&1
agent-browser eval "JSON.stringify({t: window.__app.sim.t.toFixed(1), fps: document.getElementById('fps').textContent, n: window.__app.ps.count, fluid: window.__app.fluid.active, ms: window.__app.fluid.ms.toFixed(1), worker: !!window.__app.fluid.worker})"
agent-browser console 2>&1 | grep -iE "error|warn" | grep -v PCFSoft | head -5
