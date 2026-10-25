// Transport adapted from Axiom Live Translator (made by lewzyx), as requested:
// two parallel GET endpoints, first valid response, 3s timeout, ~600-char chunks.
// No provider change, automatic retries or token-wide translation scan.
'use strict';
const TR_TIMEOUT_MS = 3000;
const TR_CHUNK_CHARS = 600;
const translationCache = new Map();
const translationInflight = new Map();

function translationChunks(text, max = TR_CHUNK_CHARS) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('\n',max),rest.lastIndexOf('. ',max),rest.lastIndexOf(' ',max));
    if (cut < max * .5) cut = max;
    // Do not split an emoji surrogate pair at the boundary.
    if (/[\uD800-\uDBFF]/.test(rest[cut]) && /[\uDC00-\uDFFF]/.test(rest[cut+1] || '')) cut--;
    parts.push(rest.slice(0,cut+1));
    rest = rest.slice(cut+1);
  }
  if (rest) parts.push(rest);
  return parts;
}
function parseTranslationGtx(data) {
  if (!Array.isArray(data?.[0])) throw new Error('unexpected response');
  return {text:data[0].map(s=>typeof s?.[0] === 'string'?s[0]:'').join(''), detected:data[2] || ''};
}
function parseTranslationChrome(data) {
  if (data && Array.isArray(data.sentences)) return {text:data.sentences.map(s=>s.trans || '').join(''),detected:data.src || ''};
  if (Array.isArray(data)) {
    if (typeof data[0] === 'string') return {text:data[0],detected:''};
    if (Array.isArray(data[0])) return {text:data[0][0] || '',detected:data[0][1] || ''};
  }
  throw new Error('unexpected response');
}
const TRANSLATION_ENDPOINTS = [
  {host:'translate.googleapis.com',url:(q,tl)=>`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${q}`,parse:parseTranslationGtx},
  {host:'clients5.google.com',url:(q,tl)=>`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${tl}&q=${q}`,parse:parseTranslationChrome}
];
async function translatePart(text,targetLang) {
  const q=encodeURIComponent(text), tl=encodeURIComponent(targetLang);
  try {
    return await Promise.any(TRANSLATION_ENDPOINTS.map(async endpoint=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),TR_TIMEOUT_MS);
      try {
        // Deliberately identical to the reference: GET, no body or custom headers.
        const response=await fetch(endpoint.url(q,tl),{signal:controller.signal});
        if (!response.ok) throw new Error('HTTP '+response.status);
        const result=endpoint.parse(await response.json());
        if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('empty response');
        return {...result,source:endpoint.host};
      } catch(e) {throw new Error(endpoint.host+': '+(e.name==='AbortError'?'timeout (3s)':e.message));}
      finally {clearTimeout(timer);}
    }));
  } catch(e) {throw new Error(e.errors?e.errors.map(x=>x.message).join(' / '):e.message);}
}
async function translate(text,targetLang='ru') {
  if (typeof text!=='string' || !text.trim()) return {ok:false,error:'empty text'};
  const key=targetLang+'|'+text;
  if (translationCache.has(key)) return {...translationCache.get(key),cached:true};
  if (translationInflight.has(key)) return translationInflight.get(key);
  const job=(async()=>{
    try {
      const parts=await Promise.all(translationChunks(text).map(part=>translatePart(part,targetLang)));
      const result={ok:true,translated:parts.map(p=>p.text).join(''),detected:parts.find(p=>p.detected)?.detected || '',sources:[...new Set(parts.map(p=>p.source))]};
      translationCache.set(key,result);
      if (translationCache.size>500) translationCache.delete(translationCache.keys().next().value);
      return result;
    } catch(e) {return {ok:false,error:e.message};}
  })();
  translationInflight.set(key,job);
  try {return await job;} finally {translationInflight.delete(key);}
}
