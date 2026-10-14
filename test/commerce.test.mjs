import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {handle} from '../app/api/service.js';
import {initExtensions} from '../app/api/extensions.js';
import {ARTICLES,LEGACY_ARTICLES} from '../public/content-data.js';
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
test('article expansion upgrades untouched seed content while preserving merchant edits and publication state',async()=>{
 const DB=new D1Adapter();try{const edited={...LEGACY_ARTICLES[1],title:'MERCHANT CUSTOM TITLE',sections:[{heading:'Custom',text:'Keep this merchant edit.'}]};DB.sqlite.prepare('INSERT INTO content_items(id,kind,json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('blog:'+LEGACY_ARTICLES[0].id,'blog',JSON.stringify(LEGACY_ARTICLES[0]),0,'original-date','original-date');DB.sqlite.prepare('INSERT INTO content_items(id,kind,json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('blog:'+edited.id,'blog',JSON.stringify(edited),1,'original-date','original-date');await initExtensions(DB);const old=DB.sqlite.prepare('SELECT * FROM content_items WHERE id=?').get('blog:'+LEGACY_ARTICLES[0].id),custom=DB.sqlite.prepare('SELECT * FROM content_items WHERE id=?').get('blog:'+edited.id);assert.deepEqual(JSON.parse(old.json),ARTICLES[0]);assert.equal(old.enabled,0);assert.deepEqual(JSON.parse(custom.json),edited);}finally{DB.sqlite.close();}
});
test('Business invitation and customer service portals require ownership, confirmed payment and idempotent requests',async()=>{
 const DB=new D1Adapter(),env={DB,ADMIN_BOOTSTRAP_EMAIL:'owner@example.com'},user={userId:'business-owner',email:'owner@example.com'};
 const call=async(path,{method='GET',body,token,admin=false}={})=>{const res=await handle(new Request('https://site.example'+path,{method,headers:{Origin:'https://site.example','Content-Type':'application/json',...(token?{'X-Order-Token':token}:{})},body:body?JSON.stringify(body):undefined}),env,admin?user:null);return {status:res.status,data:await res.json()};};
 const manage=(path,method='GET',body)=>call(path,{method,body,admin:true});
 try{
  await manage('/api/admin/login','POST',{});await manage('/api/admin/settings','PATCH',{brand:'Test',wechat:'test',supportEmail:'',serviceHours:'Test',alipayQr:'/test.svg',wechatQr:'',refundPolicy:'Test',acceptingOrders:true});await manage('/api/admin/products/business','PATCH',{priceCents:100,enabled:true});
  const o=(await call('/api/orders',{method:'POST',body:{productId:'business',contact:'TEST BUSINESS',accountEmail:'member@example.com',method:'alipay',agreed:true}})).data,path='/api/orders/'+o.id;
  assert.equal((await call(path+'/business-invite')).status,404);assert.equal((await call(path+'/requests')).status,404);
  assert.equal((await call(path+'/business-invite',{method:'POST',token:o.token,body:{accountEmail:'member@example.com',agreed:true}})).status,409);
  await manage('/api/admin/orders/'+o.id,'PATCH',{status:'paid',version:1});
  assert.equal((await call(path+'/business-invite',{method:'POST',token:o.token,body:{accountEmail:'other@example.com',agreed:true}})).status,400);
  const invite=(await call(path+'/business-invite',{method:'POST',token:o.token,body:{accountEmail:'member@example.com',agreed:true}})).data;assert.equal(invite.status,'new');
  assert.equal((await call(path+'/business-invite',{method:'POST',token:o.token,body:{accountEmail:'member@example.com',agreed:true}})).data.id,invite.id);assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM support_requests WHERE kind='business_invite'").get().n,1);
  DB.sqlite.prepare("UPDATE support_requests SET status='resolved',admin_note='PRIVATE ADMIN NOTE' WHERE id=?").run(invite.id);
  await call(path+'/business-invite',{method:'POST',token:o.token,body:{accountEmail:'member@example.com',agreed:true}});assert.equal((await call(path+'/business-invite',{token:o.token})).data.status,'resolved');
  await call(path+'/business-invite',{method:'POST',token:o.token,body:{accountEmail:'member@example.com',agreed:true,reinvite:true}});assert.equal((await call(path+'/business-invite',{token:o.token})).data.status,'new');
  const request=(await call(path+'/requests',{method:'POST',token:o.token,body:{kind:'discount',message:'TEST RENEWAL REQUEST'}})).data;await call(path+'/requests',{method:'POST',token:o.token,body:{kind:'discount',message:'REPEATED'}});assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM support_requests WHERE kind='discount'").get().n,1);assert.ok(request.id);
  const records=(await call(path+'/requests',{token:o.token})).data;assert.ok(!JSON.stringify(records).includes('PRIVATE ADMIN NOTE'));assert.ok(records.requests.some(r=>r.kind==='discount'));
  const current=(await manage('/api/admin/orders')).data.orders.find(r=>r.id===o.id);await manage('/api/admin/orders/'+o.id,'PATCH',{status:'refunded',version:current.version});assert.equal((await call(path+'/requests',{method:'POST',token:o.token,body:{kind:'referral',message:'SHOULD NOT APPLY'}})).status,409);
 }finally{DB.sqlite.close();}
});
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

test('extended storefront protects contact lookup, activation, receipts, recovery and publishing',async()=>{
 const DB=new D1Adapter(),env={DB,ADMIN_BOOTSTRAP_EMAIL:'owner@example.com',CARD_ENCRYPTION_KEY:'d'.repeat(64)},user={userId:'extended-owner',email:'owner@example.com'};
 const call=async(path,{method='GET',body,token,admin=false}={})=>{const res=await handle(new Request('https://site.example'+path,{method,headers:{Origin:'https://site.example','Content-Type':'application/json',...(token?{'X-Order-Token':token}:{})},body:body?JSON.stringify(body):undefined}),env,admin?user:null);return {status:res.status,type:res.headers.get('content-type'),data:res.headers.get('content-type')?.includes('json')?await res.json():await res.text()};};
 const manage=(path,method='GET',body)=>call(path,{method,body,admin:true});
 try{
  assert.equal((await call('/api/content')).data.posts.length,31);
  assert.equal((await call('/api/site')).data.products.length,16);
  assert.equal((await call('/api/admin/content')).status,401);
  await manage('/api/admin/login','POST',{});
  await manage('/api/admin/settings','PATCH',{brand:'Test',wechat:'test',supportEmail:'',serviceHours:'Test',alipayQr:'/test.svg',wechatQr:'',refundPolicy:'Test',acceptingOrders:true});
  await manage('/api/admin/products/plus','PATCH',{priceCents:100,enabled:true,deliveryMode:'card',deliveryInstructions:'TEST ONLY',activationMode:'manual'});
  await manage('/api/admin/cards/import','POST',{productId:'plus',codes:'TEST-ONLY-ACTIVATION-CARD'});
  const created=(await call('/api/orders',{method:'POST',body:{productId:'plus',contact:'TEST-CONTACT',method:'alipay',agreed:true,serviceIntent:'renew'}})).data;
  assert.equal((await call('/api/orders/lookup',{method:'POST',body:{contact:'TEST-CONTACT'}})).status,404);
  assert.equal((await call('/api/orders/lookup',{method:'POST',token:created.token,body:{contact:'OTHER-CONTACT'}})).status,404);
  assert.equal((await call('/api/orders/lookup',{method:'POST',token:created.token,body:{contact:'TEST-CONTACT'}})).data.id,created.id);
  assert.equal((await call('/api/orders/'+created.id+'/receipt',{token:created.token})).status,409);
  await manage('/api/admin/orders/'+created.id,'PATCH',{status:'paid',version:1});
  const receipt=await call('/api/orders/'+created.id+'/receipt?lang=en',{token:created.token});assert.equal(receipt.type,'application/pdf');assert.ok(receipt.data.startsWith('%PDF-1.4'));assert.ok(!receipt.data.includes('TEST-ONLY-ACTIVATION-CARD'));
  assert.equal((await call('/api/orders/'+created.id+'/activate',{method:'POST',token:created.token,body:{code:'WRONG-CARD',accountEmail:'test@example.com',agreed:true}})).status,404);
  const activate={code:'TEST-ONLY-ACTIVATION-CARD',accountEmail:'test@example.com',agreed:true};
  assert.equal((await call('/api/orders/'+created.id+'/activate',{method:'POST',token:created.token,body:activate})).data.status,'requested');
  const rows=(await manage('/api/admin/orders')).data.orders,o=rows.find(o=>o.id===created.id);assert.equal(o.activation_email,'test@example.com');assert.equal(o.service_intent,'renew');
  await call('/api/orders/'+created.id+'/activate',{method:'POST',token:created.token,body:activate});
  assert.equal((await manage('/api/admin/orders')).data.orders.find(o=>o.id===created.id).version,o.version);
  assert.equal((await manage('/api/admin/orders/'+created.id+'/activate','PATCH',{version:o.version,status:'completed'})).status,200);
  assert.equal((await call('/api/orders/'+created.id,{token:created.token})).data.activation.status,'completed');
  assert.equal((await manage('/api/admin/orders/'+created.id+'/reissue','POST',{verified:false})).status,400);
  const reissued=(await manage('/api/admin/orders/'+created.id+'/reissue','POST',{verified:true})).data;
  assert.equal((await call('/api/orders/'+created.id,{token:created.token})).status,404);assert.equal((await call('/api/orders/'+created.id,{token:reissued.token})).status,200);
  const request=await call('/api/support',{method:'POST',body:{kind:'recovery',contact:'TEST-CONTACT',orderId:created.id,message:'TEST ONLY RECOVERY'}});assert.equal(request.status,200);assert.equal(request.data.token,undefined);
  assert.equal((await call('/api/admin/requests')).status,401);assert.equal((await manage('/api/admin/requests')).data.requests.length,1);
  const feedback=await manage('/api/admin/content','POST',{kind:'feedback',enabled:false,value:{title:'TEST ONLY IMAGE',category:'到账反馈',image:'/test.svg',caption:'TEST ONLY',date:'2026-10-14'}});
  assert.equal(feedback.status,200);assert.equal((await call('/api/content')).data.feedback.length,0);await manage('/api/admin/content/'+encodeURIComponent(feedback.data.id),'PATCH',{enabled:true});assert.equal((await call('/api/content')).data.feedback.length,1);
  assert.equal((await manage('/api/admin/content','POST',{kind:'feedback',value:{title:'Bad',category:'到账反馈',image:'javascript:alert(1)'}})).status,400);
  assert.equal((await manage('/api/admin/products','POST',{id:'customcard',name:'Test product',category:'other',priceCents:null,enabled:false})).status,200);
  assert.equal((await call('/api/network/lookup',{method:'POST',body:{ip:'8.8.8.8',consent:false}})).status,400);
  assert.equal((await call('/api/network/lookup',{method:'POST',body:{ip:'not-an-ip',consent:true}})).status,400);
  assert.ok((await call('/blog/rss.xml')).data.includes('<rss version="2.0">'));assert.ok((await call('/sitemap.xml')).data.includes('/blog/codex-credits-recharge-guide'));assert.ok((await call('/robots.txt')).data.includes('Disallow: /admin'));
 }finally{DB.sqlite.close();}
});
