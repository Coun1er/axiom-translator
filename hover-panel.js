// Selected Twitter hovers only. No token-wide translation or AI prefetch.
(() => {
  'use strict';
  const states = new WeakMap();
  const translations = new Map();
  const translating = new Map();
  const aiResults = new Map();
  const pending = new Map();
  let intent = null;
  let scheduled = false;
  const uid = () => crypto.randomUUID();
  const trim = s => String(s || '').trim();
  const isOwn = e => e.closest?.('.axnt-panel,.axnt-inline,.axtr-panel');
  const text = el => {
    const clone = el.cloneNode(true);
    for(const div of clone.querySelectorAll('div')) {
      if(div.classList.contains('rounded-[12px]') && !div.classList.contains('cursor-pointer') && div.previousElementSibling?.querySelector('i.ri-translate')) div.remove();
    }
    clone.querySelectorAll('.axnt-panel,.axnt-inline,.axtr-panel,script,style,button').forEach(n => n.remove());
    clone.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    return trim(clone.textContent);
  };
  function boundedSet(map,key,value,max=200) { if (map.size >= max) map.delete(map.keys().next().value); map.set(key,value); }
  function rpc(type, payload) { return chrome.runtime.sendMessage({type,payload}); }
  chrome.runtime.onMessage.addListener(m => {
    if (m?.type !== 'TRANSLATE_RES') return;
    const job = pending.get(m.payload?.requestId);
    if (job) { pending.delete(m.payload.requestId); job(m.payload); }
  });
  function translate(value) {
    if (translations.has(value)) return Promise.resolve(translations.get(value));
    if (translating.has(value)) return translating.get(value);
    const id = uid();
    const job = new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ok:false,error:'Google не ответил за 15 секунд.'}); },15000);
      pending.set(id, r => { clearTimeout(timer); resolve(r); });
      rpc('TRANSLATE_REQ',{requestId:id,text:value,targetLang:'ru'}).catch(() => {
        pending.delete(id); clearTimeout(timer); resolve({ok:false,error:'Расширение обновлено — перезагрузи страницу.'});
      });
    }).then(result => {
      if (result.ok && result.translated?.trim()) boundedSet(translations,value,result);
      return result;
    }).finally(() => translating.delete(value));
    translating.set(value,job);
    return job;
  }
  const nativePending = new Map();
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'AXNT_PULSE_CONTEXT_RESPONSE') return;
    nativePending.get(event.data.id)?.(event.data);
  });
  function nativeContext(s,enrich=false,handles=[]) {
    return new Promise(resolve => {
      const id = uid();
      const oldTrigger = s.trigger.getAttribute('data-axnt-trigger');
      s.trigger.setAttribute('data-axnt-trigger',id);
      s.popup.setAttribute('data-axnt-popup',id);
      const done = r => {
        clearTimeout(timer); nativePending.delete(id);
        if (s.trigger.getAttribute('data-axnt-trigger') === id) {
          if (oldTrigger) s.trigger.setAttribute('data-axnt-trigger',oldTrigger); else s.trigger.removeAttribute('data-axnt-trigger');
        }
        if (s.popup.getAttribute('data-axnt-popup') === id) s.popup.removeAttribute('data-axnt-popup');
        resolve(r);
      };
      const timer = setTimeout(() => done({ok:false,error:'Не получены данные страницы Axiom.'}), enrich ? 11000 : 2000);
      nativePending.set(id,done);
      window.postMessage({type:'AXNT_PULSE_CONTEXT_REQUEST',id,enrich,handles},location.origin);
    });
  }
  function rowOf(icon) {
    let el = icon;
    for (let i=0;el && i<15;i++,el=el.parentElement) {
      if (el.querySelector('a[href*="pump.fun/coin/"],a[href*="solscan.io/token/"]') && el.querySelector('img')) return el;
      if (el.id === 'root') break;
    }
    return icon.closest('a') || icon.parentElement;
  }
  function tokenFromDOM(row) {
    const link = row.querySelector('a[href*="pump.fun/coin/"],a[href*="solscan.io/token/"]');
    const mint = link?.href.match(/\/(?:coin|token)\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/)?.[1] || null;
    const nameNode = [...row.querySelectorAll('i.ri-file-copy-line,i.ri-file-copy-2-line')].map(i=>i.parentElement.querySelector('div.text-inherit,div.font-medium')).find(Boolean);
    const tokenImage = [...row.querySelectorAll('img[alt]')].find(i=>!i.closest('a[href*="pump.fun/coin/"]'));
    const name = nameNode ? text(nameNode) : tokenImage?.alt || null;
    const tickerNode=row.querySelector('div.text-textPrimary.font-medium');
    const ticker = tickerNode ? trim([...tickerNode.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('')) || null : null;
    return {token_address:mint,token_name:name,token_ticker:ticker};
  }
  function hoverTarget(target) {
    if (!(target instanceof Element) || isOwn(target)) return null;
    const anchor = target.closest('a');
    const icon = target.closest('i.ri-quill-pen-line,i.ri-user-line') || anchor?.querySelector('i.ri-quill-pen-line,i.ri-user-line');
    if (!icon || icon.closest('div.fixed.pointer-events-auto') || !anchor?.href.match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//)) return null;
    return {icon,anchor,kind:icon.matches('.ri-user-line')?'account':'tweet'};
  }
  document.addEventListener('mouseover', e => {
    const hit = hoverTarget(e.target);
    if (!hit) return;
    const row = rowOf(hit.icon);
    const token=tokenFromDOM(row);
    if (intent?.icon === hit.icon && intent.href === hit.anchor.href && intent.token.token_address===token.token_address) { intent.leftAt=null; intent.time=Date.now();return; }
    intent = {...hit,href:hit.anchor.href,row,token,time:Date.now(),leftAt:null};
    schedule();
  },true);
  document.addEventListener('mouseout', e => {
    if (intent?.anchor.contains(e.target) && !intent.anchor.contains(e.relatedTarget instanceof Node?e.relatedTarget:null)) intent.leftAt=Date.now();
  },true);
  function tweetBodies(popup,kind) {
    if (kind === 'account') return [...popup.querySelectorAll('p.break-words')].filter(e=>!isOwn(e));
    let nodes = [...popup.querySelectorAll('[data-testid="tweetText"],span.text-wrap.break-words,p.text-wrap.break-words')].filter(e=>!isOwn(e));
    // Axiom also uses div bodies. Restrict to explicit tweet typography, not all popup text.
    if (!nodes.length) nodes = [...popup.querySelectorAll('div.text-wrap.break-words')].filter(e=>!isOwn(e));
    return nodes.filter((e,i,all)=>text(e) && !isNativeTranslation(e,popup) && !all.some((p,j)=>i!==j && p.contains(e)));
  }
  function isNativeTranslation(el,popup) {
    for(let p=el.parentElement;p && p!==popup;p=p.parentElement) {
      // Axiom's built-in translation follows a Translate/Hide Translation button.
      const before=p.previousElementSibling;
      if(p.classList.contains('rounded-[12px]') && !p.classList.contains('cursor-pointer') && before?.querySelector('i.ri-translate')) return true;
    }
    return false;
  }
  function urls(popup) {
    return [...popup.querySelectorAll('a[href]')].filter(e=>!isOwn(e)).map(a=>({text:trim(a.textContent),url:a.href})).filter(x=>/^https?:/.test(x.url));
  }
  function snapshot(s) {
    const links = urls(s.popup);
    const headerHandles=[...s.popup.querySelectorAll('a,span.truncate')].filter(e=>!isOwn(e)&&!e.closest('span.text-wrap,p.text-wrap')).map(e=>trim(e.textContent).match(/^@([\w]{1,15})$/)?.[1]).filter(Boolean);
    const fallbackHandles=links.map(x=> {
      try {const u=new URL(x.url); return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname) ? u.pathname.match(/^\/([\w]{1,15})(?:\/status\/\d+)?\/?$/)?.[1] : null;} catch {return null;}
    }).filter(h=>h && !['i','intent','search','home','share'].includes(h.toLowerCase()));
    const handles = [...new Set(headerHandles.length?headerHandles:fallbackHandles)];
    const sourceHandle = new URL(s.href).pathname.match(/^\/([\w]{1,15})(?:\/|$)/)?.[1];
    if (!handles.length && sourceHandle) handles.push(sourceHandle);
    return {
      source:'Pulse/Axiom native hover',kind:s.kind,source_url:s.href,
      full_preview_text:text(s.popup),
      // Preserve roles/order; native React data below adds structured author/quote objects.
      text_blocks:s.bodies.map((el,i)=>({position:i,text:text(el)})),
      authors_in_preview:handles,links,
      images:[...s.popup.querySelectorAll('img')].filter(e=>!isOwn(e)).map(e=>({url:e.currentSrc||e.src,alt:e.alt||'',role:/profile|avatar|normal\./i.test(e.src)?'avatar':'media'})).filter(x=>/^https?:/.test(x.url))
    };
  }
  function iconButton(label,path) {
    const b=document.createElement('button'); b.type='button'; b.className='axnt-button';
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
    const p=document.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',path);svg.append(p);
    const caption=document.createElement('span');caption.textContent=label;b.append(svg,caption);b.caption=caption;
    return b;
  }
  function show(s,mode) {
    s.mode=mode; s.panel.dataset.mode=mode;
    s.left.setAttribute('aria-checked',String(mode==='translation'));
    s.ai.setAttribute('aria-pressed',String(mode==='ai'));
    s.left.caption.textContent='RU';
    s.left.title=mode==='ai'?'Вернуться к переводу':'Переключить оригинал / перевод';
    for (const [b,display] of s.displays) {
      const index=s.bodies.indexOf(b);
      const hide=mode==='ai' || (mode==='translation' && (s.nativeTranslationNodes.has(b) || (index>=0 && !!s.translated[index])));
      b.style.display=hide?'none':display;
    }
    s.inline.forEach((el,i)=>{el.style.display=mode==='translation' && s.translated[i]?s.displays.get(s.bodies[i]):'none';});
    s.output.hidden=mode!=='ai';
    s.output.classList.remove('axnt-error');
    s.output.textContent=mode==='ai'?(s.result?.narrative || s.aiError || 'Собираю контекст Pulse…'):'';
    if (mode==='ai' && s.aiError) s.output.classList.add('axnt-error');
    s.meta.hidden=mode!=='ai' && !(mode==='translation' && (s.translationBusy || s.translationError));
    s.meta.classList.toggle('axnt-error',mode==='translation' && !!s.translationError);
    s.meta.textContent=mode==='ai' ? (s.result ? `AI · ${s.result.model} · ${s.result.cached?'из кеша':s.result.seconds+' с'}` : 'AI запускается только по нажатию') : (s.translationError || (s.translationBusy?'Перевожу…':''));
  }
  function copyLink(source) {
    if(!source.hasAttribute('href'))return null;
    let url;
    try {url=new URL(source.getAttribute('href'),location.href);} catch {return null;}
    if (!['https:','http:'].includes(url.protocol)) return null;
    const clone=source.cloneNode(true);
    for (const el of [clone,...clone.querySelectorAll('*')]) {
      if (el!==clone && !['SPAN','B','STRONG','I','EM','SMALL','S','DEL','U','CODE','BR'].includes(el.tagName)) {
        el.replaceWith(document.createTextNode(el.textContent));continue;
      }
      for (const attr of [...el.attributes]) if(/^on/i.test(attr.name) || attr.name==='id') el.removeAttribute(attr.name);
    }
    clone.href=url.href;
    clone.rel=[...new Set((clone.rel+' noopener noreferrer').trim().split(/\s+/))].join(' ');
    return clone;
  }
  function translationPlan(body) {
    const parts=[];let buffer='';
    const flush=()=>{if(buffer){parts.push({kind:'text',text:buffer});buffer='';}};
    const visit=node=>{
      if(node.nodeType===Node.TEXT_NODE){buffer+=node.nodeValue;return;}
      if(!(node instanceof Element) || isOwn(node))return;
      if(node.tagName==='BR'){buffer+='\n';return;}
      if(node.tagName==='A'){
        flush();parts.push({kind:'link',text:text(node),link:copyLink(node)});return;
      }
      if(['SCRIPT','STYLE'].includes(node.tagName))return;
      node.childNodes.forEach(visit);
    };
    body.childNodes.forEach(visit);flush();return parts;
  }
  async function translateRun(part) {
    if(part.kind==='link' || !/[\p{L}\p{N}]/u.test(part.text))return {ok:true,translated:part.text};
    const result=await translate(part.text.trim());
    if(!result.ok)return result;
    if(!result.translated?.trim())return {ok:false,error:'пустой ответ'};
    return {...result,translated:part.text.match(/^\s*/)[0]+result.translated.trim()+part.text.match(/\s*$/)[0]};
  }
  function renderParts(target,parts,results) {
    target.replaceChildren();
    parts.forEach((part,i)=>{
      if(part.kind==='link' && part.link){target.append(part.link.cloneNode(true));
        const a=target.lastElementChild;
        // Follow the link rather than a surrounding quoted card's click handler.
        a.addEventListener('click',event=>event.stopPropagation());a.addEventListener('auxclick',event=>event.stopPropagation());return;
      }
      const value=part.kind==='link'?part.text:results[i].translated;
      value.split('\n').forEach((line,j)=>{if(j)target.append(document.createElement('br'));target.append(document.createTextNode(line));});
    });
  }
  async function startTranslation(s) {
    if (s.translationReady || s.translationBusy) return;
    s.translationBusy=true;s.translationError=null;
    if(s.mode==='translation')show(s,'translation');
    // Links are retained from the original DOM, not reconstructed from Google's
    // possibly shortened/translated URL labels. Only surrounding text is sent.
    const results=await Promise.all(s.plans.map(parts=>Promise.all(parts.map(translateRun))));
    const errors=[];
    results.forEach((runs,i)=>{
      const failed=runs.filter(r=>!r.ok || typeof r.translated!=='string');
      if (!failed.length) {
        s.translated[i]=runs.map(r=>r.translated).join('');
        renderParts(s.inline[i],s.plans[i],runs);
      } else errors.push(...failed.map(r=>r.error || 'пустой ответ'));
    });
    s.translationBusy=false;
    s.translationReady=!errors.length;
    s.translationError=errors.length?'Перевод недоступен: '+[...new Set(errors)].join('; ')+'. Исходный текст сохранён.':null;
    if (s.mode==='translation') show(s,s.mode);
  }
  function baseKey(s) {return JSON.stringify([s.token.token_address,s.href,s.preview.text_blocks,s.preview.authors_in_preview]);}
  async function startAI(s) {
    if (s.result) {s.result={...s.result,cached:true};show(s,'ai');return;}
    const cached=aiResults.get(baseKey(s));
    if (cached) {s.result={...cached,cached:true};show(s,'ai');return;}
    if (s.aiBusy) {show(s,'ai');return;}
    s.aiBusy=true;s.aiError=null;show(s,'ai');s.ai.disabled=true;
    try {
      const initial=await s.native;
      const live=await nativeContext(s,true,s.preview.authors_in_preview);
      const native=live.ok?live.native:initial.ok?initial.native:null;
      if (!native) throw new Error(live.error || initial.error);
      const t=native.token || {};
      const mint=s.token.token_address || t.tokenAddress;
      if (s.token.token_address && t.tokenAddress && s.token.token_address!==t.tokenAddress) throw new Error('Карточка токена успела смениться. Наведи на неё заново.');
      const twitterData={...s.preview,native_social:native.social,pulse_metadata:{twitter_handle:t.twitterHandle,followers:t.twitterFollowers,following:t.twitterFollowing,handle_history:t.twitterHandleHistory,tweet_created_at:t.tweetCreatedAt,token_image:t.tokenImage},accounts:live.authors || [],collection_warnings:live.ok?[]:[live.error],history_note:'Предыдущие твиты переданы только если Axiom вернул их в native_social или accounts. Отсутствующая история неизвестна.'};
      const payload={token_address:mint,token_name:t.tokenName || s.token.token_name,token_ticker:t.tokenTicker || s.token.token_ticker,twitter_handle:t.twitterHandle || s.preview.authors_in_preview[0] || null,twitter:s.href,twitter_data:twitterData};
      if (s.mode==='ai') s.output.textContent='Определяю нарратив…';
      const result=await rpc('NARRATIVE_REQ',payload);
      if (!result?.ok) throw new Error(result?.error || 'Расширение не ответило.');
      s.result=result;boundedSet(aiResults,baseKey(s),result);
    } catch(e) {s.aiError=e.message;}
    finally {s.aiBusy=false;s.ai.disabled=false;if(s.mode==='ai') show(s,'ai');}
  }
  function mount(popup,selection,bodies) {
    const s={...selection,popup,bodies,displays:new Map(bodies.map(e=>[e,e.style.display])),nativeTranslationNodes:new Set(),translated:[],inline:[],plans:bodies.map(translationPlan),mode:'translation'};
    for (const div of popup.querySelectorAll('div.cursor-pointer')) {
      if(div.classList.contains('rounded-[12px]') && div.classList.contains('border-[1px]') && bodies.some(b=>div.contains(b))) s.displays.set(div,div.style.display);
    }
    for (const span of popup.querySelectorAll('span.text-wrap.break-words,p.text-wrap.break-words')) {
      if (!isNativeTranslation(span,popup)) continue;
      let container=span.parentElement;
      while(container && container!==popup && !container.classList.contains('rounded-[12px]')) container=container.parentElement;
      if(container && container!==popup) {
        s.displays.set(container,container.style.display);
        s.nativeTranslationNodes.add(container);
        if(container.previousElementSibling?.querySelector('i.ri-translate')) {
          s.displays.set(container.previousElementSibling,container.previousElementSibling.style.display);
          s.nativeTranslationNodes.add(container.previousElementSibling);
        }
      }
    }
    s.trigger=selection.row;
    s.preview=snapshot(s);
    s.signature=bodies.map(text).join('\n\n');
    s.native=nativeContext(s); // Read-only native snapshot. No API requests on hover.
    s.panel=document.createElement('section');s.panel.className='axnt-panel';s.panel.setAttribute('aria-label','Перевод и AI-нарратив');
    const toolbar=document.createElement('div');toolbar.className='axnt-toolbar';
    s.left=iconButton('RU','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4 5 4 13 0 18-4-5-4-13 0-18Z');
    s.left.classList.add('axnt-toggle');s.left.setAttribute('role','switch');s.left.setAttribute('aria-label','Перевод на русский');
    const track=document.createElement('span');track.className='axnt-track';track.setAttribute('aria-hidden','true');const thumb=document.createElement('span');thumb.className='axnt-thumb';track.append(thumb);s.left.append(track);
    s.left.title='Переключить оригинал / перевод';
    s.ai=iconButton('AI','m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z');s.ai.title='Определить нарратив по всему контексту Pulse';
    s.ai.classList.add('axnt-ai');toolbar.append(s.left,s.ai);
    s.output=document.createElement('div');s.output.className='axnt-output';s.output.setAttribute('aria-live','polite');
    s.meta=document.createElement('div');s.meta.className='axnt-meta';
    s.panel.append(toolbar,s.output,s.meta);
    s.panel.addEventListener('click',e=>e.stopPropagation());
    s.left.addEventListener('click',()=>{const next=s.mode==='original'?'translation':s.mode==='ai'?'translation':'original';show(s,next);if(next==='translation')startTranslation(s);});
    s.ai.addEventListener('click',()=>startAI(s));
    bodies[0].before(s.panel);
    s.inline=bodies.map(body=>{const clone=body.cloneNode(false);clone.removeAttribute('id');clone.lang='ru';clone.classList.add('axnt-inline');clone.style.display='none';body.after(clone);return clone;});
    states.set(popup,s);show(s,'translation');startTranslation(s);
  }
  function scan() {
    scheduled=false;
    if (!intent || Date.now()-intent.time>20000) return;
    for (const popup of document.querySelectorAll('div.fixed.pointer-events-auto')) {
      if (intent.leftAt && Date.now()-intent.leftAt>1000 && !popup.matches(':hover')) continue;
      // Do not translate display examples, tooltips, settings, funding or buy panels.
      const original=text(popup);
      if (!/followers|подписчик|Joined|Дата регистрации/i.test(original)) continue;
      const handle=new URL(intent.href).pathname.split('/')[1];
      if (handle && !original.toLowerCase().includes(handle.toLowerCase()) && !urls(popup).some(x=>x.url.toLowerCase().includes('/'+handle.toLowerCase()))) continue;
      const bodies=tweetBodies(popup,intent.kind);
      if (!bodies.length) continue;
      const previous=states.get(popup);
      if (previous && previous.href===intent.href && previous.token.token_address===intent.token.token_address && previous.signature===bodies.map(text).join('\n\n')) continue;
      if (previous) {
        for (const [el,display] of previous.displays) el.style.display=display;
        previous.inline.forEach(el=>el.remove());
        previous.panel.remove();states.delete(popup);
      }
      mount(popup,{...intent},bodies);
    }
  }
  function schedule() {if(!scheduled){scheduled=true;setTimeout(scan,120);}}
  const observer=new MutationObserver(records=>{
    if(records.some(r=>!isOwn(r.target instanceof Element?r.target:r.target.parentElement))) schedule();
  });
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
})();
