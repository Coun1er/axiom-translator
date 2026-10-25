// Runs in Axiom's MAIN world. Reads only selected native React social/token props.
// No WS interception, no MSF messages, no auth-token or cookie extraction.
(() => {
  'use strict';
  const REQUEST = 'AXNT_PULSE_CONTEXT_REQUEST';
  const RESPONSE = 'AXNT_PULSE_CONTEXT_RESPONSE';
  const secret = /^(?:authorization|cookie|cookies|headers|auth|authentication|auth[-_].*|authAccessToken|authRefreshToken|access.?token|refresh.?token|api.?key|password|wallets?|private.?key|seed|session)$/i;
  function clean(value, depth = 0, seen = new WeakSet()) {
    if (depth > 18) throw new Error('Слишком глубокий контекст Twitter — данные не обрезаны, запрос остановлен.');
    if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object' || value instanceof Node) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(v => clean(v, depth + 1, seen));
      const out = {};
      for (const [k,v] of Object.entries(value)) {
        if (secret.test(k) || ['children','ref','_owner'].includes(k) || k.startsWith('__')) continue;
        const safe = clean(v, depth + 1, seen);
        if (safe !== undefined) out[k] = safe;
      }
      return out;
    } finally { seen.delete(value); }
  }
  function extract(roots) {
    const token = {};
    const social = [];
    const dedup = new Set();
    const visited = new WeakSet();
    const tokenFields = ['tokenAddress','tokenName','tokenTicker','tokenImage','pairAddress','twitter','twitterHandle','twitterFollowers','twitterFollowing','twitterHandleHistory','tweetCreatedAt'];
    function inspect(p, depth = 0) {
      if (!p || typeof p !== 'object' || Array.isArray(p) || depth > 3) return;
      if (visited.has(p)) return;
      visited.add(p);
      for (const k of tokenFields) if (p[k] != null) token[k] ??= clean(p[k]);
      for (const [k,v] of Object.entries(p)) {
        if (v == null || typeof v !== 'object' || v instanceof Node) continue;
        if (/^(?:tweet|tweetData|cachedTweetData|tweetInfo|tweetPreview|preview|quotedTweet|quotedPost|replyContext|userInfo|userData|twitterData|twitterUser|profile|author|community|communityInfo|supplementalData|tweets|previousTweets|recentTweets)$/i.test(k)) {
          const data = clean(v);
          const encoded = JSON.stringify(data);
          if (encoded && encoded !== '{}' && !dedup.has(encoded)) { dedup.add(encoded); social.push({field:k,data}); }
        } else if (/^(?:data|token|coin|pair|tokenInfo|pairInfo|info|user|account)$/i.test(k)) {
          if (!Array.isArray(v) && ['screen_name','screenName','followers_count','followersCount','quoted_status','full_text'].some(key=>key in v)) {
            const data=clean(v), encoded=JSON.stringify(data);
            if (!dedup.has(encoded)) {dedup.add(encoded);social.push({field:k,data});}
          }
          inspect(v, depth + 1);
        }
      }
    }
    for (const root of roots.filter(Boolean)) {
      // Inspect selected card descendants as well: quoted tweets have their own component.
      for (const el of [root, ...root.querySelectorAll('a,img,span,p')]) {
        let fiber = el[Object.keys(el).find(k => k.startsWith('__reactFiber'))];
        for (let i = 0; fiber && i < 18; i++, fiber = fiber.return) {
          inspect(fiber.memoizedProps);
          // Never walk into application-wide stores or hook state.
        }
        const props = el[Object.keys(el).find(k => k.startsWith('__reactProps'))];
        inspect(props);
      }
    }
    return {token, social};
  }
  const accounts = new Map();
  function nativeAuthors(social) {
    const handles=new Set();
    const visit=(v,depth=0)=>{
      if (!v || typeof v!=='object' || depth>18) return;
      if ((v.followers!=null || v.followers_count!=null || v.followersCount!=null)) {
        const h=v.userName || v.screen_name || v.screenName || v.handle;
        if(typeof h==='string' && /^[\w]{1,15}$/.test(h)) handles.add(h);
      }
      for(const child of Object.values(v)) if(child && typeof child==='object') visit(child,depth+1);
    };
    visit(social);return [...handles];
  }
  async function account(handle) {
    const k = handle.toLowerCase();
    const saved = accounts.get(k);
    if (saved && Date.now() - saved.time < 60000) return saved.promise;
    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const url = 'https://api.axiom.trade/wo/twitter-user-info-v2?twitterHandle=' + encodeURIComponent(handle) + '&v=2';
        const response = await fetch(url, {credentials:'include', signal:controller.signal});
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return {handle, source:'axiom/twitter-user-info-v2', data:clean(await response.json())};
      } catch (e) {
        accounts.delete(k);
        return {handle, error:e.name === 'AbortError' ? 'Таймаут Axiom (8с)' : String(e.message)};
      } finally { clearTimeout(timer); }
    })();
    accounts.set(k, {time:Date.now(),promise});
    if (accounts.size > 100) accounts.delete(accounts.keys().next().value);
    return promise;
  }
  window.addEventListener('message', async event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.type !== REQUEST || !/^[\w-]{1,100}$/.test(m.id || '')) return;
    const trigger = document.querySelector('[data-axnt-trigger="' + m.id + '"]');
    const popup = document.querySelector('[data-axnt-popup="' + m.id + '"]');
    if (!trigger && !popup) return;
    try {
      const native = extract([trigger, popup]);
      let authors = [];
      if (m.enrich === true) {
        const handles = [...new Set([...nativeAuthors(native.social),...(m.handles || [])].filter(h => typeof h === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(h)))];
        // Only authors from this selected card; never a background scan of Pulse.
        if (handles.length > 8) throw new Error('В карточке больше восьми авторов. Проверь выбранное окно.');
        authors = await Promise.all(handles.map(account));
      }
      window.postMessage({type:RESPONSE,id:m.id,ok:true,native,authors}, location.origin);
    } catch (e) { window.postMessage({type:RESPONSE,id:m.id,ok:false,error:String(e.message)}, location.origin); }
  });
})();
