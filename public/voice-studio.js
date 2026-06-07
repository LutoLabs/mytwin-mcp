// voice-studio.js
// Voice ingestion studio for MyAITwin — the whole Voice surface.
//
// Capture-first: an audio-reactive sound cloud is the ambient signal, a live
// transcript becomes the hero the moment words exist, and one record control
// runs the flow. On stop the transcript is saved as a private NOTE via
// /api/notes — it is NOT committed to the twin. Promotion ("Add to Twin") is a
// separate, deliberate act. When no live transcript was captured, the audio is
// transcribed via /api/voice/transcribe (Whisper) first, then saved as a note.
//
// P0 — first-word capture. The whole pipeline is pre-warmed on the ready screen:
//   prewarm() acquires the mic (muted), opens the Deepgram socket, AND starts the
//   MediaRecorder. Warming the recorder is the key win: the Opus encoder is hot
//   and its WebM init segment (header) is delivered to Deepgram before "go", so
//   the first real audio chunk is decodable instantly instead of waiting for a
//   cold encoder + header on tap. While warm the mic track is muted
//   (enabled=false) so it streams digital silence only — no speech leaves the
//   device until the user taps record. On tap we reuse the warm stream, socket,
//   and recorder; we start no timer until "go" and tear it all down if the user
//   leaves without recording.
//
// LIVE TRANSCRIPT — Deepgram primary (Nova-3, ephemeral token from
// /api/voice/token), Web Speech fallback, honest one-line note if neither runs.
// Storage transcription is ALWAYS Whisper (server-side, on stop) when no live
// transcript was captured.
//
// Usage:
//   const studio = new VoiceStudio({ mountIn, apiHeaders, onCaptured });
//   studio.mount();
//   studio.prewarm();            // optional: warm the pipeline on the ready screen
//   // later: studio.cancel(); studio.destroy();

import { AudioEngine, createRenderer } from '/voice-viz.js';

const TOKEN_URL          = '/api/voice/token';
const DEFAULT_TRANSCRIBE_URL = '/api/voice/transcribe';
const MAX_RECORD_MS   = 60 * 60 * 1000;   // 60-minute hard cap (one recording, no modes)
const DG_CLOSE_WAIT   = 1500;             // ms to wait for Deepgram's final words
const KEEPALIVE_MS    = 7000;             // Deepgram KeepAlive cadence while warm (no-recorder fallback)
const REC_TIMESLICE   = 200;             // MediaRecorder chunk size (ms) — blob for the Whisper fallback only
const DG_SAMPLE_RATE  = 16000;           // PCM sample rate streamed to Deepgram (linear16, mono)

// Mic-trouble copy: calm and specific, never a dead silent screen.
const MIC_BLOCKED_MSG = "Can't reach your microphone. Check this site's mic permission using the icon in the address bar, then your system sound settings. If Chrome keeps blocking it, Safari usually works.";
const MIC_SILENT_MSG  = "Your microphone is on but no sound is coming through. Check that the right mic is selected and that your system sound settings allow it. If Chrome keeps blocking the mic, Safari usually works.";

// ── One-time style injection ─────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('vs-styles')) return;
  const s = document.createElement('style');
  s.id = 'vs-styles';
  s.textContent = `
    .vs {
      height: 100%;
      width: 100%;
      max-width: 640px;
      margin: 0 auto;
      padding: 14px 24px 18px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    /* ── State line ───────────────────────────────────────────────────────── */
    .vs-status {
      display: flex; align-items: center; gap: 9px;
      min-height: 18px; flex-shrink: 0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.16em;
      color: var(--muted);
    }
    .vs-state-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--muted);
      border: 1px solid var(--ink);
      flex-shrink: 0;
      transition: background 200ms;
    }
    .vs[data-state="listening"] .vs-state-dot {
      background: var(--yellow);
      animation: vs-blink 1s steps(1) infinite;
    }
    .vs[data-state="saving"] .vs-state-dot { background: var(--yellow-deep); }
    .vs[data-state="saved"]   .vs-state-dot { background: var(--ink); }
    @keyframes vs-blink { 50% { opacity: 0.2; } }
    .vs-timer {
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.08em; color: var(--ink-2);
    }

    /* ── Visualisation stage ──────────────────────────────────────────────
       LARGE and FIXED. It is the stable anchor — it must never shrink, grow,
       or move when the live transcript starts. The transcript flows in its
       own space below; the controls stay pinned at the bottom. */
    /* Big but balanced: a fixed anchor that leaves room for the scrolling
       transcript and keeps the controls on-screen. Sized to the viewport, but
       never changes when words appear. */
    .vs-stage {
      flex: 0 0 auto;
      width: 100%;
      height: clamp(220px, 32vh, 340px);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .vs-canvas {
      width: 100%;
      height: 100%;
      max-width: 360px;
      max-height: 360px;
      display: block;
    }

    /* ── Live transcript: takes the remaining space and scrolls inside it ──── */
    .vs-transcript-wrap {
      position: relative;
      width: 100%;
      min-height: 0;
      display: flex;
      flex: 1 1 auto;
    }
    .vs-transcript {
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow-y: auto;
      text-align: left;
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 17px; line-height: 1.7;
      color: var(--ink);
      word-break: break-word;
      padding: 8px 2px 4px;
      border-top: 1px solid var(--line);
    }
    .vs-transcript:empty { display: none; }
    .vs-interim { color: var(--muted); font-style: italic; }
    .vs-seg { margin: 0 0 11px; }
    .vs-seg:last-child { margin-bottom: 2px; }
    .vs-ts {
      display: inline-block; min-width: 3.1em; margin-right: 9px;
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      color: var(--muted); vertical-align: 1px;
    }

    /* Jump-to-live affordance (sticky-bottom auto-follow pattern) */
    .vs-jump {
      position: absolute; right: 6px; bottom: 8px;
      display: inline-flex; align-items: center; gap: 6px;
      background: var(--ink); color: var(--paper);
      border: 1.5px solid var(--ink); border-radius: 999px;
      padding: 6px 13px;
      font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600;
      letter-spacing: 0.04em;
      box-shadow: 2px 2px 0 var(--ink); cursor: pointer;
    }
    .vs-jump:hover { transform: translate(1px, 1px); box-shadow: 1px 1px 0 var(--ink); }
    .vs-jump[hidden] { display: none; }

    /* ── Live-transcript status note (honest, never a silent dead screen) ─── */
    .vs-live-note {
      width: 100%; flex-shrink: 0;
      text-align: center;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--muted);
    }
    .vs-live-note[hidden] { display: none; }

    /* ── Result (captured) card ───────────────────────────────────────────── */
    .vs-result {
      width: 100%; flex-shrink: 0;
      background: var(--card);
      border: 1.5px solid var(--ink);
      border-radius: 12px;
      box-shadow: var(--shadow-brutal, 2px 2px 0 #0F0E0D);
      padding: 14px 16px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .vs-result-ack {
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 15px; line-height: 1.55; color: var(--ink);
    }
    .vs-result-meta {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted);
    }
    .vs-result-count {
      background: var(--yellow); color: var(--ink);
      border: 1.5px solid var(--ink);
      border-radius: 999px; padding: 2px 9px;
    }
    .vs-result-link {
      color: var(--ink-2); text-decoration: none;
      border-bottom: 1px solid var(--line);
      text-transform: none; letter-spacing: 0.02em;
    }
    .vs-result-link:hover { color: var(--ink); border-bottom-color: var(--ink); }
    .vs-error {
      width: 100%; flex-shrink: 0;
      color: #c0392b;
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 14px; line-height: 1.55; text-align: center;
    }

    /* ── Record control ───────────────────────────────────────────────────── */
    .vs-controls {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    .vs-record {
      position: relative;
      width: 74px; height: 74px;
      border-radius: 50%;
      background: var(--yellow);
      border: 1.5px solid var(--ink);
      box-shadow: 3px 3px 0 var(--ink);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform 100ms, box-shadow 100ms, background 160ms;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none; -webkit-user-select: none;
    }
    .vs-record:hover:not(:disabled) { transform: translate(1px, 1px); box-shadow: 2px 2px 0 var(--ink); }
    .vs-record:active:not(:disabled) { transform: translate(3px, 3px); box-shadow: none; }
    .vs-record:disabled { cursor: default; }
    .vs[data-state="listening"] .vs-record,
    .vs[data-state="saving"]    .vs-record { background: var(--ink); }
    /* Pulse ring while listening */
    .vs[data-state="listening"] .vs-record::after {
      content: ''; position: absolute; inset: -6px;
      border-radius: 50%;
      border: 1.5px solid var(--yellow-deep);
      animation: vs-ring 1.4s ease-out infinite;
    }
    @keyframes vs-ring {
      0%   { transform: scale(0.92); opacity: 0.7; }
      100% { transform: scale(1.18); opacity: 0; }
    }
    .vs-record-glyph { width: 22px; height: 22px; color: var(--ink); display: block; }
    .vs-record-stop {
      width: 20px; height: 20px; border-radius: 4px;
      background: #fff; display: none;
    }
    .vs[data-state="listening"] .vs-record-glyph { display: none; }
    .vs[data-state="listening"] .vs-record-stop  { display: block; }

    .vs-hint {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.12em;
      color: var(--muted);
      min-height: 13px;
    }
    .vs-saving-dots {
      font-family: 'JetBrains Mono', monospace;
      font-size: 16px; letter-spacing: 5px; color: #fff;
      animation: vs-dots 1.2s ease-in-out infinite;
    }
    @keyframes vs-dots { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }

    @media (max-width: 640px) {
      .vs { padding: 10px 16px 16px; }
      .vs-stage { height: clamp(200px, 30vh, 300px); }
      .vs-canvas { max-width: 320px; max-height: 320px; }
      .vs-record { width: 64px; height: 64px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .vs[data-state="listening"] .vs-record::after,
      .vs[data-state="listening"] .vs-state-dot { animation: none; }
    }
  `;
  document.head.appendChild(s);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Pick the best MediaRecorder mime for the Whisper-fallback blob. (Live
// transcription uses the raw-PCM tap, not this recorder, so any format is fine.)
function pickRecorderMime() {
  const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/aac'];
  for (const t of preferred) { try { if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t; } catch {} }
  return '';
}

function fmtTs(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class VoiceStudio {
  /**
   * @param {object} opts
   * @param {Element}  opts.mountIn      — container to render the studio into
   * @param {object}  [opts.apiHeaders]  — extra headers (e.g. X-Anon-Token)
   * @param {Function}[opts.onCaptured]  — ({transcript, durationMs}) called after capture
   */
  constructor({ mountIn, apiHeaders = {}, onCaptured, transcribeUrl = DEFAULT_TRANSCRIBE_URL } = {}) {
    this._mount         = mountIn;
    this._headers       = { 'Content-Type': 'application/json', ...apiHeaders };
    this._onCaptured    = onCaptured || (() => {});
    this._transcribeUrl = transcribeUrl;

    this._state    = 'idle';     // idle | listening | saving | saved | error
    this._root     = null;
    this._canvas   = null;
    this._ctx2d    = null;

    // Audio graph
    this._stream      = null;
    this._audioCtx    = null;
    this._analyser    = null;
    this._source      = null;
    this._pcmNode     = null;     // ScriptProcessor → raw PCM → Deepgram (linear16)
    this._recorder    = null;     // MediaRecorder → blob, for the Whisper fallback only
    this._mimeType    = 'audio/webm';
    this._chunks      = [];
    this._sawSignal   = false;
    this._vizSampled  = false;

    this._workletReady  = false;  // AudioWorklet module added once on the reused context
    this._starting      = false;  // synchronous re-entrancy guard for _start (state lags behind awaits)
    this._resuming      = false;  // de-dupe per-frame audioCtx.resume()

    // Live transcript
    this._liveMode      = null;   // 'webspeech' | 'deepgram' | null
    this._speech        = null;
    this._speechFatal   = false;
    this._ws            = null;   // active Deepgram socket (while recording)
    this._dgActive      = false;
    this._dgFailed      = false;
    this._dgBackpressure = 0;     // consecutive backpressured PCM frames
    this._pendingPcm    = [];     // PCM buffers captured before the socket reported open
    this._segments      = [];     // [{ text, t }] finalised utterances
    this._transcript    = '';     // joined finals (for save)
    this._interim       = '';     // provisional words, replaced in place

    // Transcript scroll (sticky-bottom auto-follow)
    this._autoFollow    = true;
    this._pausedAtLen   = 0;
    this._suppressScroll = false;   // ignore the scroll events our own auto-follow fires

    // Pre-warm pipeline (hot before "go")
    this._recording     = false;
    this._warm          = false;
    this._warming       = false;
    this._warmingPromise = null;
    this._warmStream    = null;
    this._warmWs        = null;
    this._warmKeepAlive = null;

    // Timing + animation
    this._startedAt     = null;
    this._timerId       = null;
    this._capId         = null;
    this._dgWatchdog    = null;
    this._rafId         = null;
    this._destroyed     = false;

    // Visualisation: shared audio engine + a pluggable renderer (voice-viz.js).
    // Constellation is the lead/default; ?viz=cloud|blob swaps the skin with no
    // engine change.
    this._reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let vizName = 'constellation';
    try { vizName = new URLSearchParams(location.search).get('viz') || vizName; } catch {}
    this._vizName    = vizName;
    this._engine     = null;
    this._renderer   = null;
    this._loopPaused = false;
  }

  // ── Mount + idle ───────────────────────────────────────────────────────────
  mount() {
    if (this._root) return;
    injectStyles();

    const root = document.createElement('div');
    root.className = 'vs';
    root.dataset.state = 'idle';
    root.innerHTML = `
      <div class="vs-status">
        <span class="vs-state-dot"></span>
        <span class="vs-state-label">Ready</span>
        <span class="vs-timer" hidden>0:00</span>
      </div>
      <div class="vs-stage"><canvas class="vs-canvas"></canvas></div>
      <div class="vs-transcript-wrap">
        <div class="vs-transcript" aria-live="polite"></div>
        <button type="button" class="vs-jump" hidden>↓ Jump to live</button>
      </div>
      <div class="vs-live-note" aria-live="polite" hidden></div>
      <div class="vs-controls">
        <button type="button" class="vs-record" aria-label="Start recording">
          <svg class="vs-record-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
          <span class="vs-record-stop" aria-hidden="true"></span>
        </button>
        <div class="vs-hint">Think out loud</div>
      </div>
    `;
    this._mount.appendChild(root);
    this._root   = root;
    this._canvas = root.querySelector('.vs-canvas');
    this._ctx2d  = this._canvas.getContext('2d');

    this._recordBtn = root.querySelector('.vs-record');
    this._recordBtn.addEventListener('click', () => this._onRecordClick());

    // Transcript: sticky-bottom auto-follow. If the user scrolls up to re-read,
    // stop following and offer "Jump to live"; re-arm when they return to bottom.
    const $t = root.querySelector('.vs-transcript');
    $t.addEventListener('scroll', () => {
      if (this._suppressScroll) { this._suppressScroll = false; return; }   // our own auto-follow scroll
      const nearBottom = ($t.scrollHeight - $t.scrollTop - $t.clientHeight) < 48;
      if (nearBottom) { this._autoFollow = true; this._hideJump(); }
      else {
        if (this._autoFollow) this._pausedAtLen = this._segments.length;
        this._autoFollow = false; this._updateJump();
      }
    });
    root.querySelector('.vs-jump').addEventListener('click', () => {
      this._autoFollow = true;
      this._scrollToBottom($t);
      this._hideJump();
    });

    // Audio engine + renderer (the visualiser). Engine reads the capture
    // analyser; renderer is the swappable skin. Size the canvas first so the
    // renderer initialises with real dimensions.
    this._engine   = new AudioEngine({ sensitivity: 0.8, reduceMotion: this._reduceMotion });
    this._renderer = createRenderer(this._vizName, { reduceMotion: this._reduceMotion });

    this._ro = new ResizeObserver(() => this._resizeCanvas());
    this._ro.observe(root.querySelector('.vs-stage'));
    this._resizeCanvas();
    this._renderer.init(this._ctx2d, this._cssW || 300, this._cssH || 300);

    // Pause the rAF loop when the tab is backgrounded.
    this._onVis = () => {
      if (document.hidden) { if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; } }
      else { this._startLoop(); }
    };
    document.addEventListener('visibilitychange', this._onVis);

    this._startLoop();
  }

  // The loop runs only when the studio is visible and the tab is foregrounded.
  // pause()/resume() let the host stop it while the capture view is off-screen.
  _shouldRun() { return !this._destroyed && !this._loopPaused && !document.hidden; }
  pause()  { this._loopPaused = true; if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; } }
  resume() {
    this._loopPaused = false;
    // The studio may have mounted while the capture view was hidden (canvas 0px).
    // Re-measure now that it's visible so the visualiser is full-size, not tiny.
    this._resizeCanvas();
    requestAnimationFrame(() => this._resizeCanvas());
    this._startLoop();
  }

  // ── P0: pre-warm the pipeline on the ready screen ────────────────────────────
  // Acquire the mic (muted) and open the Deepgram socket so the handshake is done
  // before the user taps record. Sends NO audio, starts no timer, shows no
  // recording indicator — this is connection setup, not recording.
  // Returns the in-flight warm-up promise so a one-tap start() can await it and
  // reuse the warm pipeline rather than racing into a cold start.
  prewarm() {
    if (this._destroyed || this._warm || this._warming) return this._warmingPromise || Promise.resolve();
    if (this._state === 'listening' || this._state === 'saving') return Promise.resolve();
    this._warming = true;
    this._warmingPromise = this._doPrewarm().finally(() => { this._warming = false; });
    return this._warmingPromise;
  }

  async _doPrewarm() {
    try {
      const { stream } = await this._getMicStream();
      if (!stream) return;
      if (this._destroyed || this._state === 'listening' || this._state === 'saving') {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      stream.getAudioTracks().forEach(t => { t.enabled = false; });  // muted until "go"
      this._warmStream    = stream;
      this._recording     = false;
      this._liveMode      = 'deepgram';
      this._pendingPcm    = [];
      // Open the Deepgram socket now and hold it open with KeepAlive (Deepgram's
      // documented idle mechanism). The PCM tap starts on "go"; warming the
      // socket removes the connection handshake from the first-word path.
      await this._openDeepgramSocket();   // opens _warmWs; its onopen starts KeepAlive
      // Create/unlock the (reused) AudioContext + load the PCM worklet now, inside
      // the button-press gesture, so the first recording starts instantly.
      await this._ensureAudioCtx();
      this._warm = true;
    } catch { /* best-effort; the cold path still works on tap */ }
  }

  // Public: begin recording in one tap. Used by the library "Record" button so a
  // single press records instead of opening a separate ready screen. Awaits any
  // in-flight prewarm (kicked off on button-press) so the warm pipeline is reused.
  start() {
    if (this._state === 'idle' || this._state === 'saved' || this._state === 'error') this._start();
  }

  // Release a warm pipeline that was never used (user left the ready screen).
  _teardownWarm() {
    this._stopKeepAlive();
    if (this._warmWs) { try { this._warmWs.close(); } catch {} this._warmWs = null; }
    if (this._warmStream) { this._warmStream.getTracks().forEach(t => t.stop()); this._warmStream = null; }
    this._warm = false; this._warming = false;
  }

  _startKeepAlive(ws) {
    this._stopKeepAlive();
    this._warmKeepAlive = setInterval(() => {
      if (this._recording) { this._stopKeepAlive(); return; }
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {} }
      else this._stopKeepAlive();
    }, KEEPALIVE_MS);
  }
  _stopKeepAlive() {
    if (this._warmKeepAlive) { clearInterval(this._warmKeepAlive); this._warmKeepAlive = null; }
  }

  // Promote a warm-open socket to the active recording socket.
  _activateWarmSocket() {
    this._stopKeepAlive();
    this._dgActive = true;
    this._liveMode = 'deepgram';
    this._setLiveNote('');
    this._flushPending(this._ws);
  }

  // ── Record button ───────────────────────────────────────────────────────────
  _onRecordClick() {
    if (this._state === 'idle' || this._state === 'saved' || this._state === 'error') {
      this._start();
    } else if (this._state === 'listening') {
      this._stopAndStore();
    }
  }

  // ── Start capture ────────────────────────────────────────────────────────────
  async _start() {
    // SYNCHRONOUS re-entrancy guard. _start is async and awaits below before it
    // ever flips _recording/_state, so guarding on _state alone lets a double-tap
    // (or the pointerdown-prewarm + click-start pair) run _start twice — which
    // orphaned an AudioContext per occurrence and beach-balled Safari. This flag
    // is set before any await and cleared in the finally.
    if (this._recording || this._starting) return;
    this._starting = true;
    try {
      await this._startInner();
    } finally {
      this._starting = false;
    }
  }

  async _startInner() {
    // If a prewarm is mid-flight (e.g. kicked off on button-press for a one-tap
    // start), let it finish so we reuse the warm stream/socket instead of racing
    // into a cold start. Resolves in ~the token-fetch time.
    if (this._warmingPromise) { try { await this._warmingPromise; } catch {} }

    // Reset transcript/session display state. NOT _chunks — a warm recorder may
    // already hold the WebM header we need for a valid fallback blob.
    this._segments   = [];
    this._transcript = '';
    this._interim    = '';
    this._dgActive   = false;
    this._dgFailed   = false;
    this._speechFatal = false;
    this._sawSignal  = false;
    this._vizSampled = false;
    this._autoFollow = true;
    this._pausedAtLen = 0;
    this._clearResult();
    this._setLiveNote('');
    this._hideJump();
    this._renderTranscript();

    // Acquire mic — reuse the warm stream if we have one, else get a fresh one.
    let stream = this._warmStream;
    this._warmStream = null;
    const warmTrackLive = stream && stream.getAudioTracks()[0] && stream.getAudioTracks()[0].readyState === 'live';
    if (!warmTrackLive) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      const { stream: s, err } = await this._getMicStream();
      if (!s) {
        this._teardownWarm();
        this._showError(err === 'unsupported'
          ? 'This browser cannot record audio. Try Safari, or capture on your phone.'
          : MIC_BLOCKED_MSG);
        return;
      }
      stream = s;
    }
    this._chunks = []; this._pendingPcm = [];
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop());
      this._showError(MIC_SILENT_MSG);
      return;
    }
    stream.getAudioTracks().forEach(t => { t.enabled = true; });   // unmute (warm was muted)
    this._stream = stream;

    this._recording = true;
    this._liveMode = 'deepgram';   // set before _initAnalyser so the PCM tap streams immediately
    this._dgBackpressure = 0;
    this._setState('listening');
    this._setHint('Tap to finish');
    this._startedAt = Date.now();
    // The view is visible now — measure the viz to full size. Re-measure a couple
    // of times to catch late layout (fonts, dynamic-viewport settle on mobile).
    this._resizeCanvas();
    requestAnimationFrame(() => this._resizeCanvas());
    setTimeout(() => this._resizeCanvas(), 250);

    // Audio graph + raw-PCM tap (off-main-thread AudioWorklet). PCM is
    // container-free, so live transcript is identical on every browser — no
    // Safari/MP4 problem, no header/first-word problem.
    await this._initAnalyser(stream);

    // Deepgram socket: reuse the warm (already-open) one, else open fresh.
    this._stopKeepAlive();
    console.info('[voice] live transcript via Deepgram (linear16)');
    if (this._warmWs && (this._warmWs.readyState === WebSocket.OPEN || this._warmWs.readyState === WebSocket.CONNECTING)) {
      this._ws = this._warmWs; this._warmWs = null;
      if (this._ws.readyState === WebSocket.OPEN) this._activateWarmSocket();
      // If still CONNECTING, its onopen sees _recording=true and flushes pending PCM.
    } else {
      if (this._warmWs) { try { this._warmWs.close(); } catch {} this._warmWs = null; }
      this._openDeepgramSocket();   // async; PCM buffers into _pendingPcm until it opens
    }
    this._warm = false;

    // Recorder runs only to collect the Whisper-fallback blob.
    this._recorder = this._makeRecorder(stream);
    this._recorder.start(REC_TIMESLICE);

    // Timer + hard cap
    this._tickTimer();
    this._timerId = setInterval(() => this._tickTimer(), 500);
    this._capId = setTimeout(() => { if (this._state === 'listening') this._stopAndStore(); }, MAX_RECORD_MS);

    // Safety net (Deepgram only): if audio is present but no words have streamed a
    // few seconds in, the socket is silently broken — switch to the browser
    // recognizer so the user still sees live text (cleared on the first word).
    if (this._liveMode === 'deepgram') {
      this._dgWatchdog = setTimeout(() => {
        if (this._state === 'listening' && this._liveMode === 'deepgram'
            && this._sawSignal && !this._segments.length && !this._interim) {
          console.warn('[voice] Deepgram silent despite audio, falling back to Web Speech');
          this._fallbackToWebSpeech();
        }
      }, 3000);
    }
  }

  // Acquire a mic stream without any UI side effects. Returns {stream} or {err}.
  async _getMicStream() {
    if (!navigator.mediaDevices?.getUserMedia) return { err: 'unsupported' };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        video: false,
      });
      return { stream };
    } catch (err) {
      console.warn('[voice-studio] getUserMedia failed:', err?.name, err?.message);
      return { err: err?.name || 'denied' };
    }
  }

  // ONE AudioContext for the whole studio lifetime — created lazily, reused
  // across recordings, suspended (not closed) between them. Creating/closing a
  // context per recording hit Safari's concurrent-context cap and beach-balled.
  async _ensureAudioCtx() {
    if (!this._audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this._audioCtx = new AC();
    }
    if (this._audioCtx.state === 'suspended') {
      try { await this._audioCtx.resume(); } catch {}
    }
    // Load the off-main-thread PCM worklet once (idempotent across recordings).
    if (this._audioCtx.audioWorklet && !this._workletReady) {
      try { await this._audioCtx.audioWorklet.addModule('/voice-pcm-worklet.js'); this._workletReady = true; }
      catch (e) { console.warn('[voice] worklet addModule failed:', e.message); }
    }
    return this._audioCtx;
  }

  // Disconnect the per-recording nodes WITHOUT closing the (reused) context.
  _disconnectGraph() {
    if (this._pcmNode) {
      try {
        if (this._pcmNode.port) { this._pcmNode.port.onmessage = null; try { this._pcmNode.port.close(); } catch {} }
        this._pcmNode.onaudioprocess = null;
        this._pcmNode.disconnect();
      } catch {}
      this._pcmNode = null;
    }
    if (this._source) { try { this._source.disconnect(); } catch {} this._source = null; }
    this._analyser = null;
  }

  async _initAnalyser(stream) {
    try {
      const ctx = await this._ensureAudioCtx();
      if (!ctx) { this._analyser = null; return; }
      this._disconnectGraph();   // defensive: never stack a second graph on the reused context

      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      src.connect(analyser);
      this._source   = src;
      this._analyser = analyser;
      this._engine?.attach(analyser);   // engine now reads live audio (was idle floor)

      // Raw-PCM tap → Deepgram (linear16), off the main thread via AudioWorklet.
      this._startPcmTap(src, ctx);
    } catch (e) {
      console.warn('[voice-studio] analyser init failed:', e.message);
      this._analyser = null;   // renderer falls back to its resting/idle state
      this._engine?.detach();
    }
  }

  // Tap the mic as raw PCM → linear16/16kHz → Deepgram. Prefer AudioWorklet
  // (audio render thread); fall back to ScriptProcessor only where unavailable.
  _startPcmTap(src, ctx) {
    if (this._workletReady && typeof AudioWorkletNode !== 'undefined') {
      try {
        const node = new AudioWorkletNode(ctx, 'pcm-tap', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          processorOptions: { outRate: DG_SAMPLE_RATE },
        });
        node.port.onmessage = (e) => this._sendPcm(e.data);   // e.data is an Int16 ArrayBuffer
        src.connect(node);
        node.connect(ctx.destination);   // pulled by the graph; processor writes silence → no feedback
        this._pcmNode = node;
        return;
      } catch (e) { console.warn('[voice] AudioWorklet tap failed, falling back:', e.message); }
    }
    // Fallback: ScriptProcessor (main thread) through a MUTED sink, not raw output.
    try {
      if (!ctx.createScriptProcessor) return;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (ev) => {
        if (this._destroyed || this._pcmNode !== proc || !this._recording || this._liveMode !== 'deepgram') return;
        const pcm = this._downsamplePcm(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
        if (pcm && pcm.length) this._sendPcm(pcm.buffer);
      };
      const sink = ctx.createGain(); sink.gain.value = 0;
      src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
      this._pcmNode = proc;
    } catch (e) { console.warn('[voice] PCM tap failed:', e.message); this._pcmNode = null; }
  }

  // Forward one PCM buffer to Deepgram, with backpressure protection.
  _sendPcm(buf) {
    if (!this._recording || this._liveMode !== 'deepgram') return;
    const sock = this._ws || this._warmWs;
    if (sock && sock.readyState === WebSocket.OPEN) {
      if (sock.bufferedAmount > (1 << 20)) {   // >1MB queued → socket draining too slow
        if (++this._dgBackpressure > 40) { try { sock.close(); } catch {} this._fallbackToWebSpeech(); }
        return;                                 // drop this frame (recognition tolerates gaps)
      }
      this._dgBackpressure = 0;
      try { sock.send(buf); } catch {}
    } else {
      this._pendingPcm.push(buf);
      if (this._pendingPcm.length > 200) this._pendingPcm.shift();   // bound (~17s) until the socket opens
    }
  }

  // Float32 @ inRate → Int16 (linear16) @ DG_SAMPLE_RATE, mono. Nearest-sample
  // decimation is plenty for speech recognition.
  _downsamplePcm(input, inRate) {
    const outRate = DG_SAMPLE_RATE;
    const clampInt16 = (v) => { v = v < -1 ? -1 : v > 1 ? 1 : v; return v < 0 ? v * 0x8000 : v * 0x7FFF; };
    if (!inRate || inRate <= outRate) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = clampInt16(input[i]);
      return out;
    }
    const ratio = inRate / outRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = clampInt16(input[Math.floor(i * ratio)]);
    return out;
  }

  // Build a recorder. Its ONLY job now is to collect a blob for the Whisper
  // fallback (used if the live transcript never produced anything). Live
  // transcription goes through the raw-PCM tap, not this recorder.
  _makeRecorder(stream) {
    const mime = pickRecorderMime() || 'audio/webm';
    this._mimeType = mime;

    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime }); }
    catch { rec = new MediaRecorder(stream); this._mimeType = 'audio/webm'; }

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);   // blob for the Whisper fallback
    };
    return rec;
  }

  // Flush any PCM captured before the socket reported open.
  _flushPending(ws) {
    for (const buf of this._pendingPcm) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(buf); } catch {}
    }
    this._pendingPcm = [];
  }

  // ── Deepgram socket (shared by warm + recording) ─────────────────────────────
  // While warm (_recording=false) the socket opens and is held alive with
  // KeepAlive but receives no audio. On "go" the PCM tap streams linear16 and
  // onopen flushes any PCM buffered before the socket reported open.
  async _openDeepgramSocket() {
    let key;
    try {
      const resp = await fetch(TOKEN_URL, { method: 'POST', headers: this._headers, body: '{}' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.key) throw new Error('no key');
      key = data.key;
    } catch (err) {
      console.warn('[voice-studio] Deepgram token unavailable:', err.message);
      this._dgFailed = true;
      if (this._recording) this._fallbackToWebSpeech();
      return;
    }

    const params = new URLSearchParams({
      model: 'nova-3', language: 'en', punctuate: 'true',
      smart_format: 'true', interim_results: 'true', endpointing: '300',
      encoding: 'linear16', sample_rate: String(DG_SAMPLE_RATE), channels: '1',
    });
    try {
      const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', key]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this._flushPending(ws);   // deliver anything buffered before open — incl. the WebM header
        if (this._recording) {
          this._dgActive = true; this._liveMode = 'deepgram'; this._setLiveNote('');
          console.info('[voice] Deepgram socket open');
        } else {
          this._startKeepAlive(ws);   // warm: hold the line open with KeepAlive until "go"
        }
      };
      ws.onmessage = (event) => {
        if (!this._recording) return;          // ignore anything received while warm
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type !== 'Results') return;
          const text = msg.channel?.alternatives?.[0]?.transcript || '';
          if (text && this._dgWatchdog) { clearTimeout(this._dgWatchdog); this._dgWatchdog = null; }  // live is flowing
          if (msg.is_final) { if (text) this._commitFinal(text); this._interim = ''; }
          else { this._interim = text; }      // provisional — replaced in place by final
          this._renderTranscript();
        } catch { /* ignore */ }
      };
      // Fall back if the socket fails OR closes while recording without ever
      // delivering a word (catches "opened but silently undecodable").
      const noWordsYet = () => !this._segments.length && !this._interim;
      ws.onerror = () => {
        this._dgFailed = true;
        if (this._recording && noWordsYet()) this._fallbackToWebSpeech();
      };
      ws.onclose = (ev) => {
        this._stopKeepAlive();
        if (this._recording) console.warn('[voice] Deepgram socket closed', ev && ev.code, ev && ev.reason);
        if (this._recording && noWordsYet()) { this._dgFailed = true; this._fallbackToWebSpeech(); }
      };
      if (this._recording) this._ws = ws; else this._warmWs = ws;
    } catch (err) {
      console.warn('[voice-studio] Deepgram WS failed:', err.message);
      this._dgFailed = true;
      if (this._recording) this._fallbackToWebSpeech();
    }
  }

  // Deepgram could not start — try the browser's recognizer as a fallback.
  _fallbackToWebSpeech() {
    if (this._state !== 'listening') return;
    if (this._liveMode === 'webspeech') return;
    if (this._startWebSpeech()) { this._setLiveNote(''); return; }
    this._setLiveNote('Live transcript is off in this browser. Your words are still saved when you finish.');
  }

  _startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;
    try {
      const rec = new SR();
      rec.continuous     = true;
      rec.interimResults = true;
      rec.lang = (navigator.language && /^en/i.test(navigator.language)) ? navigator.language : 'en-US';

      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r   = e.results[i];
          const txt = (r[0] && r[0].transcript) ? r[0].transcript : '';
          if (r.isFinal) { const clean = txt.trim(); if (clean) this._commitFinal(clean); }
          else interim += txt;
        }
        this._interim = interim;
        this._setLiveNote('');
        this._renderTranscript();
      };

      rec.onerror = (e) => {
        const err = e.error;
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          this._speechFatal = true;
          this._setLiveNote('Live transcript was blocked. Your words are still saved when you finish.');
        } else if (err === 'network') {
          this._setLiveNote('Live transcript needs a connection. Your words are still saved.');
        } else if (err === 'audio-capture') {
          this._speechFatal = true;
          this._setLiveNote('Live transcript could not reach the mic. Your words are still saved.');
        }
      };

      rec.onend = () => {
        if (this._state === 'listening' && !this._speechFatal) {
          try { rec.start(); } catch { /* already started or stopping */ }
        }
      };

      rec.start();
      this._speech   = rec;
      this._liveMode = 'webspeech';
      return true;
    } catch (e) {
      console.warn('[voice-studio] Web Speech init failed:', e.message);
      return false;
    }
  }

  // ── Transcript model + rendering ─────────────────────────────────────────────
  _commitFinal(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const t = this._startedAt ? Math.max(0, (Date.now() - this._startedAt) / 1000) : 0;
    this._segments.push({ text: clean, t });
    this._transcript = this._segments.map(s => s.text).join(' ');
  }

  _setLiveNote(msg) {
    const el = this._root?.querySelector('.vs-live-note');
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else     { el.textContent = ''; el.hidden = true; }
  }

  _renderTranscript() {
    if (!this._root) return;
    const $t = this._root.querySelector('.vs-transcript');
    if (!$t) return;

    let html = esc(this._transcript);
    if (this._interim) html += (html ? ' ' : '') + `<span class="vs-interim">${esc(this._interim)}</span>`;
    $t.innerHTML = html;

    if (this._autoFollow) { this._scrollToBottom($t); this._hideJump(); }
    else { this._updateJump(); }
  }

  // Scroll to the bottom without the scroll handler mistaking it for the user
  // scrolling up (which would pause auto-follow).
  _scrollToBottom($t) {
    this._suppressScroll = true;
    $t.scrollTop = $t.scrollHeight;
    requestAnimationFrame(() => { this._suppressScroll = false; });
  }

  _hideJump() {
    const b = this._root?.querySelector('.vs-jump');
    if (b) b.hidden = true;
  }
  _updateJump() {
    const b = this._root?.querySelector('.vs-jump');
    if (!b) return;
    if (this._state !== 'listening') { b.hidden = true; return; }
    const n = Math.max(0, this._segments.length - this._pausedAtLen);
    b.hidden = false;
    b.textContent = n > 0 ? `↓ Jump to live · ${n} new` : '↓ Jump to live';
  }

  // ── Stop + store ─────────────────────────────────────────────────────────────
  async _stopAndStore() {
    if (this._state !== 'listening') return;
    this._setState('saving');
    this._setHint('');
    this._recordBtn.disabled = true;
    this._recordBtn.querySelector('.vs-record-stop').innerHTML =
      '<span class="vs-saving-dots">◦◦◦</span>';
    this._setStatusLabel('Saving');
    this._hideJump();

    clearInterval(this._timerId);
    clearTimeout(this._capId);

    // Stop MediaRecorder, wait for the final chunk.
    await new Promise(resolve => {
      if (!this._recorder || this._recorder.state === 'inactive') return resolve();
      const prev = this._recorder.onstop;
      this._recorder.onstop = (...a) => { if (prev) prev(...a); resolve(); };
      try { this._recorder.stop(); } catch { resolve(); }
    });

    this._teardownAudio();

    // Give Deepgram a moment to flush any final words (still recording=true so
    // those finals are committed).
    if (this._ws?.readyState === WebSocket.OPEN) {
      await new Promise(resolve => {
        const to = setTimeout(resolve, DG_CLOSE_WAIT);
        const prev = this._ws.onclose;
        this._ws.onclose = (...a) => { if (prev) prev(...a); clearTimeout(to); resolve(); };
        try { this._ws.send(JSON.stringify({ type: 'CloseStream' })); }
        catch { clearTimeout(to); resolve(); }
      });
    }
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._recording = false;

    // Keep any in-progress words that never got finalised (e.g. stopped mid-phrase).
    if (this._interim && this._interim.trim()) { this._commitFinal(this._interim); this._interim = ''; }

    const durationMs = this._startedAt ? Date.now() - this._startedAt : null;
    const liveTranscript = this._transcript.trim();

    // Fast path: a live transcript already exists.
    if (liveTranscript) {
      this._finishCapture(liveTranscript, durationMs);
      return;
    }

    // No live transcript — fall back to transcribing the audio with Whisper.
    if (!this._chunks.length) { this._showError(MIC_SILENT_MSG); return; }
    if (this._vizSampled && !this._sawSignal) { this._showError(MIC_SILENT_MSG); return; }

    let b64;
    try {
      const blob = new Blob(this._chunks, { type: this._mimeType });
      b64 = await this._blobToBase64(blob);
    } catch {
      this._showError('Could not package the recording. Try again.');
      return;
    }
    if (!b64) { this._showError('Could not read the recording. Try again.'); return; }

    this._setStatusLabel('Transcribing');
    const transcript = await this._transcribeAudio(b64, this._mimeType);
    if (!transcript) return;
    this._finishCapture(transcript, durationMs);
  }

  // Reset studio to idle and hand the transcript to voice.html for save/discard UX.
  _finishCapture(transcript, durationMs) {
    this._setState('idle');
    this._setStatusLabel('Ready');
    this._resetRecordButton();
    this._recordBtn.disabled = false;
    this._setHint('Think out loud');
    this._hideTimer();
    this._setLiveNote('');
    this._clearResult();
    this._segments = []; this._transcript = ''; this._interim = '';
    this._chunks = []; this._pendingPcm = [];   // free the fallback-blob + PCM memory promptly
    this._renderTranscript();
    this._onCaptured({ transcript, durationMs });
  }

  async _transcribeAudio(audio_base64, mime_type) {
    try {
      const resp = await fetch(this._transcribeUrl, {
        method: 'POST',
        headers: this._headers,
        body: JSON.stringify({ audio_base64, mime_type }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `Could not transcribe (HTTP ${resp.status}).`);
      const text = (data.transcript || '').trim();
      if (!text) throw new Error('The recording came back empty. Try again, and speak clearly.');
      return text;
    } catch (err) {
      this._showError(err.message || 'Could not transcribe the recording. Try again.');
      return null;
    }
  }


  _showError(msg) {
    this._setState('error');
    this._setLiveNote('');
    this._teardownAudio();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._recording = false;
    clearInterval(this._timerId);
    clearTimeout(this._capId);
    this._resetRecordButton();
    this._recordBtn.disabled = false;
    this._setHint('Try again');
    this._setStatusLabel('Ready');
    this._hideTimer();

    const $controls = this._root.querySelector('.vs-controls');
    const err = document.createElement('div');
    err.className = 'vs-error';
    err.textContent = msg;
    this._clearResult();
    this._root.insertBefore(err, $controls);
  }

  _clearResult() {
    this._root?.querySelectorAll('.vs-result, .vs-error').forEach(el => el.remove());
  }

  // ── Visualiser loop ──────────────────────────────────────────────────────────
  // The studio owns the rAF loop, reads the audio engine once per frame, clears
  // the canvas, and hands { level, bass, mid, treble } to the active renderer
  // (Constellation by default). No analyser maths here — that lives in the engine.
  _startLoop() {
    if (this._rafId || !this._shouldRun()) return;
    const loop = () => {
      if (!this._shouldRun()) { this._rafId = null; return; }
      this._draw();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _draw() {
    const ctx = this._ctx2d;
    if (!ctx || !this._engine || !this._renderer) return;
    const t = performance.now();
    const cssW = this._cssW || 300, cssH = this._cssH || 300;

    // Nudge a suspended context back only while actually recording, de-duped so
    // we don't spawn a resume() promise every frame (Safari-sensitive).
    if (this._state === 'listening' && !this._resuming && this._audioCtx && this._audioCtx.state === 'suspended') {
      this._resuming = true;
      this._audioCtx.resume().catch(() => {}).finally(() => { this._resuming = false; });
    }

    const audio = this._engine.read(t);
    // Mirror the engine's raw-signal flags for "mic on but silent" detection.
    this._vizSampled = this._engine.sampled;
    this._sawSignal  = this._engine.sawSignal;

    ctx.clearRect(0, 0, cssW, cssH);
    this._renderer.frame(audio, t);
  }

  _resizeCanvas() {
    if (!this._canvas) return;
    const rect = this._canvas.getBoundingClientRect();
    // Skip while hidden (capture view off-screen → rect 0): don't poison the
    // size with a tiny value. resume()/_start() re-measure once it's visible.
    if (rect.width < 1 || rect.height < 1) return;
    const size = Math.max(40, Math.min(rect.width, rect.height));
    if (size === this._cssW && size === this._cssH) return;   // unchanged → don't clear the canvas
    this._cssW = size;
    this._cssH = size;
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width  = Math.round(size * dpr);
    this._canvas.height = Math.round(size * dpr);
    this._canvas.style.width  = size + 'px';
    this._canvas.style.height = size + 'px';
    this._ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._renderer?.resize(this._cssW, this._cssH);
  }

  // ── State + small UI helpers ────────────────────────────────────────────────
  _setState(s) {
    this._state = s;
    if (this._root) this._root.dataset.state = s;
    if (s === 'listening') { this._setStatusLabel('Listening'); this._showTimer(); }
  }
  _setStatusLabel(text) {
    const el = this._root?.querySelector('.vs-state-label');
    if (el) el.textContent = text;
  }
  _setHint(text) {
    const el = this._root?.querySelector('.vs-hint');
    if (el) el.textContent = text;
  }
  _resetRecordButton() {
    const stop = this._recordBtn?.querySelector('.vs-record-stop');
    if (stop) stop.innerHTML = '';
  }
  _showTimer() {
    const el = this._root?.querySelector('.vs-timer');
    if (el) { el.hidden = false; el.textContent = '0:00'; }
  }
  _hideTimer() {
    const el = this._root?.querySelector('.vs-timer');
    if (el) el.hidden = true;
  }
  _tickTimer() {
    if (!this._startedAt) return;
    const el = this._root?.querySelector('.vs-timer');
    if (!el) return;
    const s = Math.floor((Date.now() - this._startedAt) / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  async _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(String(r.result).split(',', 2)[1] || null);
      r.onerror = reject;
      r.readAsDataURL(blob);
    }).catch(() => null);
  }

  _teardownAudio() {
    if (this._dgWatchdog) { clearTimeout(this._dgWatchdog); this._dgWatchdog = null; }
    if (this._speech) {
      this._speechFatal = true;
      try { this._speech.onend = null; } catch {}
      try { this._speech.stop(); } catch {}
      this._speech = null;
    }
    if (this._recorder && this._recorder.state !== 'inactive') { try { this._recorder.stop(); } catch {} }
    this._recorder = null;
    this._disconnectGraph();   // disconnect source/analyser/pcm node
    if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
    // Keep the AudioContext alive (reused across recordings); just suspend it so
    // it isn't doing work at rest. Closing per-recording exhausts Safari's cap.
    if (this._audioCtx && this._audioCtx.state === 'running') { try { this._audioCtx.suspend(); } catch {} }
    this._engine?.detach();   // back to the idle floor (visualiser keeps breathing)
  }

  // ── Cancel / destroy ─────────────────────────────────────────────────────────
  cancel() {
    this._teardownWarm();   // always release a warm-but-unused pipeline
    if (this._state !== 'listening' && this._state !== 'saving') return;
    clearInterval(this._timerId);
    clearTimeout(this._capId);
    this._teardownAudio();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._recording = false;
    this._clearResult();
    this._segments = []; this._transcript = ''; this._interim = '';
    this._setLiveNote('');
    this._hideJump();
    this._renderTranscript();
    this._setState('idle');
    this._setStatusLabel('Ready');
    this._resetRecordButton();
    if (this._recordBtn) this._recordBtn.disabled = false;
    this._setHint('Think out loud');
    this._hideTimer();
  }

  destroy() {
    this._destroyed = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.cancel();
    if (this._audioCtx) { try { this._audioCtx.close(); } catch {} this._audioCtx = null; this._workletReady = false; }
    if (this._onVis) { try { document.removeEventListener('visibilitychange', this._onVis); } catch {} this._onVis = null; }
    if (this._ro) { try { this._ro.disconnect(); } catch {} this._ro = null; }
    if (this._root) { this._root.remove(); this._root = null; }
  }
}
