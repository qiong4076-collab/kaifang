import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
test('manual orders require payment review, authorization and server-owned pricing',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'ai-subscription-test-'));
 let child,base;
 async function start(){
  child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:folder,PUBLIC_ORIGIN:'',ADMIN_PASSWORD:'test-only-admin-credential-2026',CARD_ENCRYPTION_KEY:'c'.repeat(64)},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',c=>stderr+=c.toString());
  base=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Server startup timed out: '+stderr)),10000);
   child.stdout.on('data',c=>{const m=c.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
   child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited before startup: '+code+' '+stderr));});
  });
 }
 async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
 async function request(path,{method='GET',body,cookie,token,origin=base}={}){
  const headers={};if(body){headers['Content-Type']='application/json';}
  if(method!=='GET')headers.Origin=origin;
  if(cookie)headers.Cookie=cookie;
  if(token)headers['X-Order-Token']=token;
  const res=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
 }
 try{
  await start();
  assert.equal((await request('/api/admin/orders')).status,401);
  assert.equal((await request('/api/site')).data.acceptingOrders,false);
  const payload={productId:'plus',contact:'=SUM(1,2)',accountEmail:'customer@example.com',method:'alipay',agreed:true,note:'Test order',amountCents:1};
  assert.equal((await request('/api/orders',{method:'POST',body:payload})).status,503);
  assert.equal((await request('/api/admin/login',{method:'POST',origin:'https://another.example',body:{password:'test-only-admin-credential-2026'}})).status,403);
  assert.equal((await request('/api/admin/login',{method:'POST',body:{password:'wrong-credential'}})).status,401);
  const login=await request('/api/admin/login',{method:'POST',body:{password:'test-only-admin-credential-2026'}});
  assert.equal(login.status,200);assert.match(login.cookie,/admin_session=/);
  const adminCookie=login.cookie;
  assert.equal((await request('/api/admin/settings',{method:'PATCH',cookie:adminCookie,body:{brand:'AI 订阅服务',wechat:'test-customer-support',supportEmail:'support@example.com',serviceHours:'Test hours',alipayQr:'/test-alipay.png',wechatQr:'',acceptingOrders:true,refundPolicy:'Test refund policy'}})).status,200);
  assert.equal((await request('/api/admin/products/plus',{method:'PATCH',cookie:adminCookie,body:{priceCents:17900,enabled:true}})).status,200);
  const created=await request('/api/orders',{method:'POST',body:payload});
  assert.equal(created.status,201);assert.equal(created.data.order.amountCents,17900);
  assert.equal(created.data.order.status,'awaiting_payment');
  const {id,token}=created.data;
  assert.equal((await request('/api/orders/'+id,{token:'incorrect'})).status,404);
  const own=await request('/api/orders/'+id,{token});
  assert.equal(own.status,200);assert.equal(own.data.account_email,undefined);assert.equal(own.data.access_hash,undefined);
  assert.equal((await request('/api/orders/'+id+'/payment',{method:'POST',token,origin:'https://another.example',body:{reference:'test-payment'}})).status,403);
  const submission=await request('/api/orders/'+id+'/payment',{method:'POST',token,body:{reference:'test-payment'}});
  assert.equal(submission.status,200);assert.equal(submission.data.status,'payment_submitted');
  assert.notEqual(submission.data.status,'paid');
  assert.equal((await request('/api/orders/'+id+'/payment',{method:'POST',token,body:{reference:'repeat'}})).status,409);
  let rows=(await request('/api/admin/orders',{cookie:adminCookie})).data.orders;
  let order=rows.find(o=>o.id===id);
  assert.equal((await request('/api/admin/orders/'+id,{method:'PATCH',cookie:adminCookie,body:{version:order.version,status:'completed',note:''}})).status,400);
  assert.equal((await request('/api/admin/orders/'+id,{method:'PATCH',body:{version:order.version,status:'paid',note:''}})).status,401);
  assert.equal((await request('/api/admin/orders/'+id,{method:'PATCH',cookie:adminCookie,body:{version:order.version,status:'paid',note:'Confirmed in actual account'}})).status,200);
  assert.equal((await request('/api/admin/orders/'+id,{method:'PATCH',cookie:adminCookie,body:{version:order.version,status:'processing',note:''}})).status,409);
  for(const next of ['processing','completed']){
   rows=(await request('/api/admin/orders',{cookie:adminCookie})).data.orders;order=rows.find(o=>o.id===id);
   assert.equal((await request('/api/admin/orders/'+id,{method:'PATCH',cookie:adminCookie,body:{version:order.version,status:next,note:'Internal note'}})).status,200);
  }
  const csv=await fetch(base+'/api/admin/export',{headers:{Cookie:adminCookie}});assert.equal(csv.status,200);assert.ok((await csv.text()).includes("'=SUM"));
  const cardCode='TEST-ONLY-STANDALONE-CARD-1234';
  assert.equal((await request('/api/admin/products/go',{method:'PATCH',cookie:adminCookie,body:{priceCents:100,enabled:true,deliveryMode:'card',deliveryInstructions:'TEST ONLY REDEMPTION'}})).status,200);
  assert.equal((await request('/api/admin/cards/import',{method:'POST',cookie:adminCookie,body:{productId:'go',codes:cardCode+'\n'+cardCode}})).data.imported,1);
  const cardOrder=await request('/api/orders',{method:'POST',body:{productId:'go',contact:'test',method:'alipay',agreed:true}});
  assert.equal(cardOrder.status,201);assert.equal(cardOrder.data.order.delivery.code,undefined);
  assert.equal((await request('/api/admin/orders/'+cardOrder.data.id+'/deliver',{method:'POST',cookie:adminCookie,body:{}})).status,409);
  const auto=await request('/api/admin/orders/'+cardOrder.data.id,{method:'PATCH',cookie:adminCookie,body:{version:1,status:'paid'}});
  assert.equal(auto.status,200);assert.equal(auto.data.delivered,true);
  assert.equal((await request('/api/orders/'+cardOrder.data.id,{token:cardOrder.data.token})).data.delivery.code,cardCode);
  await request('/api/admin/orders/'+cardOrder.data.id+'/deliver',{method:'POST',cookie:adminCookie,body:{}});
  const stock=(await request('/api/admin/cards',{cookie:adminCookie})).data;
  assert.equal(stock.counts.find(p=>p.id==='go').delivered,1);assert.ok(!JSON.stringify(stock).includes(cardCode));
  await stop();await start();
  assert.equal((await request('/api/orders/'+cardOrder.data.id,{token:cardOrder.data.token})).data.delivery.code,cardCode);
  assert.equal((await request('/api/orders/'+id,{token})).data.status,'completed');
  assert.equal((await request('/api/admin/orders',{cookie:adminCookie})).status,401);
  assert.equal((await request('/api/site')).data.acceptingOrders,true);
 }finally{await stop();await rm(folder,{recursive:true,force:true});}
});
