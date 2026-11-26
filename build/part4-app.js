/* =====================================================================
   Nate's Theater — app layer: routing, pages, Plex, Live TV, YouTube,
   radio, settings, and the full-screen player around the engine.
   Every page has its own address (#/movies, #/item/123, #/watch/…), so
   Back, refresh and bookmarks behave like any website.
   ===================================================================== */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const E = Engine, S = Engine.S;
  const enc = encodeURIComponent;

  /* ---------- small helpers ---------- */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  function hue(str) { let x = 0; for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) % 360; return x; }
  function grad(str) { const a = hue(str || '?'); return `linear-gradient(135deg, hsl(${a} 55% 34%), hsl(${(a + 50) % 360} 60% 16%))`; }
  function fmtMin(ms) { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }
  const isHttps = location.protocol === 'https:';
  function okUrl(u) { return /^https:\/\//i.test(u) || (!isHttps && /^http:\/\//i.test(u)); }

  /* ---------- passenger gate ---------- */
  const gate = $('gate');
  function dismissGate() { gate.hidden = true; document.body.classList.remove('gated'); }
  function attest() { dismissGate(); store.set('dm_attested_at', Date.now()); }
  $('gatePassenger').addEventListener('click', attest);
  $('gateDriver').addEventListener('click', attest);
  { const at = store.get('dm_attested_at', 0); if (at && Date.now() - at < 12 * 3600 * 1000) dismissGate(); }

  if (!E.hasWC) $('wcWarn').hidden = false;

  /* A tap in the last few seconds lets audio start without a second tap
     (browsers only allow sound to begin right after a user gesture). */
  let lastTapAt = 0;
  document.addEventListener('pointerdown', () => { lastTapAt = Date.now(); }, true);
  document.addEventListener('click', () => { lastTapAt = Date.now(); }, true);
  function recentTap() { return Date.now() - lastTapAt < 4000; }

  /* =====================================================================
     Cards and rows
     ===================================================================== */
  function skeletons(n, wide) {
    return Array.from({ length: n }, () => h('div', { class: (wide ? 'lc' : 'pc') + ' skel' }, h('div', { class: 'art' }), h('div', { class: 'sk-line' })));
  }
  function artBox(img, ph, extra) {
    const box = h('div', { class: 'art' });
    if (img) {
      const im = h('img', { src: img, alt: '', loading: 'lazy', decoding: 'async', class: 'fade' });
      im.addEventListener('load', () => im.classList.add('in'));
      im.addEventListener('error', () => { im.remove(); box.prepend(h('div', { class: 'ph', text: ph || '' })); });
      box.appendChild(im);
    } else {
      box.style.background = grad(ph);
      box.appendChild(h('div', { class: 'ph', text: ph || '' }));
    }
    if (extra) extra.forEach((x) => x && box.appendChild(x));
    return box;
  }
  function progressBar(p) {
    if (!(p > 0.01 && p < 0.99)) return null;
    return h('div', { class: 'pbar' }, h('i', { style: { width: Math.round(p * 100) + '%' } }));
  }
  function posterCard(c) {
    const badge = c.unwatched > 0 ? h('div', { class: 'badge', text: String(c.unwatched) })
      : c.seen ? h('div', { class: 'badge seen', text: '✓' }) : null;
    return h('a', { class: 'pc', href: c.href },
      artBox(c.img, c.title, [progressBar(c.progress), badge]),
      h('div', { class: 't', text: c.title }),
      c.sub ? h('div', { class: 's', text: c.sub }) : null);
  }
  function wideCard(c) {
    const extras = [progressBar(c.progress)];
    if (c.live) extras.push(h('div', { class: 'live-tag', text: 'LIVE' }));
    if (c.play) extras.push(h('div', { class: 'play', text: '▶' }));
    if (c.channel) extras.push(h('div', { class: 'chan' }, h('div', { class: 'n', text: c.channel }), c.cat ? h('div', { class: 'c', text: c.cat }) : null));
    if (c.star) extras.push(c.star);
    const box = artBox(c.img, c.channel ? '' : c.title, extras);
    if (c.channel && !c.img) box.style.background = grad(c.cat || c.channel);
    const el = h(c.href ? 'a' : 'div', { class: 'lc', href: c.href, onclick: c.onclick },
      box,
      c.channel ? null : h('div', { class: 't', text: c.title }),
      c.sub ? h('div', { class: 's', text: c.sub }) : null);
    el.classList.add('pc');
    return el;
  }
  /* Magazine-style rows: as a row scrolls, the cover in the middle faces
     you and the ones toward the edges turn away like pages. Works on
     any horizontally scrolling row; cards added later are picked up. */
  function enableFlow(scroller) {
    scroller.classList.add('flow');
    let raf = 0;
    const update = () => {
      raf = 0;
      if (!scroller.isConnected) return;
      const r = scroller.getBoundingClientRect();
      if (!r.width) return;
      const cx = r.left + r.width / 2;
      for (const el of scroller.children) {
        const b = el.getBoundingClientRect();
        const d = Math.max(-1, Math.min(1, ((b.left + b.width / 2) - cx) / (r.width / 2)));
        const ang = -d * 32, sc = 1 - Math.abs(d) * 0.1, lift = Math.abs(d) < 0.15 ? -4 : 0;
        el.style.transform = `translateY(${lift}px) rotateY(${ang.toFixed(1)}deg) scale(${sc.toFixed(3)})`;
        el.style.zIndex = String(100 - Math.round(Math.abs(d) * 100));
      }
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(update); };
    scroller.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick, { passive: true });
    new MutationObserver(kick).observe(scroller, { childList: true });
    if ('ResizeObserver' in window) new ResizeObserver(kick).observe(scroller);
    kick();
    return scroller;
  }
  function row(title, moreHref) {
    const scroller = enableFlow(h('div', { class: 'scroller' }));
    const sec = h('section', { class: 'row' },
      h('div', { class: 'row-h' }, h('h2', { text: title }), moreHref ? h('a', { href: moreHref, text: 'See all ›' }) : null),
      scroller);
    return { sec, scroller };
  }
  function msg(text, err) { return h('div', { class: 'msg' + (err ? ' err' : ''), text }); }
  function chips(list, current, hrefOf) {
    return h('div', { class: 'chips pad' }, list.map((c) =>
      h('a', { class: 'chip' + (c.id === current ? ' on' : ''), href: hrefOf(c), text: c.label })));
  }

  /* =====================================================================
     Plex
     ===================================================================== */
  const PRODUCT = "Nate's Theater";
  let plexClientId = store.get('dm_plex_client_v2', null);
  if (!plexClientId) {
    const legacy = (() => { try { return localStorage.getItem('dm_plex_client'); } catch (e) { return null; } })();
    plexClientId = legacy || ('nt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
    store.set('dm_plex_client_v2', plexClientId);
  }
  const plex = {
    auth: store.get('dm_plex_auth', null),   // {token}  account
    user: store.get('dm_plex_user', null),   // {id, name, token, thumb}
    conn: store.get('dm_plex_conn', null),   // {base, token, name, relay, local}
    sections: null, connecting: null
  };
  function plexActiveToken() { return plex.user ? plex.user.token : (plex.auth ? plex.auth.token : ''); }
  function plexQS(tok) {
    return 'X-Plex-Token=' + enc(tok || (plex.conn && plex.conn.token) || '') +
      '&X-Plex-Client-Identifier=' + enc(plexClientId) + '&X-Plex-Product=' + enc(PRODUCT) +
      // Plex refuses transcodes (HTTP 400, "unable to find a matching
      // profile") unless the client identifies itself like this.
      '&X-Plex-Version=2.0&X-Plex-Platform=Chrome&X-Plex-Platform-Version=120.0' +
      '&X-Plex-Device=Web&X-Plex-Model=Web&X-Plex-Device-Name=' + enc("Nate's Theater");
  }
  function plexTv(path, method, token) {
    const headers = {
      'Accept': 'application/json', 'X-Plex-Client-Identifier': plexClientId,
      'X-Plex-Product': PRODUCT, 'X-Plex-Version': '2.0', 'X-Plex-Platform': 'Chrome',
      'X-Plex-Device-Name': "Nate's Theater (car)"
    };
    if (token) headers['X-Plex-Token'] = token;
    return E.fetchRead('https://plex.tv' + path, 'json', 15000, { method: method || 'GET', headers });
  }

  /* Find the server and a connection that answers from here. All
     candidates are probed at once; a direct connection wins over Plex's
     bandwidth-capped relay, which is only used if nothing else answers. */
  function discoverPlex() {
    return plexTv('/api/v2/resources?includeHttps=1&includeRelay=1&X-Plex-Token=' + enc(plexActiveToken())).then((list) => {
      const servers = (list || []).filter((r) => (r.provides || '').split(',').includes('server'));
      if (!servers.length) throw new Error('no Plex server was found on that account.');
      servers.sort((a, b) => (b.owned ? 1 : 0) - (a.owned ? 1 : 0) || (b.presence ? 1 : 0) - (a.presence ? 1 : 0));
      const srv = servers[0];
      const cands = (srv.connections || []).filter((c) => okUrl(c.uri));
      return new Promise((resolve, reject) => {
        let pending = cands.length, relayWin = null, done = false;
        if (!pending) { reject(new Error('your server lists no secure connections — check Remote Access.')); return; }
        cands.forEach((c) => {
          const base = c.uri.replace(/\/+$/, '');
          E.fetchRead(base + '/identity?X-Plex-Token=' + enc(srv.accessToken), 'json', 7000, { headers: { Accept: 'application/json' } })
            .then(() => {
              if (done) return;
              const conn = { base, token: srv.accessToken, name: srv.name, relay: !!c.relay, local: !!c.local };
              if (!c.relay) { done = true; resolve(conn); } else if (!relayWin) relayWin = conn;
            })
            .catch(() => {})
            .then(() => {
              if (--pending === 0 && !done) {
                done = true;
                relayWin ? resolve(relayWin) : reject(new Error(`no connection to “${srv.name}” answered from here — is the server on?`));
              }
            });
        });
      });
    }).then((conn) => {
      plex.conn = conn; plex.sections = null;
      store.set('dm_plex_conn', conn);
      return conn;
    });
  }
  function ensurePlex() {
    if (!plex.auth) return Promise.reject(Object.assign(new Error('Not signed in to Plex.'), { signin: true }));
    if (plex.conn) return Promise.resolve(plex.conn);
    if (!plex.connecting) plex.connecting = discoverPlex().finally(() => { plex.connecting = null; });
    return plex.connecting;
  }
  let rediscovering = null;
  function pget(path) {
    return ensurePlex().then((conn) => {
      const url = conn.base + path + (path.includes('?') ? '&' : '?') + plexQS(conn.token);
      return E.fetchRead(url, 'json', 20000, { headers: { Accept: 'application/json' } }).catch((e) => {
        if (/HTTP 4\d\d/.test(e.message)) throw e;
        // Network failure: the cached connection may have gone stale
        // (home IP changed, server restarted). Find it again once.
        if (!rediscovering) rediscovering = discoverPlex().finally(() => { rediscovering = null; });
        return rediscovering.then((c2) => E.fetchRead(c2.base + path + (path.includes('?') ? '&' : '?') + plexQS(c2.token),
          'json', 20000, { headers: { Accept: 'application/json' } }));
      });
    });
  }
  function pimg(path, w, hgt) {
    if (!path || !plex.conn) return '';
    return `${plex.conn.base}/photo/:/transcode?width=${w}&height=${hgt}&minSize=1&upscale=1&url=${enc(path)}&X-Plex-Token=${enc(plex.conn.token)}`;
  }
  const MC = (d) => (d && d.MediaContainer) || {};
  function getSections() {
    if (plex.sections) return Promise.resolve(plex.sections);
    return pget('/library/sections').then((d) => {
      plex.sections = (MC(d).Directory || []).filter((x) => x.type === 'movie' || x.type === 'show');
      return plex.sections;
    });
  }
  function epCode(m) { return (m.parentIndex != null ? 'S' + m.parentIndex : '') + (m.index != null ? ' · E' + m.index : ''); }
  function plexCard(m, mode) {
    // mode 'cw': continue watching (wide, plays directly)
    const c = { title: m.title, sub: '', img: pimg(m.thumb, 300, 450), href: '#/item/' + m.ratingKey,
      progress: m.viewOffset && m.duration ? m.viewOffset / m.duration : 0, seen: m.viewCount > 0 && m.type !== 'show' };
    if (m.type === 'episode') {
      c.title = m.grandparentTitle || m.title;
      c.sub = epCode(m) + ' — ' + m.title;
      c.img = pimg(m.grandparentThumb || m.parentThumb || m.thumb, 300, 450);
      c.href = '#/item/' + (m.grandparentRatingKey || m.ratingKey);
    } else if (m.type === 'season') {
      c.title = m.parentTitle || m.title; c.sub = m.title;
      c.img = pimg(m.thumb || m.parentThumb, 300, 450);
      c.href = '#/item/' + (m.parentRatingKey || m.ratingKey);
    } else if (m.type === 'show') {
      c.sub = m.year ? String(m.year) : 'TV show';
      if (m.leafCount) c.unwatched = m.leafCount - (m.viewedLeafCount || 0);
    } else {
      c.sub = m.year ? String(m.year) : '';
    }
    if (mode === 'cw') {
      return wideCard({
        title: c.title, sub: m.type === 'episode' ? c.sub : (m.year ? String(m.year) : ''),
        img: pimg(m.type === 'episode' ? (m.thumb || m.grandparentArt) : (m.art || m.thumb), 480, 270),
        href: '#/watch/plex/' + m.ratingKey, progress: c.progress, play: true
      });
    }
    return posterCard(c);
  }

  /* ---------- Plex sign-in ---------- */
  let pinPoll = null;
  function stopPinPoll() { if (pinPoll) { clearInterval(pinPoll); pinPoll = null; } }
  function authUrl(code) {
    return 'https://app.plex.tv/auth#?clientID=' + enc(plexClientId) + '&code=' + enc(code) +
      '&context%5Bdevice%5D%5Bproduct%5D=' + enc(PRODUCT) +
      '&forwardUrl=' + enc(location.origin + location.pathname + '#/profiles');
  }
  function pollPin(id, onMsg) {
    stopPinPoll();
    let tries = 0;
    pinPoll = setInterval(() => {
      if (++tries > 300) { stopPinPoll(); onMsg && onMsg('That sign-in timed out. Try again.', true); return; }
      plexTv('/api/v2/pins/' + id).then((pin) => {
        if (pin && pin.authToken) {
          stopPinPoll();
          store.set('dm_plex_pin', null);
          plex.auth = { token: pin.authToken };
          store.set('dm_plex_auth', plex.auth);
          plex.user = null; plex.conn = null; plex.sections = null;
          store.set('dm_plex_user', null); store.set('dm_plex_conn', null);
          invalidate();
          go('#/profiles', true);
        }
      }).catch(() => {});
    }, 2000);
  }
  function startSignin(onMsg) {
    onMsg('Contacting Plex…');
    plexTv('/api/v2/pins?strong=true', 'POST').then((pin) => {
      store.set('dm_plex_pin', { id: pin.id, code: pin.code, at: Date.now() });
      onMsg('Taking you to Plex to sign in — you’ll come right back here.');
      // Same tab on purpose: car browsers swallow pop-up windows.
      setTimeout(() => { location.href = authUrl(pin.code); }, 600);
      pollPin(pin.id, onMsg);
    }).catch((e) => onMsg('Could not reach Plex: ' + e.message, true));
  }
  function signOut() {
    stopPinPoll();
    plex.auth = plex.user = plex.conn = plex.sections = null;
    ['dm_plex_auth', 'dm_plex_user', 'dm_plex_conn', 'dm_plex_pin'].forEach((k) => store.set(k, null));
    invalidate(); updateMe();
  }
  { // resume a sign-in that left for Plex's page and came back
    const p = store.get('dm_plex_pin', null);
    if (!plex.auth && p && p.id && Date.now() - p.at < 25 * 60 * 1000) pollPin(p.id, (m, err) => err && toast(m));
  }

  /* =====================================================================
     Live TV sources
     ===================================================================== */
  const VERIFIED = [
    ["MovieSphere", "Movies", "https://amg00353-lionsgatestudio-moviesphere-xumo-zh5u0.amagi.tv/playlist.m3u8", "https://i.imgur.com/h1ejU90.png"],
    ["Gravitas Movies", "Movies", "https://d6dg3ebeih71x.cloudfront.net/Gravitas_Movies.m3u8", "https://i.imgur.com/H2hD4vT.png"],
    ["24 Hour Free Movies", "Movies", "https://d1j2u714xk898n.cloudfront.net/scheduler/scheduleMaster/145.m3u8", "https://i.imgur.com/iSVnzR1.png"],
    ["Charge!", "Movies", "https://fast-channels.sinclairstoryline.com/CHARGE/index.m3u8", "https://static.wikia.nocookie.net/logopedia/images/0/09/Charge!_network_logo.png/revision/latest/scale-to-width-down/512/"],
    ["ION", "Series", "https://wurlewscripps.global.transmit.live/hls/68b9b0338cacd6fc468c222c/v1/scripps_ion_1/vizio_us/latest/main/hls/playlist.m3u8", "https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ion_logo.svg/960px-Ion_logo.svg.png"],
    ["ION Mystery", "Series", "https://bdd9b4ef.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/Vml6aW9fSU9OTXlzdGVyeV9ITFM/playlist.m3u8", "https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/ION_Mystery_logo.svg/960px-ION_Mystery_logo.svg.png"],
    ["The Carol Burnett Show", "Classic TV", "https://vizioaaaa-carol-burnett-vizio-xam92.amagi.tv/playlist/vizioAAAA-carol-burnett-vizio/playlist.m3u8", "https://i.imgur.com/1a03FlX.png"],
    ["Story Television", "Classic TV", "https://2-fss-1.streamhoster.com/pl_122/206858-4412976-1/playlist.m3u8", "https://upload.wikimedia.org/wikipedia/en/e/e1/Story_television_logo.png"],
    ["FailArmy", "Comedy", "https://failarmy-international-au.samsung.wurl.tv/playlist.m3u8", "https://i.imgur.com/VIpQJxL.png"],
    ["Comet", "Sci-Fi", "https://fast-channels.sinclairstoryline.com/COMET/index.m3u8", "https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/Comet_logo.svg/960px-Comet_logo.svg.png"],
    ["DUST", "Sci-Fi", "https://dqi7ayt2o24fn.cloudfront.net/playlist.m3u8", "https://i.imgur.com/FxYhME9.png"],
    ["Midnight Pulp", "Horror", "https://linear-897.frequency.stream/dist/cineverse/897/hls/master/playlist.m3u8", "https://provider-static.plex.tv/a/epg/channels/logos/gracenote/a1a2cdc3d6f0714c586e9959732580c7.png"],
    ["RetroCrush", "Anime", "https://linear-899.frequency.stream/dist/cineverse/899/hls/master/playlist.m3u8", "https://i.imgur.com/M40b4YI.png"],
    ["Hell's Kitchen", "Reality", "https://amg00654-itv-amg00654c1-samsung-au-1072.playouts.now.amagi.tv/itv-hellskitchen-samsung/playlist.m3u8", "https://i.imgur.com/P9eT0O9.png"],
    ["Fear Factor", "Reality", "https://amg00627-banijaygroup-fearfactor-samsungau-9vdod.amagi.tv/playlist/amg00627-banijaygroup-fearfactor-samsungau/playlist.m3u8", "https://i.imgur.com/CIYnLWz.png"],
    ["American Ninja Warrior", "Reality", "https://d4whmvwm0rdvi.cloudfront.net/10007/99951318/hls/master.m3u8?ads.xumo_channelId=99951318", "https://raw.githubusercontent.com/RoqueDJ/iptv-svg/main/1792421696158.png"],
    ["Court TV", "Crime", "https://cdn-uw2-prod.tsv2.amagi.tv/linear/amg01438-ewscrippscompan-courttv-tablo/playlist.m3u8", "https://i.imgur.com/jOKA735.png"],
    ["Unsolved Mysteries", "Crime", "https://d31z96rdrmwfsp.cloudfront.net/master.m3u8", "https://i.imgur.com/De3khrX.png"],
    ["Top Gear", "Entertainment", "https://amg00793-amg00793c5-vizio-us-2666.playouts.now.amagi.tv/playlist/amg00793-bbcstudios-bbctopgear8minother-vizious/playlist.m3u8", "https://i.imgur.com/S6Su6QH.png"],
    ["Tastemade", "Entertainment", "https://rakutenaa-tm-intl-aus-rakuten-eu-n1gtg.amagi.tv/playlist/rakutenAA-tm-intl-aus-rakuten-eu/playlist.m3u8", "https://i.imgur.com/xP7Ehn8.png"],
    ["NBC News NOW", "News", "https://d1si3n1st4nkgb.cloudfront.net/10502/88896001/hls/master.m3u8?ads.xumo_channelId=88896001", "https://i.imgur.com/JZt2qh5.png"],
    ["DW English", "News", "https://amg01644-amg01644c1-amgplt0343.playout.now3.amagi.tv/ts-eu-w1-n2/playlist/amg01644-amg01644c1-amgplt0343/playlist.m3u8", "https://i.imgur.com/MNKkgfa.png"],
    ["Bloomberg TV+", "News", "https://bloomberg.com/media-manifest/streams/us.m3u8", "https://i.imgur.com/OuogLHx.png"],
    ["Sky News", "News", "https://dash4.antik.sk/live/test_skynews/playlist.m3u8", "https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1404.png"],
    ["PBS Kids", "Kids", "https://livestream.pbskids.org/out/v1/14507d931bbe48a69287e4850e53443c/est.m3u8", "https://i.imgur.com/fg8c9WK.png"],
    ["MeTV Toons", "Kids", "https://sr-live-weigel1.akamaized.net/out/v1/0d1dbf29e64e47bc991796cc24fbeb97/index_2.m3u8", "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/MeTV_Toons.png/250px-MeTV_Toons.png"],
    ["The Weather Channel", "Weather", "https://twcprod-live.twc-tv.com/v1/manifest/b4d4d63a49309cc5140171fb2e92485c31be1e9e/DSP_6228e4760505741a116f1ba2_twcprod-live/6bf09ce5-366b-463c-b67e-c4b799f73c3f/4.m3u8", "https://i.imgur.com/PIaNjfa.png"],
    ["AccuWeather NOW", "Weather", "https://cdn-ue1-prod.tsv2.amagi.tv/linear/amg00684-accuweather-accuweather-plex/playlist.m3u8", "https://i.imgur.com/M8wbVYK.png"]
  ].map(([name, cat, url, logo]) => ({ name, cat, url, logo: logo || '' }));

  const REGIONS = [
    // English-speaking channels only
    ['us', 'USA'], ['ca', 'Canada'], ['uk', 'UK'], ['ie', 'Ireland'], ['au', 'Australia'], ['nz', 'New Zealand']
  ];
  function parseM3U(text, allowHttp) {
    const out = []; let cur = null;
    const urlOk = (u) => okUrl(u) || (allowHttp && /^http:\/\//i.test(u));
    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith('#EXTINF')) {
        const attr = (k) => { const m = line.match(new RegExp(k + '="([^"]*)"')); return m ? m[1] : ''; };
        const comma = line.lastIndexOf(',');
        cur = { name: comma >= 0 ? line.slice(comma + 1).trim() : 'Channel', logo: attr('tvg-logo'), cat: (attr('group-title') || 'Other').split(';')[0] };
      } else if (!line.startsWith('#')) {
        if (cur && urlOk(line) && !/\.mpd(\?|$)/i.test(line)) { cur.url = line; if (!okUrl(cur.logo)) cur.logo = ''; out.push(cur); }
        cur = null;
      }
    });
    return out;
  }
  const listCache = {};
  function loadM3U(url) {
    if (listCache[url]) return Promise.resolve(listCache[url]);
    return E.fetchRead(url, 'text', 20000).then((t) => (listCache[url] = parseM3U(t)));
  }
  function favs() { return store.get('dm_favs', []); }
  function isFav(url) { return favs().some((f) => f.url === url); }
  function toggleFav(ch) {
    let f = favs();
    if (f.some((x) => x.url === ch.url)) { f = f.filter((x) => x.url !== ch.url); toast(`Removed ${ch.name} from favorites`); }
    else { f.unshift({ name: ch.name, cat: ch.cat, url: ch.url, logo: ch.logo || '', iptv: !!ch.iptv, sid: ch.sid || '' }); toast(`Added ${ch.name} to favorites`); }
    store.set('dm_favs', f.slice(0, 200));
  }
  function channelHref(ch) {
    if (ch.iptv) return '#/watch/iptv/' + enc(ch.url) + '/' + enc(ch.name) + '/' + enc(ch.cat || '') + '/' + enc(ch.sid || '');
    return '#/watch/live/' + enc(ch.url) + '/' + enc(ch.name) + '/' + enc(ch.cat || '');
  }

  /* ---------- Channel memory: which channels actually played here ----------
     Each live/IPTV channel opened in the player is marked as working once
     a picture appears, or as failed if the player gives up before that.
     Lists then show working channels first and dim the ones that failed. */
  const HEALTH_KEY = 'dm_chhealth';
  let healthMap = store.get(HEALTH_KEY, {});
  function chHealth(url) { return healthMap[url] || null; }
  function markHealth(url, ok) {
    const e = healthMap[url] || { ok: 0, fail: 0 };
    if (ok) e.ok++; else e.fail++;
    e.last = ok ? 1 : 0; e.at = Date.now();
    healthMap[url] = e;
    try { repaintHealth(url); } catch (err) {}
    const keys = Object.keys(healthMap);
    if (keys.length > 4000) keys.sort((a, b) => healthMap[a].at - healthMap[b].at).slice(0, keys.length - 4000).forEach((k) => delete healthMap[k]);
    store.set(HEALTH_KEY, healthMap);
  }
  function paintHealth(card) {
    const hl = chHealth(card.dataset.url);
    const box = card.querySelector('.art');
    card.querySelectorAll('.ok-tag,.bad-tag').forEach((x) => x.remove());
    card.classList.toggle('bad', !!hl && !hl.last);
    if (!hl) return;
    box.appendChild(hl.last ? h('div', { class: 'ok-tag', text: '✓ Played here' }) : h('div', { class: 'bad-tag', text: 'Didn’t play last time' }));
  }
  // Update cards already on screen (cached pages keep their scroll position).
  function repaintHealth(url) {
    document.querySelectorAll('.lc').forEach((c) => { if (c.dataset.url === url) paintHealth(c); });
    cache.forEach((v) => v.node.querySelectorAll('.lc').forEach((c) => { if (c.dataset.url === url) paintHealth(c); }));
  }
  function healthRank(ch) { const e = chHealth(ch.url); return !e ? 1 : e.last ? 0 : 2; }
  function sortByHealth(list) {
    return list.map((c, i) => [c, i]).sort((a, b) => healthRank(a[0]) - healthRank(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }
  function channelCard(ch) {
    const star = h('button', {
      class: 'badge', type: 'button', 'aria-label': 'Favorite',
      style: { border: '0', cursor: 'pointer', background: 'rgba(0,0,0,.55)', color: isFav(ch.url) ? '#f5c518' : '#fff', minWidth: '40px', height: '40px', fontSize: '20px' },
      text: isFav(ch.url) ? '★' : '☆',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleFav(ch); e.currentTarget.textContent = isFav(ch.url) ? '★' : '☆'; e.currentTarget.style.color = isFav(ch.url) ? '#f5c518' : '#fff'; }
    });
    const card = wideCard({ channel: ch.logo ? '' : ch.name, cat: ch.logo ? '' : ch.cat, img: '', live: true, href: channelHref(ch), star,
      title: ch.name, sub: ch.logo ? (ch.cat || '') : '' });
    if (ch.logo) {
      const box = card.querySelector('.art');
      box.style.background = '#1b1d22';
      const ph = box.querySelector('.ph'); if (ph) ph.remove();
      const im = h('img', { src: ch.logo, alt: '', loading: 'lazy', style: { objectFit: 'contain', padding: '22px' } });
      im.addEventListener('error', () => { im.remove(); box.style.background = grad(ch.cat || ch.name); box.appendChild(h('div', { class: 'chan' }, h('div', { class: 'n', text: ch.name }))); });
      box.insertBefore(im, box.firstChild);
    }
    card.dataset.url = ch.url;
    paintHealth(card);
    return card;
  }

  /* =====================================================================
     YouTube helper + radio
     ===================================================================== */
  const YT_DEFAULT = 'https://yt-helper.tail56cd28.ts.net';
  function ytBase() { return (store.get('dm_yt_base', '') || YT_DEFAULT).replace(/\/+$/, ''); }
  function ytIdFrom(raw) {
    raw = (raw || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    const m = raw.match(/[?&]v=([A-Za-z0-9_-]{11})/) || raw.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
      raw.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  /* Send to car: turn a shared or pasted link into something the car can
     play. YouTube (videos, Shorts, live) and direct video links for now. */
  function linkTarget(text, title) {
    text = String(text || '');
    const id = ytIdFrom(text) || (text.match(/https?:\/\/\S+/g) || []).map(ytIdFrom).find(Boolean);
    if (id) return { hash: '#/watch/yt/' + enc(id) + '/' + enc((title || 'YouTube video').slice(0, 120)), label: title || 'YouTube video' };
    const url = (text.match(/https?:\/\/[^\s"'<>]+/) || [])[0];
    if (url && /\.(m3u8|mp4|m4v|mov|ts)(\?|#|$)/i.test(url)) return { hash: '#/watch/url/' + enc(url), label: 'Video link' };
    return url ? { unsupported: url } : null;
  }
  const ytCache = {};
  function ytSearch(q, n) {
    const key = q + '|' + (n || 24);
    if (ytCache[key]) return Promise.resolve(ytCache[key]);
    return E.fetchRead(ytBase() + '/search?q=' + enc(q) + '&n=' + (n || 24), 'json', 25000)
      .then((d) => (ytCache[key] = d.results || []));
  }
  function ytCard(r) {
    return wideCard({
      title: r.title, sub: [r.channel, r.duration ? E.fmt(r.duration) : ''].filter(Boolean).join(' · '),
      img: okUrl(r.thumb || '') ? r.thumb : '', play: true,
      href: '#/watch/yt/' + enc(r.id) + '/' + enc(r.title || 'YouTube video')
    });
  }
  const YT_CHIPS = [['Trending', 'trending today'], ['Trailers', 'new movie trailers'], ['Music', 'music videos'], ['News', 'news live'],
    ['Comedy', 'stand up comedy'], ['Cars', 'car reviews'], ['Podcasts', 'podcast full episode'], ['Kids', 'kids cartoons']];

  const RB = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info'];
  function radioSearch(params) {
    const qs = new URLSearchParams(Object.assign({ hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: '60' }, params)).toString();
    let i = 0;
    const attempt = () => E.fetchRead(RB[i] + '/json/stations/search?' + qs, 'json', 12000).catch((e) => { if (++i < RB.length) return attempt(); throw e; });
    return attempt().then((list) => {
      // The directory lists many duplicates (same station, several streams):
      // keep the first (most-played) of each name.
      const seen = new Set();
      return list.filter((s) => {
        if (!okUrl(s.url_resolved || '')) return false;
        const k = (s.name || '').trim().toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k); return true;
      });
    });
  }
  const RADIO_TAGS = [
    ['talk', 'Talk'], ['news', 'News'], ['sports', 'Sports'], ['comedy', 'Comedy'], ['pop', 'Pop'], ['rock', 'Rock'],
    ['classic rock', 'Classic rock'], ['country', 'Country'], ['hiphop', 'Hip-hop'], ['rnb', 'R&B'], ['jazz', 'Jazz'],
    ['blues', 'Blues'], ['classical', 'Classical'], ['oldies', 'Oldies'], ['80s', '80s'], ['90s', '90s'], ['dance', 'Dance'],
    ['electronic', 'Electronic'], ['latin', 'Latin'], ['christian', 'Christian'], ['chillout', 'Chill'], ['christmas', 'Christmas']
  ];
  const RADIO_COUNTRIES = [['US', 'USA'], ['CA', 'Canada'], ['GB', 'UK'], ['IE', 'Ireland'], ['AU', 'Australia'], ['MX', 'México'],
    ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['BR', 'Brazil'], ['JP', 'Japan'], ['ALL', 'Worldwide']];
  function radioFavs() { return store.get('dm_radiofavs', []); }
  function isRadioFav(st) { return radioFavs().some((f) => f.stationuuid === st.stationuuid); }
  function toggleRadioFav(st) {
    let f = radioFavs();
    if (f.some((x) => x.stationuuid === st.stationuuid)) { f = f.filter((x) => x.stationuuid !== st.stationuuid); toast(`Removed ${st.name} from your stations`); }
    else {
      f.unshift({ stationuuid: st.stationuuid, name: st.name, url_resolved: st.url_resolved, favicon: st.favicon || '', tags: st.tags || '', countrycode: st.countrycode || '', bitrate: st.bitrate || 0 });
      toast(`Added ${st.name} to your stations`);
    }
    store.set('dm_radiofavs', f.slice(0, 200));
    document.querySelectorAll('.rstar').forEach((b) => { if (b.dataset.id === st.stationuuid) paintStar(b, isRadioFav(st)); });
  }
  function paintStar(b, on) { b.textContent = on ? '★' : '☆'; b.style.color = on ? '#f5c518' : '#fff'; }
  const radio = h('audio', { preload: 'none' });
  let radioBar = null, radioNow = null;
  radio.addEventListener('error', () => { if (radioNow) toast(radioNow.pod ? 'That episode couldn’t be loaded — try another one.' : `${radioNow.name} isn’t broadcasting right now — try another station.`); });
  function markPlayingCards() {
    document.querySelectorAll('[data-station]').forEach((c) => c.classList.toggle('now', !!radioNow && c.dataset.station === radioNow.stationuuid));
  }
  function playRadio(st) {
    if (playerOpen) closeWatch();
    if (radioNow && radioNow.pod) savePodNow();
    radioNow = st;
    radio.preload = 'none';
    radio.src = st.url_resolved;
    radio.defaultPlaybackRate = radio.playbackRate = 1;
    radio.play().catch((e) => toast('That station would not start: ' + e.message));
    if (!radioBar) {
      radioBar = h('div', { class: 'radiobar' });
      document.body.appendChild(radioBar);
    }
    radioBar.hidden = false;
    const star = h('button', { class: 'pb rstar', type: 'button', 'data-id': st.stationuuid, 'aria-label': 'Save station', onclick: () => toggleRadioFav(st) });
    paintStar(star, isRadioFav(st));
    const pp = h('button', { class: 'pb', type: 'button', text: '❚❚', 'aria-label': 'Pause', onclick: () => { if (radio.paused) { radio.play(); pp.textContent = '❚❚'; } else { radio.pause(); pp.textContent = '▶'; } } });
    radioBar.replaceChildren(
      h('div', { class: 'rb-logo', style: { background: grad(st.name) } },
        okUrl(st.favicon || '') ? h('img', { src: st.favicon, alt: '', onerror: (e) => e.currentTarget.remove() }) : null),
      h('div', { class: 'rb-txt' }, h('div', { class: 'rb-n', text: st.name }),
        h('div', { class: 'rb-s', text: ['Live radio', (st.tags || '').split(',').filter(Boolean).slice(0, 2).join(', '), st.bitrate ? st.bitrate + ' kbps' : ''].filter(Boolean).join(' · ') })),
      star, pp,
      h('button', { class: 'pb', type: 'button', text: '✕', 'aria-label': 'Stop', onclick: stopRadio })
    );
    markPlayingCards();
  }
  function stopRadio() { if (radioNow && radioNow.pod) savePodNow(); radio.pause(); radio.removeAttribute('src'); radioNow = null; if (radioBar) radioBar.hidden = true; markPlayingCards(); }
  function stationCard(st) {
    const tag = (st.tags || '').split(',').filter(Boolean)[0] || st.countrycode || 'Radio';
    const star = h('button', { class: 'badge rstar', type: 'button', 'data-id': st.stationuuid, 'aria-label': 'Save station',
      style: { border: '0', cursor: 'pointer', background: 'rgba(0,0,0,.55)', minWidth: '40px', height: '40px', fontSize: '20px' },
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleRadioFav(st); } });
    paintStar(star, isRadioFav(st));
    const card = wideCard({ channel: st.name, cat: tag, img: '', title: st.name, onclick: () => playRadio(st), star });
    card.dataset.station = st.stationuuid || '';
    if (okUrl(st.favicon || '')) {
      const box = card.querySelector('.art');
      const im = h('img', { class: 'logo', src: st.favicon, alt: '', loading: 'lazy' });
      im.addEventListener('load', () => { if (im.naturalWidth < 48) im.remove(); else box.classList.add('has-logo'); });
      im.addEventListener('error', () => im.remove());
      box.insertBefore(im, box.firstChild);
    }
    if (radioNow && radioNow.stationuuid === st.stationuuid) card.classList.add('now');
    return card;
  }

  /* =====================================================================
     Podcasts — Apple's public podcast directory (search, top charts,
     episodes; no helper needed). Episodes play through the same audio
     element as radio, with resume, skip and speed.
     ===================================================================== */
  const POD_GENRES = [['', 'Top shows'], ['1488', 'True Crime'], ['1303', 'Comedy'], ['1311', 'News'], ['1487', 'History'],
    ['1324', 'Society & Culture'], ['1545', 'Sports'], ['1304', 'Education'], ['1318', 'Technology'], ['1321', 'Business'],
    ['1533', 'Science'], ['1305', 'Kids & Family']];
  const POD_SPEEDS = [1, 1.25, 1.5, 2, 0.8];
  const podCache = new Map();
  function podJson(url) {
    const hit = podCache.get(url);
    if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.p;
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    podCache.set(url, { p, at: Date.now() }); p.catch(() => podCache.delete(url));
    return p;
  }
  const podArt = (u, size) => (u || '').replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/i, '/' + size + 'x' + size + 'bb.jpg');
  function podShowOf(r) {
    return { id: String(r.collectionId || r.trackId), name: r.collectionName || r.trackName || 'Podcast', by: r.artistName || '',
      art: r.artworkUrl600 || r.artworkUrl100 || '', genre: r.primaryGenreName || '' };
  }
  function podSearch(q) {
    return podJson('https://itunes.apple.com/search?media=podcast&country=US&limit=40&term=' + enc(q)).then((d) => (d.results || []).map(podShowOf));
  }
  function podTop(genre) {
    return podJson('https://itunes.apple.com/us/rss/toppodcasts/limit=50/' + (genre ? 'genre=' + genre + '/' : '') + 'json').then((d) => {
      let e = (d.feed && d.feed.entry) || []; if (!Array.isArray(e)) e = [e];
      return e.map((x) => ({ id: x.id.attributes['im:id'], name: x['im:name'].label, by: (x['im:artist'] || {}).label || '',
        art: podArt(((x['im:image'] || []).slice(-1)[0] || {}).label, 600), genre: ((x.category || {}).attributes || {}).label || '' }));
    });
  }
  function podEpisodes(id) {
    return podJson('https://itunes.apple.com/lookup?id=' + enc(id) + '&media=podcast&entity=podcastEpisode&limit=100&country=US').then((d) => {
      const rs = d.results || [];
      const top = rs.find((r) => r.wrapperType === 'track');
      const show = top ? podShowOf(top) : { id: String(id), name: 'Podcast', by: '', art: '' };
      const eps = rs.filter((r) => r.wrapperType === 'podcastEpisode' && r.episodeUrl && okUrl(r.episodeUrl)).map((r) => podEp({
        guid: String(r.episodeGuid || r.trackId), name: r.trackName, show: show.name, showId: show.id, url_resolved: r.episodeUrl,
        favicon: r.artworkUrl600 || r.artworkUrl160 || show.art, date: r.releaseDate, dur: Math.round((r.trackTimeMillis || 0) / 1000),
        desc: (r.description || '').replace(/\s+/g, ' ').slice(0, 260) }));
      return { show, eps };
    });
  }
  // Only the fields we use, as plain strings - also used on episodes a phone sends.
  function podEp(x) {
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    return { pod: true, guid: s(x.guid, 200), stationuuid: 'pod:' + s(x.guid, 200), name: s(x.name, 300), show: s(x.show, 200), showId: s(x.showId, 30),
      url_resolved: s(x.url_resolved, 2000), favicon: okUrl(x.favicon || '') ? s(x.favicon, 1000) : '', date: s(x.date, 40), dur: +x.dur || 0, desc: s(x.desc, 300) };
  }
  const podSubs = () => store.get('dm_podsubs', []);
  const isPodSub = (id) => podSubs().some((s) => s.id === id);
  function togglePodSub(s) {
    let l = podSubs();
    if (isPodSub(s.id)) { l = l.filter((x) => x.id !== s.id); toast('Unfollowed ' + s.name); }
    else { l.unshift({ id: s.id, name: s.name, by: s.by, art: s.art }); toast('Following ' + s.name); }
    store.set('dm_podsubs', l.slice(0, 100)); invalidate('podcasts');
  }
  const podPos = () => store.get('dm_podpos', {});
  function savePodPos(ep, t, dur, done) {
    const all = podPos();
    all[ep.guid] = { t: Math.floor(t || 0), dur: Math.round(dur || ep.dur || 0), at: Date.now(), done: !!done, ep: Object.assign(podEp(ep), { desc: '' }) };
    Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(80).forEach((k) => delete all[k]);
    store.set('dm_podpos', all); invalidate('podcasts'); invalidate('home');
  }
  function savePodNow() {
    if (radioNow && radioNow.pod && radio.currentTime > 5) {
      const d = isFinite(radio.duration) ? radio.duration : radioNow.dur;
      savePodPos(radioNow, radio.currentTime, d, !!d && radio.currentTime > d - 30);
    }
  }
  function podInProgress() {
    return Object.values(podPos()).filter((x) => !x.done && x.t > 30).sort((a, b) => b.at - a.at).map((x) => x.ep);
  }
  function podFmtDate(d) {
    const t = new Date(d); if (isNaN(t)) return '';
    return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function podDur() { return isFinite(radio.duration) && radio.duration > 0 ? radio.duration : (radioNow && radioNow.dur) || 0; }
  function podSkip(s) { if (!(radioNow && radioNow.pod)) return; try { radio.currentTime = Math.max(0, Math.min(podDur() - 1, radio.currentTime + s)); } catch (e) {} }
  function podSeek(t) { if (!(radioNow && radioNow.pod)) return; try { radio.currentTime = Math.max(0, Math.min(podDur() - 1, t)); } catch (e) {} }

  function playPodcast(ep, at) {
    ep = podEp(ep);
    if (!okUrl(ep.url_resolved)) { toast('That episode can’t be played here.'); return; }
    if (playerOpen) closeWatch();
    savePodNow();
    radioNow = ep;
    const saved = podPos()[ep.guid];
    const start = at != null ? Math.max(0, at) : (saved && !saved.done ? Math.max(0, saved.t - 3) : 0);
    radio.preload = 'auto';
    radio.src = ep.url_resolved;
    const sp = +store.get('dm_podspeed', 1) || 1;
    radio.defaultPlaybackRate = radio.playbackRate = sp;
    if (start > 0) {
      const jump = () => { radio.removeEventListener('loadedmetadata', jump); try { radio.currentTime = start; } catch (e) {} };
      radio.addEventListener('loadedmetadata', jump);
    }
    radio.play().catch((e) => toast('That episode would not start: ' + e.message));
    drawPodBar();
    markPlayingCards();
    if (start > 0 && at == null) toast('Picking up where you left off (' + E.fmt(start) + ')');
  }
  let podTimeEl = null, podPP = null, podLastSave = 0;
  function drawPodBar() {
    const ep = radioNow;
    if (!radioBar) { radioBar = h('div', { class: 'radiobar' }); document.body.appendChild(radioBar); }
    radioBar.hidden = false;
    podTimeEl = h('span', { class: 'rb-time' });
    podPP = h('button', { class: 'pb', type: 'button', text: '❚❚', 'aria-label': 'Pause', onclick: () => { if (radio.paused) radio.play(); else radio.pause(); } });
    const speed = h('button', { class: 'pb rb-speed', type: 'button', 'aria-label': 'Playback speed', onclick: () => {
      const cur = radio.playbackRate || 1, nx = POD_SPEEDS[(POD_SPEEDS.indexOf(cur) + 1) % POD_SPEEDS.length];
      radio.defaultPlaybackRate = radio.playbackRate = nx; store.set('dm_podspeed', nx); speed.textContent = nx + '×';
    } });
    speed.textContent = (radio.playbackRate || 1) + '×';
    radioBar.replaceChildren(
      h('a', { class: 'rb-logo', href: '#/podcasts/show/' + enc(ep.showId), style: { background: grad(ep.show) } },
        ep.favicon ? h('img', { src: podArt(ep.favicon, 160), alt: '', onerror: (e) => e.currentTarget.remove() }) : null),
      h('div', { class: 'rb-txt' }, h('div', { class: 'rb-n', text: ep.name }), h('div', { class: 'rb-s' }, h('span', { text: ep.show + ' · ' }), podTimeEl)),
      h('button', { class: 'pb', type: 'button', text: '↺ 15', 'aria-label': 'Back 15 seconds', onclick: () => podSkip(-15) }),
      podPP,
      h('button', { class: 'pb', type: 'button', text: '30 ↻', 'aria-label': 'Forward 30 seconds', onclick: () => podSkip(30) }),
      speed,
      h('button', { class: 'pb', type: 'button', text: '✕', 'aria-label': 'Stop', onclick: stopRadio }));
    paintPodTime();
  }
  function paintPodTime() {
    if (!(radioNow && radioNow.pod) || !podTimeEl) return;
    const d = podDur();
    podTimeEl.textContent = E.fmt(radio.currentTime || 0) + (d ? ' / ' + E.fmt(d) : '');
    if (podPP) podPP.textContent = radio.paused ? '▶' : '❚❚';
  }
  radio.addEventListener('timeupdate', () => {
    if (!(radioNow && radioNow.pod)) return;
    paintPodTime();
    if (Date.now() - podLastSave > 10000) { podLastSave = Date.now(); savePodNow(); }
  });
  radio.addEventListener('play', paintPodTime);
  radio.addEventListener('pause', () => { paintPodTime(); savePodNow(); });
  radio.addEventListener('ended', () => {
    if (!(radioNow && radioNow.pod)) return;
    savePodPos(radioNow, podDur(), podDur(), true);
    toast('Finished: ' + radioNow.name);
    paintPodTime();
  });

  function podShowCard(s) {
    return h('a', { class: 'pc sq', href: '#/podcasts/show/' + enc(s.id) },
      artBox(s.art ? podArt(s.art, 400) : '', s.name, []),
      h('div', { class: 't', text: s.name }), s.by ? h('div', { class: 's', text: s.by }) : null);
  }
  function podEpCard(ep) {
    const sv = podPos()[ep.guid];
    const p = sv && sv.dur ? sv.t / sv.dur : 0;
    const left = sv && sv.dur ? E.fmt(Math.max(0, sv.dur - sv.t)) + ' left' : ep.show;
    return h('div', { class: 'pc sq', 'data-station': ep.stationuuid, onclick: () => playPodcast(ep) },
      artBox(ep.favicon ? podArt(ep.favicon, 400) : '', ep.name, [progressBar(p), h('div', { class: 'play', text: '▶' })]),
      h('div', { class: 't', text: ep.name }), h('div', { class: 's', text: left }));
  }
  function podEpRow(ep) {
    const sv = podPos()[ep.guid];
    const dur = (sv && sv.dur) || ep.dur;
    const p = sv ? (sv.done ? 1 : dur ? sv.t / dur : 0) : 0;
    const meta = [podFmtDate(ep.date), ep.dur ? Math.max(1, Math.round(ep.dur / 60)) + ' min' : '',
      sv && sv.done ? '✓ Played' : sv && sv.t > 30 && dur ? E.fmt(Math.max(0, dur - sv.t)) + ' left' : ''].filter(Boolean).join(' · ');
    return h('button', { class: 'podep', type: 'button', 'data-station': ep.stationuuid, onclick: () => playPodcast(ep) },
      h('div', { class: 'podep-play', text: '▶' }),
      h('div', { class: 'podep-txt' }, h('div', { class: 't', text: ep.name }), h('div', { class: 's', text: meta }),
        ep.desc ? h('div', { class: 'd', text: ep.desc }) : null,
        p > 0.01 ? h('div', { class: 'podep-bar' }, h('i', { style: { width: Math.min(100, Math.round(p * 100)) + '%' } })) : null));
  }
  function podGrid(list) { const g = h('div', { class: 'grid sq' }); list.forEach((s) => g.appendChild(podShowCard(s))); return g; }

  function podcastsView(root, [sec, a]) {
    if (sec === 'show') { podShowPage(root, a); return; }
    const input = h('input', { type: 'text', placeholder: 'Search podcasts', value: sec === 'search' ? (a || '') : '', autocomplete: 'off', spellcheck: 'false' });
    const submit = () => { const v = input.value.trim(); if (v) go('#/podcasts/search/' + enc(v)); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'Podcasts' })));
    root.appendChild(h('div', { class: 'pad' }, h('div', { class: 'field' }, input, h('button', { class: 'btn red', type: 'button', text: 'Search', onclick: submit }))));
    const cur = sec === 'genre' ? 'g' + a : sec ? '' : 'g';
    root.appendChild(chips(POD_GENRES.map(([id, label]) => ({ id: 'g' + id, label })), cur, (c) => c.id === 'g' ? '#/podcasts' : '#/podcasts/genre/' + c.id.slice(1)));
    const body = h('div'); root.appendChild(body);
    if (sec === 'search' && a) {
      body.appendChild(msg('Searching…'));
      podSearch(a).then((l) => body.replaceChildren(l.length ? podGrid(l) : h('div', { class: 'empty', text: 'No podcasts found.' })))
        .catch((e) => body.replaceChildren(msg('Podcast search isn’t answering (' + e.message + ').', true)));
      return;
    }
    if (!sec) {
      const cont = podInProgress();
      if (cont.length) { const r = row('Continue listening'); cont.forEach((ep) => r.scroller.appendChild(podEpCard(ep))); body.appendChild(r.sec); }
      const subs = podSubs();
      if (subs.length) { const r = row('Your shows'); subs.forEach((s) => r.scroller.appendChild(podShowCard(s))); body.appendChild(r.sec); }
      // Shows played lately (finished or not), newest first.
      const seen = new Set(), recent = [];
      Object.values(podPos()).sort((x, y) => y.at - x.at).forEach((x) => {
        const ep = x.ep || {};
        if (ep.showId && !seen.has(ep.showId)) { seen.add(ep.showId); recent.push({ id: ep.showId, name: ep.show, by: 'Played ' + podFmtDate(x.at), art: ep.favicon }); }
      });
      if (recent.length) { const r = row('Recently played'); recent.slice(0, 20).forEach((s) => r.scroller.appendChild(podShowCard(s))); body.appendChild(r.sec); }
    }
    const g = POD_GENRES.find(([id]) => id === (sec === 'genre' ? a : '')) || POD_GENRES[0];
    const chart = h('div'); body.appendChild(chart);
    chart.appendChild(h('div', { class: 'row-h pad' }, h('h2', { text: sec === 'genre' ? 'Top in ' + g[1] : 'Top podcasts in the US' })));
    const load = msg('Loading…'); chart.appendChild(load);
    podTop(sec === 'genre' ? a : '').then((l) => { load.remove(); chart.appendChild(podGrid(l)); })
      .catch((e) => { load.replaceWith(msg('Couldn’t load the charts (' + e.message + ').', true)); });
  }
  function podShowPage(root, id) {
    const wait = msg('Loading episodes…'); root.appendChild(wait);
    podEpisodes(id).then(({ show, eps }) => {
      wait.remove();
      const label = () => isPodSub(show.id) ? '✓ Following' : '+ Follow';
      const follow = h('button', { class: 'btn ghost', type: 'button', text: label(), onclick: (e) => { togglePodSub(show); e.currentTarget.textContent = label(); } });
      const sv = podPos();
      const resume = eps.find((ep) => sv[ep.guid] && !sv[ep.guid].done && sv[ep.guid].t > 30);
      root.appendChild(h('div', { class: 'pod-hero pad' },
        h('div', { class: 'pod-cover', style: { background: grad(show.name) } }, show.art ? h('img', { src: podArt(show.art, 600), alt: '' }) : null),
        h('div', { class: 'pod-info' }, h('h1', { text: show.name }), h('div', { class: 'pod-by', text: [show.by, show.genre].filter(Boolean).join(' · ') }),
          h('div', { class: 'btns' },
            resume ? h('button', { class: 'btn red', type: 'button', text: '▶ Resume', onclick: () => playPodcast(resume) })
              : eps[0] ? h('button', { class: 'btn red', type: 'button', text: '▶ Play latest', onclick: () => playPodcast(eps[0]) }) : null,
            follow))));
      if (!eps.length) { root.appendChild(h('div', { class: 'empty', text: 'No playable episodes listed for this show.' })); return; }
      root.appendChild(h('div', { class: 'pad podeps' }, eps.map(podEpRow)));
      markPlayingCards();
    }).catch((e) => wait.replaceWith(msg('Couldn’t load this podcast (' + e.message + ').', true)));
  }

  /* =====================================================================
     IPTV subscription — an M3U playlist link or an Xtream Codes login.
     Providers that only offer http:// links, or that block web players,
     can be routed through the home helper's /iptv relay (locked to the
     provider and a secret key set on the helper).
     ===================================================================== */
  function iptvCfg() { return store.get('dm_iptv', null); }
  function xbase(c) { let b = (c.server || '').trim().replace(/\/+$/, ''); if (b && !/^https?:\/\//i.test(b)) b = 'http://' + b; return b; }
  function iptvWrap(url) {
    const c = iptvCfg();
    if (!c || !c.proxy || !c.key) return url;
    return ytBase() + '/iptv?k=' + enc(c.key) + '&u=' + enc(url);
  }
  function blockedHttp(url) { return isHttps && /^http:\/\//i.test(url); }
  function isRawTs(url) {
    const path = url.split('?')[0];
    if (/\.ts$/i.test(path)) return true;
    if (/\.(m3u8?|mp4|mkv|avi)$/i.test(path)) return false;
    return /\/\d+$/.test(path); // Xtream style: /user/pass/12345
  }
  function xapi(c, action, extra) {
    const url = xbase(c) + '/player_api.php?username=' + enc(c.user) + '&password=' + enc(c.pass) + (action ? '&action=' + action : '') + (extra || '');
    const u = iptvWrap(url);
    if (blockedHttp(u)) return Promise.reject(new Error('your provider uses http://, which needs “Route through the home helper” turned on in Settings'));
    return E.fetchRead(u, 'json', 45000);
  }
  let iptvData = null, iptvLoading = null;
  function loadIptv(force) {
    const c = iptvCfg();
    if (!c) return Promise.reject(new Error('not set up'));
    if (iptvData && !force) return Promise.resolve(iptvData);
    if (iptvLoading && !force) return iptvLoading;
    let p;
    if (c.type === 'xtream') {
      p = Promise.all([xapi(c, 'get_live_categories'), xapi(c, 'get_live_streams')]).then(([cats, streams]) => {
        const names = {};
        (cats || []).forEach((x) => { names[x.category_id] = x.category_name; });
        return (Array.isArray(streams) ? streams : []).map((st) => ({
          name: st.name || 'Channel', cat: names[st.category_id] || 'Other',
          logo: okUrl(st.stream_icon || '') ? st.stream_icon : '',
          url: `${xbase(c)}/live/${enc(c.user)}/${enc(c.pass)}/${st.stream_id}.ts`, sid: String(st.stream_id), iptv: true
        }));
      });
    } else {
      const u = iptvWrap(c.m3u);
      p = blockedHttp(u) ? Promise.reject(new Error('your playlist link is http://, which needs “Route through the home helper” turned on in Settings'))
        : E.fetchRead(u, 'text', 90000).then((t) => {
          if (t.indexOf('#EXTM3U') < 0 && t.indexOf('#EXTINF') < 0) throw new Error('that link did not return an M3U playlist');
          return parseM3U(t, true).filter((ch) => !/\/(movie|series)\//i.test(ch.url)).map((ch) => Object.assign(ch, { iptv: true }));
        });
    }
    iptvLoading = p.then((list) => {
      const cats = [...new Set(list.map((x) => x.cat || 'Other'))];
      iptvData = { channels: list, cats, at: Date.now() };
      return iptvData;
    }).finally(() => { iptvLoading = null; });
    return iptvLoading;
  }
  function b64(t) { try { return decodeURIComponent(escape(atob(t || ''))); } catch (e) { return t || ''; } }
  function xtreamNowNext(sid) {
    const c = iptvCfg();
    if (!c || c.type !== 'xtream' || !sid) return Promise.resolve('');
    return xapi(c, 'get_short_epg', '&stream_id=' + enc(sid) + '&limit=2').then((d) => {
      const l = (d && d.epg_listings) || [];
      return [l[0] ? 'Now: ' + b64(l[0].title) : '', l[1] ? 'Next: ' + b64(l[1].title) : ''].filter(Boolean).join('   ·   ');
    }).catch(() => '');
  }
  function iptvSetupCard(onSaved) {
    const c = iptvCfg() || { type: 'm3u', m3u: '', server: '', user: '', pass: '', proxy: false, key: '' };
    const type = h('select', {}, h('option', { value: 'm3u', text: 'M3U playlist link' }), h('option', { value: 'xtream', text: 'Xtream Codes login (server, username, password)' }));
    type.value = c.type || 'm3u';
    const m3u = h('input', { type: 'text', value: c.m3u || '', placeholder: 'http://provider.example/get.php?username=…&password=…&type=m3u_plus', autocapitalize: 'off', spellcheck: 'false' });
    const server = h('input', { type: 'text', value: c.server || '', placeholder: 'Server, e.g. http://provider.example:8080', autocapitalize: 'off', spellcheck: 'false' });
    const user = h('input', { type: 'text', value: c.user || '', placeholder: 'Username', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' });
    const pass = h('input', { type: 'password', value: c.pass || '', placeholder: 'Password', autocomplete: 'off' });
    const proxy = h('input', { type: 'checkbox', style: { width: '26px', height: '26px' } }); proxy.checked = !!c.proxy;
    const key = h('input', { type: 'text', value: c.key || '', placeholder: 'Helper IPTV key (IPTV_KEY on the helper)', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' });
    const m3uRow = h('div', { class: 'field', style: { marginBottom: '10px' } }, m3u);
    const xRow = h('div', {}, h('div', { class: 'field', style: { marginBottom: '10px' } }, server), h('div', { class: 'field', style: { marginBottom: '10px' } }, user, pass));
    const keyRow = h('div', { class: 'field', style: { marginBottom: '10px' } }, key);
    const sync = () => { m3uRow.hidden = type.value !== 'm3u'; xRow.hidden = type.value !== 'xtream'; keyRow.hidden = !proxy.checked; };
    type.addEventListener('change', sync); proxy.addEventListener('change', sync); sync();
    const st = msg('');
    const save = () => {
      const cfg = { type: type.value, m3u: m3u.value.trim(), server: server.value.trim(), user: user.value.trim(), pass: pass.value, proxy: proxy.checked, key: key.value.trim() };
      if (cfg.type === 'm3u' && !/^https?:\/\//i.test(cfg.m3u)) { st.textContent = 'Paste the full playlist link (starting with http:// or https://).'; st.className = 'msg err'; return; }
      if (cfg.type === 'xtream' && (!cfg.server || !cfg.user || !cfg.pass)) { st.textContent = 'Fill in server, username and password.'; st.className = 'msg err'; return; }
      if (cfg.proxy && !cfg.key) { st.textContent = 'Routing through the helper needs the helper’s IPTV key.'; st.className = 'msg err'; return; }
      store.set('dm_iptv', cfg); iptvData = null; invalidate('live/iptv');
      st.textContent = 'Saved on this screen — loading your channels…'; st.className = 'msg';
      loadIptv(true).then((d) => { st.textContent = `Saved and connected — ${d.channels.length} channels in ${d.cats.length} groups. It stays set up next time you open the app.`; if (onSaved) onSaved(); })
        .catch((e) => { st.textContent = 'Saved, but loading failed: ' + e.message; st.className = 'msg err'; });
    };
    return h('div', { class: 'card' }, h('h2', { text: 'IPTV subscription' }),
      h('p', { text: 'Use the M3U link or Xtream login your IPTV provider gave you. It’s saved in this browser and stays set up between visits.' }),
      h('div', { class: 'field', style: { marginBottom: '10px' } }, type), m3uRow, xRow,
      h('label', { style: { display: 'flex', gap: '12px', alignItems: 'center', fontSize: '16px', margin: '6px 0 10px', cursor: 'pointer' } }, proxy,
        'Route through the home helper (needed for http:// providers, or ones that block web players)'),
      keyRow,
      h('div', { class: 'btns' }, h('button', { class: 'btn red', type: 'button', text: 'Save & load channels', onclick: save }),
        iptvCfg() ? h('button', { class: 'btn ghost', type: 'button', text: 'Remove', onclick: () => { store.set('dm_iptv', null); iptvData = null; invalidate('live/iptv'); st.textContent = 'Removed.'; st.className = 'msg'; } }) : null),
      st);
  }

  /* ---------- Backup / restore of everything saved on this screen ---------- */
  const SAVED_KEYS = ['dm_plex_auth', 'dm_plex_user', 'dm_plex_conn', 'dm_plex_client_v2', 'dm_iptv', 'dm_lists', 'dm_mychans', 'dm_favs', 'dm_quality', 'dm_ahead', 'dm_podsubs', 'dm_podpos', 'dm_podspeed', 'dm_yt_base', 'dm_yt_lastq'];
  function backupCard() {
    const box = h('textarea', { rows: '4', spellcheck: 'false', style: { width: '100%', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '12px', padding: '12px', fontSize: '14px', fontFamily: 'monospace' } });
    const st = msg('');
    return h('div', { class: 'card' }, h('h2', { text: 'Backup & restore' }),
      h('p', { text: 'Everything you set up here (Plex sign-in, IPTV, channel lists, favorites) is saved in this browser and is still there next time. If the car’s browser data ever gets cleared, paste a backup code here to put it all back. The code contains your logins — keep it private.' }),
      box,
      h('div', { class: 'btns', style: { marginTop: '10px' } },
        h('button', { class: 'btn ghost', type: 'button', text: 'Make backup code', onclick: () => {
          const o = {}; SAVED_KEYS.forEach((k) => { const v = store.get(k, null); if (v != null) o[k] = v; });
          box.value = 'NT1:' + btoa(unescape(encodeURIComponent(JSON.stringify(o))));
          box.select(); try { document.execCommand('copy'); st.textContent = 'Copied. Keep it somewhere private (a note on your phone).'; } catch (e) { st.textContent = 'Select and copy the code above.'; }
          st.className = 'msg';
        } }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Restore from code', onclick: () => {
          try {
            const raw = box.value.trim().replace(/^NT1:/, '');
            const o = JSON.parse(decodeURIComponent(escape(atob(raw))));
            Object.keys(o).forEach((k) => { if (SAVED_KEYS.includes(k)) store.set(k, o[k]); });
            st.textContent = 'Restored — reloading…'; st.className = 'msg';
            setTimeout(() => location.replace(location.pathname + '#/home'), 400);
            setTimeout(() => location.reload(), 500);
          } catch (e) { st.textContent = 'That doesn’t look like a backup code.'; st.className = 'msg err'; }
        } })),
      st);
  }



  /* ---------- Location (the browser's own location permission) ----------
     Used only on this screen: shown in Settings and used to center the
     traffic map. The last position is kept in this browser so the map
     can open near the car even before a fresh fix arrives. */
  function getPosition(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) { reject(new Error('this browser has no location support')); return; }
      if (!window.isSecureContext) { reject(new Error('location only works on the secure (https) site')); return; }
      navigator.geolocation.getCurrentPosition((p) => {
        const pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed, at: Date.now() };
        store.set('dm_lastpos', pos);
        resolve(pos);
      }, (err) => {
        const why = err.code === 1 ? 'location permission was declined — allow it for this site in the browser, then try again'
          : err.code === 3 ? 'no location fix yet (timed out) — try again in a moment'
          : 'the car didn’t provide a location';
        reject(new Error(why));
      }, { enableHighAccuracy: true, timeout: timeoutMs || 15000, maximumAge: 30000 });
    });
  }
  function fmtPos(p) {
    const mph = p.speed != null && p.speed >= 0 ? ` · ${Math.round(p.speed * 2.23694)} mph` : '';
    return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} (within about ${Math.round(p.acc)} m)${mph}`;
  }
  function locationCard() {
    const out = h('div', { class: 'kv', style: { marginTop: '12px' } });
    const st = msg('');
    let watchId = null, updates = 0;
    const stop = () => { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } };
    const run = () => {
      stop(); updates = 0; out.replaceChildren();
      st.textContent = 'Asking the car for its location… (the browser may ask you to allow it)'; st.className = 'msg';
      getPosition(20000).then((p) => {
        st.textContent = 'Location is available — the car shares its position with this site.';
        const posEl = h('span', { text: fmtPos(p) }), updEl = h('span', { text: '1 (watching for 60 seconds)' });
        out.replaceChildren(h('b', { text: 'Position' }), posEl, h('b', { text: 'Updates' }), updEl,
          h('b', { text: 'Map' }), h('a', { href: '#/traffic', style: { textDecoration: 'underline' }, text: 'Open the traffic map here' }));
        updates = 1;
        watchId = navigator.geolocation.watchPosition((q) => {
          updates++;
          const pos = { lat: q.coords.latitude, lon: q.coords.longitude, acc: q.coords.accuracy, speed: q.coords.speed, at: Date.now() };
          store.set('dm_lastpos', pos);
          posEl.textContent = fmtPos(pos); updEl.textContent = updates + ' (watching for 60 seconds)';
        }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
        setTimeout(() => { stop(); updEl.textContent = updates + ' in 60 seconds' + (updates > 3 ? ' — live updates work' : ''); }, 60000);
      }).catch((e) => { st.textContent = 'No location: ' + e.message + '.'; st.className = 'msg err'; });
    };
    return h('div', { class: 'card' }, h('h2', { text: 'Location' }),
      h('p', { text: 'Checks whether the car shares its GPS position with this site. Your position stays on this screen — it’s only used to center the traffic map.' }),
      h('button', { class: 'btn ghost', type: 'button', text: 'Test my location', onclick: run }), out, st);
  }

  /* =====================================================================
     Router
     ===================================================================== */
  const view = $('view');
  let currentKey = null, sawAppView = false;
  const cache = new Map(); // key -> {node, y, at}
  function invalidate(prefix) { if (!prefix) cache.clear(); else [...cache.keys()].forEach((k) => k.startsWith(prefix) && cache.delete(k)); }
  function go(hash, replace) { if (replace) location.replace(hash); else location.hash = hash; }
  function parse() {
    const raw = location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/');
    return { name: parts[0] || 'home', args: parts.slice(1).map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } }), key: raw || 'home' };
  }
  const VIEWS = {};
  VIEWS.podcasts = podcastsView;
  function route() {
    const r = parse();
    if (r.name === 'watch') {
      if (currentKey === null) render({ name: 'home', args: [], key: 'home' });
      openWatch(r.args);
      return;
    }
    sawAppView = true;
    document.body.classList.toggle('remote-mode', r.name === 'remote');
    if (r.name === 'remote') dismissGate();
    if (playerOpen) closeWatch();
    if (r.key !== currentKey) render(r);
  }
  function render(r) {
    if (currentKey !== null) { const c = cache.get(currentKey); if (c) c.y = window.scrollY; }
    currentKey = r.key;
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on',
      a.dataset.tab === r.name || (r.name === 'library' && a.dataset.tab === (r.args[1] === 'show' ? 'tv' : 'movies'))));
    const hit = cache.get(r.key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
      view.replaceChildren(hit.node);
      requestAnimationFrame(() => window.scrollTo(0, hit.y || 0));
      return;
    }
    const node = h('div');
    view.replaceChildren(node);
    window.scrollTo(0, 0);
    const fn = VIEWS[r.name] || VIEWS.home;
    const TITLES = { home: '', movies: 'Movies', tv: 'TV Shows', library: 'Library', live: 'Live TV', iptv: 'IPTV', youtube: 'YouTube',
      radio: 'Radio', traffic: 'Traffic', remote: 'Remote', search: 'Search', settings: 'Settings', signin: 'Sign in', profiles: 'Who’s watching', item: '' };
    document.title = (TITLES[r.name] ? TITLES[r.name] + ' · ' : '') + 'Nate’s Theater';
    if (!['settings', 'signin', 'profiles', 'remote'].includes(r.name)) cache.set(r.key, { node, y: 0, at: Date.now() });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    try { fn(node, r.args); } catch (e) { node.appendChild(msg('Something went wrong on this page: ' + e.message, true)); }
  }
  window.addEventListener('hashchange', route);
  function updateMe() {
    // Always a clear gear; the Plex profile shows as a small badge on it.
    const me = $('meBtn');
    me.replaceChildren(h('span', { class: 'gear', text: '⚙' }));
    if (plex.user) {
      const badge = h('span', { class: 'mebadge' });
      if (plex.user.thumb && okUrl(plex.user.thumb)) badge.appendChild(h('img', { src: plex.user.thumb, alt: '' }));
      else badge.textContent = (plex.user.name || '?').charAt(0).toUpperCase();
      me.appendChild(badge);
    }
    me.title = 'Settings' + (plex.user ? ' · watching as ' + plex.user.name : '');
  }

  /* ---------- Home ---------- */
  VIEWS.home = (root) => {
    const hero = h('div'); root.appendChild(hero);
    const rows = h('div'); root.appendChild(rows);
    const slot = () => { const s = h('div'); rows.appendChild(s); return s; };
    const sCW = slot(), sPlex = slot(), sFav = slot(), sLive = slot(), sYT = slot(), sRadio = slot(), sPod = slot();
    const podCont = podInProgress();
    if (podCont.length) { const r = row('Continue listening', '#/podcasts'); podCont.forEach((ep) => r.scroller.appendChild(podEpCard(ep))); sPod.appendChild(r.sec); }

    if (!plex.auth) {
      hero.appendChild(h('section', { class: 'hero' }, h('div', { class: 'bg', style: { background: 'radial-gradient(circle at 75% 30%, #3a1f2a, #0c0d10 60%)' } }),
        h('div', { class: 'in' }, h('div', { class: 'kicker', text: 'Plex' }), h('h1', { text: 'Your movies and shows, in the car' }),
          h('p', { text: 'Sign in with Plex to bring your whole library here — Continue Watching, posters, resume where you left off.' }),
          h('div', { class: 'btns' }, h('a', { class: 'btn', href: '#/signin', text: 'Sign in with Plex' }), h('a', { class: 'btn ghost', href: '#/live', text: 'Watch Live TV' })))));
    } else {
      sPlex.appendChild(msg('Connecting to your Plex server…'));
      ensurePlex().then(() => Promise.all([
        pget('/library/onDeck?X-Plex-Container-Start=0&X-Plex-Container-Size=20').catch(() => ({})),
        getSections()
      ])).then(([od, secs]) => {
        sPlex.replaceChildren();
        const deck = (MC(od).Metadata || []).filter((m) => m.type === 'movie' || m.type === 'episode');
        const heroItem = deck[0];
        if (deck.length) {
          const r = row('Continue Watching');
          deck.forEach((m) => r.scroller.appendChild(plexCard(m, 'cw')));
          sCW.appendChild(r.sec);
        }
        secs.forEach((sec) => {
          const r = row('Recently added · ' + sec.title, '#/library/' + sec.key + '/' + sec.type);
          sPlex.appendChild(r.sec);
          pget(`/library/sections/${sec.key}/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=24`).then((d) => {
            const seen = new Set();
            (MC(d).Metadata || []).forEach((m) => {
              const showKey = m.type === 'episode' ? m.grandparentRatingKey : m.type === 'season' ? m.parentRatingKey : m.ratingKey;
              if (seen.has(showKey)) return; seen.add(showKey);
              r.scroller.appendChild(plexCard(m));
            });
            if (!heroItem && !hero.firstChild) {
              const first = (MC(d).Metadata || []).find((m) => m.type === 'movie');
              if (first) hero.appendChild(heroFor(first, false));
            }
          }).catch(() => r.sec.remove());
        });
        if (heroItem) hero.appendChild(heroFor(heroItem, true));
      }).catch((e) => {
        sPlex.replaceChildren(msg('Plex: ' + e.message, true), h('div', { class: 'pad' }, h('a', { class: 'btn ghost', href: '#/settings', text: 'Plex settings' })));
      });
    }

    const f = favs();
    if (f.length) { const r = row('Your channels', '#/live/fav'); f.slice(0, 20).forEach((ch) => r.scroller.appendChild(channelCard(ch))); sFav.appendChild(r.sec); }
    { const r = row('Live TV', '#/live'); VERIFIED.slice(0, 16).forEach((ch) => r.scroller.appendChild(channelCard(ch))); sLive.appendChild(r.sec); }
    {
      const q = store.get('dm_yt_lastq', '') || YT_CHIPS[0][1];
      ytSearch(q, 16).then((res) => {
        if (!res.length) return;
        const r = row('YouTube', '#/youtube'); res.forEach((x) => r.scroller.appendChild(ytCard(x))); sYT.appendChild(r.sec);
      }).catch(() => {});
    }
    if (radioFavs().length) {
      const r = row('Your radio stations', '#/radio/US/' + enc('★'));
      radioFavs().slice(0, 20).forEach((st) => r.scroller.appendChild(stationCard(st))); sRadio.appendChild(r.sec);
    }
    radioSearch({ countrycode: 'US', limit: '24' }).then((list) => {
      if (!list.length) return;
      const r = row('Popular radio', '#/radio'); list.forEach((st) => r.scroller.appendChild(stationCard(st))); sRadio.appendChild(r.sec);
      const t = row('Talk & news radio', '#/radio/US/talk'); sRadio.appendChild(t.sec);
      radioSearch({ countrycode: 'US', tag: 'talk', limit: '20' })
        .then((l2) => { if (!l2.length) t.sec.remove(); l2.forEach((st) => t.scroller.appendChild(stationCard(st))); }).catch(() => t.sec.remove());
    }).catch(() => {});
  };
  function heroFor(m, resume) {
    const isEp = m.type === 'episode';
    const title = isEp ? m.grandparentTitle : m.title;
    const art = pimg(m.art || m.grandparentArt || m.thumb, 1600, 900);
    const sub = isEp ? `${epCode(m)} — ${m.title}` : [m.year, m.duration ? fmtMin(m.duration) : ''].filter(Boolean).join(' · ');
    const left = resume && m.viewOffset && m.duration ? fmtMin(m.duration - m.viewOffset) + ' left' : '';
    return h('section', { class: 'hero' }, h('div', { class: 'bg', style: { backgroundImage: art ? `url("${art}")` : 'none' } }),
      h('div', { class: 'in' },
        h('div', { class: 'kicker', text: resume ? 'Continue watching' : 'Just added' }),
        h('h1', { text: title || '' }),
        h('div', { class: 'meta' }, h('span', { text: sub }), left ? h('span', { text: left }) : null),
        m.summary ? h('p', { text: m.summary }) : null,
        h('div', { class: 'btns' },
          h('a', { class: 'btn', href: '#/watch/plex/' + m.ratingKey, text: resume ? '▶  Resume' : '▶  Play' }),
          h('a', { class: 'btn ghost', href: '#/item/' + (isEp ? m.grandparentRatingKey : m.ratingKey), text: 'More info' }))));
  }

  /* ---------- Movies / TV library ---------- */
  function libraryOfType(type) {
    return (root) => {
      root.appendChild(msg('Loading…'));
      ensurePlex().then(getSections).then((secs) => {
        const mine = secs.filter((s) => s.type === type);
        if (!mine.length) { root.replaceChildren(h('div', { class: 'empty', text: `No ${type === 'movie' ? 'movie' : 'TV'} libraries on your server.` })); return; }
        go('#/library/' + mine[0].key + '/' + type, true);
      }).catch((e) => root.replaceChildren(signinOrError(e)));
    };
  }
  VIEWS.movies = libraryOfType('movie');
  VIEWS.tv = libraryOfType('show');
  const SORTS = [{ id: 'addedAt:desc', label: 'Recently added' }, { id: 'titleSort', label: 'A–Z' },
    { id: 'originallyAvailableAt:desc', label: 'Newest' }, { id: 'rating:desc', label: 'Top rated' }, { id: 'unwatched', label: 'Unwatched' }];
  VIEWS.library = (root, [key, type, sort]) => {
    sort = sort || 'addedAt:desc';
    root.appendChild(msg('Loading…'));
    ensurePlex().then(getSections).then((secs) => {
      const sec = secs.find((s) => String(s.key) === String(key));
      if (!sec) throw new Error('that library is not on this server.');
      const same = secs.filter((s) => s.type === sec.type);
      root.replaceChildren(...[
        h('div', { class: 'page-h' }, h('h1', { text: sec.title })),
        same.length > 1 ? chips(same.map((s) => ({ id: String(s.key), label: s.title })), String(key), (c) => `#/library/${c.id}/${type}`) : null,
        chips(SORTS, sort, (c) => `#/library/${key}/${type}/${c.id}`)].filter(Boolean));
      const grid = h('div', { class: 'grid posters' }); root.appendChild(grid);
      const status = msg(''); root.appendChild(status);
      const moreWrap = h('div', { class: 'more' }); root.appendChild(moreWrap);
      let start = 0, total = Infinity, busy = false;
      const PAGE = 60;
      const qsort = sort === 'unwatched' ? 'unwatched=1&sort=addedAt:desc' : 'sort=' + enc(sort);
      function more(upTo) {
        if (busy || start >= total) return Promise.resolve();
        busy = true; status.textContent = start ? 'Loading…' : '';
        const sk = start ? [] : skeletons(18, false); sk.forEach((x) => grid.appendChild(x));
        const size = upTo && upTo + PAGE > start + PAGE ? upTo + PAGE - start : PAGE;
        return pget(`/library/sections/${key}/all?${qsort}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`).then((d) => {
          sk.forEach((x) => x.remove());
          const mc = MC(d);
          total = mc.totalSize != null ? mc.totalSize : (mc.size < PAGE ? start + (mc.size || 0) : Infinity);
          (mc.Metadata || []).forEach((m) => grid.appendChild(plexCard(m)));
          start += (mc.Metadata || []).length || size;
          status.textContent = start >= total ? '' : '';
          if (!(mc.Metadata || []).length) total = start;
          moreWrap.replaceChildren(start < total ? h('button', { class: 'btn ghost', type: 'button', text: 'Load more', onclick: more }) : null);
        }).catch((e) => { status.textContent = 'Could not load: ' + e.message; status.className = 'msg err'; })
          .finally(() => { busy = false; });
      }
      more();
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) more(); }, { rootMargin: '900px' }).observe(moreWrap);
      }
      // A–Z: a letter bar on the right, like the Plex app. Tap a letter to
      // jump to where it starts (loading the titles up to there first).
      if (sort === 'titleSort') {
        pget(`/library/sections/${key}/firstCharacter?sort=titleSort`).then((d) => {
          const dirs = MC(d).Directory || [];
          if (!dirs.length) return;
          let at = 0;
          const pos = {};
          dirs.forEach((x) => { pos[x.title] = { at, n: +x.size || 0 }; at += +x.size || 0; });
          const letters = ['#'].concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
          const jump = (L) => {
            const p = pos[L]; if (!p || !p.n) return;
            const go2 = () => {
              const cards = grid.querySelectorAll('.pc');
              const el = cards[p.at];
              if (!el) return false;
              const navH = (document.querySelector('.nav') || { offsetHeight: 0 }).offsetHeight;
              const top = el.getBoundingClientRect().top + window.scrollY - navH - 14;
              window.scrollTo({ top, behavior: Math.abs(top - window.scrollY) < window.innerHeight * 2 ? 'smooth' : 'auto' });
              // posters above may still be settling: check once more
              setTimeout(() => { const t2 = el.getBoundingClientRect().top + window.scrollY - navH - 14; if (Math.abs(t2 - window.scrollY) > 40) window.scrollTo(0, t2); }, 450);
              return true;
            };
            if (go2()) return;
            const wait = () => busy ? setTimeout(wait, 150) : more(p.at).then(go2);
            wait();
          };
          root.appendChild(h('div', { class: 'azbar', role: 'navigation', 'aria-label': 'Jump to letter' },
            letters.map((L) => h('button', { type: 'button', text: L, class: pos[L] && pos[L].n ? '' : 'off', onclick: () => jump(L) }))));
        }).catch(() => {});
      }
    }).catch((e) => root.replaceChildren(signinOrError(e)));
  };
  function signinOrError(e) {
    if (e && e.signin) {
      return h('div', { class: 'center-card' }, h('h1', { text: 'Sign in to Plex' }),
        h('p', { text: 'Your movies and shows come from your own Plex server.' }),
        h('a', { class: 'btn red', href: '#/signin', text: 'Sign in with Plex' }));
    }
    return h('div', {}, msg('Plex: ' + (e && e.message), true), h('div', { class: 'pad' }, h('a', { class: 'btn ghost', href: '#/settings', text: 'Plex settings' })));
  }

  /* ---------- Details ---------- */
  VIEWS.item = (root, [rk, seasonPick]) => {
    root.appendChild(msg('Loading…'));
    pget(`/library/metadata/${rk}?includeOnDeck=1`).then((d) => {
      const m = (MC(d).Metadata || [])[0];
      if (!m) throw new Error('not found on the server.');
      root.replaceChildren();
      const isShow = m.type === 'show', isEp = m.type === 'episode', isSeason = m.type === 'season';
      if (isSeason) { go('#/item/' + m.parentRatingKey + '/' + m.ratingKey, true); return; }
      const art = pimg(m.art || m.grandparentArt, 1600, 900);
      const poster = pimg(isEp ? (m.grandparentThumb || m.thumb) : m.thumb, 420, 630);
      const metaBits = [];
      if (m.year) metaBits.push(h('span', { text: String(m.year) }));
      if (m.contentRating) metaBits.push(h('span', { class: 'cr', text: m.contentRating }));
      if (m.duration && !isShow) metaBits.push(h('span', { text: fmtMin(m.duration) }));
      if (isShow && m.childCount) metaBits.push(h('span', { text: m.childCount + (m.childCount === 1 ? ' season' : ' seasons') }));
      if (m.audienceRating || m.rating) metaBits.push(h('span', { text: '★ ' + (m.audienceRating || m.rating) }));
      (m.Genre || []).slice(0, 3).forEach((g) => metaBits.push(h('span', { text: g.tag })));
      const btns = h('div', { class: 'btns' });
      if (!isShow) {
        const canResume = m.viewOffset > 30000 && m.duration && m.viewOffset < m.duration - 60000;
        btns.appendChild(h('a', { class: 'btn', href: '#/watch/plex/' + m.ratingKey + (canResume ? '' : '/0'),
          text: canResume ? '▶  Resume · ' + E.fmt(m.viewOffset / 1000) : '▶  Play' }));
        if (canResume) btns.appendChild(h('a', { class: 'btn ghost', href: '#/watch/plex/' + m.ratingKey + '/0', text: 'Play from start' }));
        if (isEp) btns.appendChild(h('a', { class: 'btn ghost', href: '#/item/' + m.grandparentRatingKey, text: 'All episodes' }));
      }
      const deckEp = isShow && m.OnDeck && m.OnDeck.Metadata ? m.OnDeck.Metadata : null;
      if (isShow && deckEp) btns.appendChild(h('a', { class: 'btn', href: '#/watch/plex/' + deckEp.ratingKey,
        text: (deckEp.viewOffset ? '▶  Resume ' : '▶  Play ') + epCode(deckEp).replace(' · ', '') }));
      root.appendChild(h('section', { class: 'hero det' }, h('div', { class: 'bg', style: { backgroundImage: art ? `url("${art}")` : 'none' } }),
        h('div', { class: 'det-in' },
          poster ? h('div', { class: 'poster' }, h('img', { src: poster, alt: '' })) : null,
          h('div', { class: 'info' },
            isEp ? h('div', { class: 'up', text: `${m.grandparentTitle} · ${epCode(m)}` }) : null,
            h('h1', { text: m.title }),
            h('div', { class: 'meta' }, metaBits),
            m.summary ? h('p', { class: 'summary', text: m.summary }) : null,
            btns,
            (m.Role || []).length ? h('div', { class: 'people', text: 'Starring ' + m.Role.slice(0, 5).map((x) => x.tag).join(', ') }) : null))));
      if (isShow) showSeasons(root, m, deckEp, seasonPick);
    }).catch((e) => root.replaceChildren(signinOrError(e)));
  };
  function showSeasons(root, show, deckEp, seasonPick) {
    const wrap = h('div'); root.appendChild(wrap);
    pget(`/library/metadata/${show.ratingKey}/children`).then((d) => {
      const seasons = (MC(d).Metadata || []).filter((s) => s.type === 'season');
      if (!seasons.length) { wrap.appendChild(msg('No episodes listed.')); return; }
      let pick = seasons.find((s) => String(s.ratingKey) === String(seasonPick));
      if (!pick && deckEp) pick = seasons.find((s) => String(s.ratingKey) === String(deckEp.parentRatingKey));
      if (!pick) pick = seasons.find((s) => (s.viewedLeafCount || 0) < (s.leafCount || 0)) || seasons[0];
      if (seasons.length > 1) {
        wrap.appendChild(h('div', { class: 'chips pad', style: { paddingTop: '18px' } }, seasons.map((s) =>
          h('a', { class: 'chip' + (s === pick ? ' on' : ''), href: '#/item/' + show.ratingKey + '/' + s.ratingKey, text: s.title }))));
      }
      const list = h('div', { class: 'eps', style: { marginTop: '14px' } }); wrap.appendChild(list);
      return pget(`/library/metadata/${pick.ratingKey}/children`).then((d2) => {
        (MC(d2).Metadata || []).forEach((ep) => {
          const p = ep.viewOffset && ep.duration ? ep.viewOffset / ep.duration : 0;
          list.appendChild(h('a', { class: 'ep', href: '#/watch/plex/' + ep.ratingKey },
            artBox(pimg(ep.thumb, 480, 270), '', [progressBar(p), ep.viewCount > 0 ? h('div', { class: 'badge seen', text: '✓' }) : null]),
            h('div', {},
              h('div', { class: 'et', text: `${ep.index != null ? ep.index + '. ' : ''}${ep.title}` }),
              h('div', { class: 'em', text: [ep.duration ? fmtMin(ep.duration) : '', ep.originallyAvailableAt || ''].filter(Boolean).join(' · ') }),
              ep.summary ? h('div', { class: 'es', text: ep.summary }) : null)));
        });
      });
    }).catch((e) => wrap.appendChild(msg('Could not load episodes: ' + e.message, true)));
  }

  /* ---------- Live TV ---------- */
  function myLists() { return store.get('dm_lists', []); }
  function myChannels() { return store.get('dm_mychans', []); }
  function liveSources() {
    const sources = [{ id: 'fav', label: '★ Favorites' }, { id: 'iptv', label: iptvCfg() ? '📡 My IPTV' : '📡 Add IPTV' }, { id: 'verified', label: 'Tested channels' }];
    if (myChannels().length) sources.push({ id: 'mine', label: 'My channels' });
    myLists().forEach((l, i) => sources.push({ id: 'list' + i, label: l.name }));
    REGIONS.forEach(([cc, name]) => sources.push({ id: 'cc-' + cc, label: name }));
    return sources;
  }
  VIEWS.live = (root, [src, cat, q]) => {
    src = src || (favs().length ? 'fav' : 'verified');
    if (src === 'iptv') { root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'Live TV' })));
      root.appendChild(chips(liveSources(), 'iptv', (c) => '#/live/' + c.id)); iptvBody(root, cat, q); return; }
    const sources = liveSources();
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'Live TV' }), h('a', { class: 'btn ghost', href: '#/settings', text: '+ Add your own list' })));
    root.appendChild(chips(sources, src, (c) => '#/live/' + c.id));
    const body = h('div'); root.appendChild(body);
    let p;
    if (src === 'fav') p = Promise.resolve(favs());
    else if (src === 'verified') p = Promise.resolve(VERIFIED);
    else if (src === 'mine') p = Promise.resolve(myChannels());
    else if (src.startsWith('list')) { const l = myLists()[+src.slice(4)]; p = l ? loadM3U(l.url) : Promise.reject(new Error('that list was removed.')); }
    else if (src.startsWith('cc-')) {
      const cc = src.slice(3);
      const note = h('div'); body.appendChild(note);
      p = E.fetchRead('channels/checked-' + cc + '.json', 'json', 10000).then((d) => {
        const when = d.checked ? new Date(d.checked).toLocaleDateString() : '';
        note.appendChild(h('div', { class: 'msg' }, `${d.ok} English-language channels that passed a playback check on ${when}.`));
        return (d.channels || []).map((c) => ({ name: c.name, cat: c.cat, url: c.url, logo: c.logo || '' }));
      }).catch(() => {
        note.appendChild(msg('Community-maintained channel list (iptv-org), not checked yet — some channels won’t play here; those show an error, just try another.'));
        return loadM3U('https://iptv-org.github.io/iptv/countries/' + cc + '.m3u');
      });
    } else if (src.startsWith('all-')) {
      body.appendChild(msg('All channels in this region’s community list, unchecked — many won’t play (dead links, region locks, formats the player can’t decode).'));
      p = loadM3U('https://iptv-org.github.io/iptv/countries/' + src.slice(4) + '.m3u');
    } else p = Promise.resolve([]);
    const loading = msg('Loading channels…'); body.appendChild(loading);
    p.then((list) => {
      loading.remove();
      if (!list.length) { body.appendChild(h('div', { class: 'empty', text: src === 'fav' ? 'No favorites yet — tap ☆ on any channel to add it here.' : 'No channels in this list.' })); return; }
      const cats = [...new Set(list.map((c) => c.cat || 'Other'))];
      if (cats.length > 1 && list.length > 12) {
        body.appendChild(chips([{ id: '', label: 'All' }].concat(cats.map((c) => ({ id: c, label: c }))), cat || '', (c) => '#/live/' + src + (c.id ? '/' + enc(c.id) : '')));
      }
      const shown = sortByHealth(cat ? list.filter((c) => (c.cat || 'Other') === cat) : list);
      const grid = h('div', { class: 'grid wide' }); body.appendChild(grid);
      let i = 0;
      const step = () => { shown.slice(i, i + 60).forEach((ch) => grid.appendChild(channelCard(ch))); i += 60; btn.hidden = i >= shown.length; };
      const btn = h('button', { class: 'btn ghost', type: 'button', text: 'Show more', onclick: step });
      body.appendChild(h('div', { class: 'more' }, btn));
      step();
    }).catch((e) => { loading.remove(); body.appendChild(msg('Could not load that list: ' + e.message, true)); });
  };

  /* ---------- YouTube ---------- */
  VIEWS.youtube = (root, [q]) => {
    const input = h('input', { type: 'text', placeholder: 'Search YouTube or paste a link', value: q || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const submit = () => {
      const v = input.value.trim(); if (!v) return;
      const id = ytIdFrom(v);
      if (id) go('#/watch/yt/' + enc(id) + '/' + enc('YouTube video'));
      else go('#/youtube/' + enc(v));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'YouTube' })));
    root.appendChild(h('div', { class: 'pad' }, h('div', { class: 'field' }, input, h('button', { class: 'btn red', type: 'button', text: 'Search', onclick: submit }))));
    root.appendChild(chips(YT_CHIPS.map(([l, v]) => ({ id: v, label: l })), q || '', (c) => '#/youtube/' + enc(c.id)));
    const body = h('div'); root.appendChild(body);
    const query = q || store.get('dm_yt_lastq', '') || YT_CHIPS[0][1];
    if (q) store.set('dm_yt_lastq', q);
    body.appendChild(msg('Loading…'));
    ytSearch(query, 30).then((res) => {
      body.replaceChildren();
      if (!res.length) { body.appendChild(h('div', { class: 'empty', text: 'No results.' })); return; }
      const grid = h('div', { class: 'grid wide' }); res.forEach((r) => grid.appendChild(ytCard(r))); body.appendChild(grid);
    }).catch((e) => body.replaceChildren(msg('The YouTube helper at home isn’t answering (' + e.message + '). Its address is in Settings.', true)));
  };

  /* ---------- IPTV ---------- */
  VIEWS.iptv = (root, [cat, q]) => { go('#/live/iptv' + (cat ? '/' + enc(cat) : '') + (q ? '/' + enc(q) : ''), true); };
  function iptvBody(root, cat, q) {
    if (!iptvCfg()) {
      root.appendChild(iptvSetupCard(() => { currentKey = null; render(parse()); }));
      return;
    }
    const search = h('input', { type: 'text', value: q || '', placeholder: 'Find a channel', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const catSel = h('select', {});
    const doFilter = () => go('#/live/iptv/' + enc(catSel.value) + (search.value.trim() ? '/' + enc(search.value.trim()) : ''), true);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFilter(); });
    catSel.addEventListener('change', doFilter);
    root.appendChild(h('div', { class: 'pad', style: { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' } },
      h('button', { class: 'btn ghost', type: 'button', text: 'Refresh list', onclick: () => { iptvData = null; invalidate('live/iptv'); currentKey = null; render(parse()); } }),
      h('a', { class: 'btn ghost', href: '#/settings', text: 'Provider settings' })));
    root.appendChild(h('div', { class: 'pad' }, h('div', { class: 'field' }, catSel, search, h('button', { class: 'btn red', type: 'button', text: 'Search', onclick: doFilter }))));
    const body = h('div'); root.appendChild(body);
    const loading = msg('Loading your channels — big lists can take a moment…'); body.appendChild(loading);
    loadIptv().then((d) => {
      loading.remove();
      catSel.replaceChildren(h('option', { value: '', text: `All channels (${d.channels.length})` }), h('option', { value: '★', text: '★ Favorites' }),
        d.cats.map((c) => h('option', { value: c, text: c })));
      catSel.value = cat || '';
      let list = sortByHealth(d.channels);
      if (cat === '★') { const fav = new Set(favs().map((f) => f.url)); list = list.filter((c) => fav.has(c.url)); }
      else if (cat) list = list.filter((c) => (c.cat || 'Other') === cat);
      if (q) { const ql = q.toLowerCase(); list = list.filter((c) => c.name.toLowerCase().includes(ql)); }
      if (!list.length) { body.appendChild(h('div', { class: 'empty', text: cat === '★' ? 'No favorites yet — tap ☆ on a channel.' : 'No channels match.' })); return; }
      body.appendChild(msg(`${list.length} channels`));
      const grid = h('div', { class: 'grid wide' }); body.appendChild(grid);
      let i = 0;
      const btn = h('button', { class: 'btn ghost', type: 'button', text: 'Show more' });
      const step = () => { list.slice(i, i + 60).forEach((ch) => grid.appendChild(channelCard(ch))); i += 60; btn.hidden = i >= list.length; };
      btn.addEventListener('click', step);
      const more = h('div', { class: 'more' }, btn); body.appendChild(more);
      step();
      if ('IntersectionObserver' in window) new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting) && !btn.hidden) step(); }, { rootMargin: '900px' }).observe(more);
    }).catch((e) => { loading.remove(); body.appendChild(msg('Could not load your channels: ' + e.message, true)); });
  }


  /* ---------- Traffic (Waze live map) ---------- */
  function wazeEmbed(lat, lon, zoom) {
    return `https://embed.waze.com/iframe?zoom=${zoom}&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&pin=1&ct=livemap`;
  }
  VIEWS.traffic = (root) => {
    const note = h('div', { class: 'msg', style: { padding: '8px 0 0' } });
    const frame = h('iframe', { class: 'wazeframe', title: 'Waze live traffic map', loading: 'eager', referrerpolicy: 'no-referrer',
      allow: 'geolocation' });
    const show = (p, zoom, label) => { frame.src = wazeEmbed(p.lat, p.lon, zoom); note.textContent = label; };
    const centre = () => {
      note.textContent = 'Finding the car…';
      getPosition(12000).then((p) => show(p, 14, 'Centered on the car · live traffic, police, hazards and accidents from Waze drivers.'))
        .catch((e) => {
          const last = store.get('dm_lastpos', null);
          if (last) show(last, 13, `Showing the last known position (${new Date(last.at).toLocaleString()}) — ${e.message}.`);
          else show({ lat: 39.5, lon: -98.35 }, 4, 'Couldn’t get the car’s location (' + e.message + '). Drag and zoom the map to your area.');
        });
    };
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'Traffic' }),
      h('div', { class: 'btns' },
        h('button', { class: 'btn ghost', type: 'button', text: '◎ Center on car', onclick: centre }),
        h('a', { class: 'btn ghost', href: 'https://www.waze.com/live-map/', target: '_blank', rel: 'noopener', text: 'Open Waze live map' }))));
    root.appendChild(h('div', { class: 'pad' }, note, frame));
    const last = store.get('dm_lastpos', null);
    if (last) show(last, 13, 'Showing the last known position while finding the car…');
    centre();
  };

  /* ---------- Radio ---------- */
  VIEWS.radio = (root, [cc, tag, q]) => {
    cc = 'US'; // US stations only
    tag = tag || ''; q = q || '';
    const href = (c, t, s) => '#/radio/' + c + '/' + enc(t || '') + (s ? '/' + enc(s) : '');
    const input = h('input', { type: 'text', value: q, placeholder: 'Find a station (name, city, show…)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const doSearch = () => go(href(cc, tag === '★' ? '' : tag, input.value.trim()));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'Radio' }), h('span', { class: 'msg', style: { padding: '0' }, text: 'US stations' })));
    root.appendChild(h('div', { class: 'pad' }, h('div', { class: 'field' }, input, h('button', { class: 'btn red', type: 'button', text: 'Search', onclick: doSearch }))));
    root.appendChild(chips([{ id: '', label: 'Popular' }, { id: '★', label: '★ Your stations' }].concat(RADIO_TAGS.map(([id, label]) => ({ id, label }))),
      tag, (c) => href(cc, c.id, '')));
    const body = h('div'); root.appendChild(body);
    if (tag === '★') {
      const f = radioFavs();
      if (!f.length) { body.appendChild(h('div', { class: 'empty', text: 'No saved stations yet — tap ☆ on any station to keep it here.' })); return; }
      const grid = h('div', { class: 'grid wide' }); f.forEach((st) => grid.appendChild(stationCard(st))); body.appendChild(grid);
      return;
    }
    const grid = h('div', { class: 'grid wide' }); body.appendChild(grid);
    const status = msg(''); body.appendChild(status);
    const btn = h('button', { class: 'btn ghost', type: 'button', text: 'More stations' });
    body.appendChild(h('div', { class: 'more' }, btn));
    let offset = 0, busy = false;
    const params = {};
    if (cc !== 'ALL') params.countrycode = cc;
    if (tag) params.tag = tag;
    if (q) params.name = q;
    const page = () => {
      if (busy) return; busy = true;
      if (!offset) grid.replaceChildren(...skeletons(12, true));
      status.textContent = offset ? 'Loading more…' : '';
      radioSearch(Object.assign({ limit: '60', offset: String(offset) }, params)).then((list) => {
        if (!offset) grid.replaceChildren();
        list.forEach((st) => grid.appendChild(stationCard(st)));
        offset += 60;
        btn.hidden = list.length < 30;
        status.textContent = !grid.children.length ? 'No stations found — try another genre or country.' : '';
      }).catch((e) => { if (!offset) grid.replaceChildren(); status.textContent = 'Could not load stations: ' + e.message; status.className = 'msg err'; })
        .finally(() => { busy = false; });
    };
    btn.addEventListener('click', page);
    page();
  };

  /* ---------- Search ---------- */
  VIEWS.search = (root, [q]) => {
    q = q || '';
    const box = h('input', { type: 'search', value: q, placeholder: 'Search movies, shows, channels, YouTube, radio', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const doSearch = () => { const v = box.value.trim(); if (v) go('#/search/' + enc(v)); };
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: q ? `Results for “${q}”` : 'Search' })));
    root.appendChild(h('div', { class: 'pad' }, h('div', { class: 'field' }, box, h('button', { class: 'btn red', type: 'button', text: 'Search', onclick: doSearch }))));
    if (!q) { setTimeout(() => box.focus(), 50); return; }
    const slots = [h('div'), h('div'), h('div'), h('div')]; slots.forEach((s) => root.appendChild(s));
    const ql = q.toLowerCase();
    let any = false;
    const none = msg('Searching…'); root.appendChild(none);
    const done = [];
    if (plex.auth) {
      done.push(pget('/hubs/search?query=' + enc(q) + '&limit=20').then((d) => {
        (MC(d).Hub || []).forEach((hub) => {
          const items = (hub.Metadata || []).filter((m) => ['movie', 'show', 'episode'].includes(m.type));
          if (!items.length) return;
          any = true;
          const r = row(hub.title || 'Plex');
          items.forEach((m) => r.scroller.appendChild(plexCard(m)));
          slots[0].appendChild(r.sec);
        });
      }).catch(() => {}));
    }
    const chans = favs().concat(myChannels(), VERIFIED).filter((c, i, a) => a.findIndex((x) => x.url === c.url) === i)
      .filter((c) => (c.name + ' ' + (c.cat || '')).toLowerCase().includes(ql));
    if (chans.length) { any = true; const r = row('Live TV'); chans.forEach((c) => r.scroller.appendChild(channelCard(c))); slots[1].appendChild(r.sec); }
    if (iptvCfg()) {
      done.push(loadIptv().then((d) => {
        const hits = d.channels.filter((c) => c.name.toLowerCase().includes(ql)).slice(0, 40);
        if (!hits.length) return; any = true;
        const r = row('IPTV', '#/live/iptv//' + enc(q)); hits.forEach((c) => r.scroller.appendChild(channelCard(c))); slots[1].appendChild(r.sec);
      }).catch(() => {}));
    }
    done.push(ytSearch(q, 16).then((res) => {
      if (!res.length) return; any = true;
      const r = row('YouTube', '#/youtube/' + enc(q)); res.forEach((x) => r.scroller.appendChild(ytCard(x))); slots[2].appendChild(r.sec);
    }).catch(() => {}));
    done.push(radioSearch({ name: q, countrycode: 'US', limit: '16' }).then((list) => {
      if (!list.length) return; any = true;
      const r = row('Radio'); list.forEach((st) => r.scroller.appendChild(stationCard(st))); slots[3].appendChild(r.sec);
    }).catch(() => {}));
    Promise.all(done).then(() => { none.remove(); if (!any) root.appendChild(h('div', { class: 'empty', text: 'Nothing found.' })); });
  };

  /* ---------- Sign-in & profiles ---------- */
  VIEWS.signin = (root) => {
    const st = msg('');
    const say = (t, err) => { st.textContent = t; st.className = 'msg' + (err ? ' err' : ''); };
    root.appendChild(h('div', { class: 'center-card' },
      h('h1', { text: 'Sign in with Plex' }),
      h('p', { text: 'Same as any Plex app: you’ll go to Plex’s own sign-in page and come right back. Your server is found automatically.' }),
      h('button', { class: 'btn red', type: 'button', text: 'Continue to Plex', onclick: () => startSignin(say) }), st));
  };
  VIEWS.profiles = (root) => {
    if (!plex.auth) {
      const p = store.get('dm_plex_pin', null);
      root.appendChild(h('div', { class: 'center-card' }, h('h1', { text: p ? 'Finishing sign-in…' : 'Not signed in' }),
        p ? h('div', { class: 'spin', style: { margin: '30px auto' } }) : h('a', { class: 'btn red', href: '#/signin', text: 'Sign in with Plex' })));
      return;
    }
    const card = h('div', { class: 'center-card', style: { maxWidth: '900px' } }, h('h1', { text: 'Who’s watching?' }));
    const st = msg('Loading profiles…'); const grid = h('div', { class: 'users' });
    const pinRow = h('div', { hidden: true });
    card.append(grid, pinRow, st); root.appendChild(card);
    const finish = () => { invalidate(); updateMe(); toast('Watching as ' + plex.user.name); go('#/home', true); };
    const choose = (u, name, pin) => {
      st.textContent = `Switching to ${name}…`; st.className = 'msg';
      plexTv('/api/v2/home/users/' + enc(u.uuid || u.id) + '/switch' + (pin ? '?pin=' + enc(pin) : ''), 'POST', plex.auth.token).then((d) => {
        const tok = d && (d.authToken || d.authenticationToken);
        if (!tok) throw new Error('Plex did not hand back a profile token.');
        plex.user = { id: u.uuid || u.id, name, token: tok, thumb: u.thumb || '' };
        store.set('dm_plex_user', plex.user);
        plex.conn = null; plex.sections = null; store.set('dm_plex_conn', null); // server tokens are per-profile
        finish();
      }).catch((e) => { st.textContent = pin ? 'That PIN didn’t work — try again.' : 'Could not switch: ' + e.message; st.className = 'msg err'; });
    };
    plexTv('/api/v2/home/users', 'GET', plex.auth.token).then((d) => {
      const users = Array.isArray(d) ? d : (d && d.users) || [];
      if (!users.length) throw new Error('none');
      st.textContent = '';
      users.forEach((u) => {
        const name = u.friendlyName || u.title || u.username || 'Profile';
        grid.appendChild(h('button', { class: 'user', type: 'button', onclick: () => {
          if (!u.protected) { pinRow.hidden = true; choose(u, name, ''); return; }
          const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: `PIN for ${name}` });
          const goBtn = h('button', { class: 'btn red', type: 'button', text: 'Continue', onclick: () => choose(u, name, pin.value.trim()) });
          pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') goBtn.click(); });
          pinRow.replaceChildren(h('div', { class: 'field', style: { maxWidth: '460px', margin: '0 auto' } }, pin, goBtn),
            h('p', { text: 'The PIN goes straight to Plex — it isn’t stored.' }));
          pinRow.hidden = false; pin.focus();
        } },
          h('div', { class: 'av' }, u.thumb && okUrl(u.thumb) ? h('img', { src: u.thumb, alt: '' }) : name.charAt(0).toUpperCase()),
          h('div', { class: 'un', text: name }), u.protected ? h('span', { class: 'lock', text: 'PIN' }) : null));
      });
    }).catch(() => {
      // Not a Plex Home account (or plex.tv hiccup): watch as the account itself.
      plex.user = { id: 'owner', name: 'Owner', token: plex.auth.token, thumb: '' };
      store.set('dm_plex_user', plex.user);
      finish();
    });
  };

  /* ---------- Settings ---------- */
  const QUALITIES = [
    { id: '1080', label: '1080p (8 Mbps)', res: '1920x1080', br: 8000 },
    { id: '720', label: '720p (4 Mbps)', res: '1280x720', br: 4000 },
    { id: '480', label: '480p (1.5 Mbps)', res: '854x480', br: 1500 },
    { id: '360', label: '360p (0.7 Mbps)', res: '640x360', br: 720 }
  ];
  VIEWS.settings = (root) => {
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'Settings' })));
    // Plex
    const pc = h('div', { class: 'card' }, h('h2', { text: 'Plex' }));
    if (!plex.auth) pc.append(h('p', { text: 'Not signed in.' }), h('a', { class: 'btn red', href: '#/signin', text: 'Sign in with Plex' }));
    else {
      const kv = h('div', { class: 'kv' },
        h('b', { text: 'Profile' }), h('span', { text: plex.user ? plex.user.name : '—' }),
        h('b', { text: 'Server' }), h('span', { text: plex.conn ? plex.conn.name : 'not connected yet' }),
        h('b', { text: 'Connection' }), h('span', { text: plex.conn ? (plex.conn.relay ? 'Plex relay (slow — about 2 Mbps max)' : plex.conn.local ? 'Home network' : 'Remote, direct') : '—' }));
      pc.append(kv, h('div', { class: 'btns' },
        h('a', { class: 'btn ghost', href: '#/profiles', text: 'Switch profile' }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Reconnect', onclick: (e) => {
          plex.conn = null; store.set('dm_plex_conn', null); e.currentTarget.textContent = 'Connecting…';
          ensurePlex().then(() => { invalidate(); render(parse()); toast('Connected to ' + plex.conn.name); })
            .catch((err) => toast('Could not connect: ' + err.message)).finally(() => { currentKey = null; render(parse()); });
        } }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Sign out', onclick: () => { signOut(); currentKey = null; render(parse()); toast('Signed out of Plex on this screen.'); } })));
    }
    root.appendChild(pc);
    // Quality
    const sel = h('select', { onchange: (e) => { store.set('dm_quality', e.target.value); toast('Saved.'); } },
      h('option', { value: 'auto', text: 'Automatic (starts at 720p, lowers itself on a weak signal)' }),
      QUALITIES.map((q) => h('option', { value: q.id, text: q.label })));
    sel.value = store.get('dm_quality', 'auto');
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Plex playback quality' }),
      h('p', { text: 'Lower quality uses less mobile data and is steadier on LTE. Plex converts the video on your server to fit.' }),
      h('div', { class: 'field' }, sel)));
    // Dead-zone buffer
    const ah = h('select', { onchange: (e) => { store.set('dm_ahead', +e.target.value); S.aheadMax = +e.target.value * 60; toast('Saved.'); } },
      [[0, 'Off (about 40 seconds)'], [2, '2 minutes'], [5, '5 minutes (recommended)'], [10, '10 minutes']].map(([v, t]) => h('option', { value: String(v), text: t })));
    ah.value = String(store.get('dm_ahead', 5));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Dead-zone buffer' }),
      h('p', { text: 'While the signal is good, movies, shows and YouTube download ahead so they keep playing through stretches with no signal. Live TV can only buffer a few seconds. Higher-quality video may save a bit less, to keep memory use safe.' }),
      h('div', { class: 'field' }, ah)));
    // Own lists
    const listBox = h('div');
    const drawLists = () => {
      listBox.replaceChildren();
      myLists().forEach((l, i) => listBox.appendChild(h('div', { class: 'field', style: { marginBottom: '8px' } },
        h('span', { style: { flex: '1' }, text: `${l.name} — ${l.url}` }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Remove', onclick: () => { const a = myLists(); a.splice(i, 1); store.set('dm_lists', a); invalidate('live'); drawLists(); } }))));
      myChannels().forEach((c, i) => listBox.appendChild(h('div', { class: 'field', style: { marginBottom: '8px' } },
        h('span', { style: { flex: '1' }, text: `${c.name} (channel)` }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Remove', onclick: () => { const a = myChannels(); a.splice(i, 1); store.set('dm_mychans', a); invalidate('live'); drawLists(); } }))));
    };
    drawLists();
    const ln = h('input', { type: 'text', placeholder: 'Name (e.g. My IPTV)' });
    const lu = h('input', { type: 'text', placeholder: 'Playlist (.m3u) or stream (.m3u8) address', autocapitalize: 'off', spellcheck: 'false' });
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Your own channels' }),
      h('p', { text: 'Add an M3U playlist (it shows up as its own tab in Live TV) or a single stream address. Streams must be HLS with MPEG-TS segments, H.264 video and AAC audio, and allow playback from other websites.' }),
      listBox,
      h('div', { class: 'field' }, ln, lu, h('button', { class: 'btn red', type: 'button', text: 'Add', onclick: () => {
        const url = lu.value.trim(), name = ln.value.trim() || 'My list';
        if (!okUrl(url)) { toast('That needs to be an https:// address.'); return; }
        if (/\.m3u8(\?|$)/i.test(url)) { const a = myChannels(); a.push({ name, url, cat: 'My channels', logo: '' }); store.set('dm_mychans', a); }
        else { const a = myLists(); a.push({ name, url }); store.set('dm_lists', a); }
        ln.value = lu.value = ''; invalidate('live'); drawLists(); toast('Added — find it under Live TV.');
      } }))));
    root.appendChild(iptvSetupCard());
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Phone remote' }),
      h('p', { text: 'Control the car screen from a phone in the back seat: pick what to watch, pause, skip. On the car tap 📱 at the top; on the phone open this page and enter the code.' }),
      h('div', { class: 'btns' }, h('button', { class: 'btn ghost', type: 'button', text: '📱 Show pairing code (car)', onclick: showRemotePairing }),
        h('a', { class: 'btn ghost', href: '#/remote', text: 'Use this device as the remote' }))));
    root.appendChild(locationCard());
    root.appendChild(backupCard());
    // Direct stream
    const du = h('input', { type: 'text', placeholder: 'https://example.com/stream.m3u8', autocapitalize: 'off', spellcheck: 'false' });
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Play a link' }),
      h('p', { text: 'Paste an HLS (.m3u8) address or a direct MP4 file. MP4 files download fully before they start.' }),
      h('div', { class: 'field' }, du,
        h('button', { class: 'btn red', type: 'button', text: 'Play', onclick: () => { if (du.value.trim()) go('#/watch/url/' + enc(du.value.trim())); } }),
        h('a', { class: 'btn ghost', href: '#/watch/url/' + enc('https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8'), text: 'Test stream' }))));
    // YouTube helper
    const yb = h('input', { type: 'text', value: store.get('dm_yt_base', '') || '', placeholder: YT_DEFAULT, autocapitalize: 'off', spellcheck: 'false' });
    const ys = msg('');
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: 'YouTube helper' }),
      h('p', { text: 'YouTube plays through the helper on your home NAS, which converts videos into a format this player can draw. Leave empty for the built-in address.' }),
      h('div', { class: 'field' }, yb,
        h('button', { class: 'btn ghost', type: 'button', text: 'Save & check', onclick: () => {
          store.set('dm_yt_base', yb.value.trim() || null);
          Object.keys(ytCache).forEach((k) => delete ytCache[k]);
          ys.textContent = 'Checking…'; ys.className = 'msg';
          E.fetchRead(ytBase() + '/health', 'text', 8000).then(() => { ys.textContent = 'Helper is answering.'; })
            .catch((e) => { ys.textContent = 'Helper not reachable: ' + e.message; ys.className = 'msg err'; });
        } })), ys));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: 'About' }),
      h('p', { text: 'Nate’s Theater draws the picture itself with WebCodecs on a canvas instead of using the browser’s video player — the part Tesla pauses outside Park. While the car is moving, it’s for the passenger only. DRM services (Netflix, Disney+ and similar) can’t play this way; use the car’s own apps while parked.' })));
  };

  /* =====================================================================
     Player
     ===================================================================== */
  const player = $('player');
  let playerOpen = false, watchKey = null, idleTimer = null;
  let P = null;          // current Plex session
  let restarting = false;
  function newSid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
  }

  function showUi() {
    player.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (S.playing && !S.buffering) player.classList.add('idle'); }, 3500);
  }
  player.addEventListener('pointerdown', showUi);
  player.addEventListener('mousemove', showUi);
  // Tap the picture to play or pause (buttons, the bars and the seek
  // slider keep their own jobs). A phone playing along follows the car.
  const tapFlash = h('div', { class: 'tapflash' });
  player.appendChild(tapFlash);
  player.addEventListener('click', (e) => {
    if (MIR || !S.started || S.ended || !playerOpen) return;
    if (e.target.closest('button, a, input, select, .pl-top, .pl-row, .upnext, .po-cover')) return;
    $('btnPlay').click();
    tapFlash.textContent = S.playing ? '▶' : '❚❚';
    tapFlash.classList.remove('go'); void tapFlash.offsetWidth; tapFlash.classList.add('go');
  });

  function refreshOverlay() {
    if (!playerOpen) return;
    const waiting = S.loading || S.buffering || (S.started && S.playing && !S.firstFrameAt && !S.ended);
    const err = $('status').classList.contains('err');
    $('plSpin').hidden = !waiting || err;
    $('plBig').hidden = waiting || err || !(S.loaded && (!S.started || S.ended));
    $('plBig').innerHTML = S.ended ? '&#8635;' : '&#9654;';
    $('btnBack10').hidden = $('btnFwd10').hidden = !E.canSeek();
    $('seek').disabled = !E.canSeek();
    $('plLive').hidden = !(S.isLive && !S.view) || !S.loaded;
    if (err) player.classList.remove('idle');
  }
  E.hooks.onState = refreshOverlay;
  // Dead-zone buffer setting (minutes saved ahead), and a small "saved" readout.
  const aheadMin = () => +store.get('dm_ahead', 5) || 0;
  S.aheadMax = aheadMin() * 60;
  setInterval(() => {
    S.aheadMax = aheadMin() * 60;
    const el = $('plAhead'); if (!el) return;
    const b = playerOpen && S.started ? E.bufferedAhead() : null;
    el.hidden = b == null || b < 45 || aheadMin() === 0;
    if (!el.hidden) el.textContent = '⬇ ' + E.fmt(b) + ' saved';
  }, 1000);
  E.hooks.onStreamGone = () => {
    if (MIR) { if (MIR.info.kind === 'plex') mirrorLoad(carPosNow() || 0); return; }
    if (P && playerOpen) { E.setStatus('Reconnecting to Plex…'); startPlexAt(plexPos(), true); }
  };
  let watchChannel = null;
  E.hooks.onError = (m) => {
    // Phone playing along: Plex often refuses the first stream request
    // from a device it hasn't seen yet - retry, picking up the car's spot.
    if (MIR && MIR.info.kind === 'plex' && /HTTP (400|404|409|5\d\d)|timed out|Failed to fetch/i.test(m || '') && (MIR.retries || 0) < 3) {
      MIR.retries = (MIR.retries || 0) + 1;
      E.setStatus('Getting it ready on this device…');
      S.loading = true; refreshOverlay();
      const mine = MIR;
      setTimeout(() => { if (MIR === mine) mirrorLoad(carPosNow() || 0); }, 1500 * MIR.retries);
      return;
    }
    if (watchChannel && !watchChannel.done && !S.firstFrameAt) { watchChannel.done = true; markHealth(watchChannel.url, false); }
    if (P && /HTTP (400|404|409|5\d\d)|timed out|Failed to fetch/i.test(m || '') && (P.retries || 0) < 2) {
      P.retries = (P.retries || 0) + 1;
      const off = P.offset, auto = P.wantAuto, rk = P.rk;
      E.setStatus('Plex is getting the video ready at ' + E.fmt(off) + '…');
      S.loading = true; refreshOverlay();
      setTimeout(() => { if (P && P.rk === rk && playerOpen) startPlexAt(off, auto, true); }, 1500 * P.retries);
    }
  };
  E.hooks.onFirstFrame = () => {
    if (P) P.retries = 0;
    if (MIR) MIR.retries = 0;
    if (watchChannel && !watchChannel.done) { watchChannel.done = true; markHealth(watchChannel.url, true); } $('plNote').textContent = ''; refreshOverlay(); showUi(); };

  function openPlayerShell(title, sub) {
    stopRadio();
    playerOpen = true;
    player.hidden = false;
    document.body.classList.add('playing');
    $('plTitle').textContent = title || '';
    $('plSub').textContent = sub || '';
    $('plNote').textContent = '';
    $('upNext').hidden = true;
    showUi();
  }
  /* Phones only: the movie keeps running on the car (so it still controls
     and syncs the phones), but the car screen goes dark and its sound
     is off - for when the driver doesn't want it on. */
  let phonesOnly = false;
  function setPhonesOnly(on) {
    on = !!on && playerOpen && !MIR;
    if (on === phonesOnly) return;
    phonesOnly = on;
    document.body.classList.toggle('phones-only', on);
    E.setMuted(on);
    const b = $('plPhones'); if (b) b.textContent = on ? '📺 Show here' : '📱 Phones only';
    if (typeof publishNow === 'function') publishNow(true);
  }
  function closeWatch() {
    setPhonesOnly(false);
    endPlex();
    playerOpen = false; watchKey = null; watchChannel = null;
    clearUpNext();
    E.teardown();
    player.hidden = true;
    document.body.classList.remove('playing');
    invalidate('home'); invalidate('item');
    // Return the page to the view underneath with fresh progress bars.
    const r = parse();
    if (r.name !== 'watch' && (r.key === 'home' || r.name === 'item') && currentKey === r.key) { currentKey = null; render(r); }
  }
  function wantAutoplay() {
    const ctx = E.ensureCtx();
    if (REM.autoUntil > Date.now() && ctx) { try { ctx.resume(); } catch (e) {} return true; }
    if (ctx && ctx.state === 'running') return true;
    if (recentTap() && ctx) { try { ctx.resume(); } catch (e) {} return true; }
    return false;
  }

  function openWatch(args) {
    const key = args.join('/');
    if (playerOpen && key === watchKey) return;
    watchChannel = (args[0] === 'live' || args[0] === 'iptv') ? { url: args[1], done: false } : null;
    watchKey = key;
    const [kind, a, b, c, d] = args;
    const auto = wantAutoplay();
    if (kind === 'plex') { playPlex(a, b != null && b !== '' ? +b : null, auto); return; }
    endPlex();
    if (kind === 'live') {
      openPlayerShell(b || 'Live TV', c ? 'Live TV · ' + c : 'Live TV');
      E.load(a, b); S.autoplay = auto;
    } else if (kind === 'iptv') {
      openPlayerShell(b || 'Channel', c || 'IPTV');
      const playUrl = iptvWrap(a);
      if (blockedHttp(playUrl)) {
        E.setStatus('Your provider sends http:// links, which this secure page can’t open directly. Turn on “Route through the home helper” in Settings → IPTV subscription.', true);
      } else {
        E.load(playUrl, b, { ts: isRawTs(a) }); S.autoplay = auto;
        if (d) xtreamNowNext(d).then((t) => { if (t && watchKey === key) $('plSub').textContent = (c ? c + '   ·   ' : '') + t; });
      }
    } else if (kind === 'yt') {
      openPlayerShell(b || 'YouTube', 'YouTube');
      $('plNote').textContent = 'Converting at home — the first play of a video can take a little while to start.';
      E.load(ytBase() + '/stream?v=' + enc(a), b); S.autoplay = auto;
      // A shared link has no title yet: ask YouTube for it.
      if (!b || b === 'YouTube video') {
        fetch('https://www.youtube.com/oembed?format=json&url=' + enc('https://www.youtube.com/watch?v=' + a)).then((r) => r.ok ? r.json() : null).then((d) => {
          if (d && d.title && watchKey === key) { $('plTitle').textContent = d.title; $('plSub').textContent = d.author_name || 'YouTube'; }
        }).catch(() => {});
      }
    } else if (kind === 'url') {
      openPlayerShell('Stream', a);
      E.load(a, 'stream'); S.autoplay = auto;
    } else { go('#/home', true); }
    refreshOverlay();
  }

  /* ---------- Plex playback ---------- */
  const PROFILE_EXTRA = [
    'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)',
    'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.level&value=41)',
    'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.bitDepth&value=8)',
    'add-limitation(scope=videoAudioCodec&scopeName=aac&type=upperBound&name=audio.channels&value=2)'
  ].join('+');
  function startLevel() {
    const q = store.get('dm_quality', 'auto');
    if (q !== 'auto') return q;
    return plex.conn && plex.conn.relay ? '480' : '720';
  }
  function playPlex(rk, startAt, auto) {
    endPlex();
    openPlayerShell('Loading…', '');
    E.teardown();
    S.loading = true; refreshOverlay();
    pget('/library/metadata/' + rk).then((d) => {
      const m = (MC(d).Metadata || [])[0];
      if (!m) throw new Error('that title is not on the server.');
      if (watchKey === null || !watchKey.startsWith('plex/' + rk)) return;
      let off = startAt;
      if (off == null || isNaN(off)) off = (m.viewOffset > 30000 && m.duration && m.viewOffset < m.duration - 60000) ? Math.floor(m.viewOffset / 1000) : 0;
      const isEp = m.type === 'episode';
      $('plTitle').textContent = isEp ? m.grandparentTitle : m.title;
      $('plSub').textContent = isEp ? `${epCode(m)} — ${m.title}` : (m.year ? String(m.year) : '');
      P = { rk: String(rk), meta: m, duration: (m.duration || 0) / 1000, level: startLevel(), stalls: [], sid: null, offset: off };
      startPlexAt(off, auto);
      if (off > 0) toast('Resuming at ' + E.fmt(off));
    }).catch((e) => { S.loading = false; E.setStatus('Could not start that title: ' + e.message, true); refreshOverlay(); });
  }
  function stopTranscode(sid) {
    if (!sid || !plex.conn) return;
    fetch(plex.conn.base + '/video/:/transcode/universal/stop?session=' + enc(sid) + '&' + plexQS(), { keepalive: true }).catch(() => {});
  }
  function startPlexAt(off, auto, freshSession) {
    if (!P) return;
    off = Math.max(0, Math.min(Math.floor(off), Math.max(0, Math.floor(P.duration) - 5)));
    const q = QUALITIES.find((x) => x.id === P.level) || QUALITIES[1];
    if (freshSession || !P.sid) {
      if (P.sid) stopTranscode(P.sid);
      P.sid = newSid();
    }
    P.offset = off; P.wantAuto = auto !== false;
    const conn = plex.conn;
    const url = conn.base + '/video/:/transcode/universal/start.m3u8?path=' + enc('/library/metadata/' + P.rk) +
      '&mediaIndex=0&partIndex=0&protocol=hls&fastSeek=1&copyts=1&offset=' + off +
      '&directPlay=0&directStream=1&directStreamAudio=1&subtitles=none' +
      '&videoResolution=' + q.res + '&maxVideoBitrate=' + q.br + '&videoQuality=100' +
      '&session=' + enc(P.sid) + '&X-Plex-Session-Identifier=' + enc(P.sid) +
      '&X-Plex-Client-Profile-Extra=' + enc(PROFILE_EXTRA) + '&' + plexQS(conn.token);
    restarting = true;
    E.load(url, $('plTitle').textContent);
    restarting = false;
    S.view = { offset: off, duration: P.duration };
    S.autoplay = auto !== false;
    timeline('buffering');
    refreshOverlay();
  }
  function plexPos() { return P ? E.dispPos(E.mediaNow()) : 0; }
  function timeline(state, posSec) {
    if (!P || !plex.conn) return;
    const t = Math.round((posSec != null ? posSec : plexPos()) * 1000);
    fetch(plex.conn.base + '/:/timeline?ratingKey=' + enc(P.rk) + '&key=' + enc('/library/metadata/' + P.rk) +
      '&state=' + state + '&time=' + t + '&duration=' + Math.round(P.duration * 1000) +
      '&X-Plex-Session-Identifier=' + enc(P.sid || '') + '&' + plexQS(), { keepalive: state === 'stopped' }).catch(() => {});
  }
  function endPlex() {
    if (!P) return;
    const p = P;
    if (S.started) timeline('stopped');
    stopTranscode(p.sid);
    P = null;
  }
  setInterval(() => {
    if (!P || !S.started || S.ended) return;
    timeline(S.buffering ? 'buffering' : S.playing ? 'playing' : 'paused');
  }, 10000);
  E.hooks.onTeardown = null;
  window.addEventListener('pagehide', () => { endPlex(); });

  E.hooks.onBuffering = (on) => {
    if (!on || !P || !S.firstFrameAt || performance.now() - S.firstFrameAt < 4000) return;
    const now = performance.now();
    P.stalls = P.stalls.filter((t) => now - t < 120000).concat(now);
    const idx = QUALITIES.findIndex((q) => q.id === P.level);
    if (P.stalls.length >= 3 && store.get('dm_quality', 'auto') === 'auto' && idx < QUALITIES.length - 1) {
      P.level = QUALITIES[idx + 1].id; P.stalls = [];
      toast('Weak signal — lowering quality to ' + P.level + 'p to keep playing.');
      startPlexAt(plexPos(), true);
    }
  };

  E.hooks.onSeekRequest = (pos) => {
    if (P) { timeline('paused', pos); startPlexAt(pos, S.playing || !S.started); }
    else E.seekTo(pos);
  };
  let skipTarget = null, skipTimer = null;
  function skip(delta) {
    if (!E.canSeek()) return;
    const base = skipTarget != null ? skipTarget : E.dispPos(E.mediaNow());
    skipTarget = Math.max(0, Math.min(E.dispDur() - 1, base + delta));
    $('timeLabel').textContent = E.fmt(skipTarget) + ' / ' + E.fmt(E.dispDur());
    clearTimeout(skipTimer);
    // Plex seeks restart the server's conversion, so batch quick taps.
    skipTimer = setTimeout(() => { const t = skipTarget; skipTarget = null; E.hooks.onSeekRequest(t); }, P ? 700 : 150);
    showUi();
  }
  $('btnBack10').addEventListener('click', () => skip(-10));
  $('btnFwd10').addEventListener('click', () => skip(30));
  $('btnPlay').addEventListener('click', () => {
    E.togglePlay();
    if (P && S.started) timeline(S.playing ? 'playing' : 'paused');
    showUi();
  });
  $('plBig').addEventListener('click', () => {
    if (S.ended && P) { startPlexAt(0, true); return; }
    E.togglePlay(); showUi();
  });
  $('plBack').addEventListener('click', () => { if (MIR) { mirrorStop(); return; } if (sawAppView) history.back(); else go('#/home', true); });
  $('plHome').addEventListener('click', () => { if (MIR) { mirrorStop(); return; } go('#/home'); });
  $('plPhones').addEventListener('click', () => setPhonesOnly(!phonesOnly));
  $('poShow').addEventListener('click', () => setPhonesOnly(false));
  /* Full screen: one toggle for the whole app (menu button and the
     player's button do the same thing), so browsing and watching stay
     full screen together and the two can't fight each other. */
  const root = document.documentElement;
  const fsOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  function toggleFullscreen() {
    if (fsOn()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!req) { toast('This browser doesn’t allow full screen.'); return; }
    const p = req.call(root, { navigationUI: 'hide' });
    if (p && p.catch) p.catch(() => toast('Full screen was blocked by the browser.'));
  }
  function paintFs() {
    const on = fsOn();
    $('fsAll').innerHTML = on ? '&#10006;' : '&#9974;';
    $('fsAll').title = $('fsAll').ariaLabel = on ? 'Exit full screen' : 'Full screen';
    $('btnFs').innerHTML = on ? '&#10006;' : '&#9974;';
  }
  $('fsAll').addEventListener('click', toggleFullscreen);
  $('btnFs').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', paintFs);
  document.addEventListener('webkitfullscreenchange', paintFs);
  if (!(root.requestFullscreen || root.webkitRequestFullscreen)) $('fsAll').hidden = true;
  document.addEventListener('keydown', (e) => {
    if (!playerOpen || /INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); $('btnPlay').click(); }
    else if (e.key === 'ArrowLeft') skip(-10);
    else if (e.key === 'ArrowRight') skip(30);
    else if (e.key === 'Escape' && !document.fullscreenElement) $('plBack').click();
    showUi();
  });

  /* ---------- Up next ---------- */
  let upNextTimer = null;
  function clearUpNext() { clearInterval(upNextTimer); upNextTimer = null; $('upNext').hidden = true; }
  E.hooks.onEnded = () => {
    refreshOverlay();
    if (!P) return;
    const m = P.meta;
    timeline('stopped', P.duration);
    if (m.type !== 'episode' || !m.grandparentRatingKey) return;
    pget(`/library/metadata/${m.grandparentRatingKey}/allLeaves`).then((d) => {
      const leaves = MC(d).Metadata || [];
      const i = leaves.findIndex((x) => String(x.ratingKey) === String(m.ratingKey));
      const next = i >= 0 ? leaves[i + 1] : null;
      if (!next || !playerOpen) return;
      let left = 15;
      const name = `${epCode(next)} — ${next.title}`;
      $('upNextName').textContent = name;
      $('upNextGo').textContent = `Play in ${left}`;
      $('upNext').hidden = false;
      player.classList.remove('idle');
      const goNext = () => { clearUpNext(); go('#/watch/plex/' + next.ratingKey + '/0', true); };
      $('upNextGo').onclick = goNext;
      $('upNextNo').onclick = clearUpNext;
      upNextTimer = setInterval(() => { left--; $('upNextGo').textContent = left > 0 ? `Play in ${left}` : 'Starting…'; if (left <= 0) goNext(); }, 1000);
    }).catch(() => {});
  };


  /* =====================================================================
     Phone remote. The car opens a "room" on the home helper and shows a
     QR code / 6-digit code; a phone that joins sends small commands
     (play, skip, open this…) and reads back what's playing. Messages go
     through the helper because the car (mobile data) and the phone can't
     reach each other directly.
     Data the car sends lives in named slots: "now" (small, every second
     or so), "lists" and "results" (posters, sent once), "mirror" (what
     the phone needs to play the same thing itself).
     ===================================================================== */
  const REM = { room: null, code: '', gen: 0, phoneSeenAt: 0, lastNow: '', autoUntil: 0, srvOffset: 0 };
  function remoteApi(path, opts) { return E.fetchRead(ytBase() + '/remote' + path, 'json', 30000, opts); }
  function remotePost(path, body) {
    return remoteApi(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  /* Clock alignment with the helper, used to keep a mirrored screen in
     step. Only quick round trips count (the long "wait for news" polls
     would skew it by seconds); the quickest recent sample wins. */
  let bestRtt = Infinity, bestAt = 0;
  function noteServerTime(d, t0) {
    if (!d || !d.t) return;
    const now = Date.now(), rtt = now - t0;
    if (rtt > 1500) { if (bestRtt === Infinity) REM.srvOffset = d.t - now; return; }
    if (rtt <= bestRtt || now - bestAt > 60000) { bestRtt = rtt; bestAt = now; REM.srvOffset = d.t - (t0 + now) / 2; }
  }
  function serverNow() { return Date.now() + REM.srvOffset; }
  function remoteLink(room) { return location.origin + location.pathname.replace(/(index|player)\.html$/, '') + '#/remote/' + room; }
  function postSlot(name, data) {
    if (!REM.room) return Promise.resolve();
    const t0 = Date.now();
    return remotePost('/' + REM.room + '/state/' + name, data).then((d) => noteServerTime(d, t0)).catch(() => { if (name === 'now') REM.lastNow = ''; });
  }

  // ---- car side ----
  function carRemoteStart() {
    const saved = store.get('dm_remote_car', null);
    if (saved && saved.room && Date.now() - (saved.used || saved.at) < 7.5 * 3600 * 1000) {
      REM.room = saved.room; REM.code = saved.code || '';
      carRemoteLoop();
      return Promise.resolve();
    }
    return remotePost('/new', {}).then((d) => {
      REM.room = d.room; REM.code = d.code;
      store.set('dm_remote_car', { room: d.room, code: d.code, at: Date.now() });
      carRemoteLoop();
    });
  }
  function carRemoteStop() {
    REM.gen++; REM.room = null; REM.code = ''; store.set('dm_remote_car', null);
    updateRemoteBtn();
  }
  function carRemoteLoop() {
    const gen = ++REM.gen, room = REM.room;
    updateRemoteBtn();
    const loop = () => {
      if (gen !== REM.gen) return;
      const t0 = Date.now();
      remoteApi('/' + room + '/cmds?wait=20').then((d) => {
        noteServerTime(d, t0);
        (d.cmds || []).forEach(handleRemoteCmd);
        setTimeout(loop, 50);
      }).catch((e) => {
        if (/HTTP 404/.test(e.message)) { carRemoteStop(); toast('The phone remote expired — tap 📱 to pair again.'); return; }
        setTimeout(loop, 4000);
      });
    };
    loop();
  }
  setInterval(() => { if (REM.room) publishNow(false); }, 1000);
  const artCache = {};
  function posterData(path, w, hgt) {
    // Small poster as image data, so no Plex token leaves the car.
    if (!path || !plex.conn) return Promise.resolve(null);
    const key = path + '@' + w;
    if (artCache[key] !== undefined) return Promise.resolve(artCache[key]);
    return fetch(pimg(path, w, hgt)).then((r) => r.ok ? r.blob() : null).then((b) => new Promise((ok) => {
      if (!b) { ok(null); return; }
      const fr = new FileReader();
      fr.onload = () => ok(fr.result); fr.onerror = () => ok(null);
      fr.readAsDataURL(b);
    })).then((v) => (artCache[key] = v)).catch(() => null);
  }
  let nowArtVal = null, nowArtKey = '';
  function nowArt() {
    let key = '', fetcher = null;
    if (P && P.meta) {
      const path = P.meta.type === 'episode' ? (P.meta.grandparentThumb || P.meta.thumb) : P.meta.thumb;
      key = 'p:' + path; fetcher = () => posterData(path, 200, 300);
    } else {
      const k = (watchKey || '').split('/');
      if (k[0] === 'yt' && k[1]) return 'https://i.ytimg.com/vi/' + encodeURIComponent(k[1]) + '/hqdefault.jpg';
      return null;
    }
    if (key !== nowArtKey) { nowArtKey = key; nowArtVal = null; fetcher().then((v) => { if (nowArtKey === key) { nowArtVal = v; publishNow(true); } }); }
    return nowArtVal;
  }
  function nowState() {
    if (playerOpen && !MIR) {
      return { kind: P ? 'plex' : (watchKey || '').split('/')[0], art: nowArt(), title: $('plTitle').textContent, sub: $('plSub').textContent,
        pos: +E.dispPos(E.mediaNow()).toFixed(2), at: serverNow(), dur: Math.round(E.dispDur() || 0), seek: E.canSeek(), live: !!(S.isLive && !S.view),
        playing: !!S.playing && !S.buffering, buffering: !!(S.buffering || S.loading), ended: !!S.ended, mirrorable: true,
        liveRef: E.livePos(), key: contentKey(), phonesOnly };
    }
    if (radioNow && radioNow.pod) return { kind: 'podcast', art: radioNow.favicon ? podArt(radioNow.favicon, 300) : null, title: radioNow.name, sub: radioNow.show,
      pos: +(radio.currentTime || 0).toFixed(2), at: serverNow(), dur: Math.round(podDur()), seek: true, playing: !radio.paused, mirrorable: true, key: 'pod/' + radioNow.guid };
    if (radioNow) return { kind: 'radio', art: okUrl(radioNow.favicon || '') ? radioNow.favicon : null, title: radioNow.name, sub: 'Live radio', playing: !radio.paused, seek: false, mirrorable: true };
    return { kind: 'idle' };
  }
  function publishNow(force) {
    if (!REM.room) return;
    const st = nowState();
    const cmp = JSON.stringify(Object.assign({}, st, { at: 0, pos: Math.round(st.pos || 0) }));
    if (!force && cmp === REM.lastNow) return;
    REM.lastNow = cmp;
    postSlot('now', st);
  }
  const SAFE_HASH = /^#\/(watch\/(plex|live|iptv|yt|url)\/|item\/|home$|movies$|tv$|live|iptv|youtube|radio|podcasts|traffic$|search\/)/;
  function handleRemoteCmd(c) {
    REM.phoneSeenAt = Date.now();
    const saved = store.get('dm_remote_car', null);
    if (saved && saved.room === REM.room && Date.now() - (saved.used || 0) > 60000) store.set('dm_remote_car', Object.assign(saved, { used: Date.now() }));
    updateRemoteBtn();
    const t = c && c.type;
    if (t === 'hello') { publishNow(true); return; }
    if (t === 'toggle') { if (playerOpen) $('btnPlay').click(); else if (radioNow) { radio.paused ? radio.play() : radio.pause(); } }
    else if (t === 'skip' && radioNow && radioNow.pod) podSkip(Math.max(-600, Math.min(600, +c.s || 0)));
    else if (t === 'seek' && radioNow && radioNow.pod) podSeek(Math.max(0, +c.pos || 0));
    else if (t === 'pod' && c.ep && typeof c.ep === 'object') playPodcast(c.ep);
    else if (t === 'skip' && playerOpen) skip(Math.max(-600, Math.min(600, +c.s || 0)));
    else if (t === 'seek' && playerOpen && E.canSeek()) E.hooks.onSeekRequest(Math.max(0, +c.pos || 0));
    else if (t === 'back') { if (playerOpen) $('plBack').click(); else if (radioNow) stopRadio(); }
    else if (t === 'phones') setPhonesOnly(!!c.on);
    else if (t === 'stopradio') stopRadio();
    else if (t === 'go' && typeof c.hash === 'string' && SAFE_HASH.test(c.hash)) { REM.autoUntil = Date.now() + 8000; go(c.hash); }
    else if (t === 'radio' && c.st && okUrl(c.st.url_resolved || '')) playRadio(c.st);
    else if (t === 'lists') buildRemoteLists().then((l) => postSlot('lists', l));
    else if (t === 'find' && typeof c.q === 'string' && c.q.trim()) remoteFind(c.q.trim().slice(0, 80)).then((r) => postSlot('results', r));
    else if (t === 'mirror') buildMirror().then((m) => postSlot('mirror', Object.assign({ req: c.req || 0 }, m)))
      .catch((e) => postSlot('mirror', { req: c.req || 0, kind: 'error', error: e.message }));
    setTimeout(() => publishNow(true), 400);
  }
  function plexEntry(m) {
    const isEp = m.type === 'episode';
    return { t: isEp ? m.grandparentTitle : m.title, s: isEp ? epCode(m) + ' — ' + m.title : (m.year ? String(m.year) : ''),
      go: (m.type === 'show' || m.type === 'season') ? null : '#/watch/plex/' + m.ratingKey,
      p: m.viewOffset && m.duration ? +(m.viewOffset / m.duration).toFixed(3) : 0,
      _art: isEp ? (m.grandparentThumb || m.thumb) : m.thumb };
  }
  function withPosters(items) {
    return Promise.all(items.map((it) => (it._art ? posterData(it._art, 120, 180) : Promise.resolve(null)).then((img) => {
      const o = Object.assign({}, it); delete o._art; if (img) o.img = img; return o;
    })));
  }
  function chanEntry(ch) { return { t: ch.name, s: ch.cat || 'Live', go: channelHref(ch), img: okUrl(ch.logo || '') ? ch.logo : null }; }
  function radioEntry(st) {
    return { t: st.name, s: (st.tags || '').split(',').filter(Boolean).slice(0, 2).join(', ') || 'Radio', img: okUrl(st.favicon || '') ? st.favicon : null,
      st: { stationuuid: st.stationuuid, name: st.name, url_resolved: st.url_resolved, favicon: st.favicon || '', tags: st.tags || '', bitrate: st.bitrate || 0 } };
  }
  function buildRemoteLists() {
    const podItem = (ep) => ({ t: ep.name, s: ep.show, img: ep.favicon ? podArt(ep.favicon, 300) : null, pod: Object.assign(podEp(ep), { desc: '' }) });
    const out = { cont: [], recent: [], live: [], radio: [], pods: podInProgress().slice(0, 20).map(podItem) };
    const jobs = [];
    if (plex.auth) {
      jobs.push(pget('/library/onDeck?X-Plex-Container-Start=0&X-Plex-Container-Size=20')
        .then((d) => withPosters((MC(d).Metadata || []).filter((m) => m.type === 'movie' || m.type === 'episode').map(plexEntry)))
        .then((l) => { out.cont = l; }).catch(() => {}));
      jobs.push(getSections().then((secs) => Promise.all(secs.map((sec) =>
        pget(`/library/sections/${sec.key}/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=15`)
          .then((d) => (MC(d).Metadata || []).filter((m) => m.type === 'movie' || m.type === 'episode').map(plexEntry)).catch(() => []))))
        .then((lists) => withPosters([].concat(...lists))).then((l) => { out.recent = l; }).catch(() => {}));
    }
    out.live = favs().concat(VERIFIED).filter((c, i, a) => a.findIndex((x) => x.url === c.url) === i).slice(0, 40).map(chanEntry);
    out.radio = radioFavs().map(radioEntry);
    podSubs().slice(0, 8).forEach((s) => jobs.push(podEpisodes(s.id).then(({ eps }) => {
      if (eps[0] && !out.pods.some((x) => x.pod.guid === eps[0].guid)) out.pods.push(podItem(eps[0]));
    }).catch(() => {})));
    jobs.push(radioSearch({ countrycode: 'US', limit: '25' }).then((l) => {
      l.forEach((st) => { if (!out.radio.some((x) => x.st.stationuuid === st.stationuuid)) out.radio.push(radioEntry(st)); });
    }).catch(() => {}));
    return Promise.all(jobs).then(() => out);
  }
  function remoteFind(q) {
    const ql = q.toLowerCase(), res = { q, items: [] };
    const jobs = [];
    if (plex.auth) jobs.push(pget('/hubs/search?query=' + enc(q) + '&limit=15').then((d) => {
      const l = [];
      (MC(d).Hub || []).forEach((hub) => (hub.Metadata || []).forEach((m) => { if (m.type === 'movie' || m.type === 'episode') l.push(Object.assign(plexEntry(m), { k: 'Plex' })); }));
      return withPosters(l.slice(0, 20));
    }).then((l) => { res.items.unshift(...l); }).catch(() => {}));
    favs().concat(myChannels(), VERIFIED).filter((c) => c.name.toLowerCase().includes(ql)).slice(0, 15)
      .forEach((c) => res.items.push(Object.assign(chanEntry(c), { k: 'Live TV' })));
    jobs.push(ytSearch(q, 12).then((l) => l.forEach((r) => res.items.push({ t: r.title, s: r.channel || '', k: 'YouTube', img: okUrl(r.thumb || '') ? r.thumb : null,
      go: '#/watch/yt/' + enc(r.id) + '/' + enc(r.title || 'YouTube video') }))).catch(() => {}));
    jobs.push(podSearch(q).then((l) => l.slice(0, 12).forEach((s) => res.items.push({ t: s.name, s: s.by, k: 'Podcasts', img: s.art ? podArt(s.art, 300) : null,
      go: '#/podcasts/show/' + enc(s.id) }))).catch(() => {}));
    jobs.push(radioSearch({ name: q, countrycode: 'US', limit: '10' }).then((l) => l.forEach((st) => res.items.push(Object.assign(radioEntry(st), { k: 'Radio' })))).catch(() => {}));
    return Promise.all(jobs).then(() => res);
  }
  /* What a phone needs to play the same thing itself. For Plex the car
     asks the server for a temporary access pass (not the account key). */
  function contentKey() { return P ? 'plex/' + P.rk : watchKey; }   // same title = same key, even after a seek
  function buildMirror() {
    if (!playerOpen && radioNow && radioNow.pod) return Promise.resolve({ kind: 'podcast', ep: Object.assign(podEp(radioNow), { desc: '' }), pos: radio.currentTime || 0, at: serverNow(), playing: !radio.paused, title: radioNow.name });
    if (!playerOpen && radioNow) return Promise.resolve({ kind: 'radio', st: radioEntry(radioNow).st, title: radioNow.name });
    if (!playerOpen) return Promise.resolve({ kind: 'none' });
    const title = $('plTitle').textContent, sub = $('plSub').textContent;
    if (P) {
      return pget('/security/token?type=delegation&scope=all').then((d) => {
        const tok = MC(d).token || (d && d.token);
        if (!tok) throw new Error('Plex didn’t give out a temporary pass');
        return { kind: 'plex', base: plex.conn.base, token: tok, rk: P.rk, dur: P.duration, title, sub, key: contentKey() };
      });
    }
    return Promise.resolve({ kind: (watchKey || '').split('/')[0], url: S.srcUrl, ts: !!(S.srcOpts && S.srcOpts.ts),
      live: !!(S.isLive && !S.isEvent && !S.view), liveRef: E.livePos(), at: serverNow(), title, sub, key: contentKey() });
  }
  function updateRemoteBtn() {
    const pb = $('plPhones'); if (pb) pb.hidden = !REM.room || !!MIR;
    const b = $('remoteBtn');
    if (!b) return;
    b.classList.toggle('on', !!REM.room);
    b.title = REM.room ? (Date.now() - REM.phoneSeenAt < 60000 ? 'Phone remote connected' : 'Phone remote on — waiting for a phone') : 'Phone remote';
  }
  function showRemotePairing() {
    const box = h('div', { class: 'pairbox' });
    const shade = h('div', { class: 'pairshade', onclick: (e) => { if (e.target === shade) shade.remove(); } }, box);
    document.body.appendChild(shade);
    box.appendChild(h('h2', { text: 'Phone remote' }));
    const body = h('div', {}, msg('Setting up…')); box.appendChild(body);
    carRemoteStart().then(() => {
      let qr;
      try { qr = MiniQR.toCanvas(remoteLink(REM.room), 264); } catch (e) { qr = null; }
      body.replaceChildren(
        h('div', { class: 'pairrow' }, qr ? h('div', { class: 'qr' }, qr) : null,
          h('div', { class: 'paircode', text: REM.code ? REM.code.replace(/(\d{3})(\d{3})/, '$1 $2') : '—' })),
        h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', text: 'Done', onclick: () => shade.remove() }),
          h('button', { class: 'btn ghost', type: 'button', text: 'New code', onclick: () => { carRemoteStop(); shade.remove(); showRemotePairing(); } }),
          h('button', { class: 'btn ghost', type: 'button', text: 'Turn remote off', onclick: () => { carRemoteStop(); shade.remove(); toast('Phone remote off.'); } })));
    }).catch((e) => body.replaceChildren(msg('The remote needs the home helper, which isn’t answering (' + e.message + ').', true)));
  }

  // ---- phone side: "Watch here too" ----
  let MIR = null; // { info, carNow, sid, timer }
  function carElapsed(n) { return n && n.playing ? Math.max(0, serverNow() - (n.at || serverNow())) / 1000 : 0; }
  function mirrorTarget() {
    const n = MIR && MIR.carNow;
    if (!n) return null;
    if (MIR.info.live) {                       // live: same broadcast chunk as the car
      if (MIR.info.ts || !n.liveRef) return null;
      return E.liveTimeOf(n.liveRef.seq, n.liveRef.off + carElapsed(n));
    }
    return carPosNow();
  }
  function carPosNow() {
    const n = MIR && MIR.carNow;
    if (!n || n.pos == null) return null;
    return n.pos + (n.playing ? Math.max(0, serverNow() - (n.at || serverNow())) / 1000 : 0);
  }
  function mirrorPlexUrl(info, off) {
    // Phones get 480p (~1.5 Mbps): looks the same on a small screen and
    // leaves the home connection to the car's stream.
    const q = QUALITIES.find((x) => x.id === '480');
    return info.base + '/video/:/transcode/universal/start.m3u8?path=' + enc('/library/metadata/' + info.rk) +
      '&mediaIndex=0&partIndex=0&protocol=hls&fastSeek=1&copyts=1&offset=' + Math.max(0, Math.floor(off)) +
      '&directPlay=0&directStream=1&directStreamAudio=1&subtitles=none&videoResolution=' + q.res + '&maxVideoBitrate=' + q.br +
      '&videoQuality=100&session=' + enc(MIR.sid) + '&X-Plex-Session-Identifier=' + enc(MIR.sid) +
      '&X-Plex-Client-Profile-Extra=' + enc(PROFILE_EXTRA) + '&' + plexQS(info.token);
  }
  function mirrorStopPlexSession() {
    if (MIR && MIR.info.kind === 'plex' && MIR.sid) {
      fetch(MIR.info.base + '/video/:/transcode/universal/stop?session=' + enc(MIR.sid) + '&' + plexQS(MIR.info.token), { keepalive: true }).catch(() => {});
    }
  }
  function mirrorLoad(at) {
    const info = MIR.info;
    if (info.kind === 'plex') {
      mirrorStopPlexSession();
      MIR.sid = newSid();
      E.load(mirrorPlexUrl(info, at || 0), info.title);
      S.view = { offset: Math.floor(at || 0), duration: info.dur };
    } else if (info.live) {
      const ref = (MIR.carNow && MIR.carNow.liveRef) || info.liveRef;
      const lead = ref ? Object.assign({}, ref, { off: ref.off + carElapsed(MIR.carNow || info) + 1 }) : null;
      E.load(info.url, info.title, { ts: !!info.ts, joinRef: lead });
    } else {
      E.load(info.url, info.title, { ts: !!info.ts });
      MIR.firstJump = true;                    // jump to the car's spot once it's playing
    }
    S.autoplay = true;
  }
  function paintMirrorSound() {
    const b = $('mirSound'); if (!b) return;
    b.textContent = S.muted ? '🔇 Sound: car speakers' : '🔊 Sound: this device';
  }
  function mirrorStart(info, carNow) {
    if (info.kind === 'radio') { playRadio(info.st); toast('Playing the car’s station on this device.'); return; }
    if (info.kind === 'podcast') {
      const lag = info.playing ? Math.max(0, serverNow() - (info.at || serverNow())) / 1000 : 0;
      playPodcast(info.ep, (info.pos || 0) + lag); toast('Playing the car’s podcast on this device.'); return;
    }
    if (info.kind === 'none' || info.kind === 'error') { toast(info.kind === 'error' ? 'Couldn’t start it here: ' + info.error : 'Nothing is playing on the car.'); return; }
    if (!E.hasWC) { toast('This browser can’t play video this way — try Chrome.'); return; }
    mirrorStop();
    MIR = { info, carNow, sid: null, timer: null, fixing: 0 };
    E.ensureCtx(); try { S.ctx.resume(); } catch (e) {}
    E.setMuted(store.get('dm_mirror_muted', true));
    openPlayerShell(info.title, (info.sub ? info.sub + ' · ' : '') + 'Synced with the car');
    document.body.classList.add('mirror-mode');
    if (!$('mirSound')) {
      const b = h('button', { class: 'pb', id: 'mirSound', type: 'button', onclick: () => { E.setMuted(!S.muted); store.set('dm_mirror_muted', S.muted); paintMirrorSound(); } });
      document.querySelector('.pl-top').appendChild(b);
    }
    paintMirrorSound();
    mirrorLoad(carPosNow() || 0);
    MIR.timer = setInterval(mirrorSync, 1000);
  }
  function mirrorSync() {
    if (!MIR || !S.loaded) return;
    const n = MIR.carNow;
    if (!n || n.kind === 'idle') return;
    // Car went phones-only (its sound is off): play sound here. Back to
    // this phone's own choice when the car screen comes back.
    if (!!n.phonesOnly !== !!MIR.po) {
      MIR.po = !!n.phonesOnly;
      E.setMuted(MIR.po ? false : store.get('dm_mirror_muted', true)); paintMirrorSound();
      if (MIR.po) toast('Car screen is off — sound is on this phone now.');
    }
    const carGoing = !!n.playing;   // false while the car is paused OR buffering
    // Wait with the car: pause while it's paused or buffering, go when it goes.
    if (S.started && !S.ended) {
      if (carGoing && !S.playing) E.togglePlay();
      else if (!carGoing && S.playing) E.togglePlay();
    }
    if (!S.started || !S.firstFrameAt || S.buffering || !carGoing) return;
    const target = mirrorTarget();
    if (target == null) return;
    const diff = E.dispPos(E.mediaNow()) - target;
    if (MIR.firstJump && E.canSeek()) {        // YouTube / links: start where the car is
      MIR.firstJump = false;
      if (Math.abs(diff) > 2) { E.seekTo(target + 0.5); MIR.fixing = Date.now() + 5000; return; }
    }
    if (MIR.info.live && Math.abs(diff) > 15) {
      // live and far apart (e.g. the phone fell behind the broadcast): rejoin the car's chunk
      if (Date.now() < MIR.fixing) return;
      MIR.fixing = Date.now() + 30000; mirrorLoad(0); return;
    }
    const isPlex = MIR.info.kind === 'plex';
    if (Math.abs(diff) > (isPlex ? 15 : 4)) {
      // A real jump (the car skipped). For Plex a reload starts a new
      // conversion on the server, so at most once every 30 s; other videos
      // just jump, at most every 8 s.
      if (Date.now() < MIR.fixing) return;
      MIR.fixing = Date.now() + (isPlex ? 30000 : 8000);
      if (isPlex) mirrorLoad(target + 2);
      else E.seekTo(target + 0.5);
    } else if (diff > 0.12) {
      E.nudge(Math.min(0.5, diff));            // ahead: hold back a little
    } else if (diff < -0.12) {
      E.nudge(diff < -3 ? -1 : Math.max(-0.5, diff));   // behind: catch up without reloading
    }
  }
  function mirrorStop() {
    if (!MIR) return;
    clearInterval(MIR.timer);
    mirrorStopPlexSession();
    MIR = null;
    document.body.classList.remove('mirror-mode');
    const b = $('mirSound'); if (b) b.remove();
    E.setMuted(false);
    playerOpen = false; watchKey = null;
    E.teardown();
    $('player').hidden = true;
    document.body.classList.remove('playing');
  }

  // ---- phone side: the remote page ----
  function phoneId() {
    let id = store.get('dm_phone_id', null);
    if (!id) { id = 'ph' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store.set('dm_phone_id', id); }
    return id;
  }
  VIEWS.remote = (root, [room]) => {
    document.body.classList.add('remote-mode');
    dismissGate();
    const gen = ++REM.gen;
    const alive = () => gen === REM.gen && parse().name === 'remote';
    const brand = (right) => h('div', { class: 'rm-top' },
      h('div', { class: 'rm-brand' }, 'Nate’s ', h('b', { text: 'Theater' })), right || h('span', { class: 'rm-pill', text: 'Remote' }));

    // One-time tip: on iPhone, a web page can't hide Safari's bars, but a
    // Home Screen app can - show how, once, and never inside the app itself.
    const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone && !store.get('dm_a2hs_tip', false)) {
      const tip = h('div', { class: 'rm-tip' }, h('span', {}, 'For full screen: tap ', h('b', { text: 'Share ⬆' }), ', then ', h('b', { text: 'Add to Home Screen' }), '.'),
        h('button', { type: 'button', 'aria-label': 'Close', text: '✕', onclick: () => { store.set('dm_a2hs_tip', true); tip.remove(); } }));
      setTimeout(() => { if (alive()) root.appendChild(tip); }, 1500);
    }
    // Opened from the Home Screen icon: go straight back to the last car.
    if (!room && standalone && store.get('dm_remote_phone', null)) { go('#/remote/' + store.get('dm_remote_phone', null), true); return; }
    if (!room) {
      const input = h('input', { class: 'rm-code', type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '••••••',
        autocomplete: 'one-time-code', 'aria-label': '6-digit code' });
      const btn = h('button', { class: 'rm-btn', type: 'button', text: 'Connect' });
      const st = h('div', { class: 'rm-err' });
      let busy = false;
      const join = () => {
        const code = input.value.replace(/\D/g, '');
        if (code.length !== 6) { st.textContent = 'Enter all 6 digits.'; return; }
        if (busy) return; busy = true;
        st.textContent = ''; btn.textContent = 'Connecting…'; btn.disabled = true;
        remoteApi('/pair?code=' + code + '&p=' + enc(phoneId())).then((d) => { store.set('dm_remote_phone', d.room); go('#/remote/' + d.room, true); })
          .catch((e) => {
            const why = (e.message.match(/\((.*)\)/) || [, 'That code didn’t work.'])[1];
            st.textContent = /HTTP 40[03]/.test(e.message) ? why.charAt(0).toUpperCase() + why.slice(1) + '.' : 'Can’t reach the car right now. Check your signal and try again.';
            btn.textContent = 'Connect'; btn.disabled = false; busy = false; input.select();
          });
      };
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 6);
        st.textContent = '';
        if (input.value.length === 6) join();
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
      btn.addEventListener('click', join);
      const saved = store.get('dm_remote_phone', null);
      root.appendChild(h('div', { class: 'rm-page' }, brand(),
        h('div', { class: 'rm-connect' },
          h('div', { class: 'rm-icon', text: '📱' }),
          h('h1', { text: 'Connect to your car' }),
          h('p', { text: 'Enter the 6-digit code shown on the car screen.' }),
          input, st, btn,
          saved ? h('a', { class: 'rm-link', href: '#/remote/' + saved, text: 'Reconnect to the last car' }) : null)));
      setTimeout(() => input.focus(), 50);
      return;
    }

    store.set('dm_remote_phone', room);
    const send = (cmd) => { const t0 = Date.now(); return remotePost('/' + room + '/cmd', cmd).then((d) => noteServerTime(d, t0)).catch((e) => { if (/404/.test(e.message)) gone(); }); };
    // keep the phone's clock estimate fresh while it plays along
    const clockPing = setInterval(() => { if (!alive()) { clearInterval(clockPing); return; } if (MIR) { const t0 = Date.now(); remoteApi('/' + room + '/state?wait=0&v=999999999').then((d) => noteServerTime(d, t0)).catch(() => {}); } }, 5000);
    const dot = h('span', { class: 'rm-dot' });
    const conn = h('span', { class: 'rm-conn' }, dot, h('span', { text: 'Connecting…' }));
    const icon = h('div', { class: 'rm-kind', text: '🎬' });
    const title = h('div', { class: 'rm-t', text: 'Connecting to the car…' });
    const sub = h('div', { class: 'rm-s' });
    const bar = h('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'rm-seek', disabled: true, 'aria-label': 'Position' });
    const tl = h('span'), tr = h('span');
    const pp = h('button', { class: 'rm-round big', type: 'button', text: '▶', 'aria-label': 'Play or pause', onclick: () => send({ type: 'toggle' }) });
    const back10 = h('button', { class: 'rm-round', type: 'button', 'aria-label': 'Back 10 seconds', onclick: () => send({ type: 'skip', s: -10 }) }, h('span', { text: '↺' }), h('small', { text: '10' }));
    const fwd30 = h('button', { class: 'rm-round', type: 'button', 'aria-label': 'Forward 30 seconds', onclick: () => send({ type: 'skip', s: 30 }) }, h('span', { text: '↻' }), h('small', { text: '30' }));
    const close = h('button', { class: 'rm-close', type: 'button', text: 'Close', onclick: () => send({ type: 'back' }) });
    const phonesBtn = h('button', { class: 'rm-phones', type: 'button', hidden: true, onclick: () => {
      const on = !(now && now.phonesOnly);
      send({ type: 'phones', on });
      if (on && !MIR && !mirrorReq) watchHere.click();   // start it on this phone too
    } });
    let mirrorReq = 0;
    const watchHere = h('button', { class: 'rm-watch', type: 'button', hidden: true, onclick: () => {
      mirrorReq = Date.now(); watchHere.textContent = 'Starting…'; send({ type: 'mirror', req: mirrorReq });
      setTimeout(() => { watchHere.textContent = '📲 Watch here too'; }, 6000);
    } }, '📲 Watch here too');
    let dur = 0, lastHeard = 0, now = null, lists = null, results = null;
    bar.addEventListener('change', () => { if (dur) send({ type: 'seek', pos: Math.round(bar.value / 1000 * dur) }); });
    const ICON = { plex: '🎬', live: '📺', iptv: '📺', yt: '▶', youtube: '▶', radio: '📻', podcast: '🎙', url: '🎞', idle: '🚗' };
    const search = h('input', { class: 'rm-search', type: 'search', placeholder: 'Search movies, shows, channels, YouTube, radio', autocomplete: 'off', enterkeyhint: 'search' });
    const resultsEl = h('div');
    const rowsEl = h('div');
    const sendLink = (text, title) => {
      const t = linkTarget(text, title);
      if (!t) return false;
      if (t.unsupported) { toast('That link can’t play in the car yet — YouTube and direct video links work.'); return true; }
      send({ type: 'go', hash: t.hash }); toast('Sent to the car: ' + t.label);
      search.value = ''; resultsEl.replaceChildren(); window.scrollTo({ top: 0, behavior: 'smooth' });
      return true;
    };
    const pasteBtn = h('button', { class: 'rm-paste', type: 'button', text: '🔗 Paste link', onclick: () => {
      if (!(navigator.clipboard && navigator.clipboard.readText)) { search.focus(); toast('Paste the link into the search box.'); return; }
      navigator.clipboard.readText().then((txt) => { if (!sendLink(txt)) toast('No link found — copy a video link first, then tap Paste link.'); })
        .catch(() => { search.focus(); toast('Paste the link into the search box.'); });
    } });
    const pend = store.get('dm_share', null);
    if (pend) { store.set('dm_share', null); if (Date.now() - (pend.at || 0) < 10 * 60 * 1000) setTimeout(() => { if (alive() && !sendLink(pend.text, pend.title)) toast('That share didn’t include a video link.'); }, 800); }
    const doFind = () => {
      const q = search.value.trim(); if (!q) { resultsEl.replaceChildren(); return; }
      if (/^https?:\/\//i.test(q) || /youtu\.?be/i.test(q)) { if (sendLink(q)) return; }
      search.blur(); results = null;
      resultsEl.replaceChildren(h('div', { class: 'rm-row' }, h('div', { class: 'rm-rh', text: 'Searching…' }), h('div', { class: 'rm-scroll' }, ...skelCards(6, 'poster'))));
      send({ type: 'find', q });
    };
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(); });
    search.addEventListener('search', () => { if (!search.value.trim()) resultsEl.replaceChildren(); });
    const pick = (it) => { if (it.st) send({ type: 'radio', st: it.st }); else if (it.pod) send({ type: 'pod', ep: it.pod }); else if (it.go) send({ type: 'go', hash: it.go }); toast('Playing on the car: ' + it.t); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    function skelCards(n, shape) { return Array.from({ length: n }, () => h('div', { class: 'rm-card ' + shape + ' skel' }, h('div', { class: 'rm-art' }))); }
    function card(it, shape) {
      const art = h('div', { class: 'rm-art', style: it.img ? null : { background: grad(it.t || '?') } });
      if (it.img && /^(data:image\/|https:\/\/)/.test(it.img)) {
        const im = h('img', { src: it.img, alt: '', loading: 'lazy' });
        im.addEventListener('error', () => { im.remove(); art.style.background = grad(it.t || '?'); art.appendChild(h('span', { text: it.t })); });
        art.appendChild(im);
        if (shape !== 'poster') art.classList.add('logo');
      } else art.appendChild(h('span', { text: it.t }));
      if (it.p > 0.01 && it.p < 0.99) art.appendChild(h('div', { class: 'rm-prog' }, h('i', { style: { width: Math.round(it.p * 100) + '%' } })));
      return h('button', { class: 'rm-card ' + shape, type: 'button', onclick: () => pick(it) }, art,
        h('div', { class: 'rm-ct', text: it.t }), it.s ? h('div', { class: 'rm-cs', text: it.s }) : null);
    }
    function row(label, items, shape) {
      if (!items || !items.length) return null;
      return h('div', { class: 'rm-row' }, h('div', { class: 'rm-rh', text: label }),
        enableFlow(h('div', { class: 'rm-scroll' }, ...items.filter((it) => it.go || it.st || it.pod).map((it) => card(it, shape)))));
    }
    function drawRows() {
      if (!lists) { rowsEl.replaceChildren(...['Continue Watching', 'Recently added'].map((l) => h('div', { class: 'rm-row' }, h('div', { class: 'rm-rh', text: l }), h('div', { class: 'rm-scroll' }, ...skelCards(5, 'poster'))))); return; }
      rowsEl.replaceChildren(...[row('Continue Watching', lists.cont, 'poster'), row('Recently added', lists.recent, 'poster'),
        row('Live TV', lists.live, 'wide'), row('Podcasts', lists.pods, 'square'), row('Radio', lists.radio, 'square')].filter(Boolean));
    }
    function drawResults() {
      if (!results) return;
      if (!results.items.length) { resultsEl.replaceChildren(h('div', { class: 'rm-empty', text: 'Nothing found for “' + results.q + '”.' })); return; }
      const by = (k) => results.items.filter((it) => (it.k || '') === k);
      resultsEl.replaceChildren(...[row('Plex', by('Plex'), 'poster'), row('YouTube', by('YouTube'), 'wide'),
        row('Live TV', by('Live TV'), 'wide'), row('Podcasts', by('Podcasts'), 'square'), row('Radio', by('Radio'), 'square')].filter(Boolean));
    }
    function drawNow(n) {
      const idle = !n || n.kind === 'idle';
      const art = n && n.art && /^(data:image\/|https:\/\/)/.test(n.art) ? n.art : null;
      icon.classList.toggle('poster', !!art && n.kind === 'plex');
      if (art) { if (!icon.firstChild || icon.firstChild.src !== art) icon.replaceChildren(h('img', { src: art, alt: '' })); }
      else icon.textContent = ICON[(n && n.kind) || 'idle'] || '🎬';
      title.textContent = idle ? 'Nothing playing' : (n.title || '');
      sub.textContent = idle ? 'Pick something below to play it on the car.' : (n.sub || '');
      pp.textContent = n && n.playing ? '❚❚' : '▶';
      dur = (n && n.dur) || 0;
      const seek = !!(n && n.seek && dur);
      bar.disabled = !seek; back10.disabled = fwd30.disabled = !seek; pp.disabled = idle; close.hidden = idle;
      watchHere.hidden = idle || !(n && n.mirrorable) || !!MIR;
      const video = !idle && n && n.kind !== 'radio' && n.kind !== 'podcast';
      phonesBtn.hidden = !video;
      phonesBtn.textContent = n && n.phonesOnly ? '📺 Turn the car screen back on' : '📱 Phones only — car screen off';
      phonesBtn.classList.toggle('on', !!(n && n.phonesOnly));
      if (dur && document.activeElement !== bar) bar.value = Math.round(1000 * (n.pos || 0) / dur);
      if (!dur) bar.value = 0;
      tl.textContent = idle ? '' : n.buffering ? 'Loading…' : dur ? E.fmt(n.pos || 0) : (n.kind === 'radio' ? 'Live radio' : 'Live');
      tr.textContent = dur ? '−' + E.fmt(Math.max(0, dur - (n.pos || 0))) : '';
    }
    function paintConn() {
      if (!alive()) return;
      const ok = Date.now() - lastHeard < 30000;
      dot.className = 'rm-dot' + (ok ? ' ok' : '');
      conn.lastChild.textContent = ok ? 'Connected' : 'Waiting for the car…';
      setTimeout(paintConn, 2000);
    }
    function gone() {
      if (!alive()) return;
      REM.gen++; store.set('dm_remote_phone', null); mirrorStop();
      root.replaceChildren(h('div', { class: 'rm-page' }, brand(), h('div', { class: 'rm-connect' },
        h('div', { class: 'rm-icon', text: '⏱' }), h('h1', { text: 'Remote disconnected' }),
        h('p', { text: 'The pairing ended. Tap 📱 on the car screen for a new code.' }),
        h('a', { class: 'rm-btn', href: '#/remote', text: 'Enter a new code' }))));
    }
    root.appendChild(h('div', { class: 'rm-page' }, brand(conn),
      h('div', { class: 'rm-now' },
        h('div', { class: 'rm-head' }, icon, h('div', { class: 'rm-titles' }, title, sub), close),
        bar, h('div', { class: 'rm-times' }, tl, tr),
        h('div', { class: 'rm-ctrls' }, back10, pp, fwd30), watchHere, phonesBtn),
      h('div', { class: 'rm-searchrow' }, search, pasteBtn),
      h('details', { class: 'rm-help' }, h('summary', { text: 'Send videos from other apps' }),
        h('p', { text: 'Copy a YouTube or video link anywhere, then tap 🔗 Paste link. Or type it into the search box.' }),
        h('b', { text: 'Android' }),
        h('p', { text: 'Add this remote to your home screen (Chrome menu ⋮ → Add to Home screen). Then in YouTube or any app, tap Share and pick “Theater”.' }),
        h('b', { text: 'iPhone — one-time setup' }),
        h('ol', {},
          h('li', { text: 'Open the Shortcuts app and tap + to make a new shortcut.' }),
          h('li', { text: 'Tap ⓘ at the bottom and turn on “Show in Share Sheet”. Set it to receive URLs and Text.' }),
          h('li', { text: 'Add the action “URL Encode” (it uses the Shortcut Input).' }),
          h('li', {}, 'Add the action “Open URLs” and type: ', h('code', { text: location.origin + location.pathname + '?send=' }), ' then insert the “URL Encoded Text” right after it.'),
          h('li', { text: 'Name it “Send to car”. Now tap Share in YouTube, Safari or Messages and pick Send to car.' })),
        h('p', { class: 'rm-note', text: 'The shortcut opens Safari, so connect Safari to the car once with the 6-digit code too.' })), resultsEl, rowsEl));
    drawNow(null); drawRows(); paintConn();
    let ver = 0;
    const poll = () => {
      if (!alive()) return;
      const t0 = Date.now();
      remoteApi('/' + room + '/state?wait=20&v=' + ver + '&p=' + enc(phoneId())).then((d) => {
        lastHeard = Date.now(); noteServerTime(d, t0);
        ver = d.ver || ver;
        const sl = d.slots || {};
        if (sl.now) {
          now = sl.now; if (MIR) MIR.carNow = now; drawNow(now);
          // The car switched to something else: follow it on this device.
          if (MIR && !mirrorReq && now.key && MIR.info.key && now.key !== MIR.info.key && now.mirrorable) {
            mirrorReq = Date.now(); send({ type: 'mirror', req: mirrorReq });
          }
        }
        if (sl.lists) { lists = sl.lists; drawRows(); }
        if (sl.results) { results = sl.results; drawResults(); }
        if (sl.mirror && sl.mirror.req && sl.mirror.req === mirrorReq) { mirrorReq = 0; watchHere.textContent = '📲 Watch here too'; mirrorStart(sl.mirror, now); }
        setTimeout(poll, 100);
      }).catch((e) => {
        if (/404/.test(e.message)) { gone(); return; }
        if (/HTTP 409/.test(e.message)) { full(); return; }
        setTimeout(poll, 3000);
      });
    };
    function full() {
      if (!alive()) return;
      REM.gen++; mirrorStop();
      root.replaceChildren(h('div', { class: 'rm-page' }, brand(), h('div', { class: 'rm-connect' },
        h('div', { class: 'rm-icon', text: '👥' }), h('h1', { text: 'Remote is full' }),
        h('p', { text: 'Three phones are already using the remote. Try again when one of them closes it.' }),
        h('button', { class: 'rm-btn', type: 'button', text: 'Try again', onclick: () => { currentKey = null; render(parse()); } }))));
    }
    send({ type: 'hello' }); send({ type: 'lists' });
    poll();
  };

  /* ---------- start ---------- */
  // A link shared to the app (Android share menu, or the iPhone Shortcut,
  // which opens ?send=<link>): keep it, clean the address, and open the
  // remote - it sends the link to the car once connected.
  (() => {
    const qs = new URLSearchParams(location.search);
    const text = [qs.get('send'), qs.get('url'), qs.get('text')].filter(Boolean).join(' ');
    if (!text) return;
    store.set('dm_share', { text: text.slice(0, 2000), title: (qs.get('title') || '').slice(0, 200), at: Date.now() });
    const room = store.get('dm_remote_phone', null);
    history.replaceState(null, '', location.pathname + (room ? '#/remote/' + room : '#/remote'));
  })();
  updateMe();
  if (parse().name === 'remote') { document.body.classList.add('remote-mode'); dismissGate(); }
  else if (plex.auth && !plex.user && parse().name !== 'profiles') go('#/profiles', true);
  $('remoteBtn').addEventListener('click', showRemotePairing);
  if (store.get('dm_remote_car', null)) carRemoteStart().catch(() => {});
  route();
})();
