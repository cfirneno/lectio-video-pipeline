// Scene pipeline v2: bible.json + scene.json in, a finished film scene (MP4) out.
//
// What changed from v1, and why the first scene had no continuity:
//   v1 made every still from scratch (text + one reference).   v2 re-photographs the bible:
//   every shot names a SET and its people/vehicles, and the image model gets the approved
//   master pictures of all of them at once, with the instruction to keep them unchanged.
//   v1 made a new picture for every shot.                        v2 shares SETUPS: shots that
//   declare the same "setup" reuse one picture (the seven dialogue close-ups become two).
//
//   node make-scene.mjs bible.json scene.json --plan            no network: shot list, timing, cost
//   node make-scene.mjs bible.json scene.json --until stills    stop after stills; writes contact_sheet.jpg
//   node make-scene.mjs bible.json scene.json                   everything
//   node make-scene.mjs bible.json scene.json --draft           no video models: every shot is a moving still
//   node make-scene.mjs bible.json scene.json --redo n1_2,d3_1  remake those shots' pictures
//   MAX_COST=40 caps estimated fal spend for the run.
//
// Needs bible/<NAME>/master.jpg for every entity the scene uses (make-bible.mjs).
// Resumable, cached, keyed to inputs, one run at a time - as v1.

import fs from 'node:fs';
import path from 'node:path';
import { has, hash, readJson, writeJson, fresh, stamp, pool, ledger, run, ffmpeg, duration, EL, el, fal, falUpload, download, dataUri, IMAGE_MODELS, makeImage, contactSheet, log as L, warn as W } from './lib.mjs';

const log = L('scene'), warn = W('scene');
const argv = process.argv.slice(2);
const files = argv.filter((a, i) => !a.startsWith('--') && !['--until', '--redo'].includes(argv[i - 1]));
if (files.length < 2) { console.error('usage: node make-scene.mjs bible.json scene.json [--plan] [--draft] [--until stills] [--redo ids]'); process.exit(1); }
const [biblePath, scenePath] = files;
const flag = (n) => argv.includes(n), opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const PLAN = flag('--plan'), DRAFT = flag('--draft'), UNTIL = opt('--until'), REDO = (opt('--redo') || '').split(',').filter(Boolean);

const bible = JSON.parse(fs.readFileSync(biblePath, 'utf8'));
const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
const BIBLE = path.resolve(path.dirname(biblePath), 'bible');
const OUT = path.resolve(path.dirname(scenePath), 'out', scene.slug);
fs.mkdirSync(OUT, { recursive: true });
const out = (...p) => path.join(OUT, ...p);
const master = (name) => path.join(BIBLE, name, 'master.jpg');
const angleFile = (name, i) => path.join(BIBLE, name, `angle_${i}.jpg`);

const W_ = 1920, H_ = 1080, FPS = 30;
const LEAD = 0.3, TAIL = 0.4, MIN_SHOT = 1.5;
const MAX_COST = Number(process.env.MAX_COST || 40);
const IMAGE_MODEL = bible.imageModel || 'nano-banana-pro';
const IMG = IMAGE_MODELS[IMAGE_MODEL];
const VIDEO_MODEL = 'fal-ai/kling-video/v3/standard/image-to-video';
const LIPSYNC_MODEL = 'minimax/h3-max/lip-sync/image-to-video';
const PRICE = { videoPerSec: 0.084, lipsyncPerSec: 0.08 };
const LIPSYNC_RES = '768P', LIPSYNC_MIN = 5.0, LIPSYNC_MAX = 14.8;
const TTS_MODEL = bible.ttsModel || 'eleven_multilingual_v2';
const ENT = bible.entities || {};
const STYLE = bible.style || '';

const money = ledger(out('cost.json'));
const report = { slug: scene.slug, fallbacks: [], tools: { images: IMAGE_MODEL, video: VIDEO_MODEL, lipsync: LIPSYNC_MODEL, tts: TTS_MODEL } };
const failed = readJson(out('failed.json'), {});

// ───────────────────────────── scene model ─────────────────────────────

const beats = scene.beats;
const isSpeech = (b) => b.type === 'narration' || b.type === 'dialogue';
const voiceOf = (b) => (b.type === 'narration' ? 'NARRATOR' : b.speaker);
const kindOf = (name) => ENT[name]?.kind;

beats.forEach((b) => {
  if (!b.id) throw new Error('every beat needs an "id"');
  if (!b.shots?.length) throw new Error(`beat ${b.id} has no shots`);
  if (b.type === 'dialogue' && !ENT[b.speaker]) throw new Error(`beat ${b.id}: speaker ${b.speaker} is not in the bible`);
  b.shots.forEach((s, k) => {
    s.id = `${b.id}_${k + 1}`;
    s.mode = DRAFT && s.mode !== 'still' ? 'still' : (s.mode || 'video');
    s.with = s.with || [];
    if (s.mode === 'lipsync') {
      if (k !== 0 || b.type !== 'dialogue') throw new Error(`shot ${s.id}: a lipsync shot must be the first shot of a dialogue beat`);
      if (!s.with.includes(b.speaker)) s.with.unshift(b.speaker);
      s.setup = s.setup || `cu-${b.speaker}-${s.set || 'x'}`; // every close-up of a speaker in a set shares one picture
    }
    for (const n of [s.set, ...s.with].filter(Boolean)) if (!ENT[n]) throw new Error(`shot ${s.id}: "${n}" is not in the bible`);
    if (!s.set && !s.with.some((n) => kindOf(n) === 'set')) warn(`${s.id}: no set named; the background will be invented`);
  });
});
const allShots = beats.flatMap((b) => b.shots.map((s) => Object.assign(s, { beat: b })));

// Beat length = measured speech + padding (or fixed seconds); shots share it by weight; all snapped to frames.
function buildTimeline(speechSeconds) {
  const snap = (t) => Math.round(t * FPS) / FPS;
  let t = 0;
  for (const b of beats) {
    b.lead = isSpeech(b) ? (b.lead ?? LEAD) : 0;
    const dur = isSpeech(b) ? b.lead + speechSeconds(b) + (b.tail ?? TAIL) : b.seconds;
    const total = b.shots.reduce((n, s) => n + (s.weight || 1), 0);
    b.start = t;
    for (const s of b.shots) { s.start = t; s.len = Math.max(snap(MIN_SHOT), snap(dur * (s.weight || 1) / total)); t = snap(t + s.len); }
    b.dur = snap(t - b.start); b.at = b.start + b.lead;
  }
  return t;
}
const clipSeconds = (s) => Math.min(15, Math.max(3, Math.ceil(s.len)));
const lipsyncSeconds = (s) => Math.min(LIPSYNC_MAX, Math.max(LIPSYNC_MIN, s.len));
const setups = () => new Set(allShots.map((s) => s.setup || s.id)).size;

function estimate() {
  const vid = allShots.filter((s) => s.mode === 'video'), lip = allShots.filter((s) => s.mode === 'lipsync');
  const e = { images: setups() * IMG.price, video: vid.reduce((n, s) => n + clipSeconds(s), 0) * PRICE.videoPerSec, lipsync: lip.reduce((n, s) => n + lipsyncSeconds(s), 0) * PRICE.lipsyncPerSec };
  e.total = e.images + e.video + e.lipsync;
  return e;
}

if (PLAN) {
  const total = buildTimeline((b) => Math.max(1.2, b.text.split(/\s+/).length / 2.6));
  log(`PLAN "${scene.title || scene.slug}" - about ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}, ${beats.length} beats, ${allShots.length} shots, ${setups()} pictures`);
  for (const b of beats) {
    log(`${b.start.toFixed(1).padStart(6)}s  ${b.id.padEnd(8)} ${b.type.padEnd(9)} ${b.dur.toFixed(1).padStart(5)}s  ${isSpeech(b) ? `${voiceOf(b)}: "${b.text.slice(0, 55)}${b.text.length > 55 ? '...' : ''}"` : ''}`);
    for (const s of b.shots) log(`          ${s.id.padEnd(10)} ${s.mode.padEnd(8)} ${s.len.toFixed(1)}s  ${s.set || ''} ${s.with.join(',')}${s.setup ? `  [setup ${s.setup}]` : ''}`);
  }
  const e = estimate();
  log(`estimated fal cost: images $${e.images.toFixed(2)} + video $${e.video.toFixed(2)} + lip-sync $${e.lipsync.toFixed(2)} = $${e.total.toFixed(2)}`);
  const missing = [...new Set(allShots.flatMap((s) => [s.set, ...s.with]).filter(Boolean))].filter((n) => !has(master(n)));
  if (missing.length) log(`NOT YET IN THE BIBLE (run make-bible first): ${missing.join(', ')}`);
  process.exit(0);
}

// one run at a time
const LOCK = out('.lock');
const other = Number(readJson(LOCK, 0));
if (other) { let alive = true; try { process.kill(other, 0); } catch { alive = false; } if (alive) { console.error(`[scene] another run is already going (pid ${other})`); process.exit(2); } }
writeJson(LOCK, process.pid);
const unlock = () => fs.rmSync(LOCK, { force: true });
process.on('exit', unlock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { unlock(); process.exit(130); });

for (const id of REDO) {
  const s = allShots.find((x) => x.id === id);
  const pic = s ? `still_${s.setup || s.id}.jpg` : `still_${id}.jpg`;
  for (const f of [pic, `${pic}.key`, `clip_${id}.mp4`, `clip_${id}.mp4.key`, `seg_${id}.mp4`, `seg_${id}.mp4.key`]) fs.rmSync(out(f), { force: true });
  delete failed[id]; log(`redo: cleared ${id}`);
}
writeJson(out('failed.json'), failed);

// ───────────────────────────── 1. voices ─────────────────────────────

async function resolveVoices() {
  const wanted = { ...(bible.voices || {}) };
  for (const [name, e] of Object.entries(ENT)) if (e.voice) wanted[name] = e.voice;
  const key = hash(wanted);
  const cache = path.join(BIBLE, 'voices.json'); // shared by every scene
  if (fresh(cache, key)) return readJson(cache);
  const { voices } = await (await el(`${EL}/v1/voices`)).json();
  const used = new Set(), pick = {};
  for (const [speaker, name] of Object.entries(wanted)) {
    let v = voices.find((x) => !used.has(x.voice_id) && (x.voice_id === name || x.name.toLowerCase().startsWith(String(name).toLowerCase())));
    if (!v) { v = voices.find((x) => !used.has(x.voice_id)); report.fallbacks.push(`voice "${name}" not found for ${speaker}; used "${v?.name}"`); }
    if (!v) throw new Error('no voices on this ElevenLabs account');
    used.add(v.voice_id); pick[speaker] = { voice_id: v.voice_id, name: v.name };
  }
  writeJson(cache, pick); stamp(cache, key);
  return pick;
}

async function speak(b, voice, i) {
  const file = out(`line_${b.id}.mp3`);
  const settings = b.type === 'narration' ? bible.narratorVoiceSettings : ENT[b.speaker]?.voiceSettings;
  const key = hash(b.text, voice.voice_id, TTS_MODEL, settings);
  if (fresh(file, key)) return;
  const same = (o) => o && isSpeech(o) && voiceOf(o) === voiceOf(b);
  const body = { text: b.text, model_id: TTS_MODEL };
  if (settings) body.voice_settings = settings;
  if (same(beats[i - 1])) body.previous_text = beats[i - 1].text;
  if (same(beats[i + 1])) body.next_text = beats[i + 1].text;
  const j = await (await el(`${EL}/v1/text-to-speech/${voice.voice_id}/with-timestamps?output_format=mp3_44100_128`, body)).json();
  fs.writeFileSync(file, Buffer.from(j.audio_base64, 'base64'));
  writeJson(out(`line_${b.id}.align.json`), j.alignment);
  stamp(file, key);
  log(`line ${b.id} spoken (${voiceOf(b)} / ${voice.name})`);
}

async function sound(kind, prompt, seconds) {
  const file = `${kind}_${hash(kind, prompt, Math.round(seconds))}.mp3`;
  if (has(out(file))) return file;
  try {
    const res = kind === 'music'
      ? await el(`${EL}/v1/music?output_format=mp3_44100_128`, { prompt, music_length_ms: Math.min(600000, Math.max(3000, Math.ceil(seconds * 1000))), force_instrumental: true })
      : await el(`${EL}/v1/sound-generation?output_format=mp3_44100_128`, { text: prompt, duration_seconds: Math.min(30, Math.max(0.5, seconds)), prompt_influence: 0.45 });
    fs.writeFileSync(out(file), Buffer.from(await res.arrayBuffer()));
    log(`${kind} generated: "${prompt.slice(0, 50)}..."`);
    return file;
  } catch (e) {
    warn(`${kind} failed, continuing without it: ${e.message}`);
    report.fallbacks.push(`${kind} unavailable: ${e.message.slice(0, 160)}`);
    return null;
  }
}

const voices = await resolveVoices();
report.tools.voices = Object.fromEntries(Object.entries(voices).map(([k, v]) => [k, v.name]));
for (let i = 0; i < beats.length; i++) if (isSpeech(beats[i])) await speak(beats[i], voices[voiceOf(beats[i])], i);

const total = buildTimeline((b) => duration(`line_${b.id}.mp3`, OUT));
const shots = allShots;
writeJson(out('timeline.json'), { total, beats: beats.map((b) => ({ id: b.id, type: b.type, start: b.start, dur: b.dur, at: b.at, shots: b.shots.map((s) => ({ id: s.id, mode: s.mode, setup: s.setup, start: s.start, len: s.len })) })) });
log(`timeline: ${Math.floor(total / 60)}:${(total % 60).toFixed(1).padStart(4, '0')} - ${beats.length} beats, ${shots.length} shots, ${setups()} pictures`);
for (const s of shots.filter((x) => x.mode === 'lipsync')) if (s.beat.dur > LIPSYNC_MAX) warn(`${s.id}: line runs ${s.beat.dur.toFixed(1)}s but lip-sync handles ${LIPSYNC_MAX}s; split it across two beats`);
const est = estimate();
log(`estimated fal cost for one take of everything: $${est.total.toFixed(2)} (already spent on this scene: $${money.total()})`);
if (est.total > MAX_COST) { console.error(`[scene] estimate exceeds MAX_COST $${MAX_COST}`); process.exit(1); }

// ───────────────────────────── 2. music, ambience, effects ─────────────────────────────

const beatById = Object.fromEntries(beats.map((b) => [b.id, b]));
const beds = [];
for (const bd of scene.beds || []) {
  const a = beatById[bd.from], z = beatById[bd.to];
  if (!a || !z) throw new Error(`bed refers to unknown beat id: ${bd.from} / ${bd.to}`);
  const start = a.start, end = z.start + z.dur;
  const file = await sound(bd.kind, bd.prompt, bd.kind === 'music' ? end - start + 1 : Math.min(30, end - start));
  if (file) beds.push({ ...bd, file, start, end });
}
const effects = [];
for (const b of beats) for (const fx of b.sfx || []) {
  const file = await sound('sfx', fx.prompt, fx.seconds);
  if (file) effects.push({ ...fx, file, at: b.start + (fx.at || 0), seconds: Math.min(fx.seconds, duration(file, OUT)) });
}
if (UNTIL === 'audio') { log('stopped after audio'); process.exit(0); }

// ───────────────────────────── 3. stills: re-photograph the bible ─────────────────────────────

// The references handed to the image model for a shot: the set first, then people and vehicles.
// Each one is the approved master (or a named angle of it), never a fresh invention.
function refsFor(s) {
  const names = [...new Set([s.set, ...s.with].filter(Boolean))];
  const refs = [], legend = [], check = [];
  for (const n of names) {
    const file = s.angle?.[n] ? angleFile(n, s.angle[n]) : master(n);
    if (!has(file)) throw new Error(`${s.id}: bible/${n}/${path.basename(file)} is missing - run make-bible.mjs first`);
    refs.push(file);
    const e = ENT[n];
    legend.push(`reference ${refs.length} is ${e.kind === 'set' ? 'the location' : e.kind === 'person' ? 'the person' : `the ${e.kind}`} ${n}`);
    check.push({ name: n, kind: e.kind, look: e.look });
  }
  return { refs, legend, check };
}

// "life": what is always going on in a set (vehicles moving, people walking, clouds, dust).
// Written once on the set in the bible; added to every still and every clip in that set.
const lifeOf = (s) => (s.life === false ? '' : (s.life || ENT[s.set]?.life || ''));
// "transform": { NAME: "how it is deliberately altered" } on a shot; a set's own transform (a wrecked tower in WRECK) is inherited.
const transformOf = (s) => ({ ...(ENT[s.set]?.transform || {}), ...(s.transform || {}) });
function shotPrompt(s, legend) {
  const people = s.with.filter((n) => kindOf(n) === 'person').map((n) => `${n} (${ENT[n].look})`);
  const life = lifeOf(s);
  return [
    legend.length ? `${legend.join('; ')}.` : '',
    `Photograph a new shot in exactly this location with exactly these people and vehicles, changed in no detail (same faces, same clothing and gear, same construction, same colours, same weapons), only the camera has moved:`,
    `${s.shot}.`,
    Object.keys(transformOf(s)).length ? `Deliberate changes in this shot: ${Object.entries(transformOf(s)).map(([k, v]) => `${k} is shown ${v}`).join('; ')}.` : '',
    people.length ? `People in this shot: ${people.join('; ')}.` : '',
    life ? `In the background, small and unobtrusive: ${life}.` : '',
    kindOf(s.set) !== 'person' && bible.geography ? `Fixed geography of the location: ${bible.geography}` : '',
    `No text or lettering anywhere. ${STYLE}`,
  ].filter(Boolean).join(' ');
}

const missingMasters = [...new Set(shots.flatMap((s) => [s.set, ...s.with]).filter(Boolean))].filter((n) => !has(master(n)));
if (missingMasters.length) { console.error(`[scene] not in the bible yet: ${missingMasters.join(', ')}. Run make-bible.mjs and approve them first.`); process.exit(1); }

const byPicture = new Map(); // setup name -> the first shot that defines it
for (const s of shots) { const k = s.setup || s.id; if (!byPicture.has(k)) byPicture.set(k, s); s.picture = `still_${k}.jpg`; }
await pool([...byPicture.values()], 4, async (s) => {
  const { refs, legend, check } = refsFor(s);
  const prompt = shotPrompt(s, legend);
  const key = hash(prompt, refs.map((f) => readJson(`${f}.key`, null)), IMAGE_MODEL);
  if (!(await makeImage({ modelName: IMAGE_MODEL, file: out(s.picture), key, prompt, refs, check, geography: bible.geography || '', transform: transformOf(s), soft: ['GEOGRAPHY', 'LOCATION', 'WRECK'], attempts: 2, charge: money.charge, log, warn }))) report.fallbacks.push(`${s.id}: image failed`);
});
for (const s of shots) if (!has(out(s.picture))) {
  const prev = shots[shots.indexOf(s) - 1];
  if (prev && has(out(prev.picture))) { s.picture = prev.picture; report.fallbacks.push(`${s.id}: no picture; reused ${prev.id}`); } else s.picture = null;
}
contactSheet([...byPicture.values()].filter((s) => has(out(s.picture))).map((s) => ({ file: out(s.picture), label: s.setup || s.id })), out('contact_sheet.jpg'), OUT);
log(`contact sheet -> out/${scene.slug}/contact_sheet.jpg (${byPicture.size} pictures for ${shots.length} shots)`);
report.continuity = {};
for (const s of byPicture.values()) { const v = readJson(`${out(s.picture)}.check.json`, null); if (v) report.continuity[s.setup || s.id] = v.ok ? 'ok' : v.problems.map((p) => `${p.entity}: ${p.issue}`).join('; '); }
const failedPics = Object.entries(report.continuity).filter(([, v]) => v !== 'ok');
if (failedPics.length) { log(`CONTINUITY FAILURES (${failedPics.length}) after 3 attempts each - reword or --redo before the full run:`); failedPics.forEach(([k, v]) => log(`  ${k}: ${v}`)); } else log('continuity: every picture passed');
if (UNTIL === 'stills') { log('stopped after stills (--until stills). To remake any: --redo <shot id>. Then run again without --until.'); process.exit(0); }

// ───────────────────────────── 4. clips ─────────────────────────────

async function makeClip(s, key, input, model, seconds, perSec, kind) {
  const file = out(`clip_${s.id}.mp4`);
  if (fresh(file, key)) return file;
  if (failed[s.id]) { report.fallbacks.push(`${s.id}: skipped, refused earlier (${failed[s.id]})`); return null; }
  try {
    const r = await fal(model, input, `${file}.job.json`, s.id);
    await download(r.video.url, file);
    money.charge(kind, seconds * perSec); stamp(file, key);
    log(`clip_${s.id}.mp4 generated (${kind}, ${seconds.toFixed(1)}s)`);
    return file;
  } catch (e) {
    warn(`${s.id} failed, will be a moving still: ${e.message.slice(0, 300)}`);
    failed[s.id] = e.message.slice(0, 160); writeJson(out('failed.json'), failed);
    report.fallbacks.push(`${s.id}: ${kind} failed -> moving still`);
    return null;
  }
}

await pool(shots.filter((s) => s.picture && s.mode !== 'still'), 3, async (s) => {
  const picKey = readJson(`${out(s.picture)}.key`, null);
  if (s.mode === 'video') {
    const life = lifeOf(s);
    const secs = clipSeconds(s), prompt = `${s.motion || s.shot}.${life ? ` Background life, subtle: ${life}.` : ''} Everything else stays exactly as in the starting frame. ${STYLE}`;
    const input = { prompt, start_image_url: dataUri(out(s.picture)), duration: String(secs), aspect_ratio: '16:9', generate_audio: false };
    s.clip = await makeClip(s, hash('video', VIDEO_MODEL, picKey, prompt, secs), input, VIDEO_MODEL, secs, PRICE.videoPerSec, 'video');
  } else {
    const secs = lipsyncSeconds(s), audio = out(`lipin_${s.id}.mp3`);
    const key = hash('lipsync', LIPSYNC_MODEL, picKey, readJson(out(`line_${s.beat.id}.mp3.key`), null), secs.toFixed(2), s.beat.lead);
    let input = null;
    if (!fresh(out(`clip_${s.id}.mp4`), key) && !failed[s.id]) {
      ffmpeg(['-i', `line_${s.beat.id}.mp3`, '-af', `adelay=${Math.round(s.beat.lead * 1000)}:all=1,apad`, '-t', secs.toFixed(3), '-ar', '44100', '-b:a', '128k', audio], OUT);
      input = { image_url: await falUpload(out(s.picture), 'image/jpeg'), audio_url: await falUpload(audio, 'audio/mpeg'), resolution: LIPSYNC_RES };
    }
    s.clip = await makeClip(s, key, input, LIPSYNC_MODEL, secs, PRICE.lipsyncPerSec, 'lipsync');
  }
});

// ───────────────────────────── 5. cut, titles, mix ─────────────────────────────

function makeSegment(s, n) {
  const file = `seg_${s.id}.mp4`;
  const src = s.clip ? path.basename(s.clip) : s.picture;
  const key = hash(src, src ? readJson(`${out(src)}.key`, null) : null, s.len, s.in, s.out, s.zoom);
  if (fresh(out(file), key)) return;
  const len = s.len.toFixed(4), frames = Math.round(s.len * FPS) + 2;
  let input, chain;
  if (s.clip) { input = ['-i', src]; chain = [`scale=${W_}:${H_}:force_original_aspect_ratio=increase`, `crop=${W_}:${H_}`, `fps=${FPS}`, 'tpad=stop_mode=clone:stop_duration=30']; }
  else if (s.picture) {
    const zoomOut = (s.zoom || (n % 2 ? 'out' : 'in')) === 'out';
    input = ['-i', src];
    chain = [`scale=${W_ * 2}:${H_ * 2}:force_original_aspect_ratio=increase`, `crop=${W_ * 2}:${H_ * 2}`, `zoompan=z='${zoomOut ? 'max(1.16-0.0006*on,1)' : 'min(1+0.0006*on,1.16)'}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W_}x${H_}:fps=${FPS}`];
  } else { input = ['-f', 'lavfi', '-i', `color=c=black:s=${W_}x${H_}:r=${FPS}:d=${len}`]; chain = []; }
  chain.push(`trim=0:${len}`, 'setpts=PTS-STARTPTS');
  if (s.in === 'fade') chain.push('fade=t=in:st=0:d=0.8');
  if (s.in === 'flash') chain.push('fade=t=in:st=0:d=0.5:color=white');
  if (s.out === 'fade') chain.push(`fade=t=out:st=${Math.max(0, s.len - 1).toFixed(3)}:d=1`);
  chain.push('format=yuv420p');
  ffmpeg([...input, '-vf', chain.join(','), '-an', '-t', len, '-r', String(FPS), '-c:v', 'libx264', '-crf', '17', '-preset', 'fast', file], OUT);
  stamp(out(file), key);
}

function assTime(t) { const cs = Math.max(0, Math.round(t * 100)), p = (n) => String(n).padStart(2, '0'); return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`; }
function buildTitles() {
  const ev = [];
  for (const b of beats.filter(isSpeech)) {
    const end = b.start + b.dur - 0.1;
    if (b.caption) ev.push(`Dialogue: 0,${assTime(b.at - 0.1)},${assTime(end)},Caption,,0,0,0,,${b.caption}`);
    const al = b.supertitle ? readJson(out(`line_${b.id}.align.json`), null) : null;
    if (!al) continue;
    const words = []; let cur = null;
    al.characters.forEach((ch, k) => { if (/\s/.test(ch)) { cur = null; return; } if (!cur) { cur = { text: '', start: al.character_start_times_seconds[k] }; words.push(cur); } cur.text += ch; });
    const line = (a) => words.map((w, k) => { if (k !== a) return w.text; const m = w.text.match(/^(.*?)([.,;:!?·…]*)$/u); return `{\\u1}${m[1]}{\\u0}${m[2]}`; }).join(' ');
    const add = (from, to, text) => { if (to > from) ev.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Super,,0,0,0,,${text}`); };
    add(Math.max(b.start, b.at - 0.25), b.at + words[0].start, line(-1));
    words.forEach((w, k) => add(b.at + w.start, k < words.length - 1 ? b.at + words[k + 1].start : end, line(k)));
  }
  if (!ev.length) return false;
  const style = (name, size, align, mv) => `Style: ${name},DejaVu Serif,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,1,0,1,3,2,${align},120,120,${mv},1`;
  fs.writeFileSync(out('titles.ass'), ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W_}`, `PlayResY: ${H_}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Super', 64, 8, 70), style('Caption', 48, 2, 90), '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...ev, ''].join('\n'));
  return / ass /.test(run('ffmpeg', ['-hide_banner', '-filters'], OUT).stdout);
}

function assemble(titles) {
  fs.writeFileSync(out('segments.txt'), shots.map((s) => `file 'seg_${s.id}.mp4'`).join('\n') + '\n');
  const inputs = ['-f', 'concat', '-safe', '0', '-i', 'segments.txt'];
  let idx = 1; const f = []; const T = total.toFixed(3);
  const norm = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const lines = beats.filter(isSpeech);
  lines.forEach((b, n) => { inputs.push('-i', `line_${b.id}.mp3`); f.push(`[${idx++}:a]${norm},adelay=${Math.round(b.at * 1000)}:all=1[s${n}]`); });
  f.push(`${lines.map((_, n) => `[s${n}]`).join('')}amix=inputs=${lines.length}:normalize=0:duration=longest,apad,atrim=0:${T},asplit=2[speech][key]`);
  // "volume": 0.6  or  "volume": [0.2, 1.0]  (rises evenly from the first to the second across the sound's length)
  const vol = (v, span, dflt) => Array.isArray(v) ? `volume='${v[0]}+(${v[1]}-${v[0]})*min(t/${span.toFixed(3)},1)':eval=frame` : `volume=${v ?? dflt}`;
  const ducked = [], plain = [];
  beds.forEach((bd, n) => {
    inputs.push('-stream_loop', '-1', '-i', bd.file);
    const span = bd.end - bd.start, fi = Math.min(bd.fadeIn ?? 1, span / 2), fo = Math.min(bd.fadeOut ?? 1, span / 2);
    f.push(`[${idx++}:a]${norm},atrim=0:${span.toFixed(3)},afade=t=in:d=${fi},afade=t=out:st=${(span - fo).toFixed(3)}:d=${fo},${vol(bd.volume, span, 0.8)},adelay=${Math.round(bd.start * 1000)}:all=1[b${n}]`);
    (bd.kind === 'music' ? ducked : plain).push(`[b${n}]`);
  });
  effects.forEach((fx, n) => {
    inputs.push('-i', fx.file);
    const fo = Math.min(1.5, fx.seconds / 3);
    f.push(`[${idx++}:a]${norm},atrim=0:${fx.seconds.toFixed(3)},afade=t=in:d=0.05,afade=t=out:st=${(fx.seconds - fo).toFixed(3)}:d=${fo.toFixed(3)},${vol(fx.volume, fx.seconds, 0.7)},adelay=${Math.round(fx.at * 1000)}:all=1[x${n}]`);
    plain.push(`[x${n}]`);
  });
  const mix = ['[speech]'];
  if (ducked.length) { f.push(`${ducked.join('')}amix=inputs=${ducked.length}:normalize=0:duration=longest,apad,atrim=0:${T}[music]`); f.push('[music][key]sidechaincompress=threshold=0.02:ratio=9:attack=15:release=600[duck]'); mix.push('[duck]'); }
  else f.push('[key]anullsink');
  if (plain.length) { f.push(`${plain.join('')}amix=inputs=${plain.length}:normalize=0:duration=longest,apad,atrim=0:${T}[fx]`); mix.push('[fx]'); }
  f.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=first,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=13[a]`);
  f.push(titles ? '[0:v]ass=titles.ass[v]' : '[0:v]null[v]');
  ffmpeg([...inputs, '-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-t', T, '-movflags', '+faststart', 'final.mp4'], OUT);
}

shots.forEach((s, n) => makeSegment(s, n));
assemble(buildTitles());

const got = duration('final.mp4', OUT);
Object.assign(report, { durationExpected: Number(total.toFixed(2)), durationActual: Number(got.toFixed(2)), durationOk: Math.abs(got - total) < 0.25,
  shots: shots.length, pictures: byPicture.size, movingClips: shots.filter((s) => s.clip && s.mode === 'video').length, lipsyncClips: shots.filter((s) => s.clip && s.mode === 'lipsync').length,
  stillShots: shots.filter((s) => !s.clip).length, refused: failed, cost: { ...money.cost, total: money.total() } });
writeJson(out('report.json'), report);
log(`DONE -> out/${scene.slug}/final.mp4 (${got.toFixed(2)}s)  fal spend on this scene so far: $${money.total()}`);
if (report.fallbacks.length) log(`fallbacks (${report.fallbacks.length}): ${report.fallbacks.join(' | ')}`);
