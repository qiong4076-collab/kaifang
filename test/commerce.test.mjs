import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {handle} from '../app/api/service.js';
class D1Adapter{
 constructor(){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())this.sqlite.exec(readFileSync('drizzle/'+file,'utf8'));}
 prepare(sql){
  const database=this.sqlite;
  return {bind(...args){return {
   async first(){return database.prepare(sql).get(...args)||null;},
   async all(){return {results:database.prepare(sql).all(...args)};},
   async run(){return {meta:{changes:Number(database.prepare(sql).run(...args).changes)}};},
   runNow(){
    if(/^\s*SELECT/i.test(sql))return {results:database.prepare(sql).all(...args),meta:{changes:0}};
    return {meta:{changes:Number(database.prepare(sql).run(...args).changes)}};
   }
  };}};
 }
 async batch(items){this.sqlite.exec('BEGIN');try{const results=items.map(i=>i.runNow());this.sqlite.exec('COMMIT');return results;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
test('hosted API protects manual payments, admin ownership, prices, receipt privacy and concurrent edits',async()=>{
 const DB=new D1Adapter(),env={DB,ADMIN_BOOTSTRAP_EMAIL:'owner@example.com'},user={userId:'owner-unique-id',email:'owner@example.com'};
 async function call(path,{method='GET',body,asAdmin=false,identity,token,origin='https://site.example'}={}){
  const headers={Origin:origin};if(body)headers['Content-Type']='application/json';if(token)headers['X-Order-Token']=token;
  const request=new Request('https://site.example'+path,{method,headers,body:body?JSON.stringify(body):undefined});
  const response=await handle(request,env,identity||(asAdmin?user:null));const contentType=response.headers.get('content-type')||'';
  return {status:response.status,data:contentType.includes('json')?await response.json():await response.text()};
 }
 try{
  assert.equal((await call('/api/site')).data.acceptingOrders,false);
  assert.equal((await call('/api/admin/orders')).status,401);
  assert.equal((await call('/api/admin/login',{method:'POST',identity:{userId:'other',email:'other@example.com'},body:{}})).status,403);
  assert.equal((await call('/api/admin/login',{method:'POST',asAdmin:true,body:{}})).status,200);
  assert.equal((await call('/api/admin/session',{asAdmin:true})).data.authenticated,true);
  assert.equal((await call('/api/admin/login',{method:'POST',identity:{userId:'different-id',email:'owner@example.com'},body:{}})).status,401);
  assert.equal((await call('/api/admin/settings',{method:'PATCH',asAdmin:true,origin:'https://evil.example',body:{}})).status,403);
  const configuration={brand:'AI 订阅服务',wechat:'test-support',supportEmail:'support@example.com',serviceHours:'Test hours',alipayQr:'/test-qr.svg',wechatQr:'',refundPolicy:'Test refund policy',acceptingOrders:true};
  assert.equal((await call('/api/admin/settings',{method:'PATCH',asAdmin:true,body:configuration})).status,200);
  assert.equal((await call('/api/admin/products/plus',{method:'PATCH',asAdmin:true,body:{priceCents:17900,enabled:true}})).status,200);
  const payload={productId:'plus',contact:'=SUM(1,2)',accountEmail:'customer@example.com',method:'alipay',agreed:true,note:'Test order',amountCents:1};
  const created=await call('/api/orders',{method:'POST',body:payload});assert.equal(created.status,201);assert.equal(created.data.order.amountCents,17900);
  const {id,token}=created.data;assert.equal(created.data.order.status,'awaiting_payment');
  assert.equal((await call('/api/orders/'+id,{token:'bad'})).status,404);
  const receipt=(await call('/api/orders/'+id,{token})).data;assert.equal(receipt.account_email,undefined);assert.equal(receipt.access_hash,undefined);
  assert.equal((await call('/api/admin/products/plus',{method:'PATCH',asAdmin:true,body:{priceCents:19900,enabled:true}})).status,200);
  assert.equal((await call('/api/orders/'+id,{token})).data.amountCents,17900);
  const paid=await call('/api/orders/'+id+'/payment',{method:'POST',token,body:{reference:'test-reference'}});
  assert.equal(paid.status,200);assert.equal(paid.data.status,'payment_submitted');
  assert.equal((await call('/api/orders/'+id+'/payment',{method:'POST',token,body:{reference:'repeat'}})).status,409);
  let order=(await call('/api/admin/orders',{asAdmin:true})).data.orders[0];
  assert.equal((await call('/api/admin/orders/'+id,{method:'PATCH',body:{version:order.version,status:'paid'}})).status,401);
  assert.equal((await call('/api/admin/orders/'+id,{method:'PATCH',asAdmin:true,body:{version:order.version,status:'completed'}})).status,400);
  assert.equal((await call('/api/admin/orders/'+id,{method:'PATCH',asAdmin:true,body:{version:order.version,status:'paid'}})).status,200);
  assert.equal((await call('/api/admin/orders/'+id,{method:'PATCH',asAdmin:true,body:{version:order.version,status:'processing'}})).status,409);
  for(const status of ['processing','completed']){order=(await call('/api/admin/orders',{asAdmin:true})).data.orders[0];assert.equal((await call('/api/admin/orders/'+id,{method:'PATCH',asAdmin:true,body:{version:order.version,status}})).status,200);}
  assert.equal((await call('/api/orders/'+id,{token})).data.status,'completed');
  assert.ok((await call('/api/admin/export',{asAdmin:true})).data.includes("'=SUM"));
  assert.equal((await call('/api/admin/session',{identity:{userId:'different-id',email:'owner@example.com'}})).data.authenticated,false);
 }finally{DB.sqlite.close();}
});

test('card fulfillment requires confirmed payment, encrypts stock, protects receipts and safely retries shortages',async()=>{
 const DB=new D1Adapter(),env={DB,ADMIN_BOOTSTRAP_EMAIL:'owner@example.com',CARD_ENCRYPTION_KEY:'a'.repeat(64)},user={userId:'card-owner',email:'owner@example.com'};
 async function call(path,{method='GET',body,asAdmin=false,token}={}){
  const headers={Origin:'https://site.example'};if(body)headers['Content-Type']='application/json';if(token)headers['X-Order-Token']=token;
  const res=await handle(new Request('https://site.example'+path,{method,headers,body:body?JSON.stringify(body):undefined}),env,asAdmin?user:null);
  return {status:res.status,data:(res.headers.get('content-type')||'').includes('json')?await res.json():await res.text()};
 }
 const admin=(path,method,body)=>call(path,{method,body,asAdmin:true});
 const order=async id=>(await admin('/api/admin/orders')).data.orders.find(o=>o.id===id);
 const confirm=async id=>admin('/api/admin/orders/'+id,'PATCH',{status:'paid',version:(await order(id)).version});
 const importStock=codes=>admin('/api/admin/cards/import','POST',{productId:'plus',codes});
 try{
  await admin('/api/admin/login','POST',{});
  await admin('/api/admin/settings','PATCH',{brand:'Test',wechat:'test-support',supportEmail:'',serviceHours:'Test',alipayQr:'/test.svg',wechatQr:'',refundPolicy:'Test',acceptingOrders:true});
  assert.equal((await call('/api/admin/cards')).status,401);
  assert.equal((await call('/api/admin/cards/import',{method:'POST',body:{productId:'plus',codes:'UNAUTHORIZED'}})).status,401);
  assert.equal((await admin('/api/admin/products/plus','PATCH',{priceCents:100,enabled:true,deliveryMode:'card',deliveryInstructions:''})).status,400);
  await admin('/api/admin/products/plus','PATCH',{priceCents:100,enabled:true,deliveryMode:'card',deliveryInstructions:'TEST ONLY: use the card as instructed.'});
  const payload={productId:'plus',contact:'test-customer',accountEmail:'',method:'alipay',agreed:true};
  assert.equal((await call('/api/orders',{method:'POST',body:payload})).status,409);
  const firstCode='TEST-ONLY-SECRET-A-1234';
  assert.deepEqual((await importStock(firstCode+'\n'+firstCode)).data,{imported:1,skipped:1});
  const raw=DB.sqlite.prepare('SELECT * FROM cards').get();assert.ok(!raw.ciphertext.includes(firstCode));assert.notEqual(raw.code_hash,firstCode);
  assert.ok(!JSON.stringify((await admin('/api/admin/cards')).data).includes(firstCode));
  assert.ok(!JSON.stringify((await call('/api/site')).data).includes(firstCode));
  const a=(await call('/api/orders',{method:'POST',body:payload})).data,b=(await call('/api/orders',{method:'POST',body:payload})).data;
  assert.equal((await admin('/api/admin/orders/'+a.id+'/deliver','POST',{})).status,409);
  const submitted=await call('/api/orders/'+a.id+'/payment',{method:'POST',token:a.token,body:{reference:'TEST-NO-PAYMENT'}});
  assert.equal(submitted.data.status,'payment_submitted');assert.equal(submitted.data.delivery.code,undefined);
  assert.equal((await call('/api/orders/'+a.id,{token:b.token})).status,404);
  // Changing a product later must not change the purchased delivery contract.
  await admin('/api/admin/products/plus','PATCH',{priceCents:200,enabled:true,deliveryMode:'manual',deliveryInstructions:'NEW INSTRUCTIONS'});
  const stale=(await order(a.id)).version;
  const confirmed=await confirm(a.id);assert.equal(confirmed.data.delivered,true);
  const received=(await call('/api/orders/'+a.id,{token:a.token})).data;
  assert.equal(received.delivery.code,firstCode);assert.equal(received.delivery.instructions,'TEST ONLY: use the card as instructed.');assert.equal(received.amountCents,100);
  assert.equal((await admin('/api/admin/orders/'+a.id,'PATCH',{status:'paid',version:stale})).status,409);
  await admin('/api/admin/orders/'+a.id+'/deliver','POST',{});
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM cards WHERE order_id=?').get(a.id).n,1);
  assert.equal((await admin('/api/admin/cards/'+raw.id,'PATCH',{disabled:true})).status,409);
  assert.equal((await confirm(b.id)).data.waitingStock,true);
  assert.equal((await call('/api/orders/'+b.id,{token:b.token})).data.delivery.status,'waiting_stock');
  assert.equal((await admin('/api/admin/orders/'+b.id,'PATCH',{status:'completed',version:(await order(b.id)).version})).status,400);
  assert.equal((await admin('/api/admin/orders/'+b.id+'/deliver','POST',{})).data.waitingStock,true);
  assert.equal((await admin('/api/admin/cards/import','POST',{productId:'go',codes:firstCode})).data.skipped,1);
  const secondCode='TEST-ONLY-SECRET-B-5678';await importStock(secondCode+'\nTEST-ONLY-DISABLED-9012');
  const disableId=DB.sqlite.prepare('SELECT id FROM cards WHERE hint=?').get('••••9012').id;
  await admin('/api/admin/cards/'+disableId,'PATCH',{disabled:true});
  assert.equal((await admin('/api/admin/orders/'+b.id+'/deliver','POST',{})).data.delivered,true);
  assert.equal((await call('/api/orders/'+b.id,{token:b.token})).data.delivery.code,secondCode);
  assert.equal((await admin('/api/admin/cards')).data.counts.find(p=>p.id==='plus').available,0);
  assert.ok(!(await admin('/api/admin/export')).data.includes(firstCode));
  await admin('/api/admin/orders/'+a.id,'PATCH',{status:'refunded',version:(await order(a.id)).version});
  assert.equal((await call('/api/orders/'+a.id,{token:a.token})).data.delivery.code,undefined);
  assert.equal((await admin('/api/admin/orders/'+a.id+'/deliver','POST',{})).status,409);
  assert.equal(DB.sqlite.prepare('SELECT order_id FROM cards WHERE id=?').get(raw.id).order_id,a.id);
  await importStock('abcd');assert.equal(DB.sqlite.prepare('SELECT hint FROM cards ORDER BY rowid DESC LIMIT 1').get().hint,'••••');
 }finally{DB.sqlite.close();}
});

test('simultaneous card confirmations and retries cannot double-allocate stock',async()=>{
 const DB=new D1Adapter(),env={DB,ADMIN_BOOTSTRAP_EMAIL:'owner@example.com',CARD_ENCRYPTION_KEY:'b'.repeat(64)},user={userId:'parallel-owner',email:'owner@example.com'};
 const call=async(path,method='GET',body,admin=true)=>{const res=await handle(new Request('https://site.example'+path,{method,headers:{Origin:'https://site.example','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,admin?user:null);return {status:res.status,data:await res.json()};};
 try{
  await call('/api/admin/login','POST',{});
  await call('/api/admin/settings','PATCH',{brand:'Test',wechat:'test',supportEmail:'',serviceHours:'Test',alipayQr:'/test.svg',wechatQr:'',refundPolicy:'Test',acceptingOrders:true});
  await call('/api/admin/products/plus','PATCH',{priceCents:100,enabled:true,deliveryMode:'card',deliveryInstructions:'TEST ONLY'});
  await call('/api/admin/cards/import','POST',{productId:'plus',codes:'PARALLEL-TEST-CARD-A\nPARALLEL-TEST-CARD-B'});
  const orders=await Promise.all([1,2].map(()=>call('/api/orders','POST',{productId:'plus',contact:'test',method:'alipay',agreed:true},false)));
  const id=orders[0].data.id;
  const repeated=await Promise.all([1,2].map(()=>call('/api/admin/orders/'+id,'PATCH',{status:'paid',version:1})));
  assert.deepEqual(repeated.map(r=>r.status).sort(),[200,409]);
  const second=await call('/api/admin/orders/'+orders[1].data.id,'PATCH',{status:'paid',version:1});assert.equal(second.data.delivered,true);
  await Promise.all([1,2,3].map(()=>call('/api/admin/orders/'+id+'/deliver','POST',{})));
  assert.equal(DB.sqlite.prepare('SELECT COUNT(DISTINCT order_id) AS n FROM cards').get().n,2);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM history WHERE order_id=? AND status='completed'").get(id).n,1);
 }finally{DB.sqlite.close();}
});
