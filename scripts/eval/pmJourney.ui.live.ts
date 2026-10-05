import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test, expect } from 'vitest';
import { freshPglite } from '../../server/postgres/pglite';
import { createRuntime } from '../../server/runtime';
import { createApp } from '../../server/app';
import { serveApi } from '../../server/http/api';
import { scriptedHttp } from '../../src/product/testkit/connectorContract';
import { manualClock } from '../../src/product/ports/clock';
import { schedulerTick } from '../../src/product/app/scheduler';
import { runOneJob } from '../../src/product/app/monitoring';
import { sentryRoute, NOW as SENTRY_NOW } from '../../src/product/integrations/connectors/__fixtures__/sentry';

// Manual local browser acceptance. Build first, then set JAGR_LIVE_EVAL=1 and
// JAGR_PLAYWRIGHT_PATH to an installed Playwright module and run this file with Vitest.
// PGlite, identity, credentials and provider responses are disposable fixtures.
// This proves the application journey, not Google OAuth or hosted scheduler reliability.
test('automatic PM journey in an isolated workspace, synthetic providers only', {timeout:300000}, async()=>{
 const require=createRequire(import.meta.url);
 const playwrightPath=process.env.JAGR_PLAYWRIGHT_PATH;
 if(!playwrightPath)throw new Error('Set JAGR_PLAYWRIGHT_PATH to an installed Playwright module for this local fixture test.');
 const {chromium}=require(playwrightPath);
 const now=Math.floor(Date.now()/3600000)*3600000; const H=3600000;
 const times=Array.from({length:193},(_,i)=>now-192*H+i*H);
 const local=(n:number)=>new Date(n).toISOString().slice(0,19);
 const delta=now-Date.parse(SENTRY_NOW);
 const shift=(v:any):any=>Array.isArray(v)?v.map(shift):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,shift(x)])):typeof v==='number'&&v>1000000000?v+delta/1000:typeof v==='string'&&/^2026-09-\d\dT/.test(v)?new Date(Date.parse(v)+delta).toISOString():v;
 let mode='anomaly'; const clock=manualClock(new Date(now).toISOString());
 const {http}=scriptedHttp((u)=>{
  if(u.hostname==='amplitude.com'){
   if(mode==='unavailable')return {status:503,body:{error:'synthetic outage'}};
   if(u.pathname==='/api/2/annotations')return {body:{data:[]}};
   if(u.pathname==='/api/2/events/segmentation'){
    const event=JSON.parse(u.searchParams.get('e')??'{}').event_type;
    const selected=mode==='incomplete'?times.filter(t=>t<now-24*H||t===now-H):times;
    return {body:{data:{series:[selected.map(t=>event==='Checkout Started'?100:mode==='quiet'?80:t>=now-4*H?40:80)],seriesLabels:[0],xValues:selected.map(local)}}};
   }
  }
  const r=sentryRoute(u); if(r)return {...r,body:shift(r.body)};
  return undefined;
 });
 let base=''; let held=false; let release=()=>{};
 const gate=new Promise<void>(r=>release=r);
 const rt=await createRuntime({JAGR_SESSION_SECRET:randomBytes(32).toString('hex'),JAGR_SECRET_KEY:randomBytes(32).toString('base64'),JAGR_APP_URL:'http://127.0.0.1'}, {sql:await freshPglite(),clock,http:async(u,init)=>{if(held)await gate;return http(u,init)},identity:{google:{id:'google',authorizationUrl:({state})=>`${base}/api/auth/google/callback?code=pm&state=${state}`,exchange:async()=>({provider:'google',subject:'pm-beta-fixture',emailVerified:true,displayName:'Fixture PM'})}}});
 const app=createApp(rt);
 const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
 const server=createServer((req,res)=>{const path=new URL(req.url??'/','http://x').pathname;if(path.startsWith('/api/'))return void serveApi(app,req,res);const file=join('dist',path);const target=path!=='/'&&existsSync(file)?file:'dist/index.html';res.setHeader('content-type',types[extname(target)]??'application/octet-stream');res.end(readFileSync(target));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as any).port}`;
 const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}, timezoneId:'Asia/Kolkata', locale:'en-IN'});page.setDefaultTimeout(10000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
 const mark=(s:string)=>console.log('BROWSER PASS:',s);
 try{
  await page.goto(base); await page.screenshot({path:'/tmp/jagr-pm-beta-landing.png',fullPage:true});mark('fresh landing/auth boundary');
  await page.goto(base+'/settings');
  await page.getByRole('link',{name:'Continue with Google',exact:true}).click();
  await page.getByText(/Signed in as Fixture PM/).waitFor();mark('fixture sign-in');
  await page.getByLabel('Workspace name').fill('PM beta disposable');await page.getByRole('button',{name:'Create workspace',exact:true}).click();await page.getByText('PM beta disposable',{exact:false}).first().waitFor();
  await page.goto(base+'/');await page.getByText('Connect your product stack',{exact:false}).first().waitFor();mark('workspace/onboarding');
  await page.goto(base+'/sources');
  async function connect(provider:string){const card=page.locator('div',{has:page.getByText(provider,{exact:true})}).filter({has:page.getByRole('button',{name:'Connect',exact:true})}).last();await card.getByRole('button',{name:'Connect',exact:true}).click();}
  await connect('Amplitude');
  expect(await page.locator('textarea').count()).toBe(0);
  await page.getByLabel('Successful event name').fill('Order Completed');await page.getByLabel('Started event name').fill('Checkout Started');
  await page.getByLabel('API key',{exact:true}).fill('fixture-amplitude-key');await page.getByLabel('Secret key',{exact:true}).fill('fixture-amplitude-secret');
  await page.getByRole('button',{name:'Connect and test',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();mark('Amplitude structured setup and verification');
  await connect('Sentry');await page.getByLabel(/^Organization/).fill('acme');await page.getByLabel(/^Projects/).fill('42');await page.getByLabel(/^Environment/).fill('production');await page.getByLabel('Sentry search query (empty means all errors)').fill('transaction:/checkout*');await page.getByLabel('Auth token (org:read, project:read, event:read)',{exact:true}).fill('fixture-sentry-token');
  await page.getByRole('button',{name:'Connect and test',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();mark('Sentry structured setup and verification');
  const ws=(await rt.repos.members.forUser((await rt.repos.users.byIdentity('google','pm-beta-fixture'))!.id))[0].workspaceId;
  await page.goto(base+'/watches?new=1');
  for(let i=0;i<5;i++){await page.getByRole('button',{name:'Next',exact:true}).click();}
  await page.getByRole('button',{name:'Create watch',exact:true}).last().click();await page.getByText('Watch created',{exact:true}).waitFor();mark('watch configured entirely through UI');
  await page.getByRole('button',{name:'Start watching',exact:true}).click();
  // The existing application scheduler executes without a Run Now request. This does not test a hosted trigger.
  clock.advance(3600000);
  const tick = await schedulerTick(rt);
  expect(tick.failedWorkspaceIds).toEqual([]);
  expect(tick.enqueued).toBeGreaterThan(0);
  for(let i=0;i<20;i++){const job=await runOneJob(rt,{workerId:'fixture-scheduled-worker',leaseMs:60000});if(job.state==='idle')break;expect(job.state).toBe('completed');}
  await page.goto(base+'/watches');
  await page.getByRole('heading',{name:'Watches',exact:true}).waitFor();
  await page.getByText(/Watching · needs attention/).first().waitFor();
  expect(await page.locator('main').innerText()).toContain('Watching');
  expect(await page.locator('main').innerText()).toMatch(/IST|GMT\\+5:30/);
  expect(await page.locator('main').innerText()).not.toContain(' UTC');
  mark('automatic scheduled application execution and local timezone');
  await page.goto(base+'/');await page.getByRole('button',{name:'Run now',exact:true}).first().click();await page.getByText('Queued — waiting to check',{exact:true}).first().waitFor();mark('queued status');
  held=true; const worker=runOneJob(rt,{workerId:'fixture-browser-worker',leaseMs:60000});
  await page.getByText('Checking',{exact:true}).first().waitFor({timeout:20000});mark('checking status');release();await worker;await page.getByText('Completed · Important change detected — review the investigation.',{exact:true}).first().waitFor({timeout:20000});await page.getByRole('link',{name:'Open investigation',exact:true}).first().waitFor();mark('completed status and investigation link without refresh');
  await page.goto(base+'/watches');await page.getByRole('button',{name:/run log/i}).first().click();expect(await page.locator('body').innerText()).toMatch(/z-score/);expect(await page.locator('body').innerText()).toMatch(/persistence passed/);mark('persisted anomaly diagnostics');
  const invs=await rt.repos.investigations.list(ws);expect(invs.length).toBeGreaterThan(0);const inv=invs[0];expect(inv.correlatedProviders).toEqual(expect.arrayContaining(['amplitude','sentry']));
  await page.goto(`${base}/investigations/w/${inv.id}`);await page.getByText('What is not known',{exact:true}).waitFor();const text=await page.locator('main').innerText();expect(text).toMatch(/What changed/);expect(text).toMatch(/What Jagr checked/);expect(text).toMatch(/Cause not established/);expect(text).toMatch(/Amplitude/);expect(text).toMatch(/Sentry/);expect(text).toMatch(/confidence/i);expect(text).toMatch(/Recommendations only/);expect(text).not.toMatch(/Already completed|Do it|simulated tracker/);await page.screenshot({path:'/tmp/jagr-pm-beta-investigation.png',fullPage:true});mark('multi-source investigation, evidence, confidence, unknowns and no fake action');
  await page.getByLabel('Somewhat useful',{exact:true}).check();await page.getByLabel('Missing evidence',{exact:true}).check();await page.getByLabel('What was missing? (optional)').fill('External payment-provider status');await page.getByRole('button',{name:'Save feedback',exact:true}).click();await page.getByText('Feedback saved to this workspace. Thank you.',{exact:true}).waitFor();const audit=(await rt.repos.audit.list(ws)).filter(x=>x.action==='investigation.feedback');expect(audit).toHaveLength(1);expect(JSON.parse(audit[0].detail!).usefulness).toBe('somewhat_useful');mark('feedback saved through authenticated API and persisted');
  await page.goto(base+'/demo');await page.getByText(/DEMO.*SCRIPTED REPLAY.*No changes are made/).first().waitFor();await page.goto(base+'/tasks');expect(await page.locator('main').innerText()).not.toMatch(/PAY-284|Demo checkout task/);expect(await rt.repos.investigations.list(ws)).toHaveLength(invs.length);mark('demo/customer separation');
  // A separate real watch over fixture data exercises negative execution outcomes.
  await page.goto(base+'/watches');await page.getByRole('button',{name:'Pause',exact:true}).first().click();
  await expect.poll(async()=> (await rt.repos.watches.list(ws)).filter(w=>w.status==='active').length).toBe(0);
  await page.evaluate(async()=>{const csrf=decodeURIComponent(document.cookie.split('; ').find(c=>c.startsWith('jagr_csrf='))!.slice(10));const ws=localStorage.getItem('jagr:server-workspace');const r=await fetch(`/api/workspaces/${ws}/watches`,{method:'POST',headers:{'content-type':'application/json','x-jagr-csrf':csrf},body:JSON.stringify({templateId:'checkout_health',name:'Coverage test',sources:['amplitude']})});if(!r.ok)throw new Error(`fixture watch ${r.status}`);});
  for(const [scenario,copy] of [['quiet','No important change detected.'],['incomplete','Not enough evidence to determine whether this changed.'],['unavailable',"Source unavailable — Jagr couldn't complete every required check."]] as const){
   mode=scenario;clock.advance(1800000);held=false;await page.goto(base+'/');await page.getByRole('button',{name:'Run now',exact:true}).first().click();await page.getByText('Queued — waiting to check',{exact:true}).first().waitFor();await runOneJob(rt,{workerId:'fixture-negative-worker',leaseMs:60000});await page.getByText('Completed · '+copy,{exact:true}).first().waitFor({timeout:20000});mark(scenario+' execution remains truthful');
  }
  expect(errors).toEqual([]);
 }catch(e){await page.screenshot({path:'/tmp/jagr-pm-beta-browser-failure.png',fullPage:true});console.log('BROWSER FAILURE URL',page.url());console.log((await page.locator('body').innerText()).slice(0,10000));throw e;}finally{release();await browser.close();server.close();}
});
