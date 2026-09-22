// The "bible": one approved master picture per person, vehicle and set, shared by
// EVERY scene of the film. Scenes never invent a face, a truck or a building; they
// re-photograph these masters from new angles.
//
//   node make-bible.mjs bible.json                 make 3 candidates per entity, write candidates.jpg, stop
//   node make-bible.mjs bible.json --pick TOWER=2 TRUCK=1 CONNORS=3 ...   approve one candidate each
//   node make-bible.mjs bible.json --pick all=1    approve candidate 1 for everything not yet approved
//   node make-bible.mjs bible.json --angles        after approval: extra angles (side view, interior...) derived
//                                                  from each approved master so they match it
//   node make-bible.mjs bible.json --redo TRUCK    throw away TRUCK's candidates and make new ones
//
// Output: bible/<NAME>/candidate_1..3.jpg, bible/<NAME>/master.jpg (approved), bible/<NAME>/angle_1..n.jpg,
//         bible/candidates.jpg (sheet), bible/masters.jpg (sheet). Env: FAL_KEY.

import fs from 'node:fs';
import path from 'node:path';
import { has, hash, readJson, writeJson, fresh, stamp, pool, ledger, makeImage, contactSheet, log as L, warn as W } from './lib.mjs';

const log = L('bible'), warn = W('bible');
const argv = process.argv.slice(2);
const biblePath = argv.find((a) => !a.startsWith('--') && !a.includes('='));
if (!biblePath) { console.error('usage: node make-bible.mjs bible.json [--pick NAME=n ...] [--angles] [--redo NAME]'); process.exit(1); }
const bible = JSON.parse(fs.readFileSync(biblePath, 'utf8'));
const DIR = path.resolve(path.dirname(biblePath), 'bible');
fs.mkdirSync(DIR, { recursive: true });
const IMAGE_MODEL = bible.imageModel || 'nano-banana-pro';
const N = bible.candidates || 3;
const picks = argv.filter((a) => a.includes('=')).map((a) => a.split('='));
const ANGLES = argv.includes('--angles');
const REDO = argv.includes('--redo') ? argv[argv.indexOf('--redo') + 1] : null;
const money = ledger(path.join(DIR, 'cost.json'));
const dir = (name) => { const d = path.join(DIR, name); fs.mkdirSync(d, { recursive: true }); return d; };

// How each kind of thing is photographed for its master.
const POSE = {
  person: 'Waist-up portrait facing the camera, neutral expression, even soft light, plain sand-coloured background, nothing else in frame.',
  vehicle: 'The whole vehicle, three-quarter front view, standing still on flat ground, nothing else in frame.',
  set: 'A clear wide view of the whole place, empty of people unless the description says otherwise.',
  location: 'One wide master view of the whole location from a high vantage point, every named part in its fixed position, so that all other views can be taken from it.',
  prop: 'The object alone on a plain background.',
};

if (REDO) {
  const d = dir(REDO);
  for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true });
  log(`cleared ${REDO}`);
}

for (const [name, n] of picks) {
  const targets = name === 'all' ? Object.keys(bible.entities).filter((e) => !has(path.join(DIR, e, 'master.jpg'))) : [name];
  for (const t of targets) {
    const src = path.join(DIR, t, `candidate_${n}.jpg`);
    if (!has(src)) { warn(`${t}: no candidate_${n}.jpg to approve`); continue; }
    fs.copyFileSync(src, path.join(DIR, t, 'master.jpg'));
    writeJson(path.join(DIR, t, 'master.jpg.key'), readJson(`${src}.key`, null));
    log(`${t}: approved candidate ${n}`);
  }
}

// 1. Candidates for anything not yet approved. An entity that "uses" others (a base that
//    contains the tower) waits until they are approved, and is then generated FROM their
//    masters and checked against them - so the tower in the base picture IS the tower.
const approvedNow = (n) => has(path.join(DIR, n, 'master.jpg'));
const pending = Object.entries(bible.entities).filter(([name]) => !approvedNow(name));
const deps = (e) => [...(e.from ? [e.from] : []), ...(e.uses || [])];
const ready = pending.filter(([, e]) => deps(e).every(approvedNow));
const waiting = pending.filter(([, e]) => !deps(e).every(approvedNow));
for (const [name, e] of waiting) log(`${name}: waiting until ${deps(e).filter((u) => !approvedNow(u)).join(', ')} approved`);
await pool(ready.flatMap(([name, e]) => Array.from({ length: N }, (_, i) => ({ name, e, i: i + 1 }))), 4, async ({ name, e, i }) => {
  // "uses": other masters that must appear, unchanged.  "from": edit THAT master in place, same viewpoint.
  const uses = [...new Set([...(e.from ? [e.from] : []), ...(e.uses || [])])];
  const refs = uses.map((u) => path.join(DIR, u, 'master.jpg'));
  const check = uses.map((u) => ({ name: u, kind: bible.entities[u].kind, look: bible.entities[u].look }));
  const legend = uses.map((u, k) => `reference ${k + 1} is ${u}`).join('; ');
  const geo = e.kind === 'person' || e.kind === 'vehicle' ? '' : (bible.geography || '');
  const tr = e.transform || {};
  const trText = Object.entries(tr).map(([k, v]) => `${k} is shown ${v}`).join('; ');
  const prompt = e.from
    ? `${legend}. Edit reference 1 in place: keep exactly the same camera viewpoint, framing and layout and every element unchanged, except: ${e.look}${trText ? `; ${trText}` : ''}.${geo ? ` Fixed geography: ${geo}` : ''} ${bible.style}`
    : `${legend ? `${legend}. Include exactly these, unchanged in every detail${trText ? ` except that ${trText}` : ''}, in the picture. ` : ''}${e.look}. ${POSE[e.kind] || POSE.prop}${geo ? ` Fixed geography of this location: ${geo}` : ''} ${bible.style}`;
  await makeImage({ modelName: IMAGE_MODEL, file: path.join(dir(name), `candidate_${i}.jpg`), key: hash(prompt, i, IMAGE_MODEL, refs.map((f) => readJson(`${f}.key`, null))), prompt, refs, check, geography: geo, transform: tr, charge: money.charge, log, warn });
});
if (ready.length) {
  const entries = ready.flatMap(([name]) => Array.from({ length: N }, (_, i) => ({ file: path.join(DIR, name, `candidate_${i + 1}.jpg`), label: `${name} ${i + 1}` })).filter((x) => has(x.file)));
  contactSheet(entries, path.join(DIR, 'candidates.jpg'), DIR, N);
  log(`candidates -> bible/candidates.jpg   (${ready.map(([n]) => n).join(', ')})`);
  log(`approve with:  node make-bible.mjs ${path.basename(biblePath)} --pick ${ready.map(([n]) => `${n}=1`).join(' ')}   (change the numbers to the ones you like)`);
  if (waiting.length) log(`then run make-bible again to get candidates for: ${waiting.map(([n]) => n).join(', ')}`);
}

// 2. Extra angles, each derived FROM the approved master so it is the same thing.
if (ANGLES) {
  const jobs = [];
  for (const [name, e] of Object.entries(bible.entities)) {
    const master = path.join(DIR, name, 'master.jpg');
    if (!has(master)) { warn(`${name}: not approved yet, skipping angles`); continue; }
    // An angle file with a ".pinned" marker beside it was supplied by hand and is never regenerated.
    (e.angles || []).forEach((angle, i) => { if (!fs.existsSync(path.join(DIR, name, `angle_${i + 1}.jpg.pinned`))) jobs.push({ name, e, angle, i: i + 1, master }); });
  }
  await pool(jobs, 4, async ({ name, e, angle, i, master }) => {
    const uses = (e.uses || []).filter(approvedNow);
    const refs = [master, ...uses.map((u) => path.join(DIR, u, 'master.jpg'))];
    const check = [{ name, kind: e.kind, look: e.look }, ...uses.map((u) => ({ name: u, kind: bible.entities[u].kind, look: bible.entities[u].look }))];
    const geo = e.kind === 'person' || e.kind === 'vehicle' ? '' : (bible.geography || '');
    const prompt = `Reference 1 is ${name}${uses.map((u, k) => `; reference ${k + 2} is ${u}`).join('')}. Re-photograph exactly the same ${e.kind === 'person' ? 'person' : e.kind === 'vehicle' ? 'vehicle' : 'place'} - every structure, object, material and colour unchanged, nothing added and nothing removed - from a new camera position: ${angle}.${geo ? ` Fixed geography: ${geo}` : ''} ${bible.style}`;
    await makeImage({ modelName: IMAGE_MODEL, file: path.join(dir(name), `angle_${i}.jpg`), key: hash(prompt, refs.map((f) => readJson(`${f}.key`, null)), IMAGE_MODEL), prompt, refs, check, geography: geo, transform: e.transform || {}, charge: money.charge, log, warn });
  });
}

// 3. Sheet of everything approved.
const approved = Object.keys(bible.entities).filter((name) => has(path.join(DIR, name, 'master.jpg')));
const entries = approved.flatMap((name) => [{ file: path.join(DIR, name, 'master.jpg'), label: name },
  ...fs.readdirSync(path.join(DIR, name)).filter((f) => /^angle_\d+\.jpg$/.test(f)).sort().map((f) => ({ file: path.join(DIR, name, f), label: `${name} ${f.replace('.jpg', '')}` }))]);
if (entries.length) { contactSheet(entries, path.join(DIR, 'masters.jpg'), DIR, 4); log(`approved: ${approved.join(', ')} -> bible/masters.jpg`); }
const missing = Object.keys(bible.entities).filter((n) => !approved.includes(n));
if (missing.length) log(`still to approve: ${missing.join(', ')}`);
// Continuity summary of everything checked.
const bad = [];
for (const name of Object.keys(bible.entities)) { const d = path.join(DIR, name); if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.check.json'))) { const v = readJson(path.join(d, f), null); if (v && !v.ok) bad.push(`${name}/${f.replace('.check.json', '')}: ${v.problems.map((p) => `${p.entity} - ${p.issue}`).join('; ')}`); } }
if (bad.length) { log(`CONTINUITY FAILURES (${bad.length}) - do not approve these:`); bad.forEach((b) => log('  ' + b)); } else log('continuity: every checked picture passed');
log(`bible spend so far: $${money.total()}`);
