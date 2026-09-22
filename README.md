# Lectio scene pipeline v2

Prose -> scene file -> voices, music, effects -> pictures re-photographed from an approved
"bible" -> moving clips + lip-sync -> finished MP4. Runs on Replit; needs ELEVENLABS_API_KEY
and FAL_KEY in Secrets; make-breakdown also uses Replit's built-in OpenAI integration.

## The four steps

1. BIBLE  (once per film, reused by every scene)
   Describe every person, vehicle and place in bible.json. Then:
     node make-bible.mjs bible.json                       -> bible/candidates.jpg  (3 candidates each)
     node make-bible.mjs bible.json --pick TOWER=2 TRUCK=1 ...   approve the ones you like
     node make-bible.mjs bible.json --angles              -> extra views derived from each master
   Result: bible/<NAME>/master.jpg (+ angle_n.jpg), bible/masters.jpg.

2. BREAKDOWN  (per scene)
   Put the prose in a text file, then:
     node make-breakdown.mjs bible.json scene-text.txt the-truck.json
   -> the-truck.json (beats, shots, setups, sound) and, if the prose needs something the
      bible lacks, the-truck.needs.json. Edit the JSON by hand as much as you like.

3. STILLS  (per scene, cheap: ~$0.15 per picture, ~10-15 pictures per scene)
     node make-scene.mjs bible.json the-truck.json --plan            free: shot list + cost
     node make-scene.mjs bible.json the-truck.json --until stills    -> out/the-truck/contact_sheet.jpg
   Every picture is the bible re-photographed: the model is handed the approved masters of
   the set, the people and the vehicle in the shot and told to change nothing but the camera.
   Shots that share a "setup" share one picture (all close-ups of one speaker = one picture).
   Remake a picture:  --redo d5_1

4. FULL RUN  (per scene, ~$15-20)
     node make-scene.mjs bible.json the-truck.json
   -> out/the-truck/final.mp4 + report.json. Resumable; never pays twice.

## Scene file, in brief
beat:  { id, type: narration|dialogue|action, text|seconds, speaker, lead, tail, sfx[], shots[] }
shot:  { mode: video|lipsync|still, set: NAME, with: [NAMEs], angle: {NAME: n}, setup: "name",
         shot: "camera/framing/staging only", motion: "what moves", weight, in, out, zoom }
Rules the pipeline enforces: dialogue beats start with a lipsync close-up of the speaker;
every name must be in the bible; a lipsync line must be under 14.8 s.

## Background life and sound that ramps
Give a set a "life" line in the bible ("jeeps moving between buildings, soldiers walking,
clouds drifting, dust in a mild breeze"): every still and clip in that set gets it. A shot can
override with its own "life", or "life": false for a dead-still frame.
Any bed or sfx "volume" can be a pair, [0.2, 0.9]: it rises evenly across the sound's length.
The bible's "uses" field makes a set depend on others (BASE uses TOWER): its candidates are
generated FROM the approved masters, in dependency order, and continuity-checked against them.

## Continuity check
Every generated picture is shown to a vision model with its reference masters and judged
entity by entity. A failure is regenerated with the complaint added, up to three times, then
flagged in the log and in report.json ("continuity"). Do not approve or render a flagged picture.

## Why v2 exists
v1 made every picture from scratch (text + one reference). Faces held; trucks, buildings,
guns and backgrounds did not. v2 never invents: it re-photographs approved masters with
several references at once, and reuses one picture across every shot that can share it.
