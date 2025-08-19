// ===== 要素取得 =====
const btnPickRoot = document.getElementById('pick-root');
const sectionSelect = document.getElementById('section-select');
const eventTitleEl = document.getElementById('event-title');
const eventSectionEl = document.getElementById('event-section');

const audio = document.getElementById('audio');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const albumEl = document.getElementById('album');
const seekEl = document.getElementById('seek');
const volEl = document.getElementById('vol');
const curEl = document.getElementById('cur');
const durEl = document.getElementById('dur');

const btnPlay   = document.getElementById('play');
const btnPause  = document.getElementById('pause');
const btnStop   = document.getElementById('stop');
const btnPrev   = document.getElementById('prev');
const btnNext   = document.getElementById('next');
const btnRew10  = document.getElementById('rew10');
const btnFf10   = document.getElementById('ff10');
const btnRepeat = document.getElementById('repeat');

const listEl = document.getElementById('file-list');

// 速度UI
const speedButtons = Array.from(document.querySelectorAll('.spd'));
const speedInd = document.getElementById('speed-ind');

// 変換UI
const convDialog = document.getElementById('conv-dialog');
const convText = document.getElementById('conv-text');
const convOk = document.getElementById('conv-ok');
const convOverlay = document.getElementById('conv-progress');
const convStatus = document.getElementById('conv-status');

// ===== 状態 =====
const EXT_TO_MIME = {
  'mp3':  'audio/mpeg',
  'm4a':  'audio/mp4',
  'aac':  'audio/aac',
  'ogg':  'audio/ogg',
  'opus': 'audio/ogg; codecs=opus',
  'flac': 'audio/flac',
  'wav':  'audio/wav',
  'wma':  'audio/x-ms-wma' // 再生不可想定（検出用）
};
const PLAYABLE_EXTS = ['mp3','m4a','aac','ogg','opus','flac','wav'];

let rootHandle = null;
let sections = [];   // { name, handle }
let tracks = [];     // [{name, url, ext, file, pathStr, playable, handle, parentDirHandle}]
let idx = -1;
let repeating = false;
let seeking = false;

// フェード用
let audioCtx = null;
let mediaSrc = null;
let gainNode = null;
let isFading = false;
const DEFAULT_FADE_SEC = 4.0;

// ffmpeg.wasm
let ffmpeg = null;
let ffmpegReady = false;

// 自然順
const coll = new Intl.Collator('ja-JP', { numeric: true, sensitivity: 'base' });
const ncmp = (a, b) => coll.compare(a, b);

// ===== ユーティリティ =====
const fmtTime = (sec) => {
  if (!isFinite(sec)) return "00:00";
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};
const stripExt = (name) => name.replace(/\.[^.]+$/, '');
const getExt = (name) => (name.split('.').pop()||'').toLowerCase();

function canPlayByExt(ext) {
  ext = (ext || '').toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) return false;
  try {
    const r = audio.canPlayType(mime); // '', 'maybe', 'probably'
    return !!r;
  } catch (_) { return false; }
}

// ピッチ保持
function enablePreservePitch() {
  try {
    if ('preservesPitch' in audio) audio.preservesPitch = true;
    if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
  } catch (_) {}
}
function setPlaybackRate(rate) {
  enablePreservePitch();
  audio.playbackRate = rate;
  speedButtons.forEach(btn => btn.classList.toggle('active', Number(btn.dataset.rate) === rate));
  speedInd.textContent = `${Math.round(rate * 100)}%`;
}

// Media Session
function setMediaSession(t){
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t?.name || 'Unknown',
    artist: '',
    album: t?.pathStr || '',
    artwork: []
  });
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', pause);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('seekto', (e) => {
    if (typeof e.seekTime === 'number') audio.currentTime = e.seekTime;
  });
}

// ===== ルート選択 → タイトル・種目 =====
btnPickRoot.addEventListener('click', pickRootFolder);

async function pickRootFolder(){
  if (!window.showDirectoryPicker){
    alert('この環境ではフォルダ選択が無効です。HTTPSまたはlocalhostで開いてください。');
    return;
  }
  try{
    const handle = await window.showDirectoryPicker();
    rootHandle = handle;
    eventTitleEl.textContent = handle.name || '（不明）';

    sections = [];
    for await (const entry of handle.values()){
      if (entry.kind === 'directory'){
        sections.push({ name: entry.name, handle: entry });
      }
    }
    sections.sort((a,b)=>ncmp(a.name, b.name));

    sectionSelect.innerHTML = '';
    for (const s of sections){
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      sectionSelect.appendChild(opt);
    }
    sectionSelect.disabled = sections.length === 0;

    let initial = sections.find(s => s.name.includes('02_はじめの体操'))?.name || sections[0]?.name;
    if (initial){
      sectionSelect.value = initial;
      await loadSectionByName(initial);
    }else{
      eventSectionEl.textContent = '—';
      renderList([]);
    }
  }catch(e){ /* キャンセル等は無視 */ }
}

sectionSelect.addEventListener('change', async (e)=>{
  const name = e.target.value;
  await loadSectionByName(name);
});

async function loadSectionByName(name){
  const sec = sections.find(s => s.name === name);
  if (!sec) return;
  eventSectionEl.textContent = sec.name;

  tracks = await collectTracksFromSection(sec.handle, rootHandle.name, sec.name);
  renderList(tracks);

  if (tracks.length){
    playIndex(0);
  }else{
    stopPlaybackUI();
  }
}

// ===== サブフォルダから曲を収集 =====
async function collectTracksFromSection(sectionHandle, rootName, sectionName){
  // 書き込み許可（変換で保存するため）
  try{
    const perm = await sectionHandle.requestPermission?.({ mode: 'readwrite' });
    // perm が 'granted' でない場合も、後の保存時に再度要求します。
  }catch(_){}

  const files = [];
  const subdirs = [];

  for await (const entry of sectionHandle.values()){
    if (entry.kind === 'file'){ files.push(entry); }
    else if (entry.kind === 'directory'){ subdirs.push(entry); }
  }

  files.sort((a,b)=>ncmp(a.name,b.name));
  subdirs.sort((a,b)=>ncmp(a.name,b.name));

  const list = [];

  // 直下ファイル
  for (const fe of files){
    const ext = getExt(fe.name);
    const file = await fe.getFile();
    const playable = canPlayByExt(ext);
    list.push({
      name: stripExt(file.name),
      url : playable ? URL.createObjectURL(file) : '',
      ext, file, playable,
      handle: fe,                   // FileSystemFileHandle
      parentDirHandle: sectionHandle,
      pathStr: `${rootName} / ${sectionName}`
    });
  }

  // 小フォルダ：先頭の音源だけ（同名mp3が無ければWMAに変換提案）
  for (const de of subdirs){
    const innerFiles = [];
    for await (const ent of de.values()){
      if (ent.kind === 'file') innerFiles.push(ent);
    }
    innerFiles.sort((a,b)=>ncmp(a.name,b.name));

    // MP3優先、次に他の再生可能拡張子、なければWMA等
    let chosen = innerFiles.find(h => getExt(h.name)==='mp3')
              || innerFiles.find(h => PLAYABLE_EXTS.includes(getExt(h.name)))
              || innerFiles[0];

    if (chosen){
      const ext = getExt(chosen.name);
      const f = await chosen.getFile();
      const playable = canPlayByExt(ext);
      list.push({
        name: stripExt(de.name),     // フォルダ名を曲名に
        url : playable ? URL.createObjectURL(f) : '',
        ext, file: f, playable,
        handle: chosen,
        parentDirHandle: de,         // サブフォルダに保存
        pathStr: `${rootName} / ${sectionName} / ${de.name}`
      });
    }
  }

  // 表示名の自然順
  list.sort((a,b)=>ncmp(a.name, b.name));
  return list;
}

// ===== リスト描画・再生制御 =====
function renderList(items){
  listEl.innerHTML = '';
  items.forEach((t, i)=>{
    const li = document.createElement('li');

    // 左：曲名 + パス
    const left = document.createElement('div');
    left.innerHTML = `<div>${t.name}</div><div class="sub muted">${t.pathStr}</div>`;

    // 中：拡張子バッジ
    const mid = document.createElement('div');
    mid.className = 'badge';
    mid.textContent = (t.ext || '').toUpperCase();

    // 右：操作（WMA → 変換ボタン）
    const right = document.createElement('div');
    if (!t.playable && t.ext === 'wma') {
      const btn = document.createElement('button');
      btn.className = 'convert-btn';
      btn.textContent = '変換';
      btn.title = 'WMAをMP3に変換して同じフォルダへ保存';
      btn.addEventListener('click', ()=> confirmConvert(i));
      right.appendChild(btn);
    } else {
      // 再生可能ならクリックで再生
      li.addEventListener('click', ()=> playIndex(i));
    }

    if (i === idx) li.classList.add('active');

    li.appendChild(left);
    li.appendChild(mid);
    li.appendChild(right);
    listEl.appendChild(li);
  });
}

function updateActiveInList(){
  listEl.querySelectorAll('li').forEach((el, i)=>{
    el.classList.toggle('active', i === idx);
  });
}

function setNowPlayingUI(t){
  titleEl.textContent  = t?.name || '—';
  artistEl.textContent = '';
  albumEl.textContent  = t?.pathStr || '';
}

// ===== 再生系 =====
function ensureAudioGraph(){
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  mediaSrc = audioCtx.createMediaElementSource(audio);
  gainNode = audioCtx.createGain();
  gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
  mediaSrc.connect(gainNode).connect(audioCtx.destination);
}

function cancelFade(){
  if (!audioCtx || !gainNode) return;
  isFading = false;
  const now = audioCtx.currentTime;
  try{ gainNode.gain.cancelScheduledValues(now); }catch(_){}
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(1.0, now + 0.01);
}

async function fadeOutAndPause(seconds = DEFAULT_FADE_SEC){
  ensureAudioGraph();
  if (isFading) return;
  isFading = true;

  try{ await audioCtx.resume(); }catch(_){}

  const now = audioCtx.currentTime;
  const start = gainNode.gain.value;
  const target = 0.0001;

  try{ gainNode.gain.cancelScheduledValues(now); }catch(_){}
  gainNode.gain.setValueAtTime(start, now);
  gainNode.gain.linearRampToValueAtTime(target, now + seconds);

  setTimeout(()=>{
    const n2 = audioCtx.currentTime;
    try{ gainNode.gain.cancelScheduledValues(n2); }catch(_){}
    gainNode.gain.setValueAtTime(target, n2);

    audio.pause();
    btnPause.hidden = true; btnPlay.hidden = false;

    // 次回に備えてゲインを戻す
    gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime + 0.01);
    isFading = false;
  }, Math.max(100, seconds*1000));
}

function playIndex(i){
  if (i < 0 || i >= tracks.length) return;
  const t = tracks[i];
  if (!t.playable){
    alert('このトラックはまだ再生できません（WMAなど）。「変換」ボタンでMP3に変換してください。');
    return;
  }
  idx = i;
  audio.src = t.url;
  setNowPlayingUI(t);
  setMediaSession(t);
  cancelFade();
  play();
  updateActiveInList();
}

function play(){
  ensureAudioGraph();
  cancelFade();
  enablePreservePitch();
  audio.play().catch(console.error);
  btnPlay.hidden = true; btnPause.hidden = false;
}
function pause(){
  cancelFade();
  audio.pause();
  btnPause.hidden = true; btnPlay.hidden = false;
}
function stopSoft(){ fadeOutAndPause(DEFAULT_FADE_SEC); }
function prev(){
  if (!tracks.length) return;
  if (idx > 0) playIndex(idx-1);
  else if (repeating) playIndex(tracks.length-1);
}
function next(){
  if (!tracks.length) return;
  if (idx < tracks.length-1) playIndex(idx+1);
  else if (repeating) playIndex(0);
}
function seekBy(deltaSec){
  if (!isFinite(audio.duration)) return;
  const target = Math.min(Math.max(audio.currentTime + deltaSec, 0), Math.max(0, audio.duration - 0.05));
  audio.currentTime = target;
}
function stopPlaybackUI(){
  audio.pause();
  btnPause.hidden = true; btnPlay.hidden = false;
  idx = -1;
  titleEl.textContent = '—';
  artistEl.textContent = '';
  albumEl.textContent = '';
  curEl.textContent = '00:00';
  durEl.textContent = '00:00';
  seekEl.value = '0';
  updateActiveInList();
}

// ===== 変換（WMA→MP3 同フォルダ保存） =====
async function ensureFfmpeg(){
  if (ffmpegReady) return;
  convOverlay.hidden = false;
  convStatus.textContent = 'ffmpeg読込中…（初回のみ数十MB）';
  // ESM を動的 import（CDNから読み込み）
  const { createFFmpeg, fetchFile } = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js');
  ffmpeg = createFFmpeg({
    log: true,
    corePath: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js'
  });
  // 進捗を表示
  ffmpeg.setLogger(({ message })=>{
    if (message) convStatus.textContent = message;
  });
  ffmpeg.setProgress(({ ratio })=>{
    if (ratio) convStatus.textContent = `変換中… ${Math.round(ratio*100)}%`;
  });
  await ffmpeg.load();
  ffmpeg.fetchFile = fetchFile;
  ffmpegReady = true;
  convOverlay.hidden = true;
}

let convertTargetIndex = null;

async function confirmConvert(trackIndex){
  const t = tracks[trackIndex];
  if (!t || t.ext !== 'wma') return;

  // 同名mp3の存在確認
  const base = stripExt(t.handle.name);
  const mp3Name = `${base}.mp3`;
  let mp3Exists = false;
  try{
    await t.parentDirHandle.getFileHandle(mp3Name);
    mp3Exists = true;
  }catch(_){}

  if (mp3Exists){
    alert(`同じフォルダに「${mp3Name}」が既にあります。変換は不要です。`);
    return;
  }

  // ダイアログ表示
  convText.textContent = `「${t.handle.name}」を MP3 に変換して、同じフォルダに「${mp3Name}」として保存します。よろしいですか？`;
  convertTargetIndex = trackIndex;
  convDialog.showModal();

  // OK が押されたら変換開始
  convDialog.addEventListener('close', async ()=>{
    if (convDialog.returnValue === 'ok' && convertTargetIndex === trackIndex){
      await convertAndSave(trackIndex);
    }
  }, { once: true });
}

async function convertAndSave(trackIndex){
  const t = tracks[trackIndex];
  if (!t) return;

  // 書き込み許可
  try{
    const perm = await t.parentDirHandle.requestPermission?.({ mode: 'readwrite' });
    if (perm && perm !== 'granted'){
      alert('このフォルダへの書き込み許可が必要です。');
      return;
    }
  }catch(_){}

  // ffmpeg.wasm 読み込み
  await ensureFfmpeg();

  convOverlay.hidden = false;
  convStatus.textContent = 'ファイルを読み込み中…';

  // FFmpeg仮想FSに入力配置
  const inputName = 'input.wma';
  const outputName = 'output.mp3';
  const data = await t.file.arrayBuffer();
  ffmpeg.FS('writeFile', inputName, new Uint8Array(data));

  // 変換（可変ビットレート -q:a 2 ≒ 高音質）
  convStatus.textContent = '変換中…';
  try{
    await ffmpeg.run('-i', inputName, '-c:a', 'libmp3lame', '-q:a', '2', outputName);
  }catch(err){
    convOverlay.hidden = true;
    alert('変換に失敗しました。WMAの種類によっては変換できない場合があります。');
    console.error(err);
    return;
  }

  // 出力取得
  convStatus.textContent = '保存中…';
  const out = ffmpeg.FS('readFile', outputName);

  // 同名mp3として保存
  const base = stripExt(t.handle.name);
  const mp3Name = `${base}.mp3`;
  const mp3Handle = await t.parentDirHandle.getFileHandle(mp3Name, { create: true });
  const writable = await mp3Handle.createWritable();
  await writable.write(out);
  await writable.close();

  convOverlay.hidden = true;

  // プレイリストを更新：このトラックをMP3に差し替え
  const mp3File = await mp3Handle.getFile();
  t.ext = 'mp3';
  t.file = mp3File;
  t.playable = true;
  t.url = URL.createObjectURL(mp3File);
  t.handle = mp3Handle;

  renderList(tracks);
  // 変換した曲を再生位置に
  const i = tracks.indexOf(t);
  if (i >= 0) playIndex(i);

  alert(`変換して保存しました：${mp3Name}`);
}

// ===== イベント =====
btnPlay.addEventListener('click', play);
btnPause.addEventListener('click', pause);
btnStop.addEventListener('click', stopSoft);
btnPrev.addEventListener('click', prev);
btnNext.addEventListener('click', next);
btnRew10.addEventListener('click', ()=> seekBy(-10));
btnFf10.addEventListener('click',  ()=> seekBy(+10));
btnRepeat.addEventListener('click', ()=>{
  repeating = !repeating;
  btnRepeat.style.outline = repeating ? '2px solid #8ab4f8' : 'none';
});

audio.addEventListener('timeupdate', ()=>{
  if (!seeking && isFinite(audio.duration)){
    seekEl.value = String(Math.floor((audio.currentTime / audio.duration) * 1000));
  }
  curEl.textContent = fmtTime(audio.currentTime);
  durEl.textContent = fmtTime(audio.duration);
});
audio.addEventListener('ended', ()=>{ next(); });

seekEl.addEventListener('input', ()=>{ seeking = true; });
seekEl.addEventListener('change', ()=>{
  if (isFinite(audio.duration)){
    const ratio = Number(seekEl.value)/1000;
    audio.currentTime = ratio * audio.duration;
  }
  seeking = false;
});
volEl.addEventListener('input', ()=>{ audio.volume = Number(volEl.value); });

// 速度ボタン
speedButtons.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const rate = Number(btn.dataset.rate);
    setPlaybackRate(rate);
  });
});
setPlaybackRate(1.0);

// キー操作
document.addEventListener('keydown', (e)=>{
  if (e.code === 'Space'){ e.preventDefault(); audio.paused ? play() : pause(); }
  else if (e.key === 'ArrowRight'){ next(); }
  else if (e.key === 'ArrowLeft'){ prev(); }
  else if (e.key === ']'){ seekBy(+10); }
  else if (e.key === '['){ seekBy(-10); }
  else if (e.key.toLowerCase() === 's'){ stopSoft(); }
  else if (e.key === '+' || e.key === '='){
    const nexts = [0.7,0.8,0.9,1.0,1.1,1.2,1.3];
    const cur = audio.playbackRate;
    const id = nexts.findIndex(x=>x>=cur-1e-6);
    const n = Math.min(nexts.length-1, Math.max(0, id+1));
    setPlaybackRate(nexts[n]);
  } else if (e.key === '-'){
    const nexts = [0.7,0.8,0.9,1.0,1.1,1.2,1.3];
    const cur = audio.playbackRate;
    const id = nexts.findIndex(x=>x>=cur-1e-6);
    const n = Math.max(0, (id === -1 ? nexts.length-1 : id-1));
    setPlaybackRate(nexts[n]);
  }
});
