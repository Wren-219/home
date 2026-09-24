const { WORK } = require('../lib/env');
const fs=require('fs'); const D=WORK+'/dat/'; const B='http://localhost:8081'; let cookie='';
const api=async(m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:b===undefined?undefined:JSON.stringify(b)});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];const t=await r.text();try{return JSON.parse(t)}catch{return t}};
const ok=(c,m)=>console.log((c?'  OK  ':'  XX  ')+m);
(async()=>{
  await api('POST','/api/login',{pin:'0527'});
  const now=Date.now();
  console.log('[漏了「关闭」信号：5 小时前打开，至今没收到关闭]');
  fs.writeFileSync(D+'phone.json', JSON.stringify({events:[
    {t: now-5*3600000, app:'DeepSeek', k:'open'},
    {t: now-10*60000, app:'Claude', k:'open'},
  ]}));
  const r=await api('GET','/api/phone?hours=24');
  console.log('      '+r.report.split('\n').join('\n      '));
  ok(!/DeepSeek.*还开着/.test(r.report), 'DeepSeek 不再谎报「还开着」');
  ok(/DeepSeek：1 次，共 2 小时 0 分/.test(r.report), '按两小时封顶算，不会变成 5 小时');
  ok(/Claude（从.*已经 10 分钟/.test(r.report), '刚打开 10 分钟的 Claude 照常算「正开着」');
  ok(/往少了算/.test(r.report), '并且老实说明时长偏保守');
})();
