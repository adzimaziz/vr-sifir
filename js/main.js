import * as THREE from 'three';
import * as A from './audio.js';
import * as DB from './songs-db.js';

const $ = (s) => document.querySelector(s);
const V3 = THREE.Vector3;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------- settings
const DIFFS = {
  mudah: { label: 'Mudah', desc: 'Perlahan', travel: 6.0, minGap: 3.2 },
  sederhana: { label: 'Sederhana', desc: 'Ikut rentak', travel: 4.6, minGap: 2.2 },
  sukar: { label: 'Sukar', desc: 'Laju!', travel: 3.4, minGap: 1.25 },
};

const settings = Object.assign({ tables: [2, 3, 4, 5], diff: 'mudah', songId: null }, store.get('settings', {}));
if (!DIFFS[settings.diff]) settings.diff = 'mudah';
const saveSettings = () => store.set('settings', settings);

// ---------------------------------------------------------------- geometry constants
const HIT_Z = -1.15;        // where a row arrives exactly on the beat
const SPAWN_DIST = 22;      // metres travelled from spawn to HIT_Z
const LANES = [-0.55, 0, 0.55];
const CUBE = 0.38;
const HIT_R = 0.27;
const BLADE = 0.95;
const BLADE_START = 0.1;
const MIN_SPEED = 0.5;      // tip speed (m/s) needed to count as a hit

// ---------------------------------------------------------------- menu
let songs = [];
let currentPrep = null;     // { id, buffer, autoBpm, offset }
let prepToken = 0;
let vrSupported = false;

function setStatus(text, err = false) {
  const el = $('#songStatus');
  el.textContent = text;
  el.classList.toggle('err', err);
}

function buildTables() {
  const box = $('#tables');
  box.innerHTML = '';
  for (let n = 1; n <= 12; n++) {
    const b = document.createElement('button');
    b.textContent = n;
    b.className = 'tbl' + (settings.tables.includes(n) ? ' on' : '');
    b.onclick = () => {
      settings.tables = settings.tables.includes(n)
        ? settings.tables.filter((x) => x !== n)
        : [...settings.tables, n].sort((a, c) => a - c);
      saveSettings();
      buildTables();
      updatePlayButtons();
    };
    box.append(b);
  }
}
$('#tAll').onclick = () => { settings.tables = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; saveSettings(); buildTables(); updatePlayButtons(); };
$('#tNone').onclick = () => { settings.tables = []; saveSettings(); buildTables(); updatePlayButtons(); };

function buildDiffs() {
  const box = $('#diffs');
  box.innerHTML = '';
  for (const [key, d] of Object.entries(DIFFS)) {
    const b = document.createElement('button');
    b.className = settings.diff === key ? 'on' : '';
    b.innerHTML = `${d.label}<small>${d.desc}</small>`;
    b.onclick = () => { settings.diff = key; saveSettings(); buildDiffs(); updateRecord(); };
    box.append(b);
  }
}

async function loadSongList() {
  const list = [{ id: 'builtin', name: 'Rentak Asas (muzik terbina)', kind: 'builtin' }];
  try {
    const r = await fetch('songs/songs.json', { cache: 'no-cache' });
    const j = await r.json();
    for (const s of j.songs || []) {
      list.push({ id: 'file:' + s.file, name: s.title || s.file, kind: 'file', url: 'songs/' + s.file, bpm: s.bpm, offset: s.offset });
    }
  } catch (e) { console.warn('songs.json', e); }
  try {
    for (const s of await DB.listSongs()) list.push({ id: s.id, name: s.name, kind: 'local' });
  } catch (e) { console.warn('IndexedDB', e); }
  songs = list;
  if (!songs.find((s) => s.id === settings.songId)) settings.songId = songs[1] ? songs[1].id : 'builtin';
  renderSongs();
}

function renderSongs() {
  const box = $('#songs');
  box.innerHTML = '';
  for (const s of songs) {
    const b = document.createElement('button');
    b.className = 'song' + (s.id === settings.songId ? ' on' : '');
    const kind = { builtin: 'terbina', file: 'lagu', local: 'dari peranti' }[s.kind];
    b.innerHTML = `<span>${s.id === settings.songId ? '▶' : '♪'}</span><span class="name"></span><span class="kind">${kind}</span>`;
    b.querySelector('.name').textContent = s.name;
    b.onclick = () => selectSong(s.id);
    if (s.kind === 'local') {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Buang lagu';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Buang lagu "${s.name}"?`)) return;
        await DB.deleteSong(s.id);
        if (settings.songId === s.id) settings.songId = 'builtin';
        await loadSongList();
        prepareSelected();
      };
      b.append(del);
    }
    box.append(b);
  }
}

function selectSong(id) {
  if (id === settings.songId && currentPrep) return;
  settings.songId = id;
  saveSettings();
  renderSongs();
  prepareSelected();
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

async function prepareSelected() {
  const id = settings.songId;
  const song = songs.find((s) => s.id === id);
  if (!song) return;
  const token = ++prepToken;
  currentPrep = null;
  updatePlayButtons();
  setStatus('Memuatkan lagu…');
  try {
    let buffer, beat;
    if (song.kind === 'builtin') {
      await nextFrame();
      buffer = A.makeBuiltinBeat();
      beat = { bpm: A.BUILTIN_BPM, offset: 0 };
    } else {
      const data = song.kind === 'file'
        ? await (await fetch(song.url)).arrayBuffer()
        : await (await DB.getSong(id)).blob.arrayBuffer();
      if (token !== prepToken) return;
      buffer = await A.decode(data);
      if (token !== prepToken) return;
      const key = 'beat:' + id + ':' + buffer.duration.toFixed(2);
      beat = store.get(key, null);
      if (!beat) {
        setStatus('Menganalisis rentak lagu…');
        await nextFrame();
        beat = A.analyzeBeat(buffer);
        store.set(key, beat);
      }
      if (song.bpm) beat = { ...beat, bpm: song.bpm };
      if (song.offset != null) beat = { ...beat, offset: song.offset };
    }
    if (token !== prepToken) return;
    currentPrep = { id, name: song.name, buffer, autoBpm: beat.bpm, offset: beat.offset };
    showBpm();
  } catch (e) {
    console.error(e);
    if (token === prepToken) setStatus('✖ Gagal memuatkan lagu: ' + (e.message || e), true);
  }
  updatePlayButtons();
  updateRecord();
}

function currentBpm() {
  return store.get('bpm:' + currentPrep.id, null) || currentPrep.autoBpm;
}

function showBpm() {
  if (!currentPrep) return;
  const ov = store.get('bpm:' + currentPrep.id, null);
  $('#bpm').value = currentBpm().toFixed(1);
  setStatus(`✔ Sedia · ${fmtTime(currentPrep.buffer.duration)} · BPM ${currentBpm().toFixed(1)} ${ov ? '(ditetapkan)' : '(auto)'}`);
}

function setBpm(v) {
  if (!currentPrep || !(v >= 40 && v <= 240)) { showBpm(); return; }
  store.set('bpm:' + currentPrep.id, Math.round(v * 10) / 10);
  showBpm();
}
$('#bpm').onchange = (e) => setBpm(parseFloat(e.target.value));
$('#bpmHalf').onclick = () => currentPrep && setBpm(currentBpm() / 2);
$('#bpmDouble').onclick = () => currentPrep && setBpm(currentBpm() * 2);
$('#bpmAuto').onclick = () => { if (currentPrep) { store.del('bpm:' + currentPrep.id); showBpm(); } };

$('#fileIn').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  setStatus('Menyimpan lagu…');
  try {
    const rec = await DB.addSong(f);
    await loadSongList();
    selectSong(rec.id);
  } catch (err) {
    setStatus('✖ Tidak dapat simpan lagu: ' + err.message, true);
  }
};

function updatePlayButtons() {
  const ok = !!currentPrep && settings.tables.length > 0;
  $('#btnVR').disabled = !ok || !vrSupported;
  $('#btnScreen').disabled = !ok;
  let note = '';
  if (!settings.tables.length) note = 'Pilih sekurang-kurangnya satu sifir.';
  else if (!vrSupported) note = window.isSecureContext
    ? 'VR tidak dikesan. Buka laman ini dalam Pico Browser untuk main VR.'
    : 'VR perlukan HTTPS (contoh GitHub Pages).';
  $('#vrNote').textContent = note;
}

const hsKey = () => `hs:${settings.songId}:${settings.diff}`;
function updateRecord() {
  const hs = store.get(hsKey(), 0);
  $('#record').textContent = hs ? `🏆 Rekod (${DIFFS[settings.diff].label}): ${hs}` : '';
}

function showLastResult() {
  const r = store.get('lastResult', null);
  const el = $('#lastResult');
  if (!r) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<h3>Keputusan terakhir ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}</h3>
    <div class="stats">
      <div><b>${r.score}</b><span>Markah</span></div>
      <div><b>${r.correct}</b><span>Betul</span></div>
      <div><b>${r.wrong + r.missed}</b><span>Salah/terlepas</span></div>
      <div><b>${r.acc}%</b><span>Ketepatan</span></div>
    </div>
    ${r.mistakes.length ? `<div class="mistakes">Ulang kaji: ${r.mistakes.map((m) => `<b>${m}</b>`).join(' · ')}</div>` : ''}`;
}

// ---------------------------------------------------------------- three.js setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
if (renderer.xr.setFoveation) renderer.xr.setFoveation(0.5);
$('#game').prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05030f);
scene.fog = new THREE.Fog(0x05030f, 14, 40);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 150);
camera.position.set(0, 1.6, 0);
scene.add(camera);

scene.add(new THREE.HemisphereLight(0x9aa8ff, 0x2a0a40, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1, 3, 2);
scene.add(sun);

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

// ---------------------------------------------------------------- world
const ringMat = new THREE.MeshBasicMaterial({ color: 0xff3d8b });
const ringBase = new THREE.Color(0xff3d8b);
const railMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });

(function buildWorld() {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 70), new THREE.MeshBasicMaterial({ color: 0x0b0720 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -30;
  scene.add(floor);

  const grid = new THREE.GridHelper(70, 70, 0x7c3aed, 0x2e1065);
  grid.position.set(0, 0.002, -30);
  scene.add(grid);

  const railGeo = new THREE.BoxGeometry(0.04, 0.02, 50);
  for (const x of [-1.15, 1.15]) {
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.set(x, 0.01, -23);
    scene.add(rail);
  }

  const ringGeo = new THREE.TorusGeometry(3.4, 0.05, 6, 48);
  for (let i = 0; i < 8; i++) {
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(0, 1.4, -7 - i * 5);
    scene.add(ring);
  }

  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.MeshBasicMaterial({ color: 0x9d174d, fog: false }));
  sunDisc.position.set(0, 9, -90);
  scene.add(sunDisc);

  const starPos = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i++) {
    const v = new V3().randomDirection();
    v.y = Math.abs(v.y) * 0.9 + 0.05;
    v.normalize().multiplyScalar(80);
    starPos.set([v.x, v.y, v.z], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.35, fog: false })));
})();

// ---------------------------------------------------------------- canvas text helpers
const FONT = 'system-ui, "Segoe UI", Roboto, Arial, sans-serif';

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

class Panel {
  constructor(w, h, pw, ph) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.g = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, fog: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mat);
    this.mesh.renderOrder = 2;
  }
  draw(fn) {
    const { g, canvas } = this;
    g.clearRect(0, 0, canvas.width, canvas.height);
    fn(g, canvas.width, canvas.height);
    this.tex.needsUpdate = true;
    return this;
  }
  dispose() {
    this.tex.dispose();
    this.mat.dispose();
    this.mesh.geometry.dispose();
  }
}

function text(g, str, x, y, size, color = '#fff', align = 'center', weight = 800) {
  g.font = `${weight} ${size}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(str, x, y);
}

// ---------------------------------------------------------------- cubes
const cubeGeo = new THREE.BoxGeometry(CUBE, CUBE, CUBE);
const halfGeo = new THREE.BoxGeometry(CUBE, CUBE / 2, CUBE);
const edgeGeo = new THREE.EdgesGeometry(cubeGeo);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x9be7ff });
const sideMat = new THREE.MeshLambertMaterial({ color: 0x2747d6, emissive: 0x0c1c66 });
const greenSideMat = new THREE.MeshLambertMaterial({ color: 0x16a34a, emissive: 0x0a5a26 });
const cubeMatCache = new Map();

function cubeMats(n, green) {
  const key = n + (green ? 'g' : '');
  if (!cubeMatCache.has(key)) {
    const tex = canvasTexture(256, 256, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, green ? '#22c55e' : '#3b5bfd');
      grad.addColorStop(1, green ? '#15803d' : '#1e2fa8');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.lineWidth = 10;
      g.strokeStyle = 'rgba(255,255,255,.85)';
      rrect(g, 12, 12, w - 24, h - 24, 26);
      g.stroke();
      const s = String(n);
      text(g, s, w / 2, h / 2 + 6, s.length >= 3 ? 104 : 140);
    });
    const front = new THREE.MeshBasicMaterial({ map: tex });
    const side = green ? greenSideMat : sideMat;
    cubeMatCache.set(key, [side, side, side, side, front, side]);
  }
  return cubeMatCache.get(key);
}

const SIGN_STYLE = {
  q: { bg: 'rgba(30,14,70,.88)', border: '#c084fc', head: null },
  ok: { bg: 'rgba(10,70,35,.92)', border: '#4ade80', head: ['BETUL!', '#bbf7d0'] },
  bad: { bg: 'rgba(90,15,25,.92)', border: '#f87171', head: ['SALAH!', '#fecaca'] },
  miss: { bg: 'rgba(80,50,10,.92)', border: '#fbbf24', head: ['TERLEPAS', '#fde68a'] },
};

function drawSign(panel, row, style) {
  const st = SIGN_STYLE[style];
  panel.draw((g, w, h) => {
    g.fillStyle = st.bg;
    rrect(g, 6, 6, w - 12, h - 12, 30);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = st.border;
    g.stroke();
    const q = `${row.a} × ${row.b} = ${style === 'q' ? '?' : row.ans}`;
    if (st.head) {
      text(g, st.head[0], w / 2, 44, 40, st.head[1]);
      text(g, q, w / 2, 118, 78);
    } else {
      text(g, q, w / 2, h / 2 + 4, 92);
    }
  });
}

// ---------------------------------------------------------------- effects
const fx = { slices: [], floaters: [] };

const MAX_PARTICLES = 200;
const particles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 0.035, 0.035), new THREE.MeshBasicMaterial(), MAX_PARTICLES);
particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
particles.frustumCulled = false;
scene.add(particles);
const pData = Array.from({ length: MAX_PARTICLES }, () => ({ pos: new V3(), vel: new V3(), life: 0, max: 1 }));
let pNext = 0;
const tmpM = new THREE.Matrix4();
const tmpC = new THREE.Color();
const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
for (let i = 0; i < MAX_PARTICLES; i++) {
  particles.setMatrixAt(i, zeroM);
  particles.setColorAt(i, tmpC.set(0xffffff));
}

function burst(pos, color, count = 22) {
  tmpC.set(color);
  for (let k = 0; k < count; k++) {
    const p = pData[pNext];
    particles.setColorAt(pNext, k % 3 === 0 ? tmpC.clone().lerp(new THREE.Color(0xffffff), 0.6) : tmpC);
    p.pos.copy(pos);
    p.vel.randomDirection().multiplyScalar(1.5 + Math.random() * 2.5);
    p.max = p.life = 0.4 + Math.random() * 0.4;
    pNext = (pNext + 1) % MAX_PARTICLES;
  }
  particles.instanceColor.needsUpdate = true;
}

function sliceCube(pos, dir, bladeDir, green) {
  const n = new V3().crossVectors(dir, bladeDir);
  if (n.lengthSq() < 1e-4) n.set(1, 0, 0);
  n.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), n);
  for (const sgn of [1, -1]) {
    const mat = (green ? greenSideMat : sideMat).clone();
    mat.transparent = true;
    const m = new THREE.Mesh(halfGeo, mat);
    m.quaternion.copy(q);
    m.position.copy(pos).addScaledVector(n, sgn * CUBE / 4);
    scene.add(m);
    fx.slices.push({
      mesh: m,
      vel: n.clone().multiplyScalar(sgn * 1.8).addScaledVector(dir, 1.2).add(new V3(0, 0.8, 1.5)),
      spin: new V3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(10),
      life: 0.8,
    });
  }
}

function addFloater(mesh, mat, life, vy, onDone) {
  fx.floaters.push({ mesh, mat, life, max: life, vy, onDone });
}

const popupTex = new Map();
function popup(str, color, pos) {
  if (!popupTex.has(str)) {
    popupTex.set(str, canvasTexture(256, 128, (g, w, h) => {
      g.shadowColor = color;
      g.shadowBlur = 18;
      text(g, str, w / 2, h / 2, 86, color);
    }));
  }
  const mat = new THREE.MeshBasicMaterial({ map: popupTex.get(str), transparent: true, depthWrite: false, fog: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.3), mat);
  m.position.copy(pos);
  m.renderOrder = 3;
  scene.add(m);
  addFloater(m, mat, 0.9, 0.6, () => { m.geometry.dispose(); mat.dispose(); });
}

const fxV = new V3();
const fxE = new THREE.Euler();
function updateFx(dt) {
  let any = false;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = pData[i];
    if (p.life <= 0) continue;
    any = true;
    p.life -= dt;
    if (p.life <= 0) { particles.setMatrixAt(i, zeroM); continue; }
    p.vel.y -= 5 * dt;
    p.pos.addScaledVector(p.vel, dt);
    const s = p.life / p.max;
    tmpM.makeScale(s, s, s).setPosition(p.pos);
    particles.setMatrixAt(i, tmpM);
  }
  if (any || fx.hadParticles) particles.instanceMatrix.needsUpdate = true;
  fx.hadParticles = any;

  for (let i = fx.slices.length - 1; i >= 0; i--) {
    const s = fx.slices[i];
    s.life -= dt;
    s.vel.y -= 6 * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    fxE.set(s.spin.x * dt, s.spin.y * dt, s.spin.z * dt);
    s.mesh.quaternion.multiply(new THREE.Quaternion().setFromEuler(fxE));
    s.mesh.material.opacity = Math.min(1, s.life / 0.4);
    if (s.life <= 0) {
      scene.remove(s.mesh);
      s.mesh.material.dispose();
      fx.slices.splice(i, 1);
    }
  }

  for (let i = fx.floaters.length - 1; i >= 0; i--) {
    const f = fx.floaters[i];
    f.life -= dt;
    f.mesh.position.y += f.vy * dt;
    f.mat.opacity = Math.min(1, f.life / 0.4);
    if (f.life <= 0) {
      f.mesh.removeFromParent();
      f.onDone && f.onDone();
      fx.floaters.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------- sabers
function makeSaber(color, idx) {
  const group = new THREE.Group();
  const hilt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.024, 0.2, 12),
    new THREE.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.8, roughness: 0.3 }),
  );
  hilt.rotation.x = -Math.PI / 2;
  group.add(hilt);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, BLADE, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.026, BLADE, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  for (const m of [core, glow]) {
    m.rotation.x = -Math.PI / 2;
    m.position.z = -BLADE_START - BLADE / 2;
    group.add(m);
  }
  return {
    idx, group, src: null, has: false,
    base: new V3(), mid: new V3(), tip: new V3(),
    pBase: new V3(), pMid: new V3(), pTip: new V3(),
  };
}
const sabers = [makeSaber(0xff2d55, 0), makeSaber(0x2d9bff, 1)];

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  scene.add(controller);
  controller.addEventListener('connected', (e) => {
    if (!e.data || !e.data.gamepad) return; // ignore hand-tracking sources
    const s = sabers[e.data.handedness === 'left' ? 0 : 1];
    s.src = e.data;
    s.has = false;
    controller.add(s.group);
  });
  controller.addEventListener('disconnected', () => {
    for (const s of sabers) {
      if (s.group.parent === controller) { controller.remove(s.group); s.src = null; s.has = false; }
    }
  });
}

function haptic(s, intensity, ms) {
  const gp = s.src && s.src.gamepad;
  if (!gp) return;
  const h = gp.hapticActuators && gp.hapticActuators[0];
  if (h && h.pulse) h.pulse(intensity, ms);
  else if (gp.vibrationActuator && gp.vibrationActuator.playEffect) {
    gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity });
  }
}

// screen (mouse) mode: the right saber pivots in front of the camera towards the mouse
const mouse = new THREE.Vector2(0, -0.3);
const raycaster = new THREE.Raycaster();
const mousePlane = new THREE.Plane(new V3(0, 0, 1), -HIT_Z); // the plane rows arrive in
const mouseTarget = new V3();
renderer.domElement.addEventListener('pointermove', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
});

function updateMouseSaber() {
  const s = sabers[1];
  raycaster.setFromCamera(mouse, camera);
  if (!raycaster.ray.intersectPlane(mousePlane, mouseTarget)) return;
  s.group.position.set(0.05, G.hitY - 0.3, -0.35);
  // Object3D.lookAt aims +Z, the blade runs along -Z, so look away from the target
  s.group.lookAt(fxV.copy(s.group.position).multiplyScalar(2).sub(mouseTarget));
}

// ---------------------------------------------------------------- 3D buttons & panels
class Btn3D {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 184;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.side = new THREE.MeshLambertMaterial({ color: 0x1e3a8a });
    const front = new THREE.MeshBasicMaterial({ map: this.tex });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.2, 0.08), [this.side, this.side, this.side, this.side, front, this.side]);
    this.mesh.rotation.x = -0.35;
    this.box = new THREE.Box3();
    this.inside = [false, false];
    this.action = null;
  }
  set(label, color, action) {
    const g = this.canvas.getContext('2d');
    const { width: w, height: h } = this.canvas;
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.lineWidth = 12;
    g.strokeStyle = 'rgba(255,255,255,.9)';
    rrect(g, 10, 10, w - 20, h - 20, 26);
    g.stroke();
    text(g, label, w / 2, h / 2 + 4, label.length > 8 ? 62 : 76);
    this.tex.needsUpdate = true;
    this.side.color.set(color).multiplyScalar(0.55);
    this.action = action;
  }
}

const ui = { root: new THREE.Group(), info: new Panel(1.6, 1.0, 800, 500), btnA: new Btn3D(), btnB: new Btn3D(), active: null, shownAt: 0 };
ui.info.mesh.position.set(0, 1.62, -1.9);
ui.btnA.mesh.position.set(-0.36, 1.0, -1.05);
ui.btnB.mesh.position.set(0.36, 1.0, -1.05);
ui.root.add(ui.info.mesh, ui.btnA.mesh, ui.btnB.mesh);
ui.root.visible = false;
scene.add(ui.root);

function drawInfo(title, titleColor, lines, footer) {
  ui.info.draw((g, w, h) => {
    g.fillStyle = 'rgba(20,10,48,.92)';
    rrect(g, 8, 8, w - 16, h - 16, 36);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = titleColor;
    g.stroke();
    text(g, title, w / 2, 70, 76, titleColor);
    let y = 140;
    for (const l of lines) {
      if (l) text(g, l[0], w / 2, y, l[1] || 40, l[2] || '#f1edff', 'center', l[3] || 700);
      y += (l && l[1] ? l[1] : 40) + 16;
    }
    if (footer) text(g, footer, w / 2, h - 44, 30, '#a99fd1', 'center', 600);
  });
}

function showUI(kind) {
  const tables = settings.tables.join(', ');
  if (kind === 'ready') {
    drawInfo('VR SIFIR', '#38bdf8', [
      [`Sifir: ${tables}`, 44],
      [`Lagu: ${trim(currentPrep.name, 30)}`, 36, '#ffc2da'],
      [`Tahap: ${DIFFS[settings.diff].label}`, 36],
      ['Hayun pedang & pukul kiub', 40, '#bbf7d0'],
      ['jawapan yang BETUL!', 40, '#bbf7d0'],
    ], 'Pukul MULA dengan pedang · atau tekan trigger');
    ui.btnA.set('MULA', '#16a34a', startRun);
    ui.btnB.set('KELUAR', '#b91c1c', exitGame);
  } else if (kind === 'pause') {
    drawInfo('JEDA', '#fbbf24', [
      [`Markah: ${G.score}`, 50],
      [`Betul ${G.correct} · Salah ${G.wrong} · Terlepas ${G.missed}`, 36],
    ], 'Trigger / A / X = sambung');
    ui.btnA.set('SAMBUNG', '#16a34a', resumeGame);
    ui.btnB.set('KELUAR', '#b91c1c', exitGame);
  } else if (kind === 'results') {
    const r = G.last;
    const lines = [
      [`${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}`, 64, '#fde047'],
      [`Markah: ${r.score}${r.record ? '  🏆 REKOD BARU!' : ''}`, 46],
      [`Betul ${r.correct} · Salah ${r.wrong} · Terlepas ${r.missed}`, 34],
      [`Ketepatan ${r.acc}% · Kombo maks ${r.maxCombo}`, 34],
    ];
    if (r.mistakes.length) lines.push([`Ulang kaji: ${r.mistakes.slice(0, 4).join('  ')}`, 30, '#86efac']);
    drawInfo('TAMAT!', '#ff3d8b', lines, 'Trigger = main lagi');
    ui.btnA.set('MAIN LAGI', '#16a34a', startRun);
    ui.btnB.set('MENU', '#4338ca', exitGame);
  }
  ui.root.position.y = G.hitY - 1.1;
  ui.root.visible = true;
  ui.active = kind;
  ui.shownAt = performance.now() / 1000;
  ui.btnA.inside = [true, true]; // must leave & re-enter before a press counts
  ui.btnB.inside = [true, true];
}

function hideUI() {
  ui.root.visible = false;
  ui.active = null;
}

function pressButton(btn) {
  if (!btn.action || !ui.active) return;
  A.sfxClick();
  btn.action();
}

const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------------------------------------------------------- HUD
const hud = new Panel(2.6, 0.62, 832, 200);
hud.mesh.visible = false;
scene.add(hud.mesh);

function multiplier() {
  return G.combo >= 14 ? 8 : G.combo >= 6 ? 4 : G.combo >= 2 ? 2 : 1;
}

function drawHUD() {
  const progress = G.duration ? Math.min(1, Math.max(0, songTime() / G.duration)) : 0;
  hud.draw((g, w, h) => {
    g.fillStyle = 'rgba(15,8,40,.75)';
    rrect(g, 4, 4, w - 8, h - 8, 28);
    g.fill();
    text(g, 'MARKAH', 150, 50, 28, '#a99fd1', 'center', 700);
    text(g, String(G.score), 150, 112, 64);
    text(g, 'KOMBO', w / 2, 50, 28, '#a99fd1', 'center', 700);
    text(g, String(G.combo), w / 2, 112, 64, G.combo >= 2 ? '#fde047' : '#fff');
    text(g, 'GANDA', w - 150, 50, 28, '#a99fd1', 'center', 700);
    text(g, 'x' + multiplier(), w - 150, 112, 64, '#38bdf8');
    g.fillStyle = 'rgba(255,255,255,.15)';
    g.fillRect(40, h - 30, w - 80, 10);
    g.fillStyle = '#ff3d8b';
    g.fillRect(40, h - 30, (w - 80) * progress, 10);
  });
}

// ---------------------------------------------------------------- game state
const G = {
  mode: 'idle', // idle | ready | playing | paused | results
  vr: false,
  hitY: 1.15,
  rows: [],
  schedule: [],
  nextIdx: 0,
  startAt: 0,
  duration: 0,
  beatDur: 0.5,
  offset: 0,
  travel: 6,
  speed: 4,
  score: 0, combo: 0, maxCombo: 0, correct: 0, wrong: 0, missed: 0,
  mistakes: [],
  bag: [],
  lastQ: null,
  hudT: 0,
  last: null,
};

function songTime() {
  return A.ctx.currentTime - G.startAt - (A.ctx.outputLatency || 0);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// every multiplication fact of the chosen tables comes up once before any repeats
function nextQuestion() {
  if (!G.bag.length) {
    for (const a of settings.tables) for (let b = 1; b <= 12; b++) G.bag.push([a, b]);
    shuffle(G.bag);
  }
  let q = G.bag.pop();
  if (G.lastQ && G.bag.length && q[0] === G.lastQ[0] && q[1] === G.lastQ[1]) {
    G.bag.unshift(q);
    q = G.bag.pop();
  }
  G.lastQ = q;
  return q;
}

// plausible wrong answers: neighbouring facts first, then near numbers
function distractors(a, b) {
  const ans = a * b;
  const ok = (v) => v > 0 && v !== ans;
  const near = shuffle([a * (b + 1), a * (b - 1), (a + 1) * b, (a - 1) * b].filter(ok));
  const other = shuffle([ans + 1, ans - 1, ans + 2, ans - 2, ans + 10, ans - 10, ans + a, a + b].filter(ok));
  const out = [];
  for (const v of [near[0], Math.random() < 0.5 ? near[1] : other[0], ...other, ...near]) {
    if (v != null && !out.includes(v)) out.push(v);
    if (out.length === 2) break;
  }
  let k = 3;
  while (out.length < 2) { if (!out.includes(ans + k)) out.push(ans + k); k++; }
  return out;
}

function spawnRow(arrival) {
  const [a, b] = nextQuestion();
  const ans = a * b;
  const values = shuffle([ans, ...distractors(a, b)]);
  const group = new THREE.Group();
  group.position.set(0, G.hitY, HIT_Z - (arrival - songTime()) * G.speed);
  const row = { a, b, ans, arrival, group, cubes: [], sign: new Panel(1.5, 0.5, 512, 170), resolved: false };
  values.forEach((v, i) => {
    const m = new THREE.Mesh(cubeGeo, cubeMats(v, false));
    m.position.x = LANES[i];
    m.add(new THREE.LineSegments(edgeGeo, edgeMat));
    group.add(m);
    row.cubes.push({ mesh: m, value: v, correct: v === ans, fading: false, scale: 1 });
  });
  drawSign(row.sign, row, 'q');
  row.sign.mesh.position.set(0, 0.52, 0);
  group.add(row.sign.mesh);
  scene.add(group);
  G.rows.push(row);
}

function clearRows() {
  for (const r of G.rows) {
    scene.remove(r.group);
    if (!r.resolved) r.sign.dispose();
  }
  G.rows = [];
}

// result sign floats up above the lane (clear of incoming rows), then fades
function releaseSign(row, style) {
  drawSign(row.sign, row, style);
  const m = row.sign.mesh;
  row.group.remove(m);
  m.position.set(0, G.hitY + 0.85, -2.8);
  m.scale.setScalar(0.65);
  scene.add(m);
  addFloater(m, row.sign.mat, 1.6, 0.25, () => row.sign.dispose());
}

function resolveRow(row, hitCube, outcome) {
  row.resolved = true;
  for (const c of row.cubes) {
    if (c === hitCube) continue;
    if (outcome !== 'ok' && c.correct) c.mesh.material = cubeMats(c.value, true);
    else c.fading = true;
  }
  if (outcome !== 'ok') G.mistakes.push(`${row.a}×${row.b}=${row.ans}`);
  releaseSign(row, outcome);
}

const cw = new V3();
const segAB = new V3();
const segAP = new V3();
const segQ = new V3();
function segDist(p, a, b) {
  segAB.subVectors(b, a);
  const l = segAB.lengthSq();
  let t = l > 0 ? segAP.subVectors(p, a).dot(segAB) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return p.distanceTo(segQ.copy(a).addScaledVector(segAB, t));
}

function hitCube(row, cube, saber) {
  const pos = cube.mesh.getWorldPosition(new V3());
  const dir = new V3().subVectors(saber.tip, saber.pTip).normalize();
  const bladeDir = new V3().subVectors(saber.tip, saber.base).normalize();
  cube.mesh.visible = false;
  sliceCube(pos, dir, bladeDir, cube.correct);
  if (cube.correct) {
    const before = multiplier();
    G.combo++;
    G.maxCombo = Math.max(G.maxCombo, G.combo);
    G.correct++;
    G.score += 100 * multiplier();
    burst(pos, 0x4ade80, 26);
    A.sfxGood();
    haptic(saber, 0.6, 60);
    if (multiplier() > before) {
      A.sfxCombo();
      popup('x' + multiplier() + '!', '#fde047', new V3(0, G.hitY + 1.0, HIT_Z - 0.8));
    }
    resolveRow(row, cube, 'ok');
  } else {
    G.combo = 0;
    G.wrong++;
    burst(pos, 0xf87171, 18);
    A.sfxBad();
    haptic(saber, 1.0, 220);
    resolveRow(row, cube, 'bad');
  }
  drawHUD();
}

function missRow(row) {
  G.combo = 0;
  G.missed++;
  A.sfxMiss();
  resolveRow(row, null, 'miss');
  drawHUD();
}

function updateRows(dt) {
  const t = songTime();
  while (G.nextIdx < G.schedule.length && G.schedule[G.nextIdx] - G.travel <= t) spawnRow(G.schedule[G.nextIdx++]);

  for (let i = G.rows.length - 1; i >= 0; i--) {
    const r = G.rows[i];
    const z = HIT_Z - (r.arrival - t) * G.speed;
    r.group.position.z = z;
    if (!r.resolved && z > HIT_Z + 0.9) missRow(r);
    for (const c of r.cubes) {
      if (!c.fading || !c.mesh.visible) continue;
      c.scale -= dt * 4;
      if (c.scale <= 0) c.mesh.visible = false;
      else c.mesh.scale.setScalar(c.scale);
    }
    if (z > 2.5) {
      scene.remove(r.group);
      G.rows.splice(i, 1);
    }
  }

  G.hudT += dt;
  if (G.hudT > 0.5) { G.hudT = 0; drawHUD(); }

  const done = G.nextIdx >= G.schedule.length && G.rows.every((r) => r.resolved);
  if ((done && t >= G.duration) || t >= G.duration + 4) finishRun();
}

function checkCubes(s, speed) {
  if (speed < MIN_SPEED) return;
  for (const r of G.rows) {
    if (r.resolved) continue;
    const rz = r.group.position.z;
    if (rz < -2.8 || rz > 1) continue;
    let best = null, bestD = HIT_R;
    for (const c of r.cubes) {
      cw.set(c.mesh.position.x, r.group.position.y, rz);
      const d = Math.min(segDist(cw, s.base, s.tip), segDist(cw, s.pTip, s.tip), segDist(cw, s.pMid, s.mid));
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) hitCube(r, best, s);
  }
}

const probe = new V3();
function checkButtons(s) {
  if (performance.now() / 1000 - ui.shownAt < 0.5) return;
  for (const btn of [ui.btnA, ui.btnB]) {
    btn.box.setFromObject(btn.mesh).expandByScalar(0.02);
    let inside = false;
    for (let k = 0; k <= 5 && !inside; k++) inside = btn.box.containsPoint(probe.lerpVectors(s.base, s.tip, 0.3 + 0.7 * k / 5));
    for (let k = 1; k <= 3 && !inside; k++) inside = btn.box.containsPoint(probe.lerpVectors(s.pTip, s.tip, k / 3));
    const was = btn.inside[s.idx];
    btn.inside[s.idx] = inside;
    if (inside && !was) {
      haptic(s, 0.5, 40);
      pressButton(btn);
      return;
    }
  }
}

function updateSabers(dt) {
  for (const s of sabers) {
    if (!s.group.parent) { s.has = false; continue; }
    s.group.updateWorldMatrix(true, false);
    const mw = s.group.matrixWorld;
    s.base.set(0, 0, -BLADE_START).applyMatrix4(mw);
    s.mid.set(0, 0, -BLADE_START - BLADE / 2).applyMatrix4(mw);
    s.tip.set(0, 0, -BLADE_START - BLADE).applyMatrix4(mw);
    if (s.has && dt > 0) {
      if (G.mode === 'playing') checkCubes(s, s.tip.distanceTo(s.pTip) / dt);
      else if (ui.active) checkButtons(s);
    }
    s.pBase.copy(s.base);
    s.pMid.copy(s.mid);
    s.pTip.copy(s.tip);
    s.has = true;
  }
}

function pulseWorld() {
  let k = 0.45;
  if (G.mode === 'playing' && G.beatDur > 0) {
    let ph = ((songTime() - G.offset) / G.beatDur) % 1;
    if (ph < 0) ph += 1;
    k = 0.3 + 0.7 * Math.pow(1 - ph, 3);
  }
  ringMat.color.copy(ringBase).multiplyScalar(k);
}

// ---------------------------------------------------------------- flow
function startRun() {
  clearRows();
  Object.assign(G, { score: 0, combo: 0, maxCombo: 0, correct: 0, wrong: 0, missed: 0, mistakes: [], bag: [], lastQ: null, hudT: 0 });
  const d = DIFFS[settings.diff];
  G.beatDur = 60 / currentBpm();
  G.offset = currentPrep.offset;
  G.duration = currentPrep.buffer.duration;
  G.travel = d.travel;
  G.speed = SPAWN_DIST / d.travel;

  // one question every N beats, N a power of two so questions land on the phrase
  let per = 1;
  while (per * G.beatDur < d.minGap * 0.8 && per < 32) per *= 2;
  G.schedule = [];
  let t = G.offset;
  while (t < G.travel + 1.5) t += G.beatDur;
  for (; t < G.duration - 0.6; t += per * G.beatDur) G.schedule.push(t);
  G.nextIdx = 0;

  hideUI();
  hud.mesh.position.set(0, G.hitY + 1.75, -5);
  hud.mesh.visible = true;
  if (A.ctx.state !== 'running') A.ctx.resume();
  G.startAt = A.ctx.currentTime + 0.15;
  A.playBuffer(currentPrep.buffer, G.startAt);
  G.mode = 'playing';
  drawHUD();
}

function pauseGame() {
  if (G.mode !== 'playing') return;
  G.mode = 'paused';
  A.ctx.suspend();
  showUI('pause');
}

function resumeGame() {
  if (G.mode !== 'paused') return;
  hideUI();
  A.ctx.resume();
  G.mode = 'playing';
}

function finishRun() {
  G.mode = 'results';
  A.stopMusic();
  const total = G.correct + G.wrong + G.missed;
  const acc = total ? Math.round((G.correct / total) * 100) : 0;
  const stars = acc >= 90 ? 3 : acc >= 70 ? 2 : acc >= 40 ? 1 : 0;
  const prev = store.get(hsKey(), 0);
  const record = G.score > prev;
  if (record) store.set(hsKey(), G.score);
  G.last = {
    score: G.score, correct: G.correct, wrong: G.wrong, missed: G.missed, acc, stars, record,
    maxCombo: G.maxCombo, mistakes: [...new Set(G.mistakes)],
  };
  store.set('lastResult', G.last);
  drawHUD();
  showUI('results');
}

function exitGame() {
  A.stopMusic();
  if (A.ctx.state === 'suspended') A.ctx.resume();
  clearRows();
  hideUI();
  hud.mesh.visible = false;
  G.mode = 'idle';
  const session = renderer.xr.getSession();
  if (session) session.end();
  else backToMenu();
}

function backToMenu() {
  renderer.setAnimationLoop(null);
  $('#game').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  showLastResult();
  updateRecord();
}

const clock = new THREE.Clock();

function beginGame(vr) {
  G.vr = vr;
  clearRows();
  hud.mesh.visible = false;
  for (const s of sabers) s.has = false;
  if (!vr) {
    $('#menu').classList.add('hidden');
    $('#game').classList.remove('hidden');
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.position.set(0, 1.6, 0);
    camera.lookAt(0, 1.1, -3);
    sabers[0].group.removeFromParent();
    scene.add(sabers[1].group);
    G.hitY = 1.15;
  } else {
    for (const s of sabers) if (s.group.parent === scene) scene.remove(s.group);
    G.hitY = 1.1;
  }
  G.mode = 'ready';
  showUI('ready');
  clock.getDelta();
  renderer.setAnimationLoop(frame);
}

// keep the playing height comfortable for the player's actual height
function followHead(dt) {
  const y = camera.position.y;
  if (y < 0.6) return;
  const target = THREE.MathUtils.clamp(y - 0.5, 0.75, 1.4);
  G.hitY += (target - G.hitY) * Math.min(1, dt * 3);
  ui.root.position.y = G.hitY - 1.1;
}

// ---------------------------------------------------------------- controller buttons
// xr-standard mapping on Pico 4: 0 trigger, 1 grip, 3 thumbstick, 4 A/X, 5 B/Y
const prevButtons = new WeakMap();
function pollXRButtons() {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const now = gp.buttons.map((b) => b.pressed);
    const prev = prevButtons.get(src) || [];
    prevButtons.set(src, now);
    const edge = (i) => now[i] && !prev[i];
    if (edge(5)) {
      if (G.mode === 'playing') pauseGame();
      else if (G.mode === 'paused') { A.sfxClick(); resumeGame(); }
    } else if ((edge(0) || edge(4)) && ui.active && performance.now() / 1000 - ui.shownAt > 0.5) {
      pressButton(ui.btnA);
    }
  }
}

window.addEventListener('keydown', (e) => {
  if (G.mode === 'idle' || G.vr) return;
  if (e.key === 'Escape') {
    if (G.mode === 'playing') pauseGame();
    else if (G.mode === 'paused') resumeGame();
    else exitGame();
  } else if ((e.key === 'Enter' || e.key === ' ') && ui.active) {
    e.preventDefault();
    pressButton(ui.btnA);
  }
});

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (G.vr || !ui.active) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects([ui.btnA.mesh, ui.btnB.mesh], false)[0];
  if (hit) pressButton(hit.object === ui.btnA.mesh ? ui.btnA : ui.btnB);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && !G.vr) pauseGame();
});

// ---------------------------------------------------------------- frame loop
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  pollXRButtons();
  if (!G.vr) updateMouseSaber();
  else if (G.mode === 'ready') followHead(dt);
  if (G.mode === 'playing') updateRows(dt);
  else if (G.mode === 'results') {
    for (const r of G.rows) r.group.position.z += G.speed * dt;
  }
  updateSabers(dt);
  updateFx(dt);
  pulseWorld();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- entering the game
$('#btnScreen').onclick = () => {
  A.ctx.resume();
  beginGame(false);
};

$('#btnVR').onclick = async () => {
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
  } catch (e) {
    alert('Tidak dapat masuk VR: ' + e.message);
    return;
  }
  A.ctx.resume();
  session.addEventListener('end', () => {
    A.stopMusic();
    if (A.ctx.state === 'suspended') A.ctx.resume();
    clearRows();
    hideUI();
    hud.mesh.visible = false;
    G.mode = 'idle';
    G.vr = false;
    for (const s of sabers) { s.group.removeFromParent(); s.src = null; }
    backToMenu();
  });
  session.addEventListener('visibilitychange', () => {
    if (session.visibilityState !== 'visible') pauseGame();
  });
  await renderer.xr.setSession(session);
  beginGame(true);
};

if (navigator.xr && navigator.xr.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr')
    .then((ok) => { vrSupported = ok; updatePlayButtons(); })
    .catch(() => {});
}

// ---------------------------------------------------------------- offline / install
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#installBtn').classList.remove('hidden');
});
$('#installBtn').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#installBtn').classList.add('hidden');
};

// skipped on localhost so edits show up immediately; add ?sw to test offline mode locally
const devHost = ['localhost', '127.0.0.1'].includes(location.hostname) && !location.search.includes('sw');
if ('serviceWorker' in navigator && window.isSecureContext && !devHost) {
  navigator.serviceWorker.register('./sw.js').then(() => {
    navigator.serviceWorker.ready.then(() => { $('#offline').textContent = '✔ Sedia untuk main offline'; });
  }).catch((e) => console.warn('SW', e));
}

// ---------------------------------------------------------------- init
buildTables();
buildDiffs();
updatePlayButtons();
updateRecord();
showLastResult();
loadSongList().then(prepareSelected);
if (devHost) window.__game = { G, finishRun };
