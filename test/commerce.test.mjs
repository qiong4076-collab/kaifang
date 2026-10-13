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
