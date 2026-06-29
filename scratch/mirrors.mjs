const TOKEN='790fd1b8-d55c-49be-857f-aadc31292a51';
async function unlock(url){
  const r=await fetch('https://api.brightdata.com/request',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify({zone:'web_unlocker1',url,format:'json'})});
  return await r.text();
}
function pj(t){try{return JSON.parse(t);}catch{return{};}}
for (const [label,url] of [
  ['OpenCorporates NC search','https://opencorporates.com/companies/us_nc?q=red+hat&utf8=%E2%9C%93'],
  ['Bizapedia search','https://www.bizapedia.com/north-carolina/red-hat-inc.html'],
]){
  const j=pj(await unlock(url));
  const b=j.body||'';
  console.log(`\n=== ${label}\n  status_code:${j.status_code} body_len:${b.length}`);
  // signals that real content loaded
  console.log('  has "registered agent":', /registered agent/i.test(b), '| has "officer"/"member":', /officer|member|manager/i.test(b), '| title tag:', (b.match(/<title>([^<]{0,80})/i)||[])[1]||'');
}
