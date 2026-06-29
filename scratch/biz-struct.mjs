import { writeFileSync } from 'node:fs';
const TOKEN='790fd1b8-d55c-49be-857f-aadc31292a51';
async function unlock(url){
  const r=await fetch('https://api.brightdata.com/request',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify({zone:'web_unlocker1',url,format:'json'})});
  let j={};try{j=JSON.parse(await r.text());}catch{}
  return j.body||'';
}
const search=await unlock('https://www.bizapedia.com/search/?qfn='+encodeURIComponent('RED HAT'));
writeFileSync('scratch/biz-search.html',search);
console.log('search len',search.length);
// company result links
const links=[...search.matchAll(/href="(\/[a-z]{2}\/[a-z0-9-]+\.html)"/gi)].map(m=>m[1]).filter((v,i,a)=>a.indexOf(v)===i);
console.log('result links (first 8):', links.slice(0,8).join('\n  '));
const company=await unlock('https://www.bizapedia.com'+(links[0]||'/nc/red-hat-inc.html'));
writeFileSync('scratch/biz-company.html',company);
console.log('company len',company.length,'url=',links[0]);
