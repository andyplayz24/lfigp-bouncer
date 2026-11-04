/* LFIGP Bouncer camera QR scanner.
   Rules, in order of importance:
   1. Get a live picture no matter what (one simple camera request; fall back if anything fails).
   2. Only then check the lens, and move to the main 1x lens if the phone gave us a different one.
   3. Read QR codes fast without freezing the picture (phone's built-in detector, or jsQR in a background worker). */
(function () {
  var BACK = /back|rear|environment|facing back|arri[eè]re|trasera|hinten|posteriore|خلف/i;
  var NOT_MAIN = /ultra|wide|tele|dual|triple|macro|depth|zoom|infrared|\bir\b|0[.,]5|\b2x\b|\b3x\b|\b5x\b|فائق|مقرب|مزدوج|ثلاثي/i;
  var JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';

  var st = {
    stream: null, video: null, onCode: null, onStatus: null,
    running: false, paused: false, token: 0, restarted: false,
    raf: 0, busy: false, sentAt: 0, last: 0, flip: false,
    detector: null, worker: null, canvas: document.createElement('canvas'), backs: []
  };

  function status(kind, info) { try { if (st.onStatus) st.onStatus(kind, info || ''); } catch (e) {} }
  function saveLens(l) { try { localStorage.setItem('bq_lens', l || ''); } catch (e) {} }
  function label(s) { var t = s && s.getVideoTracks && s.getVideoTracks()[0]; return (t && t.label) || ''; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function timeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Timeout')); }, ms); })]);
  }
  function stopTracks() {
    if (st.stream) st.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    st.stream = null;
    if (st.video) { try { st.video.srcObject = null; } catch (e) {} }
  }
  function req(extra) {
    var v = { width: { ideal: 1280 }, height: { ideal: 720 } };
    for (var k in extra) v[k] = extra[k];
    return navigator.mediaDevices.getUserMedia({ audio: false, video: v });
  }
  function openDefault() { return req({ facingMode: { ideal: 'environment' } }); }
  function openDevice(id) { return req({ deviceId: { exact: id } }); }

  function pickMain(backs) {
    if (!backs.length) return null;
    var exact = backs.filter(function (d) { return /^back camera$/i.test((d.label || '').trim()); })[0];
    if (exact) return exact;
    var cam0 = backs.filter(function (d) { return /camera2 0\b|camera 0\b/i.test(d.label || ''); })[0];
    if (cam0) return cam0;
    var plain = backs.filter(function (d) { return !NOT_MAIN.test(d.label || ''); })
      .sort(function (a, b) { return (a.label || '').length - (b.label || '').length; });
    return plain[0] || null;
  }

  function attach(stream, token) {
    if (token !== st.token) { stream.getTracks().forEach(function (t) { t.stop(); }); return Promise.resolve(false); }
    st.stream = stream;
    var v = st.video;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.autoplay = true;
    v.srcObject = stream;
    try {
      var t = stream.getVideoTracks()[0], caps = t.getCapabilities ? t.getCapabilities() : {};
      var adv = {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) adv.focusMode = 'continuous';
      if (caps.zoom) adv.zoom = Math.min(Math.max(caps.zoom.min || 1, 1), caps.zoom.max || 1);
      if (Object.keys(adv).length) t.applyConstraints({ advanced: [adv] }).catch(function () {});
    } catch (e) {}
    // play() never resolves on a few iPhones even though frames arrive, so don't wait on it forever.
    var p; try { p = v.play(); } catch (e) { p = null; }
    return timeout(p || Promise.resolve(), 3000).catch(function () {}).then(function () { return token === st.token; });
  }

  function goLive(token) {
    st.running = true; st.paused = false; st.busy = false;
    setupDetector(); loop();
    status('live', label(st.stream));
    // Watchdog: if no picture after 5 s, restart the camera once.
    setTimeout(function () {
      if (token !== st.token || !st.running) return;
      if (!st.video.videoWidth && !st.restarted) { st.restarted = true; status('restarting'); restart(); }
    }, 5000);
  }

  function listBacks() {
    return navigator.mediaDevices.enumerateDevices()
      .then(function (devs) { return devs.filter(function (d) { return d.kind === 'videoinput' && BACK.test(d.label || ''); }); })
      .catch(function () { return []; });
  }

  // Always the main 1x lens. The camera is only shown once we are on it, so another lens never flashes up.
  function openMain() {
    return listBacks().then(function (backs) {
      st.backs = backs;
      var main = pickMain(backs);
      if (main && main.deviceId) {
        // Permission was given before, so lens names are known: open the 1x lens directly.
        return timeout(openDevice(main.deviceId), 8000).catch(function () { return timeout(openDefault(), 12000); });
      }
      // First time on this phone: lens names stay hidden until the camera is allowed.
      return timeout(openDefault(), 12000).then(function (s) {
        return listBacks().then(function (backs2) {
          st.backs = backs2;
          var m2 = pickMain(backs2);
          if (!m2 || !m2.deviceId || m2.label === label(s)) return s;
          s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
          return wait(300).then(function () { return timeout(openDevice(m2.deviceId), 8000); })
            .catch(function () { return timeout(openDefault(), 12000); });
        });
      });
    });
  }

  function start(video, onCode, onStatus) {
    if (video) st.video = video;
    if (onCode) st.onCode = onCode;
    if (onStatus) st.onStatus = onStatus;
    if (st.running) { resume(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status('error', 'NoCamera'); return; }
    var token = ++st.token;
    status('starting');
    openMain()
      .then(function (stream) { return attach(stream, token); })
      .then(function (ok) { if (ok) goLive(token); })
      .catch(function (err) {
        if (token !== st.token) return;
        stopTracks(); st.running = false;
        status('error', String((err && (err.name || err.message)) || err));
      });
  }

  function stop() {
    st.token++; st.running = false; st.paused = false; st.busy = false;
    cancelAnimationFrame(st.raf);
    stopTracks();
    status('stopped');
  }
  function restart() { stop(); start(); }
  function pause() { st.paused = true; }
  function resume() {
    if (!st.running) { start(); return; }
    st.paused = false; st.busy = false; loop();
  }

  /* ---------- reading QR codes ---------- */
  function setupDetector() {
    st.detector = null;
    if (!('BarcodeDetector' in window)) return;
    try {
      var p = BarcodeDetector.getSupportedFormats ? BarcodeDetector.getSupportedFormats() : Promise.resolve(['qr_code']);
      p.then(function (f) { if (f && f.indexOf('qr_code') >= 0) st.detector = new BarcodeDetector({ formats: ['qr_code'] }); }).catch(function () {});
    } catch (e) {}
  }
  (function makeWorker() {
    try {
      var src = "importScripts('" + JSQR + "');" +
        "onmessage=function(e){var d=e.data,r=null;try{r=jsQR(new Uint8ClampedArray(d.buf),d.w,d.h,{inversionAttempts:'dontInvert'});}catch(x){}postMessage(r&&r.data?r.data:'');};";
      st.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      st.worker.onmessage = function (e) { st.busy = false; if (e.data) found(e.data); };
      st.worker.onerror = function () { st.worker = null; st.busy = false; };
    } catch (e) { st.worker = null; }
  })();

  function found(text) {
    if (!st.running || st.paused || !text) return;
    try { if (st.onCode) st.onCode(String(text)); } catch (e) {}
  }

  function loop() {
    cancelAnimationFrame(st.raf);
    if (!st.running || st.paused) return;
    st.raf = requestAnimationFrame(loop);
    var now = Date.now();
    if (st.busy) {
      // A worker that never answers (blocked script, old phone) is dropped; reading continues on the main thread.
      if (st.worker && st.sentAt && now - st.sentAt > 1500) { try { st.worker.terminate(); } catch (e) {} st.worker = null; st.busy = false; }
      return;
    }
    if (now - st.last < 70) return;
    st.last = now;
    var v = st.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;

    if (st.detector) {
      st.busy = true; st.sentAt = 0;
      st.detector.detect(v).then(function (codes) {
        st.busy = false;
        if (codes && codes.length && codes[0].rawValue) found(codes[0].rawValue);
      }).catch(function () { st.busy = false; st.detector = null; });
      return;
    }
    // Read the middle of the picture; alternate a tight and a wide crop so near and far codes both read.
    st.flip = !st.flip;
    var vw = v.videoWidth, vh = v.videoHeight, side = Math.floor(Math.min(vw, vh) * (st.flip ? 0.62 : 0.95));
    var sx = Math.floor((vw - side) / 2), sy = Math.floor((vh - side) / 2), size = Math.min(st.flip ? 420 : 560, side);
    var c = st.canvas; c.width = size; c.height = size;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(v, sx, sy, side, side, 0, 0, size, size);
    var img = x.getImageData(0, 0, size, size);
    if (st.worker) {
      st.busy = true; st.sentAt = now;
      try { st.worker.postMessage({ buf: img.data.buffer, w: size, h: size }, [img.data.buffer]); return; }
      catch (e) { st.worker = null; st.busy = false; img = x.getImageData(0, 0, size, size); }
    }
    if (!window.jsQR) return;
    var r = null;
    try { r = jsQR(img.data, size, size, { inversionAttempts: 'dontInvert' }); } catch (e) {}
    if (r && r.data) found(r.data);
  }

  try { localStorage.removeItem('bq_lens'); } catch (e) {}
  window.QRCam = {
    start: start, stop: stop, pause: pause, resume: resume, restart: restart,
    isLive: function () { return st.running && !st.paused; },
    lensCount: function () { return st.backs.length; },
    lensName: function () { return label(st.stream); },
    engine: function () { return st.detector ? 'built-in' : (st.worker ? 'worker' : 'main'); },
    resetLens: function () { saveLens(''); }
  };
})();
