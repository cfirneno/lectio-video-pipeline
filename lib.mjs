// Shared plumbing for the pipeline: logging, caching, ffmpeg, ElevenLabs, fal.
// Nothing here knows about scenes; make-bible / make-scene / make-breakdown build on it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const log = (tag) => (m) => console.log(`[${tag}] ${m}`);
export const warn = (tag) => (m) => console.warn(`[${tag}] WARNING: ${m}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const has = (f) => fs.existsSync(f) && fs.statSync(f).size > 0;
export const hash = (...parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
export const readJson = (f, dflt) => (has(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : dflt);
export const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
// A cached file is only reused if it was made from the same inputs ("key").
export const fresh = (file, key) => has(file) && readJson(`${file}.key`, null) === key;
export const stamp = (file, key) => writeJson(`${file}.key`, key);

export function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env ${name} (add it to Replit Secrets)`); process.exit(1); }
  return v;
}

export function run(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 27 });
  if (r.error) throw new Error(`${bin} not runnable: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${bin} failed:\n${(r.stderr || '').split('\n').slice(-15).join('\n')}`);
  return r;
}
export const ffmpeg = (args, cwd) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], cwd);
export const duration = (file, cwd) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], cwd).stdout.trim());

// Run fn over items, at most n at a time.
export async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const it = items[next++]; await fn(it); }
  }));
}

// Spend tracking that survives interruptions.
export function ledger(file) {
  const cost = readJson(file, {});
  return {
    cost,
    charge(kind, usd) { cost[kind] = Number(((cost[kind] || 0) + usd).toFixed(4)); writeJson(file, cost); },
    total() { return Number(Object.values(cost).reduce((a, b) => a + b, 0).toFixed(2)); },
  };
}

// ───────────────────────────── ElevenLabs ─────────────────────────────

export const EL = 'https://api.elevenlabs.io';
export async function el(url, body) {
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'xi-api-key': need('ELEVENLABS_API_KEY'), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status} ${url.replace(EL, '')}: ${(await res.text()).slice(0, 400)}`);
  return res;
}

// ───────────────────────────── fal ─────────────────────────────

const falHeaders = () => ({ authorization: `Key ${need('FAL_KEY')}`, 'content-type': 'application/json' });

// Submit a job and wait for it. The job ticket is kept on disk so an interrupted run
// picks the SAME job back up instead of submitting (and paying for) a new one.
export async function fal(model, input, ticket, label = ticket) {
  let job = readJson(ticket, null);
  if (!job) {
    const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: falHeaders(), body: JSON.stringify(input) });
    if (!sub.ok) throw new Error(`fal submit ${sub.status} (${model}): ${(await sub.text()).slice(0, 500)}`);
    const j = await sub.json();
    job = { status_url: j.status_url, response_url: j.response_url };
    writeJson(ticket, job);
  }
  const t0 = Date.now();
  for (;;) {
    const st = await (await fetch(job.status_url, { headers: falHeaders() })).json();
    if (st.status === 'COMPLETED') break;
    if (st.status && !['IN_QUEUE', 'IN_PROGRESS'].includes(st.status)) { fs.rmSync(ticket, { force: true }); throw new Error(`fal ${label}: status ${st.status}`); }
    if (Date.now() - t0 > 30 * 60_000) throw new Error(`fal ${label}: still running after 30 min; re-run to keep waiting on the same job`);
    await sleep(4000);
  }
  const res = await fetch(job.response_url, { headers: falHeaders() });
  fs.rmSync(ticket, { force: true });
  if (!res.ok) throw new Error(`fal result ${res.status} (${label}): ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

export async function falUpload(file, contentType) {
  const bytes = fs.readFileSync(file);
  try {
    const init = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', { method: 'POST', headers: falHeaders(), body: JSON.stringify({ file_name: path.basename(file), content_type: contentType }) });
    if (!init.ok) throw new Error(`initiate ${init.status}`);
    const { file_url, upload_url } = await init.json();
    const put = await fetch(upload_url, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes });
    if (!put.ok) throw new Error(`put ${put.status}`);
    return file_url;
  } catch {
    return `data:${contentType};base64,${bytes.toString('base64')}`; // fal also accepts files inline
  }
}

export async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

export const dataUri = (file) => `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;

// Image models. Prices read from fal.ai model pages, Sept 2026.
export const IMAGE_MODELS = {
  // Takes several reference pictures at once and keeps them; the consistency workhorse.
  'nano-banana-pro': { edit: 'fal-ai/nano-banana-pro/edit', text: 'fal-ai/nano-banana-pro', price: 0.15,
    input: (prompt, refs, opts = {}) => ({ prompt, ...(refs.length ? { image_urls: refs } : {}), aspect_ratio: '16:9', resolution: opts.hires ? '4K' : '1K', output_format: 'jpeg' }) },
  'kontext-max': { edit: 'fal-ai/flux-pro/kontext/max/multi', text: 'fal-ai/flux-pro/kontext/max/text-to-image', price: 0.08,
    input: (prompt, refs) => ({ prompt, ...(refs.length ? { image_urls: refs } : {}), aspect_ratio: '16:9', output_format: 'jpeg', safety_tolerance: '5' }) },
};

// ───────────────────────────── continuity check (vision LLM) ─────────────────────────────
// Shows the reference masters and the new picture to a vision model and asks, entity by
// entity, whether it is the SAME thing in every visible detail. Uses the OpenAI integration
// Replit provides. Returns { ok, problems: [{ entity, issue }] } or null if unavailable.
export async function continuityCheck(refs, file, entities, geography = '', transform = {}, must = []) {
  const base = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL, key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!base || !key || !entities.length) return null;
  const legend = entities.map((e, i) => `Reference ${i + 1} = ${e.name} (a ${e.kind})`).join('\n');
  const content = [{ type: 'text', text: `You are a film continuity supervisor. The first ${refs.length} image(s) are approved reference PICTURES. The LAST image is a newly generated shot that must show the same things.\n${legend}\n\nJudge ONLY by comparing the last image with the reference pictures. Do not judge against any written description. For each named entity that is clearly visible in the last image, say whether it is recognisably the SAME one as in its reference picture: same overall shape and proportions, same construction, same materials and colours, same face and hair, same clothing, same vehicle body and armor, same weapons. A different camera angle, distance, crop, lighting, weather, time of day or motion blur is fine. Judge at the scale shown: in a wide view only an entity's overall silhouette, height, proportions and top can be compared, so do not flag stair, bracing, railing or gun details that occupy only a few pixels; in a close view compare the details. If an entity is too small or too blurred to compare at all, say nothing about it. Flag only what a film audience would notice at once as a DIFFERENT thing: a different person (different face, beard, skin or hair), a different vehicle (no steel front, different body), a structure of a clearly different kind or size, a hand-held rifle where the reference has a mounted machine gun. Do NOT flag: a gate open instead of closed, small vehicles or people in the background, fence or wire visible behind or on top of a wall, minor differences of proportion, framing, bracing, railings, parapet height or roof detail, or an interior view not showing an exterior structure.${Object.keys(transform).length ? `\n\nINTENDED CHANGES: in this shot the following are deliberately shown altered, and their alteration must NOT be flagged; check only that what remains of them is consistent with the reference (same materials, colours, construction): ${Object.entries(transform).map(([k, v]) => `${k} - ${v}`).join('; ')}.` : ''}${must.length ? `\n\nREQUIRED ELEMENTS: the last image MUST clearly show each of these; flag any that is missing or replaced by something else as entity "REQUIRED": ${must.join('; ')}.` : ''}${geography ? `\n\nAlso enforce this fixed geography of the location, and flag a clear violation as entity "GEOGRAPHY": ${geography}. Judge geography ONLY for things that are in frame: a view that looks away from the base, or a close-up that does not include the wall, the opening or the tower, does not violate the geography by not showing them.` : ''}\nAnswer ONLY with JSON: {"ok": true|false, "problems": [{"entity": NAME, "issue": "one short sentence"}]}` }];
  refs.forEach((f) => content.push({ type: 'image_url', image_url: { url: dataUri(f), detail: 'low' } }));
  content.push({ type: 'image_url', image_url: { url: dataUri(file), detail: 'high' } });
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4', response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] }) });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = JSON.parse((await res.json()).choices[0].message.content);
    // Entities declared as deliberately transformed cannot fail for being transformed.
    const exempt = new Set(Object.keys(transform).map((k) => k.toUpperCase()));
    const problems = (j.problems || []).filter((p) => !exempt.has(String(p.entity || '').toUpperCase()));
    return { ok: !problems.length, problems };
  } catch (e) {
    return { ok: true, problems: [], skipped: `continuity check unavailable: ${e.message.slice(0, 120)}` };
  }
}

// Where is <what> in this picture? Returns { x, y, w, h } as fractions of the image, or null.
export async function locate(file, what) {
  const base = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL, key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!base || !key) return null;
  const content = [
    { type: 'text', text: `Find ${what} in this image. Answer ONLY with JSON giving its bounding box as fractions of the image width and height: {"found": true|false, "x": left, "y": top, "w": width, "h": height}. Include the whole object with a little margin.` },
    { type: 'image_url', image_url: { url: dataUri(file), detail: 'high' } }];
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4', response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] }) });
    if (!res.ok) throw new Error(`${res.status}`);
    const j = JSON.parse((await res.json()).choices[0].message.content);
    if (!j.found) return null;
    return { x: +j.x, y: +j.y, w: +j.w, h: +j.h };
  } catch { return null; }
}

// One picture from a prompt plus 0..n reference pictures, checked for continuity against
// them and regenerated (with the complaint added) when it fails. Returns true on success.
// `check` = [{ name, kind, look }] describing what each reference is, in the same order as refs.
// `soft`: entities whose complaints are recorded as warnings but never cause a retry (e.g. GEOGRAPHY on scene stills).
export async function makeImage({ modelName, file, key, prompt, refs = [], check = [], geography = '', transform = {}, soft = [], must = [], attempts = 3, hires = false, charge, log: L, warn: W }) {
  if (fresh(file, key)) return true;
  const M = IMAGE_MODELS[modelName];
  let feedback = '';
  let verdict = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const input = M.input(prompt + feedback, refs.map(dataUri), { hires });
      const r = await fal(refs.length ? M.edit : M.text, input, `${file}.job.json`, path.basename(file));
      await download(r.images[0].url, file);
      charge('images', M.price * (hires ? 2 : 1));
      // A safety filter hands back an all-black picture instead of an error; a real still is far bigger than this.
      if (fs.statSync(file).size < 20000) { fs.rmSync(file, { force: true }); throw new Error('blank image returned (probably the content filter) - reword the shot'); }
      verdict = refs.length && check.length ? await continuityCheck(refs, file, check, geography, transform, must) : null;
      if (verdict && soft.length) {
        const softOnes = verdict.problems.filter((p) => soft.includes(String(p.entity).toUpperCase()));
        if (softOnes.length) W(`${path.basename(file)}: note - ${softOnes.map((p) => `${p.entity}: ${p.issue}`).join('; ')}`);
        verdict.problems = verdict.problems.filter((p) => !soft.includes(String(p.entity).toUpperCase()));
        verdict.ok = !verdict.problems.length;
      }
      if (verdict && !verdict.ok) {
        W(`${path.basename(file)} attempt ${attempt}: continuity failed - ${verdict.problems.map((p) => `${p.entity}: ${p.issue}`).join('; ')}`);
        if (attempt < attempts) { feedback = ` IMPORTANT, the previous attempt got this wrong and it must be fixed: ${verdict.problems.map((p) => `${p.entity} - ${p.issue}`).join('; ')}.`; continue; }
      }
      stamp(file, key);
      writeJson(`${file}.check.json`, verdict || { ok: true, problems: [], skipped: 'no references' });
      L(`${path.basename(file)} generated${verdict ? (verdict.ok ? ' (continuity OK)' : ' (CONTINUITY FAILED, kept best attempt)') : ''}`);
      return true;
    } catch (e) {
      W(`${path.basename(file)} attempt ${attempt} failed: ${e.message.slice(0, 200)}`);
      if (attempt === attempts) return false;
    }
  }
}

// Tile pictures into a labelled contact sheet.
export function contactSheet(entries, outFile, cwd, cols = 5) {
  if (!entries.length) return;
  const tw = 480, th = 270, font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const label = fs.existsSync(font) ? (t) => `,drawtext=fontfile='${font}':text='${t.replace(/[':]/g, '')}':fontsize=22:fontcolor=yellow:borderw=2:bordercolor=black:x=8:y=8` : () => '';
  const inputs = entries.flatMap((e) => ['-i', e.file]);
  const f = entries.map((e, i) => `[${i}:v]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th}${label(e.label)}[t${i}]`);
  if (entries.length === 1) f.push('[t0]null[v]');
  else f.push(`${entries.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${entries.length}:layout=${entries.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * th}`).join('|')}:fill=black[v]`);
  ffmpeg([...inputs, '-filter_complex', f.join(';'), '-map', '[v]', '-frames:v', '1', '-q:v', '3', outFile], cwd);
}
