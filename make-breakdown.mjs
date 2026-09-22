// Script authoring: prose in, scene.json out.
//
//   node make-breakdown.mjs bible.json scene-text.txt scene.json [--slug the-truck] [--minutes 2.5]
//
// Reads your prose (narration and dialogue as you wrote it) and the bible, and asks the
// LLM to produce the shot-by-shot scene file that make-scene.mjs consumes: beats, shots,
// sets, setups, sound effects, music beds. Dialogue is kept word for word. Anything the
// scene needs that is not in the bible yet is listed in <scene>.needs.json for you to add.
//
// Uses the OpenAI integration Replit already provides (AI_INTEGRATIONS_OPENAI_BASE_URL /
// AI_INTEGRATIONS_OPENAI_API_KEY). Override the model with OPENAI_MODEL.

import fs from 'node:fs';
import path from 'node:path';
import { need, log as L } from './lib.mjs';

const log = L('breakdown');
const argv = process.argv.slice(2);
const files = argv.filter((a, i) => !a.startsWith('--') && !['--slug', '--minutes'].includes(argv[i - 1]));
if (files.length < 3) { console.error('usage: node make-breakdown.mjs bible.json scene-text.txt scene.json [--slug id] [--minutes n]'); process.exit(1); }
const [biblePath, textPath, outPath] = files;
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const slug = opt('--slug') || path.basename(outPath, '.json');
const minutes = Number(opt('--minutes') || 0);
const bible = JSON.parse(fs.readFileSync(biblePath, 'utf8'));
const prose = fs.readFileSync(textPath, 'utf8');
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4';

const entities = Object.entries(bible.entities).map(([n, e]) => `- ${n} (${e.kind}${e.voice ? ', speaks' : ''}): ${e.look}${e.angles ? ` [angles: ${e.angles.map((a, i) => `${i + 1}=${a}`).join('; ')}]` : ''}`).join('\n');

const SYSTEM = `You are a film director and editor turning prose into a shot-by-shot scene file for an automated AI film pipeline. Output ONLY a JSON object, no prose, no markdown fences.

THE PIPELINE: every shot is re-photographed from approved master pictures ("the bible"). It can only show people, vehicles and places that are IN THE BIBLE. Sound is generated from text. Timing comes from the spoken audio, so you never give durations for spoken beats.

BIBLE (the only people, vehicles and sets you may use, by exact NAME):
${entities}

OUTPUT SCHEMA:
{
  "slug": "${slug}", "title": string,
  "beds": [ { "kind": "music"|"sfx", "from": beatId, "to": beatId, "volume": 0..1, "fadeIn": s, "fadeOut": s, "prompt": string } ],
  "beats": [
    { "id": string, "type": "narration", "text": string, "lead"?: s, "tail"?: s, "sfx"?: [...], "shots": [...] },
    { "id": string, "type": "dialogue", "speaker": NAME, "text": string, "lead"?: s, "tail"?: s, "shots": [...] },
    { "id": string, "type": "action", "seconds": n, "sfx"?: [...], "shots": [...] }
  ]
}
shot: { "mode": "video"|"lipsync"|"still", "set": NAME, "with": [NAME...], "angle"?: {NAME: n}, "setup"?: string, "shot": string, "motion"?: string, "weight"?: n, "in"?: "fade"|"flash", "out"?: "fade", "zoom"?: "in"|"out" }
sfx: { "prompt": string, "seconds": n, "at"?: s, "volume": 0..1 }

RULES:
1. Dialogue text is copied from the prose WORD FOR WORD. Narration may be lightly tightened but keeps the author's voice; never add facts.
2. Every shot names a "set" (a bible entity of kind set) and lists in "with" every bible person/vehicle visible. Nothing else may appear. If the prose needs something not in the bible, still write the shot, and list what is missing in "needs": [ { "name": NAME, "kind": ..., "look": ... } ] at the top level.
3. A dialogue beat's FIRST shot is a "lipsync" close-up of the speaker (face toward camera, mouth visible) when the line is under 12 seconds spoken (~30 words); split longer lines into two dialogue beats. Reaction shots and cutaways go in later shots of the beat or in their own beats.
4. Reuse SETUPS. Give the same "setup" name to every shot that can be the same picture (all close-ups of one speaker in one place: "cu-CONNORS"; all head-on truck shots: "truck-headon"). Aim for 8-12 distinct pictures per 3-minute scene, not 35. Vary motion, not pictures.
5. Shots run 2-8 s. Narration beats get 2-4 shots. Action beats have fixed "seconds".
6. "shot" describes camera, framing and staging only (angle, distance, who is where, what they do). Do NOT re-describe faces, uniforms, vehicles or places - the bible does that. Use "angle": {NAME: n} to pick a listed angle of an entity (e.g. the interior of a tower).
7. "motion" describes what moves during the shot, in one sentence, for the video model.
8. Sound: one music bed for the main tension, cut at the climax; a second bed for the aftermath if the tone changes; an ambience sfx bed; spot sfx on beats where the prose has sound (engines, gunfire, blasts, footsteps). Keep sfx under 30 s each.
9. Keep out anything a content filter would block: no blood, wounds, gore, corpses. Stage injuries through medics, dust and stillness.
10. Beat ids: short and unique (open, n1, n2, d1, d2, climb, blast, found).
${minutes ? `11. Target about ${minutes} minutes total.` : ''}`;

const res = await fetch(`${need('AI_INTEGRATIONS_OPENAI_BASE_URL').replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${need('AI_INTEGRATIONS_OPENAI_API_KEY')}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: MODEL, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `PROSE:\n\n${prose}` }] }),
});
if (!res.ok) { console.error(`LLM ${res.status}: ${(await res.text()).slice(0, 500)}`); process.exit(1); }
const j = await res.json();
let scene;
try { scene = JSON.parse(j.choices[0].message.content); } catch (e) { console.error('LLM did not return valid JSON:', j.choices?.[0]?.message?.content?.slice(0, 500)); process.exit(1); }

// Checks the pipeline would otherwise fail on later.
const problems = [];
const names = new Set(Object.keys(bible.entities));
scene.slug = slug;
for (const b of scene.beats || []) {
  if (b.type === 'dialogue') {
    if (!names.has(b.speaker)) problems.push(`beat ${b.id}: speaker ${b.speaker} not in bible`);
    else if (!prose.replace(/\s+/g, ' ').includes(b.text.replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'"))) problems.push(`beat ${b.id}: dialogue not verbatim: "${b.text.slice(0, 60)}"`);
  }
  (b.shots || []).forEach((s, k) => {
    for (const n of [s.set, ...(s.with || [])].filter(Boolean)) if (!names.has(n)) problems.push(`shot ${b.id}_${k + 1}: "${n}" not in bible`);
    if (s.mode === 'lipsync' && (k !== 0 || b.type !== 'dialogue')) problems.push(`shot ${b.id}_${k + 1}: lipsync must be first shot of a dialogue beat`);
  });
}
fs.writeFileSync(outPath, JSON.stringify(scene, null, 2) + '\n');
const needs = scene.needs || [];
delete scene.needs;
fs.writeFileSync(outPath, JSON.stringify(scene, null, 2) + '\n');
if (needs.length) { fs.writeFileSync(outPath.replace(/\.json$/, '.needs.json'), JSON.stringify(needs, null, 2) + '\n'); log(`NOT IN THE BIBLE, add these to bible.json then run make-bible: ${needs.map((n) => n.name).join(', ')}  (details in ${path.basename(outPath).replace(/\.json$/, '.needs.json')})`); }
const setups = new Set(); let shots = 0;
for (const b of scene.beats) for (const s of b.shots) { shots++; setups.add(s.setup || `${b.id}_${shots}`); }
log(`wrote ${outPath}: ${scene.beats.length} beats, ${shots} shots, ${setups.size} pictures (model ${MODEL})`);
if (problems.length) { log(`problems to fix by hand (${problems.length}):`); problems.forEach((p) => log('  ' + p)); }
log(`next:  node make-scene.mjs ${path.basename(biblePath)} ${path.basename(outPath)} --plan`);
