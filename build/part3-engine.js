/* =====================================================================
   Drive Mode engine — browser side. Decodes H.264 with WebCodecs and
   paints frames to a <canvas> (no <video> element, so Tesla's
   in-Drive video pause has nothing to grab). AAC audio is decoded
   with WebCodecs and scheduled on an AudioContext; the audio clock
   is the master clock for A/V sync.
   ===================================================================== */
var Engine = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var canvas = $('screen');
  var btnPlay = $('btnPlay'), seek = $('seek');
  var timeLabel = $('timeLabel'), statusEl = $('status');
  var ctx2d = canvas.getContext('2d');
  var hooks = { onStreamGone: null, onTeardown: null, onEnded: null, onBuffering: null, onState: null, onFirstFrame: null, onError: null };

  var hasWC = (typeof VideoDecoder !== 'undefined') && (typeof AudioDecoder !== 'undefined');

  /* ---------- State ---------- */
  var S = {
    gen: 0, mode: null, loaded: false, loading: false,
    started: false, playing: false, ended: false, buffering: false,
    isLive: false, duration: 0,
    ctx: null, ctxEpoch: 0, mediaTarget: 0,
    vdec: null, adec: null, vdecReady: false, adecReady: false,
    vdecRetryAt: 0, adecRetryAt: 0, vdecFailures: 0, adecFailures: 0,
    vConfig: null, aConfig: null,
    frames: [], drawnFrame: null, lastFrameDur: 1 / 30, firstFrameAt: 0,
    audioPtsQueue: [], audioSources: new Set(), nextAudioWhen: 0,
    tracks: [], mp4: null, mp4VIdx: 0, mp4AIdx: 0,
    needKey: true, dropAudioBefore: 0, paintTick: 0, autoplay: false,
    // Display mapping, set by the app for sources whose real position
    // differs from engine time (Plex transcodes start at an offset).
    view: null   // {offset, duration} or null
  };
  var vSamples = [];   // {data, pts, keyframe}
  var aSamples = [];   // {data, pts}

  function setStatus(msg, isErr) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (isErr ? ' err' : '');
    if (hooks.onState) hooks.onState();
  }
  function onEngineError(msg) { S.loading = false; setStatus(msg, true); if (hooks.onError) hooks.onError(msg); }
  var errLatch = {};
  function latchedError(key, msg) {
    if (errLatch[key] === msg) return;
    errLatch[key] = msg;
    onEngineError(msg);
  }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h > 0 ? h + ':' : '') + (h > 0 && m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* Fetch with a hard timeout covering the body too (a stalled LTE
     connection otherwise hangs a segment forever). */
  // A busy server (HTTP 429 "too many requests", or 503) usually answers a
  // moment later, so wait and ask again a few times before giving up.
  function fetchRead(url, kind, ms, opts, tries) {
    tries = tries || 0;
    return fetchReadOnce(url, kind, ms, opts && Object.assign({}, opts)).catch(function (e) {
      if (!e || (e.status !== 429 && e.status !== 503) || tries >= 3) throw e;
      var wait = e.retryAfter > 0 && e.retryAfter <= 10 ? e.retryAfter * 1000 : 1500 * Math.pow(2, tries);
      return new Promise(function (res) { setTimeout(res, wait); }).then(function () { return fetchRead(url, kind, ms, opts, tries + 1); });
    });
  }
  function fetchReadOnce(url, kind, ms, opts) {
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    opts = opts || {};
    if (ctl) opts.signal = ctl.signal;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 15000) : null;
    return fetch(url, opts).then(function (r) {
      if (!r.ok) {
        return r.text().catch(function () { return ''; }).then(function (t) {
          try { var j = JSON.parse(t); if (j && j.error) t = j.error; } catch (e) {}
          t = (t || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
          var err = new Error('HTTP ' + r.status + (t ? ' (' + t + ')' : ''));
          err.status = r.status;
          err.retryAfter = +(r.headers.get('Retry-After') || 0) || 0;
          throw err;
        });
      }
      return kind === 'json' ? r.json() : kind === 'text' ? r.text() : r.arrayBuffer();
    }).then(function (v) { if (timer) clearTimeout(timer); return v; },
      function (e) {
        if (timer) clearTimeout(timer);
        throw (e && e.name === 'AbortError') ? new Error('timed out') : e;
      });
  }

  /* ---------- Clock ---------- */
  function ensureCtx() {
    // iPhone: play like a media app, so the ring/silent switch doesn't mute it.
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) {}
    if (!S.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        S.ctx = new AC();
        // One volume control for everything the player plays (used to
        // silence a mirrored screen whose sound comes from the car).
        S.gain = S.ctx.createGain();
        S.gain.gain.value = S.muted ? 0 : 1;
        wireDialogue();
      }
    }
    return S.ctx;
  }
  /* Sound path for everything the app plays through WebAudio:
     volume -> headroom -> bass -> treble -> [dialogue boost] -> limiter -> speakers.
     Bass/treble are shelf filters; the headroom cut plus a brick-wall
     limiter keep a big bass boost from distorting. */
  function wireDialogue() {
    var c = S.ctx; if (!c || !S.gain) return;
    try { wireSound(c); } catch (err) {
      // Never leave the player silent: if the sound path can't be built, go straight to the speakers.
      try { S.gain.disconnect(); } catch (e2) {}
      S.gain.connect(c.destination); S.eq = null;
    }
  }
  function wireSound(c) {
    if (!S.eq) {
      var pre = c.createGain();
      var bass = c.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 95;
      var treb = c.createBiquadFilter(); treb.type = 'highshelf'; treb.frequency.value = 8500;
      var lim = c.createDynamicsCompressor();
      lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
      pre.connect(bass); bass.connect(treb); lim.connect(c.destination);
      try { S.gain.disconnect(); } catch (e) {}
      S.gain.connect(pre);
      S.eq = { pre: pre, bass: bass, treb: treb, lim: lim };
    }
    var b = S.bassDb || 0, t = S.trebleDb || 0;
    S.eq.bass.gain.value = b; S.eq.treb.gain.value = t;
    S.eq.pre.gain.value = Math.pow(10, -(Math.max(b, t, 0) * 0.3) / 20);
    try { S.eq.treb.disconnect(); } catch (e) {}
    if (!S.dialogue) { S.eq.treb.connect(S.eq.lim); return; }
    if (!S.dlg) {
      var low = c.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 180; low.gain.value = -5;
      var mid = c.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 2600; mid.Q.value = 0.9; mid.gain.value = 6;
      var pres = c.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 1000; pres.Q.value = 1.2; pres.gain.value = 2.5;
      var comp = c.createDynamicsCompressor();
      comp.threshold.value = -26; comp.knee.value = 18; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.25;
      var make = c.createGain(); make.gain.value = 1.2;
      low.connect(mid); mid.connect(pres); pres.connect(comp); comp.connect(make); make.connect(S.eq.lim);
      S.dlg = low;
    }
    S.eq.treb.connect(S.dlg);
  }
  function setDialogue(on) { S.dialogue = !!on; if (S.ctx) wireDialogue(); }
  function setTone(bassDb, trebleDb) { S.bassDb = +bassDb || 0; S.trebleDb = +trebleDb || 0; if (S.ctx) wireDialogue(); }
  // Where other audio (the music player) joins the sound path.
  function soundInput() { ensureCtx(); return S.eq ? S.eq.pre : null; }
  function setMuted(m) { S.muted = !!m; ensureCtx(); if (S.gain) S.gain.gain.value = S.muted ? 0 : 1; }
  /* Shift playback by a small amount without reloading (positive =
     step back). Used to keep a mirrored screen in step with the car. */
  function nudge(sec) { if (S.started && S.ctx && isFinite(sec)) S.ctxEpoch += sec; }
  function mediaNow() {
    if (!S.started || !S.ctx) return S.mediaTarget;
    return S.mediaTarget + Math.max(0, S.ctx.currentTime - S.ctxEpoch);
  }
  function startClockAt(t) {
    ensureCtx();
    if (!S.ctx) { onEngineError('No audio support in this browser — cannot run the player clock.'); return; }
    S.mediaTarget = t;
    S.ctxEpoch = S.ctx.currentTime + 0.15;
    S.started = true;
    S.dropAudioBefore = t;
    if (S.ctx.state === 'suspended') S.ctx.resume();
    S.playing = true;
    updatePlayBtn();
  }

  /* ---------- Decoders ----------
     Single-owner lifecycle: setupXDecoder() is the only place a codec
     is created and configured; destroyXDecoder() is the only place one
     is closed. decode() is only ever called while the codec's live
     state is 'configured'. A codec that dies on its own is torn down by
     its error handler and rebuilt by the pump after a short backoff;
     feeding then resumes at the next keyframe. */
  function vdecUsable() { return !!(S.vdec && S.vdec.state === 'configured'); }
  function adecUsable() { return !!(S.adec && S.adec.state === 'configured'); }

  function destroyVideoDecoder() {
    var d = S.vdec;
    S.vdec = null; S.vdecReady = false;
    if (d && d.state !== 'closed') { try { d.close(); } catch (e) {} }
  }
  function destroyAudioDecoder() {
    var d = S.adec;
    S.adec = null; S.adecReady = false;
    S.audioPtsQueue = [];
    if (d && d.state !== 'closed') { try { d.close(); } catch (e) {} }
  }
  function onVideoDecoderError(dec, e) {
    if (dec !== S.vdec) return;
    destroyVideoDecoder();
    S.vdecFailures++;
    S.vdecRetryAt = performance.now() + 800;
    S.needKey = true;
    latchedError('vdec', 'Video decoder error: ' + (e && e.message ? e.message : e) + ' — restarting it…');
  }
  function onAudioDecoderError(dec, e) {
    if (dec !== S.adec) return;
    destroyAudioDecoder();
    S.adecFailures++;
    S.adecRetryAt = performance.now() + 800;
    latchedError('adec', 'Audio decoder error: ' + (e && e.message ? e.message : e) + ' — restarting it…');
  }
  function setupVideoDecoder() {
    destroyVideoDecoder();
    if (!S.vConfig || !hasWC) return;
    var dec = new VideoDecoder({
      output: function (frame) {
        if (dec !== S.vdec) { try { frame.close(); } catch (e) {} return; }
        S.vdecFailures = 0;
        if (S.frames.length > 150) { frame.close(); return; }
        S.frames.push(frame);
      },
      error: function (e) { onVideoDecoderError(dec, e); }
    });
    S.vdec = dec;
    var cfg = { codec: S.vConfig.codec, description: S.vConfig.description };
    if (S.vConfig.width) { cfg.codedWidth = S.vConfig.width; cfg.codedHeight = S.vConfig.height; }
    // Used only when the video itself doesn't say: HD is BT.709, SD is BT.601.
    var hd = (S.vConfig.height || 720) >= 600;
    cfg.colorSpace = hd ? { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
                        : { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false };
    if (VideoDecoder.isConfigSupported) {
      VideoDecoder.isConfigSupported(cfg).then(function (res) {
        if (!res.supported) latchedError('vdec-unsupported', 'This browser cannot decode ' + cfg.codec + ' video with WebCodecs.');
      }).catch(function () {});
    }
    try {
      dec.configure(cfg);
      S.vdecReady = (dec.state === 'configured');
      if (S.vdecReady) errLatch.vdec = null;
    } catch (e) {
      S.vdecReady = false;
      S.vdecFailures++;
      S.vdecRetryAt = performance.now() + 2000;
      latchedError('vdec', 'Video decoder setup failed: ' + e.message);
    }
  }
  function setupAudioDecoder() {
    destroyAudioDecoder();
    if (!S.aConfig || !hasWC) return;
    var dec = new AudioDecoder({
      output: function (buf) {
        if (dec !== S.adec) { try { buf.close(); } catch (e) {} return; }
        S.adecFailures = 0;
        var pts = S.audioPtsQueue.length ? S.audioPtsQueue.shift() : S.mediaTarget;
        var abuf = null;
        if (S.ctx) {
          try {
            abuf = S.ctx.createBuffer(buf.numberOfChannels, buf.numberOfFrames, buf.sampleRate);
            for (var ch = 0; ch < buf.numberOfChannels; ch++) {
              buf.copyTo(abuf.getChannelData(ch), { planeIndex: ch, format: 'f32-planar' });
            }
          } catch (e) { abuf = null; }
        }
        try { buf.close(); } catch (e) {}
        if (abuf) scheduleAudio(abuf, pts);
      },
      error: function (e) { onAudioDecoderError(dec, e); }
    });
    S.adec = dec;
    var cfg = {
      codec: S.aConfig.codec, description: S.aConfig.description,
      sampleRate: S.aConfig.sampleRate, numberOfChannels: S.aConfig.channels
    };
    try {
      dec.configure(cfg);
      S.adecReady = (dec.state === 'configured');
      if (S.adecReady) errLatch.adec = null;
    } catch (e) {
      S.adecReady = false;
      S.adecFailures++;
      S.adecRetryAt = performance.now() + 2000;
      latchedError('adec', 'Audio decoder setup failed: ' + e.message);
    }
  }
  function maybeRecoverDecoders() {
    if (!hasWC || !S.loaded) return;
    var now = performance.now();
    if (S.vConfig && !vdecUsable() && S.vdecFailures < 6 && now >= S.vdecRetryAt) setupVideoDecoder();
    if (S.aConfig && !adecUsable() && S.adecFailures < 6 && now >= S.adecRetryAt) setupAudioDecoder();
  }
  function onVideoConfig(cfg) {
    // Compare the avcC bytes too: a mid-stream SPS/PPS change at the same
    // size (new encoder settings) needs a reconfigured decoder.
    if (S.vConfig && S.vConfig.codec === cfg.codec && S.vConfig.width === cfg.width &&
        S.vConfig.height === cfg.height && sameBytes(S.vConfig.description, cfg.description)) return;
    S.vConfig = cfg;
    S.vdecFailures = 0; S.vdecRetryAt = 0;
    S.needKey = true;
    setupVideoDecoder();
  }
  function onAudioConfig(cfg) {
    if (S.aConfig && S.aConfig.codec === cfg.codec && S.aConfig.sampleRate === cfg.sampleRate &&
        S.aConfig.channels === cfg.channels) return;
    S.aConfig = cfg;
    S.adecFailures = 0; S.adecRetryAt = 0;
    setupAudioDecoder();
  }
  function sameBytes(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    a = new Uint8Array(a.buffer || a); b = new Uint8Array(b.buffer || b);
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function scheduleAudio(buf, pts) {
    if (!S.ctx) return;
    var when = S.ctxEpoch + (pts - S.mediaTarget);
    // Headphones / Bluetooth add delay between "play" and "heard": start the
    // sound that much earlier so it lines up with the picture.
    var lat = (S.ctx.outputLatency || 0) + (S.ctx.baseLatency || 0);
    if (lat > 0 && lat < 0.5) when -= lat;
    var now = S.ctx.currentTime;
    if (when < now - 0.25) return;            // far too late: drop rather than smear audio
    if (when < now + 0.02) when = now + 0.02;
    // Sound queued earlier can run late after the picture jumps ahead (a
    // play-along screen catching up). Skip the late slice instead of
    // queueing behind it, so the sound never drifts behind the picture.
    var offset = 0, late = S.nextAudioWhen ? S.nextAudioWhen - when : 0;
    if (late > 0.04) {
      if (late >= buf.duration) return;       // this whole piece is already behind
      offset = late; when = S.nextAudioWhen;
    } else if (late > 0) when = S.nextAudioWhen;
    S.nextAudioWhen = when + buf.duration - offset;
    // How far behind the picture this sound starts (seconds); ~0 when in step.
    S.avLag = +((when - offset) - (S.ctxEpoch + (pts - S.mediaTarget) - (lat > 0 && lat < 0.5 ? lat : 0))).toFixed(3);
    var src = S.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(S.gain || S.ctx.destination);
    src.onended = function () { S.audioSources.delete(src); };
    S.audioSources.add(src);
    try { src.start(when, offset); } catch (e) {}
  }
  function stopAudioSources() {
    S.audioSources.forEach(function (src) { try { src.stop(); } catch (e) {} try { src.disconnect(); } catch (e) {} });
    S.audioSources.clear();
    S.nextAudioWhen = 0;
  }
  function closeFrames() {
    for (var i = 0; i < S.frames.length; i++) { try { S.frames[i].close(); } catch (e) {} }
    S.frames = [];
    S.drawnFrame = null;
  }

  function decodeVideoSample(s, nextPts) {
    if (!vdecUsable()) { S.needKey = true; return; }
    var dur = (nextPts !== null && nextPts > s.pts) ? nextPts - s.pts : S.lastFrameDur;
    if (dur > 0 && dur < 0.5) S.lastFrameDur = dur;
    try {
      S.vdec.decode(new EncodedVideoChunk({
        type: s.keyframe ? 'key' : 'delta',
        timestamp: Math.round(s.pts * 1000000),
        duration: Math.round(dur * 1000000),
        data: s.data
      }));
    } catch (e) { onVideoDecoderError(S.vdec, e); }
  }
  function decodeAudioSample(a) {
    if (!adecUsable()) return;
    S.audioPtsQueue.push(a.pts);
    try {
      S.adec.decode(new EncodedAudioChunk({
        type: 'key', timestamp: Math.round(a.pts * 1000000), data: a.data
      }));
    } catch (e) { S.audioPtsQueue.pop(); onAudioDecoderError(S.adec, e); }
  }

  /* ---------- HLS tracks ----------
     Timestamp mapping: raw TS timestamps are unwrapped across the 33-bit
     rollover (every ~26.5 h — live channels hit it at random), then
     rebased so a segment's samples land at that segment's playlist
     time. A segment flagged EXT-X-DISCONTINUITY, or samples that land
     far outside their segment's window (an encoder restart, an ad
     splice), rebase the track instead of stalling the clock. */
  var PTS_WRAP = 8589934592 / 90000;
  function trackPts(track, raw) {
    if (track.lastRaw !== null) {
      var cand = raw + track.wrapAdd;
      if (cand < track.lastRaw - PTS_WRAP / 2) track.wrapAdd += PTS_WRAP;
      else if (cand > track.lastRaw + PTS_WRAP / 2 && track.wrapAdd > 0) track.wrapAdd -= PTS_WRAP;
    }
    raw += track.wrapAdd;
    track.lastRaw = raw;
    var seg = track.segments[track.demuxSeq];
    // No segments (a continuous .ts channel): anchor to the last time we
    // handed out, so a reconnect or encoder reset continues the clock
    // instead of jumping it back to zero.
    var anchor = seg ? seg.start : (track.lastRel != null ? track.lastRel : 0);
    if (track.basePts === null || track.rebaseNext) {
      track.basePts = raw - anchor;
      track.rebaseNext = false;
    } else if (seg) {
      var rel = raw - track.basePts;
      if (rel < seg.start - 8 || rel > seg.start + seg.duration + 8) track.basePts = raw - seg.start;
    } else if (track.lastRel != null) {
      var rel2 = raw - track.basePts;
      if (rel2 < track.lastRel - 5 || rel2 > track.lastRel + 10) track.basePts = raw - track.lastRel;
    }
    var out = raw - track.basePts;
    if (!seg) track.lastRel = out;
    return out;
  }
  function bindDemuxer(track) {
    var d = track.demuxer;
    d.onVideoConfig = function (cfg) { onVideoConfig(cfg); };
    d.onAudioConfig = function (cfg) { onAudioConfig(cfg); };
    d.onVideoSample = function (s) {
      vSamples.push({ data: s.data, pts: trackPts(track, s.pts), keyframe: s.keyframe });
    };
    d.onAudioSample = function (s) {
      aSamples.push({ data: s.data, pts: trackPts(track, s.pts) });
    };
    d.onUnsupported = function (what) {
      if (track.unsupportedSeen[what]) return;
      track.unsupportedSeen[what] = true;
      if (what === 'hevc') onEngineError('This stream uses HEVC/H.265 video, which this player cannot decode (H.264 only).');
      else setStatus('Note: ' + what + ' is not supported here — playing without that audio track.', false);
    };
  }

  function addSegments(track, pl) {
    var base = pl.mediaSequence, i, seq;
    for (i = 0; i < pl.segments.length; i++) {
      seq = base + i;
      if (track.segments[seq]) continue;
      var start;
      if (seq === track.firstSeq) start = 0;
      else if (track.segments[seq - 1]) start = track.segments[seq - 1].start + track.segments[seq - 1].duration;
      else start = track.endOfKnown;
      track.segments[seq] = { uri: pl.segments[i].uri, duration: pl.segments[i].duration, start: start, disc: !!pl.segments[i].disc };
      track.endOfKnown = start + pl.segments[i].duration;
      if (seq > track.lastSeq) track.lastSeq = seq;
    }
    // A live window that slid past what we were about to fetch: jump
    // forward to the oldest segment still listed instead of 404-looping.
    if (!pl.endList && track.nextSeq < base && pl.segments.length) {
      track.nextSeq = base;
      track.rebaseNext = true;
    }
    track.endList = pl.endList;
    if (pl.targetDuration) track.targetDuration = pl.targetDuration;
    if (pl.endList && S.isLive && S.tracks.every(function (t) { return t.endList; })) {
      // A growing playlist (e.g. a Plex transcode) just finished: it is
      // now a normal on-demand stream with a known end.
      S.isLive = false;
      S.duration = track.endOfKnown;
    } else if (!S.isLive || S.isEvent) {
      S.duration = Math.max(S.duration, track.endOfKnown);
    }
  }

  function makeTrack(kind, url, pl) {
    var track = {
      kind: kind, url: url, demuxer: new DmTsDemuxer(), basePts: null,
      lastRaw: null, wrapAdd: 0, rebaseNext: false,
      segments: {}, firstSeq: pl.mediaSequence, lastSeq: pl.mediaSequence - 1,
      nextSeq: pl.mediaSequence, demuxSeq: pl.mediaSequence,
      endList: false, targetDuration: pl.targetDuration || 6,
      fetching: false, done: false, endOfKnown: 0, lastPoll: 0,
      hasFetchedOnce: false, unsupportedSeen: {}, failCount: 0
    };
    S.tracks.push(track);
    // Live: start near the live edge (3 segments back), like other players.
    // A growing EVENT playlist (YouTube via the helper, Plex transcodes)
    // is a video still being converted: always start at the beginning.
    if (!pl.endList && pl.playlistType !== 'EVENT' && pl.segments.length > 4) {
      addSegments(track, pl);
      track.nextSeq = track.demuxSeq = pl.mediaSequence + pl.segments.length - 3;
      // Joining another screen (play-along): start on the same broadcast
      // chunk it's showing, if that chunk is still listed.
      if (S.joinRef && S.tracks.length === 1 && track.segments[S.joinRef.seq]) track.nextSeq = track.demuxSeq = S.joinRef.seq;
      // Start the clock where we joined, not at the start of the
      // playlist window - otherwise the picture waits (looks frozen)
      // until the clock catches up with the segment we jumped to.
      var joinAt = track.segments[track.nextSeq];
      if (joinAt && S.tracks.length === 1) {
        var into = S.joinRef && S.joinRef.seq === track.nextSeq ? Math.max(0, Math.min(joinAt.duration - 0.1, S.joinRef.off || 0)) : 0;
        S.mediaTarget = joinAt.start + into; S.dropAudioBefore = S.mediaTarget;
      }
    } else {
      addSegments(track, pl);
    }
    bindDemuxer(track);
    return track;
  }

  function fetchedUptoTime(track) {
    if (track.nextSeq <= track.firstSeq) return 0;
    var prev = track.segments[track.nextSeq - 1];
    return prev ? prev.start + prev.duration : track.endOfKnown;
  }

  /* Dead-zone buffer: for movies, shows and YouTube, keep downloading
     minutes ahead while the signal is good, so playback carries on
     through a stretch with no signal. A live broadcast can't be fetched
     ahead of what's been aired, so it keeps a short buffer. The amount
     is capped by memory (compressed video, about 160 MB at most). */
  var AHEAD_MEM = 160e6;
  function aheadLimitSec() {
    if (S.isLive && !S.isEvent) return 14;
    var want = Math.max(40, S.aheadMax || 300), bps = 0;
    for (var i = 0; i < S.tracks.length; i++) {
      var tr = S.tracks[i];
      if (tr.secFetched > 4) bps += tr.bytesFetched / tr.secFetched;
    }
    return bps > 0 ? Math.max(40, Math.min(want, AHEAD_MEM / bps)) : 40;
  }
  // Seconds of video downloaded beyond what's playing (null: not known).
  function bufferedAhead() {
    if (S.mode !== 'hls' || !S.tracks.length || !S.loaded) return null;
    var lo = Infinity;
    for (var i = 0; i < S.tracks.length; i++) lo = Math.min(lo, S.tracks[i].done ? Infinity : fetchedUptoTime(S.tracks[i]));
    if (lo === Infinity) return S.duration ? Math.max(0, S.duration - mediaNow()) : null;
    return Math.max(0, lo - mediaNow());
  }
  function maybeFetch(track) {
    if (track.fetching || track.done) return;
    if (track.retryAfter && performance.now() < track.retryAfter) return;
    var gen = S.gen;
    if (track.nextSeq > track.lastSeq) {
      if (!track.endList && performance.now() - track.lastPoll > (track.targetDuration || 6) * 500) {
        track.lastPoll = performance.now();
        track.fetching = true;
        fetchRead(track.url, 'text', 10000).then(function (text) {
          if (gen !== S.gen) return;
          addSegments(track, dmParsePlaylist(text, track.url));
        }).catch(function () {}).then(function () { if (gen === S.gen) track.fetching = false; });
      }
      return;
    }
    if (track.hasFetchedOnce && S.started && fetchedUptoTime(track) - mediaNow() > aheadLimitSec()) return;
    if (track.hasFetchedOnce && !S.started && fetchedUptoTime(track) - S.mediaTarget > 12) return;
    fetchSegment(track, gen);
  }

  function fetchSegment(track, gen) {
    var seq = track.nextSeq;
    var seg = track.segments[seq];
    if (!seg) { track.nextSeq++; return; }
    track.fetching = true;
    track.hasFetchedOnce = true;
    fetchRead(seg.uri, 'bytes', 20000, { cache: 'no-store' }).then(function (ab) {
      if (gen !== S.gen) return;
      var buf = new Uint8Array(ab);
      if (S.startJump && seq === S.startJump.seq) {
        if (buf.length < 4000 && S.startJump.seq > (track.firstSeq || 0)) { undoStartJump(); return; }
        S.startJump = null;
      }
      if (seg.disc || track.rebaseNext) {
        // New timeline: finish the old demuxer's pending data, then start
        // a clean one so half-built access units can't straddle the cut.
        try { track.demuxer.flush(); } catch (e) {}
        track.demuxer = new DmTsDemuxer();
        bindDemuxer(track);
        track.rebaseNext = true;
        track.lastRaw = null; track.wrapAdd = 0;
      }
      track.demuxSeq = seq;
      if (track.kind === 'audio' && buf.length && buf[0] !== 0x47) {
        track.demuxer.pushAudioRaw(buf, (track.basePts || 0) + seg.start);
      } else {
        track.demuxer.push(buf);
      }
      track.failCount = 0;
      track.bytesFetched = (track.bytesFetched || 0) + buf.length;
      track.secFetched = (track.secFetched || 0) + (seg.duration || 0);
      track.nextSeq = seq + 1;
      if (track.nextSeq > track.lastSeq && track.endList) { track.demuxer.flush(); track.done = true; }
    }).catch(function (e) {
      if (gen !== S.gen) return;
      track.failCount++;
      // Back off 1s, 2s, 4s… up to 8s. On a live stream a segment that
      // keeps failing is skipped — the next one is still useful.
      track.retryAfter = performance.now() + Math.min(8000, 1000 * Math.pow(2, track.failCount - 1));
      if (S.isLive && track.failCount >= 3) { track.nextSeq = seq + 1; track.failCount = 0; track.rebaseNext = true; }
      // With minutes saved ahead, a dead zone isn't worth a warning yet.
      var left = bufferedAhead();
      if (track.failCount >= 2 && (left == null || left < 20)) setStatus('Weak connection — retrying (' + e.message + ')…', false);
      // The server forgot this stream (e.g. Plex ended the session during
      // a long dead zone): let the app restart it at the current spot.
      if (!S.isLive && /HTTP 4\d\d/.test(e.message || '') && track.failCount >= 3 && hooks.onStreamGone) {
        track.failCount = 0; hooks.onStreamGone(mediaNow());
      }
    }).then(function () { if (gen === S.gen) track.fetching = false; });
  }

  function seqAtTime(track, t) {
    var seqs = Object.keys(track.segments).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < seqs.length; i++) {
      var seg = track.segments[seqs[i]];
      if (t < seg.start + seg.duration) return seqs[i];
    }
    return seqs.length ? seqs[seqs.length - 1] : track.firstSeq;
  }

  /* ---------- Pump + painter ---------- */
  function pump() {
    if (!S.loaded) return;
    var i;
    if (S.mode === 'hls') {
      for (i = 0; i < S.tracks.length; i++) maybeFetch(S.tracks[i]);
    }
    maybeRecoverDecoders();
    if (!S.started) return;
    if (!S.playing) return;
    if (vdecUsable()) {
      if (S.mode === 'hls' || S.mode === 'ts') {
        while (vdecUsable() && S.vdec.decodeQueueSize < 6 && vSamples.length && S.frames.length < 90) {
          var s = vSamples[0];
          if (S.needKey && !s.keyframe) { vSamples.shift(); continue; }
          S.needKey = false;
          vSamples.shift();
          decodeVideoSample(s, vSamples.length ? vSamples[0].pts : null);
        }
      } else if (S.mode === 'mp4' && S.mp4 && S.mp4.video) {
        var vs = S.mp4.video.samples;
        while (vdecUsable() && S.vdec.decodeQueueSize < 6 && S.mp4VIdx < vs.length && S.frames.length < 90) {
          var ms = vs[S.mp4VIdx++];
          if (S.needKey && !ms.keyframe) continue;
          S.needKey = false;
          var data = (S.mp4.video.nalLengthSize === 4) ? ms.data : dmConvertNalLength(ms.data, S.mp4.video.nalLengthSize);
          decodeVideoSample({ data: data, pts: ms.pts, keyframe: ms.keyframe },
            S.mp4VIdx < vs.length ? vs[S.mp4VIdx].pts : null);
        }
      }
    }
    // Only prepare ~4 s of sound ahead of what's playing. Scheduling it as
    // far ahead as we've downloaded meant thousands of queued sound pieces
    // - heavy for the car's computer, and a cause of crackle and dropouts.
    var audioAhead = S.ctx ? S.nextAudioWhen - S.ctx.currentTime : 0;
    if (adecUsable() && audioAhead < 4) {
      if (S.mode === 'hls' || S.mode === 'ts') {
        while (adecUsable() && S.adec.decodeQueueSize < 12 && aSamples.length) {
          var a = aSamples.shift();
          if (a.pts < S.dropAudioBefore - 0.05) continue;
          decodeAudioSample(a);
        }
      } else if (S.mode === 'mp4' && S.mp4 && S.mp4.audio) {
        var as = S.mp4.audio.samples;
        while (adecUsable() && S.adec.decodeQueueSize < 12 && S.mp4AIdx < as.length) {
          var ma = as[S.mp4AIdx++];
          if (ma.pts < S.dropAudioBefore - 0.05) continue;
          decodeAudioSample({ data: ma.data, pts: ma.pts });
        }
      }
    }
  }
  setInterval(pump, 100);

  function allTracksDone() {
    for (var i = 0; i < S.tracks.length; i++) if (!S.tracks[i].done) return false;
    return S.tracks.length > 0;
  }
  function checkEnded(t) {
    if (!S.started || S.ended || S.isLive) return;
    var drained;
    if (S.mode === 'hls') {
      drained = allTracksDone() && !vSamples.length && !aSamples.length;
    } else if (S.mode === 'mp4' && S.mp4) {
      drained = (!S.mp4.video || S.mp4VIdx >= S.mp4.video.samples.length) &&
                (!S.mp4.audio || S.mp4AIdx >= S.mp4.audio.samples.length);
    } else return;
    if (drained && S.frames.length <= 1 && (!vdecUsable() || S.vdec.decodeQueueSize === 0) && t >= S.duration - 0.6) {
      S.ended = true;
      S.playing = false;
      updatePlayBtn();
      setStatus('');
      if (hooks.onEnded) hooks.onEnded();
    }
  }

  /* Buffering: if the picture runs dry, freeze the clock (suspend the
     audio context) instead of letting it run ahead — otherwise the
     player "fast-forwards" through late frames when data catches up. */
  function videoAhead(t) {
    if (!S.vConfig) {
      if (S.aConfig || aSamples.length) return 99; // audio-only stream
      return 0;                                    // nothing decoded yet
    }
    var last = -1;
    if (vSamples.length) last = vSamples[vSamples.length - 1].pts;
    if (S.frames.length) last = Math.max(last, S.frames[S.frames.length - 1].timestamp / 1e6);
    return last - t;
  }
  function setBuffering(on) {
    if (S.buffering === on) return;
    S.buffering = on;
    if (S.ctx) { if (on) S.ctx.suspend(); else if (S.playing) S.ctx.resume(); }
    if (hooks.onBuffering) hooks.onBuffering(on);
    if (hooks.onState) hooks.onState();
  }
  /* Sound watchdog: if the picture is playing but no sound has been
     queued for a few seconds while audio data keeps arriving, rebuild
     the audio decoder and pick the sound up again at the current time. */
  var audioQuietSince = 0, audioFixes = 0;
  function checkAudio(t) {
    if (S.mode === 'mp4' || !S.started || !S.playing || S.buffering || S.ended || !S.aConfig || !S.firstFrameAt) { audioQuietSince = 0; return; }
    if (S.audioSources.size > 0 || (S.ctx && S.nextAudioWhen > S.ctx.currentTime)) { audioQuietSince = 0; return; }
    if (!audioQuietSince) { audioQuietSince = performance.now(); return; }
    if (performance.now() - audioQuietSince < 3000 || audioFixes > 20) return;
    audioQuietSince = 0; audioFixes++;
    stopAudioSources();
    S.audioPtsQueue = [];
    S.dropAudioBefore = t;
    setupAudioDecoder();
  }
  function checkBuffering(t) {
    if ((S.mode !== 'hls' && S.mode !== 'ts') || !S.started || !S.playing || S.ended) { if (S.buffering && !S.playing) S.buffering = false; return; }
    var ahead = videoAhead(t);
    if (!S.buffering) {
      if (ahead < 0.12 && !allTracksDone()) setBuffering(true);
    } else if (ahead > (!S.firstFrameAt ? 1.2 : S.isLive ? 2 : 3.5) || allTracksDone()) {
      setBuffering(false);
    }
  }

  function livePos() {
    var tr = S.tracks[0]; if (!tr || !S.isLive || S.isEvent || S.mode !== 'hls') return null;
    var t = mediaNow();
    for (var k in tr.segments) {
      var sg = tr.segments[k];
      if (t >= sg.start && t < sg.start + sg.duration) return { seq: +k, off: +(t - sg.start).toFixed(3) };
    }
    return null;
  }
  function liveTimeOf(seq, off) {
    var tr = S.tracks[0]; if (!tr) return null;
    var sg = tr.segments[seq];
    return sg ? sg.start + off : null;
  }
  function dispPos(t) { return S.view ? S.view.offset + t : t; }
  function dispDur() { return S.view ? S.view.duration : S.duration; }
  function canSeek() { return S.view ? S.view.duration > 0 : ((!S.isLive || S.isEvent) && S.duration > 0); }

  function updateTimeUi(t) {
    if (S.isLive && !S.view) { timeLabel.textContent = ''; return; }
    var p = dispPos(t), d = dispDur();
    timeLabel.textContent = fmt(p) + ' / ' + fmt(d);
    if (canSeek() && !seekDragging) seek.value = Math.round(1000 * Math.min(1, Math.max(0, p / d)));
  }

  function paint() {
    requestAnimationFrame(paint);
    if (!S.loaded) return;
    var t = mediaNow();
    var frames = S.frames;
    while (frames.length > 1 && frames[1].timestamp / 1000000 <= t) {
      var old = frames.shift();
      try { old.close(); } catch (e) {}
    }
    if (frames.length && (frames[0].timestamp / 1000000 <= t || !S.drawnFrame) && frames[0] !== S.drawnFrame) {
      var fr = frames[0];
      if (fr.displayWidth && canvas.width !== fr.displayWidth) {
        canvas.width = fr.displayWidth; canvas.height = fr.displayHeight;
      }
      try { ctx2d.drawImage(fr, 0, 0, canvas.width, canvas.height); } catch (e) {}
      S.drawnFrame = fr;
      if (!S.firstFrameAt) { S.firstFrameAt = performance.now(); if (hooks.onFirstFrame) hooks.onFirstFrame(); }
    }
    checkBuffering(t);
    if (S.paintTick % 30 === 0) checkAudio(t);
    S.paintTick++;
    if (S.paintTick % 15 === 0) updateTimeUi(t);
    checkEnded(t);
  }
  requestAnimationFrame(paint);

  /* ---------- Source loading ---------- */
  function teardown() {
    if (hooks.onTeardown) hooks.onTeardown();
    S.gen++;
    if (S.tsAbort) { try { S.tsAbort.abort(); } catch (e) {} S.tsAbort = null; }
    S.loaded = false; S.loading = false; S.started = false; S.playing = false; S.ended = false; S.autoplay = false;
    if (S.buffering) { S.buffering = false; }
    if (S.ctx && S.ctx.state === 'suspended') { try { S.ctx.resume(); } catch (e) {} }
    S.mode = null; S.isLive = false; S.isEvent = false; S.duration = 0; S.view = null; S.firstFrameAt = 0; S.startJump = null;
    S.tracks = []; S.mp4 = null; S.mp4VIdx = 0; S.mp4AIdx = 0;
    vSamples = []; aSamples = []; S.audioPtsQueue = [];
    closeFrames();
    stopAudioSources();
    destroyVideoDecoder();
    destroyAudioDecoder();
    S.vdecRetryAt = 0; S.adecRetryAt = 0; S.vdecFailures = 0; S.adecFailures = 0;
    errLatch = {};
    S.vConfig = null; S.aConfig = null;
    S.needKey = true; S.dropAudioBefore = 0; S.mediaTarget = 0;
    btnPlay.disabled = true; seek.disabled = true;
    ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    timeLabel.textContent = '';
    setStatus('');
    updatePlayBtn();
  }

  function pickVariant(pl, maxBw) {
    var vs = pl.variants.filter(function (v) { return !v.codecs || v.codecs.toLowerCase().indexOf('avc1') >= 0; });
    if (!vs.length) vs = pl.variants.slice();
    var aac = vs.filter(function (v) { return !v.codecs || v.codecs.toLowerCase().indexOf('mp4a') >= 0; });
    if (aac.length) vs = aac;
    vs.sort(function (a, b) { return a.bandwidth - b.bandwidth; });
    var under = vs.filter(function (v) { return v.bandwidth > 0 && v.bandwidth <= (maxBw || 2800000); });
    if (under.length) return under[under.length - 1];
    return vs[0];
  }

  function loadHls(url, label, opts) {
    var gen = S.gen;
    S.loading = true;
    setStatus('');
    return fetchRead(url, 'text', 30000).then(function (text) {
      if (gen !== S.gen) return;
      if (text.indexOf('#EXTM3U') !== 0) throw new Error('that address did not return an HLS playlist.');
      var pl = dmParsePlaylist(text, url);
      if (pl.encrypted) throw new Error('this stream is encrypted (DRM) — it cannot play here.');
      if (pl.hasMap) throw new Error('this stream uses fMP4 segments; this player needs MPEG-TS.');
      S.mode = 'hls'; S.loaded = true;
      if (pl.isMaster) {
        var variant = pickVariant(pl, opts && opts.maxBandwidth);
        if (!variant) throw new Error('no playable variant in the playlist.');
        return fetchRead(variant.uri, 'text', 30000).then(function (vtext) {
          if (gen !== S.gen) return;
          var vpl = dmParsePlaylist(vtext, variant.uri);
          if (vpl.encrypted || vpl.hasMap) throw new Error('the chosen variant is encrypted or fMP4 — not supported.');
          S.duration = vpl.totalDuration; S.isLive = !vpl.endList; S.isEvent = S.isLive && vpl.playlistType === 'EVENT';
          makeTrack(variant.audioGroup ? 'video' : 'muxed', variant.uri, vpl);
          S.pendingStart = vpl;
          var audioUrl = null;
          if (variant.audioGroup) {
            var rend = pl.audioRenditions.filter(function (x) { return x.group === variant.audioGroup; });
            var def = null, i;
            for (i = 0; i < rend.length; i++) if (rend[i].isDefault) { def = rend[i]; break; }
            def = def || rend[0];
            if (def) audioUrl = def.uri;
          }
          if (audioUrl) {
            return fetchRead(audioUrl, 'text', 30000).then(function (atext) {
              if (gen !== S.gen) return;
              makeTrack('audio', audioUrl, dmParsePlaylist(atext, audioUrl));
              applyStart(S.pendingStart);
              readyUp(label);
            }).catch(function () {
              if (gen === S.gen) { readyUp(label); setStatus('Separate audio track could not be loaded; playing video only.'); }
            });
          }
          applyStart(vpl);
          readyUp(label);
        });
      }
      S.duration = pl.totalDuration; S.isLive = !pl.endList; S.isEvent = S.isLive && pl.playlistType === 'EVENT';
      makeTrack('muxed', url, pl);
      applyStart(pl);
      readyUp(label);
    }).catch(function (e) {
      if (gen === S.gen) { teardown(); onEngineError('Could not load the stream: ' + e.message); }
    });
  }

  function loadMp4(url, label) {
    var gen = S.gen;
    S.loading = true;
    setStatus('Downloading the whole file before playback (MP4 links load fully first)…');
    return fetchRead(url, 'bytes', 600000).then(function (ab) {
      if (gen !== S.gen) return;
      var parsed = dmParseMP4(ab);
      if (parsed.error) throw new Error(parsed.error);
      if (!parsed.video) throw new Error('no H.264 video track found in that MP4.');
      S.mode = 'mp4'; S.mp4 = parsed; S.loaded = true;
      S.duration = parsed.duration || 0; S.isLive = false;
      S.mp4VIdx = 0; S.mp4AIdx = 0;
      onVideoConfig({ codec: parsed.video.codec, description: parsed.video.description, width: parsed.video.width, height: parsed.video.height });
      if (parsed.audio) onAudioConfig({ codec: parsed.audio.codec, description: parsed.audio.description, sampleRate: parsed.audio.sampleRate, channels: parsed.audio.channels });
      readyUp(label);
    }).catch(function (e) {
      if (gen === S.gen) { teardown(); onEngineError('Could not load the file: ' + e.message); }
    });
  }

  /* Continuous MPEG-TS (how most IPTV providers send a channel: one
     endless .ts download rather than an HLS playlist). Bytes are read
     as they arrive and fed to the same demuxer; a dropped connection is
     re-opened a few times before giving up. */
  function loadTs(url, label) {
    var gen = S.gen;
    S.loading = true;
    S.mode = 'ts'; S.isLive = true; S.loaded = true;
    var track = {
      kind: 'muxed', url: url, demuxer: new DmTsDemuxer(), basePts: null, lastRaw: null, wrapAdd: 0,
      rebaseNext: false, lastRel: null, segments: {}, demuxSeq: 0, unsupportedSeen: {}, done: false, endList: false
    };
    S.tracks.push(track);
    bindDemuxer(track);
    var failures = 0, gotData = false;
    function connect() {
      if (gen !== S.gen) return;
      var ctl = new AbortController();
      S.tsAbort = ctl;
      var idle = null;
      function arm() { clearTimeout(idle); idle = setTimeout(function () { ctl.abort(); }, 15000); }
      arm();
      fetch(url, { signal: ctl.signal }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (!r.body || !r.body.getReader) throw new Error('this browser cannot read streams');
        var reader = r.body.getReader();
        function next() {
          return reader.read().then(function (res) {
            if (gen !== S.gen) { try { ctl.abort(); } catch (e) {} return; }
            if (res.done) throw new Error('the channel stopped sending');
            arm();
            if (failures) { failures = 0; if (statusEl.textContent === 'Reconnecting…') setStatus(''); }
            if (!gotData) { gotData = true; readyUp(label); }
            track.demuxer.push(res.value);
            // Don't let a fast connection queue minutes of video in memory.
            var ahead = vSamples.length ? vSamples[vSamples.length - 1].pts - mediaNow() : 0;
            if (ahead > 25 || vSamples.length > 4000) return new Promise(function (ok) { setTimeout(ok, 400); }).then(next);
            return next();
          });
        }
        return next();
      }).catch(function (e) {
        clearTimeout(idle);
        if (gen !== S.gen) return;
        failures++;
        if (!gotData && failures >= 2) { teardown(); onEngineError('Could not open the channel: ' + (e.name === 'AbortError' ? 'timed out' : e.message)); return; }
        if (failures > 6) { teardown(); onEngineError('Lost the channel: ' + e.message); return; }
        setStatus('Reconnecting…');
        try { track.demuxer.flush(); } catch (err) {}
        track.demuxer = new DmTsDemuxer();
        bindDemuxer(track);
        track.rebaseNext = true; track.lastRaw = null; track.wrapAdd = 0;
        setTimeout(connect, 1200 * failures);
      });
    }
    connect();
  }

  /* EXT-X-START: begin at that time instead of the first segment. The
     playlist then runs on the title's own timeline (Plex lists the whole
     movie and marks the resume / seek point), so no extra display offset
     is needed. */
  function applyStart(pl) {
    if (!pl || !(pl.startOffset > 0)) return;
    var t = pl.startOffset;
    for (var i = 0; i < S.tracks.length; i++) {
      var tr = S.tracks[i];
      var seq = seqAtTime(tr, t);
      tr.nextSeq = seq; tr.demuxSeq = seq;
    }
    var first = S.tracks[0] && S.tracks[0].segments[S.tracks[0].nextSeq];
    S.mediaTarget = first ? first.start : t;
    S.dropAudioBefore = S.mediaTarget;
    if (S.view) S.view.offset = 0;
    // Remember the jump: if that segment comes back empty, the server numbered
    // its segments from the start point instead (see fetchSegment).
    S.startJump = { t: t, seq: S.tracks[0] ? S.tracks[0].nextSeq : -1 };
  }
  /* Plex lists the whole title and marks the start point when it only
     repackages the video, but when it fully converts it (e.g. 10-bit HEVC)
     the stream really begins at segment 0 = the start point, and the
     segments the mark points at stay empty. Fall back to that. */
  function undoStartJump() {
    var t = S.startJump.t; S.startJump = null;
    for (var i = 0; i < S.tracks.length; i++) {
      var tr = S.tracks[i];
      tr.nextSeq = tr.firstSeq || 0; tr.demuxSeq = tr.nextSeq; tr.rebaseNext = true;
    }
    S.mediaTarget = 0; S.dropAudioBefore = 0;
    if (S.view) S.view.offset = t;
  }

  function readyUp(label) {
    if (S.readyFor === S.gen) return; // muxed + audio paths can both report ready
    S.readyFor = S.gen;
    S.loading = false;
    btnPlay.disabled = false;
    seek.disabled = !canSeek();
    setStatus('');
    updateTimeUi(0);
    if (S.autoplay) { S.autoplay = false; togglePlay(); }
    if (hooks.onState) hooks.onState();
  }

  function load(url, label, opts) {
    if (!hasWC) { onEngineError('This browser cannot run the drive-mode player (no WebCodecs).'); return; }
    teardown();
    url = (url || '').trim();
    if (!url) { onEngineError('No stream address.'); return; }
    S.srcUrl = url; S.srcOpts = opts || null;
    S.joinRef = opts && opts.joinRef ? opts.joinRef : null;
    if (opts && opts.ts) loadTs(url, label || 'channel');
    else if (/\.mp4($|\?)/i.test(url) && !/\.m3u8/i.test(url)) loadMp4(url, label || 'MP4 file');
    else loadHls(url, label || 'stream', opts);
    if (hooks.onState) hooks.onState();
  }

  /* ---------- Seek / transport ---------- */
  function seekTo(t) {
    if (!S.loaded || (S.isLive && !S.isEvent) || !(S.duration > 0)) return;
    t = Math.max(0, Math.min(S.duration - 0.25, t));
    S.gen++;
    vSamples = []; aSamples = []; S.audioPtsQueue = [];
    closeFrames();
    stopAudioSources();
    if (S.vConfig) setupVideoDecoder();
    if (S.aConfig) setupAudioDecoder();
    S.ended = false;
    S.dropAudioBefore = t;
    S.needKey = true;
    if (S.mode === 'hls') {
      for (var i = 0; i < S.tracks.length; i++) {
        var track = S.tracks[i];
        track.demuxer = new DmTsDemuxer();
        bindDemuxer(track);
        track.nextSeq = seqAtTime(track, t);
        track.fetching = false; track.done = false; track.hasFetchedOnce = false;
        track.failCount = 0; track.retryAfter = 0;
      }
    } else if (S.mode === 'mp4' && S.mp4) {
      var vs = S.mp4.video ? S.mp4.video.samples : [];
      var vi = 0, j;
      for (j = 0; j < vs.length; j++) { if (vs[j].pts <= t && vs[j].keyframe) vi = j; if (vs[j].pts > t) break; }
      S.mp4VIdx = vi;
      var as = S.mp4.audio ? S.mp4.audio.samples : [];
      var ai = as.length;
      for (j = 0; j < as.length; j++) { if (as[j].pts >= t - 0.05) { ai = j; break; } }
      S.mp4AIdx = ai;
    }
    S.mediaTarget = t;
    if (S.started && S.ctx) S.ctxEpoch = S.ctx.currentTime + 0.15;
    updateTimeUi(t);
  }

  function updatePlayBtn() {
    var ic = function (n) { return '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; };
    btnPlay.innerHTML = ic(S.ended ? 'replay' : S.playing ? 'pause' : 'play');
    if (hooks.onState) hooks.onState();
  }

  function togglePlay() {
    if (!S.loaded) return;
    ensureCtx();
    if (!S.ctx) { onEngineError('No audio support in this browser.'); return; }
    if (S.ended) { seekTo(0); S.ended = false; startClockAt(0); return; }
    if (!S.started) { startClockAt(S.mediaTarget || 0); return; }
    if (S.playing) {
      S.ctx.suspend(); S.playing = false; S.buffering = false; updatePlayBtn();
    } else {
      S.ctx.resume(); S.playing = true; updatePlayBtn();
    }
  }

  var seekDragging = false;
  seek.addEventListener('input', function () {
    seekDragging = true;
    var d = dispDur();
    if (d > 0) timeLabel.textContent = fmt((seek.value / 1000) * d) + ' / ' + fmt(d);
  });
  seek.addEventListener('change', function () {
    seekDragging = false;
    var d = dispDur();
    if (d > 0 && hooks.onSeekRequest) hooks.onSeekRequest((seek.value / 1000) * d);
  });

  return {
    S: S, hooks: hooks, hasWC: hasWC, bufferedAhead: bufferedAhead, fmt: fmt, fetchRead: fetchRead, setMuted: setMuted, nudge: nudge, setDialogue: setDialogue, setTone: setTone, soundInput: soundInput,
    load: load, teardown: teardown, togglePlay: togglePlay, seekTo: seekTo, livePos: livePos, liveTimeOf: liveTimeOf,
    ensureCtx: ensureCtx, mediaNow: mediaNow, dispPos: dispPos, dispDur: dispDur, canSeek: canSeek,
    setStatus: setStatus, updateTimeUi: updateTimeUi
  };
})();
