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
  function artBox(img, ph, extra) {
    const box = h('div', { class: 'art' });
    if (img) {
      const im = h('img', { src: img, alt: '', loading: 'lazy', decoding: 'async' });
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
  function row(title, moreHref) {
    const scroller = h('div', { class: 'scroller' });
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
    ["MovieSphere", "Movies", "https://amg00353-lionsgatestudio-moviesphere-xumo-zh5u0.amagi.tv/playlist.m3u8"],
    ["Gravitas Movies", "Movies", "https://d6dg3ebeih71x.cloudfront.net/Gravitas_Movies.m3u8"],
    ["24 Hour Free Movies", "Movies", "https://d1j2u714xk898n.cloudfront.net/scheduler/scheduleMaster/145.m3u8"],
    ["Charge!", "Movies", "https://fast-channels.sinclairstoryline.com/CHARGE/index.m3u8"],
    ["ION", "Series", "https://wurlewscripps.global.transmit.live/hls/68b9b0338cacd6fc468c222c/v1/scripps_ion_1/vizio_us/latest/main/hls/playlist.m3u8"],
    ["ION Mystery", "Series", "https://bdd9b4ef.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/Vml6aW9fSU9OTXlzdGVyeV9ITFM/playlist.m3u8"],
    ["The Carol Burnett Show", "Classic TV", "https://vizioaaaa-carol-burnett-vizio-xam92.amagi.tv/playlist/vizioAAAA-carol-burnett-vizio/playlist.m3u8"],
    ["Story Television", "Classic TV", "https://2-fss-1.streamhoster.com/pl_122/206858-4412976-1/playlist.m3u8"],
    ["FailArmy", "Comedy", "https://failarmy-international-au.samsung.wurl.tv/playlist.m3u8"],
    ["Comet", "Sci-Fi", "https://fast-channels.sinclairstoryline.com/COMET/index.m3u8"],
    ["DUST", "Sci-Fi", "https://dqi7ayt2o24fn.cloudfront.net/playlist.m3u8"],
    ["Midnight Pulp", "Horror", "https://linear-897.frequency.stream/dist/cineverse/897/hls/master/playlist.m3u8"],
    ["RetroCrush", "Anime", "https://linear-899.frequency.stream/dist/cineverse/899/hls/master/playlist.m3u8"],
    ["Hell's Kitchen", "Reality", "https://amg00654-itv-amg00654c1-samsung-au-1072.playouts.now.amagi.tv/itv-hellskitchen-samsung/playlist.m3u8"],
    ["Fear Factor", "Reality", "https://amg00627-banijaygroup-fearfactor-samsungau-9vdod.amagi.tv/playlist/amg00627-banijaygroup-fearfactor-samsungau/playlist.m3u8"],
    ["American Ninja Warrior", "Reality", "https://d4whmvwm0rdvi.cloudfront.net/10007/99951318/hls/master.m3u8?ads.xumo_channelId=99951318"],
    ["Court TV", "Crime", "https://cdn-uw2-prod.tsv2.amagi.tv/linear/amg01438-ewscrippscompan-courttv-tablo/playlist.m3u8"],
    ["Unsolved Mysteries", "Crime", "https://d31z96rdrmwfsp.cloudfront.net/master.m3u8"],
    ["Top Gear", "Entertainment", "https://amg00793-amg00793c5-vizio-us-2666.playouts.now.amagi.tv/playlist/amg00793-bbcstudios-bbctopgear8minother-vizious/playlist.m3u8"],
    ["Tastemade", "Entertainment", "https://rakutenaa-tm-intl-aus-rakuten-eu-n1gtg.amagi.tv/playlist/rakutenAA-tm-intl-aus-rakuten-eu/playlist.m3u8"],
    ["NBC News NOW", "News", "https://d1si3n1st4nkgb.cloudfront.net/10502/88896001/hls/master.m3u8?ads.xumo_channelId=88896001"],
    ["DW English", "News", "https://amg01644-amg01644c1-amgplt0343.playout.now3.amagi.tv/ts-eu-w1-n2/playlist/amg01644-amg01644c1-amgplt0343/playlist.m3u8"],
    ["Bloomberg TV+", "News", "https://bloomberg.com/media-manifest/streams/us.m3u8"],
    ["Sky News", "News", "https://dash4.antik.sk/live/test_skynews/playlist.m3u8"],
    ["PBS Kids", "Kids", "https://livestream.pbskids.org/out/v1/14507d931bbe48a69287e4850e53443c/est.m3u8"],
    ["MeTV Toons", "Kids", "https://sr-live-weigel1.akamaized.net/out/v1/0d1dbf29e64e47bc991796cc24fbeb97/index_2.m3u8"],
    ["The Weather Channel", "Weather", "https://twcprod-live.twc-tv.com/v1/manifest/b4d4d63a49309cc5140171fb2e92485c31be1e9e/DSP_6228e4760505741a116f1ba2_twcprod-live/6bf09ce5-366b-463c-b67e-c4b799f73c3f/4.m3u8"],
    ["AccuWeather NOW", "Weather", "https://cdn-ue1-prod.tsv2.amagi.tv/linear/amg00684-accuweather-accuweather-plex/playlist.m3u8"]
  ].map(([name, cat, url]) => ({ name, cat, url, logo: '' }));

  const REGIONS = [
    ['us', 'USA'], ['ca', 'Canada'], ['uk', 'UK'], ['ie', 'Ireland'], ['au', 'Australia'], ['nz', 'New Zealand'],
    ['mx', 'México'], ['es', 'España'], ['fr', 'France'], ['de', 'Deutschland'], ['it', 'Italia'], ['nl', 'Nederland'],
    ['br', 'Brasil'], ['in', 'India'], ['jp', '日本'], ['kr', '한국']
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
      title: ch.name, sub: ch.logo ? ch.name : '' });
    if (ch.logo) {
      const box = card.querySelector('.art');
      box.style.background = '#1b1d22';
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
    return attempt().then((list) => list.filter((s) => okUrl(s.url_resolved || '')));
  }
  const RADIO_TAGS = ['pop', 'rock', 'country', 'hiphop', 'jazz', 'classical', 'news', 'talk', 'sports', 'christmas', 'oldies', 'dance'];
  const radio = h('audio', { preload: 'none' });
  let radioBar = null, radioNow = null;
  function playRadio(st) {
    if (playerOpen) closeWatch();
    radioNow = st;
    radio.src = st.url_resolved;
    radio.play().catch((e) => toast('That station would not start: ' + e.message));
    if (!radioBar) {
      radioBar = h('div', { class: 'toast', style: { bottom: '18px', display: 'flex', alignItems: 'center', gap: '14px', padding: '10px 14px' } });
      document.body.appendChild(radioBar);
    }
    radioBar.hidden = false;
    radioBar.replaceChildren(
      h('div', { style: { width: '44px', height: '44px', borderRadius: '8px', background: grad(st.name), overflow: 'hidden', flex: 'none' } },
        okUrl(st.favicon || '') ? h('img', { src: st.favicon, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } }) : null),
      h('div', { style: { minWidth: '0' } }, h('div', { style: { fontWeight: '800' }, text: st.name }), h('div', { style: { color: '#aaa', fontSize: '13px' }, text: 'Radio · ' + (st.tags || '').split(',').slice(0, 2).join(', ') })),
      h('button', { class: 'pb', type: 'button', text: '❚❚', onclick: (e) => { if (radio.paused) { radio.play(); e.currentTarget.textContent = '❚❚'; } else { radio.pause(); e.currentTarget.textContent = '▶'; } } }),
      h('button', { class: 'pb', type: 'button', text: '✕', onclick: stopRadio })
    );
  }
  function stopRadio() { radio.pause(); radio.removeAttribute('src'); radioNow = null; if (radioBar) radioBar.hidden = true; }
  function stationCard(st) {
    return wideCard({ channel: st.name, cat: (st.tags || '').split(',')[0] || st.country || 'Radio',
      img: '', title: st.name, onclick: () => playRadio(st) });
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
      store.set('dm_iptv', cfg); iptvData = null; invalidate('iptv');
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
        iptvCfg() ? h('button', { class: 'btn ghost', type: 'button', text: 'Remove', onclick: () => { store.set('dm_iptv', null); iptvData = null; invalidate('iptv'); st.textContent = 'Removed.'; st.className = 'msg'; } }) : null),
      st);
  }

  /* ---------- Backup / restore of everything saved on this screen ---------- */
  const SAVED_KEYS = ['dm_plex_auth', 'dm_plex_user', 'dm_plex_conn', 'dm_plex_client_v2', 'dm_iptv', 'dm_lists', 'dm_mychans', 'dm_favs', 'dm_quality', 'dm_yt_base', 'dm_yt_lastq'];
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
  function route() {
    const r = parse();
    if (r.name === 'watch') {
      if (currentKey === null) render({ name: 'home', args: [], key: 'home' });
      openWatch(r.args);
      return;
    }
    sawAppView = true;
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
    if (!['settings', 'signin', 'profiles'].includes(r.name)) cache.set(r.key, { node, y: 0, at: Date.now() });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    try { fn(node, r.args); } catch (e) { node.appendChild(msg('Something went wrong on this page: ' + e.message, true)); }
  }
  window.addEventListener('hashchange', route);
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('searchIn').value.trim();
    if (q) go('#/search/' + enc(q));
    $('searchIn').blur();
  });
  function updateMe() {
    const me = $('meBtn');
    me.replaceChildren();
    if (plex.user && plex.user.thumb && okUrl(plex.user.thumb)) me.appendChild(h('img', { src: plex.user.thumb, alt: '' }));
    else if (plex.user) me.textContent = (plex.user.name || '?').charAt(0).toUpperCase();
    else me.textContent = '⚙';
  }

  /* ---------- Home ---------- */
  VIEWS.home = (root) => {
    const hero = h('div'); root.appendChild(hero);
    const rows = h('div'); root.appendChild(rows);
    const slot = () => { const s = h('div'); rows.appendChild(s); return s; };
    const sCW = slot(), sPlex = slot(), sFav = slot(), sLive = slot(), sYT = slot(), sRadio = slot();

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
    radioSearch({ countrycode: 'US', limit: '20' }).then((list) => {
      if (!list.length) return;
      const r = row('Radio', '#/radio'); list.forEach((st) => r.scroller.appendChild(stationCard(st))); sRadio.appendChild(r.sec);
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
      root.replaceChildren(
        h('div', { class: 'page-h' }, h('h1', { text: sec.title })),
        same.length > 1 ? chips(same.map((s) => ({ id: String(s.key), label: s.title })), String(key), (c) => `#/library/${c.id}/${type}`) : null,
        chips(SORTS, sort, (c) => `#/library/${key}/${type}/${c.id}`));
      const grid = h('div', { class: 'grid posters' }); root.appendChild(grid);
      const status = msg(''); root.appendChild(status);
      const moreWrap = h('div', { class: 'more' }); root.appendChild(moreWrap);
      let start = 0, total = Infinity, busy = false;
      const PAGE = 60;
      const qsort = sort === 'unwatched' ? 'unwatched=1&sort=addedAt:desc' : 'sort=' + enc(sort);
      function more() {
        if (busy || start >= total) return;
        busy = true; status.textContent = 'Loading…';
        pget(`/library/sections/${key}/all?${qsort}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`).then((d) => {
          const mc = MC(d);
          total = mc.totalSize != null ? mc.totalSize : (mc.size < PAGE ? start + (mc.size || 0) : Infinity);
          (mc.Metadata || []).forEach((m) => grid.appendChild(plexCard(m)));
          start += (mc.Metadata || []).length || PAGE;
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
  VIEWS.live = (root, [src, cat]) => {
    src = src || (favs().length ? 'fav' : 'verified');
    const sources = [{ id: 'fav', label: '★ Favorites' }, { id: 'verified', label: 'Tested channels' }];
    if (myChannels().length) sources.push({ id: 'mine', label: 'My channels' });
    myLists().forEach((l, i) => sources.push({ id: 'list' + i, label: l.name }));
    REGIONS.forEach(([cc, name]) => sources.push({ id: 'cc-' + cc, label: name }));
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
        note.appendChild(h('div', { class: 'msg' }, `Showing the ${d.ok} of ${d.total} channels that passed a playback check on ${when}. `,
          h('a', { href: '#/live/all-' + cc, style: { textDecoration: 'underline' }, text: 'Show all ' + d.total }), '.'));
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
  VIEWS.iptv = (root, [cat, q]) => {
    if (!iptvCfg()) {
      root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'IPTV' })));
      root.appendChild(iptvSetupCard(() => { currentKey = null; render(parse()); }));
      return;
    }
    const search = h('input', { type: 'text', value: q || '', placeholder: 'Find a channel', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const catSel = h('select', {});
    const doFilter = () => go('#/iptv/' + enc(catSel.value) + (search.value.trim() ? '/' + enc(search.value.trim()) : ''), true);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFilter(); });
    catSel.addEventListener('change', doFilter);
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'IPTV' }),
      h('div', { class: 'btns' }, h('button', { class: 'btn ghost', type: 'button', text: 'Refresh list', onclick: () => { iptvData = null; invalidate('iptv'); currentKey = null; render(parse()); } }),
        h('a', { class: 'btn ghost', href: '#/settings', text: 'Provider settings' }))));
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
  };


  /* ---------- Radio ---------- */
  VIEWS.radio = (root, [tag]) => {
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: 'Radio' })));
    root.appendChild(chips([{ id: '', label: 'Popular' }].concat(RADIO_TAGS.map((t) => ({ id: t, label: t[0].toUpperCase() + t.slice(1) }))), tag || '', (c) => '#/radio' + (c.id ? '/' + c.id : '')));
    root.appendChild(msg('Free internet radio from the radio-browser.info directory. Plays in the background while you browse.'));
    const body = h('div'); root.appendChild(body); body.appendChild(msg('Loading stations…'));
    radioSearch(tag ? { tag, countrycode: 'US' } : { countrycode: 'US' }).then((list) => {
      body.replaceChildren();
      const grid = h('div', { class: 'grid wide' }); list.forEach((st) => grid.appendChild(stationCard(st))); body.appendChild(grid);
    }).catch((e) => body.replaceChildren(msg('Could not load stations: ' + e.message, true)));
  };

  /* ---------- Search ---------- */
  VIEWS.search = (root, [q]) => {
    q = q || '';
    $('searchIn').value = q;
    root.appendChild(h('div', { class: 'page-h' }, h('h1', { text: `Results for “${q}”` })));
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
        const r = row('IPTV', '#/iptv//' + enc(q)); hits.forEach((c) => r.scroller.appendChild(channelCard(c))); slots[1].appendChild(r.sec);
      }).catch(() => {}));
    }
    done.push(ytSearch(q, 16).then((res) => {
      if (!res.length) return; any = true;
      const r = row('YouTube', '#/youtube/' + enc(q)); res.forEach((x) => r.scroller.appendChild(ytCard(x))); slots[2].appendChild(r.sec);
    }).catch(() => {}));
    done.push(radioSearch({ name: q, limit: '16' }).then((list) => {
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
    idleTimer = setTimeout(() => { if (S.playing && !S.buffering && $('qMenu').hidden) player.classList.add('idle'); }, 3500);
  }
  player.addEventListener('pointerdown', showUi);
  player.addEventListener('mousemove', showUi);

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
    $('btnQuality').hidden = !P;
    if (P) $('btnQuality').textContent = (store.get('dm_quality', 'auto') === 'auto' ? 'Auto · ' : '') + P.level + 'p';
    if (err) player.classList.remove('idle');
  }
  E.hooks.onState = refreshOverlay;
  let watchChannel = null;
  E.hooks.onError = () => { if (watchChannel && !watchChannel.done && !S.firstFrameAt) { watchChannel.done = true; markHealth(watchChannel.url, false); } };
  E.hooks.onFirstFrame = () => {
    if (watchChannel && !watchChannel.done) { watchChannel.done = true; markHealth(watchChannel.url, true); } $('plNote').textContent = ''; refreshOverlay(); showUi(); };

  function openPlayerShell(title, sub) {
    stopRadio();
    playerOpen = true;
    player.hidden = false;
    document.body.classList.add('playing');
    $('plTitle').textContent = title || '';
    $('plSub').textContent = sub || '';
    $('plNote').textContent = '';
    $('upNext').hidden = true; $('qMenu').hidden = true;
    showUi();
  }
  function closeWatch() {
    playerOpen = false; watchKey = null; watchChannel = null;
    clearUpNext();
    E.teardown();
    player.hidden = true;
    document.body.classList.remove('playing');
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
    invalidate('home'); invalidate('item');
    // Return the page to the view underneath with fresh progress bars.
    const r = parse();
    if (r.name !== 'watch' && (r.key === 'home' || r.name === 'item') && currentKey === r.key) { currentKey = null; render(r); }
  }
  function wantAutoplay() {
    const ctx = E.ensureCtx();
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
  function startPlexAt(off, auto) {
    if (!P) return;
    off = Math.max(0, Math.min(Math.floor(off), Math.max(0, Math.floor(P.duration) - 5)));
    const q = QUALITIES.find((x) => x.id === P.level) || QUALITIES[1];
    if (P.sid) stopTranscode(P.sid);
    P.sid = newSid(); P.offset = off;
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
  E.hooks.onTeardown = () => { if (!restarting) endPlex(); };
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
  $('plBack').addEventListener('click', () => { if (sawAppView) history.back(); else go('#/home', true); });
  $('btnFs').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
    else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
  });
  $('btnQuality').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('qMenu');
    if (!menu.hidden) { menu.hidden = true; return; }
    const cur = store.get('dm_quality', 'auto');
    menu.replaceChildren(
      h('button', { type: 'button', class: cur === 'auto' ? 'on' : '', text: 'Automatic', onclick: () => pickQ('auto') }),
      QUALITIES.map((q) => h('button', { type: 'button', class: cur === q.id ? 'on' : '', text: q.label, onclick: () => pickQ(q.id) })));
    menu.hidden = false;
  });
  function pickQ(id) {
    $('qMenu').hidden = true;
    store.set('dm_quality', id);
    if (!P) return;
    const lvl = id === 'auto' ? startLevel() : id;
    if (lvl === P.level) { refreshOverlay(); return; }
    P.level = lvl; P.stalls = [];
    startPlexAt(plexPos(), true);
  }
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

  /* ---------- start ---------- */
  updateMe();
  if (plex.auth && !plex.user && parse().name !== 'profiles') go('#/profiles', true);
  route();
})();
