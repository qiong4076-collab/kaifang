import http from 'node:http';
import {initExtensions,extensionRoutes,isExtensionPath} from './extensions.mjs';
import {cardKey,availableCards,inventory,importCards,disableCard,deliverCard,customerDelivery} from './cards.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const dataDir = resolve(process.env.DATA_DIR || resolve(root, 'data'));
const publicDir = resolve(root, 'public');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(resolve(dataDir, 'orders.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, subtitle TEXT NOT NULL, price_cents INTEGER,
 enabled INTEGER NOT NULL DEFAULT 0, features TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
 amount_cents INTEGER NOT NULL, contact TEXT NOT NULL, account_email TEXT NOT NULL,
 method TEXT NOT NULL, status TEXT NOT NULL, payment_reference TEXT NOT NULL DEFAULT '',
 customer_note TEXT NOT NULL DEFAULT '', admin_note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
 status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
`);
for(const table of ['products','orders']){
 const columns=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
 if(!columns.includes('delivery_mode'))db.exec("ALTER TABLE "+table+" ADD delivery_mode TEXT NOT NULL DEFAULT 'manual'");
 if(!columns.includes('delivery_instructions'))db.exec("ALTER TABLE "+table+" ADD delivery_instructions TEXT NOT NULL DEFAULT ''");
}
db.exec(`CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),code_hash TEXT NOT NULL UNIQUE,ciphertext TEXT NOT NULL,hint TEXT NOT NULL,order_id TEXT UNIQUE REFERENCES orders(id),disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,delivered_at TEXT);`);
const cardDB={prepare(sql){return {bind(...args){return {
 async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},runNow(){return /^\s*SELECT/i.test(sql)?{results:db.prepare(sql).all(...args),meta:{changes:0}}:{meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}
};}};},async batch(items){db.exec('BEGIN IMMEDIATE');try{const result=items.map(i=>i.runNow());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
for(const [table,fields] of [['products',{category:"TEXT NOT NULL DEFAULT 'chatgpt'",billing_label:"TEXT NOT NULL DEFAULT '月'",original_price_cents:'INTEGER',activation_mode:"TEXT NOT NULL DEFAULT 'external'"}],['orders',{billing_label:"TEXT NOT NULL DEFAULT '月'",service_intent:"TEXT NOT NULL DEFAULT 'new'",activation_mode:"TEXT NOT NULL DEFAULT 'external'",activation_status:"TEXT NOT NULL DEFAULT 'none'",activation_email:"TEXT NOT NULL DEFAULT ''",activation_note:"TEXT NOT NULL DEFAULT ''"}]]){const columns=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);for(const [name,type] of Object.entries(fields))if(!columns.includes(name))db.exec('ALTER TABLE '+table+' ADD '+name+' '+type);}
db.exec(`CREATE TABLE IF NOT EXISTS content_items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,json TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS support_requests(id TEXT PRIMARY KEY,kind TEXT NOT NULL,order_id TEXT NOT NULL DEFAULT '',contact TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',admin_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
const defaults = {
 brand: 'AI 订阅服务', tagline: '为自己的账号，选择合适的订阅',
 wechat: '', supportEmail: '', serviceHours: '处理时间请联系客服确认',
 alipayQr: '', wechatQr: '', acceptingOrders: false,
 refundPolicy: '充值无法完成时，核实后退还本次订单款项。已完成订单的其他售后情况，请在付款前与客服确认。'
};
if (!db.prepare('SELECT id FROM settings WHERE id=1').get()) {
 db.prepare('INSERT INTO settings(id,json) VALUES(1,?)').run(JSON.stringify(defaults));
}
const initialProducts = [
 ['plus','ChatGPT Plus','个人办公 · 写作与日常编程',['原账号人工办理','购买前核对账号状态','支付宝 / 微信收款']],
 ['pro100','ChatGPT Pro 100','专业任务 · 更高使用需求',['原账号人工办理','实际权益以账号显示为准','订单进度可查询']],
 ['pro200','ChatGPT Pro 200','高频工作 · 长任务处理',['原账号人工办理','额度不按旧 20x 名称承诺','人工确认办理条件']],
 ['go','ChatGPT Go','轻量使用 · 预算之选',['原账号人工办理','开通条件先咨询','不包含 API 余额']],
 ['gemini','Gemini 订阅','多模态使用 · 先确认办理条件',['人工协助办理','方案与周期先确认','订单进度可查询']],
 ['grok','Grok 订阅','对话与研究 · 按实际需求选择',['人工协助办理','确认自有账号要求','付款前核对服务范围']],
 ['claude','Claude 订阅','写作与开发 · 先咨询可用方案',['人工协助办理','套餐条件先咨询','账号验证由本人处理']]
];
for(const [id,name,subtitle,features] of initialProducts) {
 db.prepare('INSERT OR IGNORE INTO products(id,name,subtitle,features) VALUES(?,?,?,?)')
 .run(id,name,subtitle,JSON.stringify(features));
}
const states = {awaiting_payment:'待付款',payment_submitted:'待核实收款',paid:'已确认收款',processing:'充值处理中',completed:'已完成',cancelled:'已取消',refunded:'已退款'};
const transitions = {
 awaiting_payment:['paid','cancelled'],payment_submitted:['paid','awaiting_payment','cancelled'],
 paid:['processing','completed','refunded'],processing:['completed','refunded'],
 completed:['refunded'],cancelled:[],refunded:[]
};
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const sessions = new Map();
const attempts = new Map();
const adminSecret = process.env.ADMIN_PASSWORD || '';
if(adminSecret && adminSecret.length < 14) throw new Error('ADMIN_PASSWORD must contain at least 14 characters.');
const salt = randomBytes(16);
const adminDigest = adminSecret ? scryptSync(adminSecret,salt,32) : null;
const settings = () => JSON.parse(db.prepare('SELECT json FROM settings WHERE id=1').get().json);
const products = () => db.prepare('SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.product_id=p.id AND c.order_id IS NULL AND c.disabled=0) AS available_cards FROM products p').all().map(p=>({...p,enabled:!!p.enabled,features:JSON.parse(p.features)}));
function limit(req, key, max, duration) {
 const at=Date.now(); const ip=req.socket.remoteAddress||'unknown'; const k=key+':'+ip;
 let entry=attempts.get(k);
 if(!entry || entry.until<at) entry={count:0,until:at+duration};
 entry.count++; attempts.set(k,entry);
 if(attempts.size>10000) for(const [id,e] of attempts) if(e.until<at) attempts.delete(id);
 if(entry.count>max) throw Object.assign(new Error('请求过于频繁，请稍后重试。'),{status:429});
}
function requireOrigin(req) {
 const expected=process.env.PUBLIC_ORIGIN || 'http://'+req.headers.host;
 if(req.headers.origin!==expected) throw Object.assign(new Error('请求来源无效。'),{status:403});
}
function cookie(req) {
 return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('admin_session='))?.slice(14)||'';
}
function isAdmin(req) {
 const token=cookie(req); const key=hash(token); const expires=sessions.get(key);
 if(!expires || expires<Date.now()){sessions.delete(key);return false;}
 return true;
}
function requireAdmin(req) {
 if(!isAdmin(req)) throw Object.assign(new Error('请先登录管理后台。'),{status:401});
}
function sessionCookie(token,maxAge) {
 return 'admin_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+maxAge+((process.env.PUBLIC_ORIGIN||'').startsWith('https://')?'; Secure':'');
}
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function textField(value,max,required=false) {
 if(typeof value!=='string') {if(required)fail('请填写必要信息。');return '';}
 const v=value.trim();
 if(v.length>max || (required&&!v)) fail('填写内容为空或超过长度限制。');
 return v;
}
function email(value,required=true) {
 const v=textField(value,180,required);
 if(v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail('请输入有效的账号邮箱。');
 return v;
}
function qr(value) {
 const v=textField(value,1000);
 if(v && !(v.startsWith('/')&&!v.startsWith('//'))&&!/^https:\/\/[^\s]+$/.test(v)) fail('二维码地址必须为站内路径或 HTTPS 图片地址。');
 return v;
}
async function body(req) {
 let chunks=[],size=0;
 for await(const chunk of req){size+=chunk.length;if(size>16000)fail('请求内容过大。',413);chunks.push(chunk);}
 try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))fail('请求内容格式错误。');return value;}catch{fail('请求内容格式错误。');}
}
function json(res,status,data,headers={}) {
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
 res.end(JSON.stringify(data));
}
async function orderForCustomer(o) {
 const h=db.prepare('SELECT status,message,created_at FROM history WHERE order_id=? ORDER BY id').all(o.id);
 return {id:o.id,productName:o.product_name,amountCents:o.amount_cents,status:o.status,statusLabel:states[o.status],
 method:o.method,billingLabel:o.billing_label,serviceIntent:o.service_intent,activation:{mode:o.activation_mode,status:o.activation_status,note:o.activation_status==='rejected'?'申请未完成，请联系客服核查。':''},createdAt:o.created_at,updatedAt:o.updated_at,paymentReference:o.payment_reference,delivery:await customerDelivery(cardDB,process.env,o),history:h};
}
function owns(req,order) {
 const supplied=req.headers['x-order-token'];
 if(!order || typeof supplied!=='string'||!supplied||hash(supplied)!==order.access_hash) fail('订单不存在或查询凭证不正确。',404);
}
function safeCSV(value) {
 let v=String(value??'');if(/^[=+\-@\t\r]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';
}
async function api(req,res,path) {
 const method=req.method;
 if(method!=='GET') requireOrigin(req);
 await initExtensions(cardDB);
 if(isExtensionPath(path,method)){
  const request=new Request((process.env.PUBLIC_ORIGIN||'http://'+req.headers.host)+req.url,{method,headers:req.headers,body:method==='GET'?undefined:JSON.stringify(await body(req))});
  const response=await extensionRoutes(request,cardDB,process.env,{body:r=>r.json(),field:textField,email,settings,owns:(_,o)=>owns(req,o),customerOrder:orderForCustomer,limit:(_,k,m,d)=>limit(req,k,m,d),admin:()=>requireAdmin(req)});
  res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(Buffer.from(await response.arrayBuffer()));
 }
 if(path==='/api/site'&&method==='GET') return json(res,200,{...settings(),products:products(),statuses:states});
 if(path==='/api/admin/session'&&method==='GET') return json(res,200,{authenticated:isAdmin(req),configured:!!adminDigest});
 if(path==='/api/admin/login'&&method==='POST') {
  limit(req,'login',6,10*60*1000);
  if(!adminDigest)fail('尚未配置后台密码，管理入口暂未启用。',503);
  const b=await body(req);const pass=textField(b.password,256,true);
  const digest=scryptSync(pass,salt,32);
  if(!timingSafeEqual(digest,adminDigest))fail('密码不正确。',401);
  const token=randomBytes(32).toString('hex');
  for(const [id,exp] of sessions)if(exp<Date.now())sessions.delete(id);
  sessions.set(hash(token),Date.now()+4*3600*1000);
  return json(res,200,{ok:true},{'Set-Cookie':sessionCookie(token,4*3600)});
 }
 if(path==='/api/admin/logout'&&method==='POST') {
  sessions.delete(hash(cookie(req)));return json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)});
 }
 if(path==='/api/orders'&&method==='POST') {
  limit(req,'create',10,60*60*1000); const b=await body(req);const s=settings();
  if(!s.acceptingOrders)fail('网站暂未开放下单，请联系客服。',503);
  const p=db.prepare('SELECT * FROM products WHERE id=?').get(textField(b.productId,40,true));
  if(!p||!p.enabled||!Number.isInteger(p.price_cents)||p.price_cents<=0)fail('此套餐暂未开售。');
  if(p.delivery_mode==='card'){cardKey(process.env);if(!await availableCards(cardDB,p.id))fail('此套餐卡密暂时缺货，请联系客服。',409);}
  const contact=textField(b.contact,120,true),accountEmail=email(b.accountEmail,p.delivery_mode!=='card'),customerNote=textField(b.note,500);
  const method=textField(b.method,20,true);
  if(!['alipay','wechat'].includes(method))fail('请选择支持的付款方式。');
  if(!(method==='alipay'?s.alipayQr:s.wechatQr))fail('该收款方式尚未配置。');
  if(b.agreed!==true)fail('请先阅读并同意服务说明。');
  const phoneRegion=textField(b.phoneRegion,16);if(!['','+86','+852','+853','+886','other'].includes(phoneRegion))fail('联系区号无效。');const orderNote=(phoneRegion?'联系区号：'+phoneRegion+'\n':'')+customerNote;
  const intent=b.serviceIntent||'new';if(!['new','renew','upgrade'].includes(intent))fail('办理类型无效。');
  const id='AI'+new Date().toISOString().slice(0,10).replaceAll('-','')+randomBytes(5).toString('hex').toUpperCase();
  const token=randomBytes(24).toString('hex'),at=now();
  db.exec('BEGIN IMMEDIATE');
  try{
   db.prepare('INSERT INTO orders(id,access_hash,product_id,product_name,amount_cents,contact,account_email,method,status,customer_note,created_at,updated_at,delivery_mode,delivery_instructions,billing_label,service_intent,activation_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,hash(token),p.id,p.name,p.price_cents,contact,accountEmail,method,'awaiting_payment',orderNote,at,at,p.delivery_mode,p.delivery_instructions,p.billing_label,intent,p.activation_mode);
   db.prepare('INSERT INTO history(order_id,status,message,created_at) VALUES(?,?,?,?)').run(id,'awaiting_payment','订单已创建，请付款并保存订单查询凭证。',at);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return json(res,201,{id,token,order:await orderForCustomer(db.prepare('SELECT * FROM orders WHERE id=?').get(id))});
 }
 const orderMatch=path.match(/^\/api\/orders\/([A-Z0-9]+)(\/payment)?$/);
 if(orderMatch) {
  limit(req,'order',60,60*1000);
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(orderMatch[1]);owns(req,o);
  if(method==='GET'&&!orderMatch[2])return json(res,200,await orderForCustomer(o));
  if(method==='POST'&&orderMatch[2]) {
   if(o.status!=='awaiting_payment')fail('订单已提交或已经处理，请查询最新状态。',409);
   const b=await body(req),ref=textField(b.reference,120,true),at=now();
   db.exec('BEGIN IMMEDIATE');
   try{
    db.prepare('UPDATE orders SET status=?,payment_reference=?,updated_at=?,version=version+1 WHERE id=?').run('payment_submitted',ref,at,o.id);
    db.prepare('INSERT INTO history(order_id,status,message,created_at) VALUES(?,?,?,?)').run(o.id,'payment_submitted','已提交付款信息，等待客服人工核实到账。',at);
    db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   return json(res,200,await orderForCustomer(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
  }
 }
 if(path.startsWith('/api/admin/')) {
  requireAdmin(req);
  if(path==='/api/admin/cards'&&method==='GET')return json(res,200,await inventory(cardDB));
  if(path==='/api/admin/cards/import'&&method==='POST'){const b=await body(req);return json(res,200,await importCards(cardDB,process.env,textField(b.productId,40,true),b.codes));}
  const cm=path.match(/^\/api\/admin\/cards\/([a-f0-9]{32})$/);
  if(cm&&method==='PATCH'){const b=await body(req);if(b.disabled!==true)fail('仅支持停用未发放卡密。');return json(res,200,await disableCard(cardDB,cm[1]));}
  const dm=path.match(/^\/api\/admin\/orders\/([A-Z0-9]+)\/deliver$/);
  if(dm&&method==='POST'){const o=db.prepare('SELECT * FROM orders WHERE id=?').get(dm[1]);if(!o)fail('订单不存在。',404);if(o.delivery_mode!=='card'||!['paid','completed'].includes(o.status))fail('只有已确认收款的卡密订单可以补发。',409);cardKey(process.env);return json(res,200,await deliverCard(cardDB,o.id));}
  if(path==='/api/admin/orders'&&method==='GET') {
   const rows=db.prepare('SELECT id,product_name,amount_cents,contact,account_email,method,status,payment_reference,customer_note,admin_note,created_at,updated_at,version,delivery_mode,service_intent,activation_mode,activation_status,activation_email,activation_note FROM orders ORDER BY created_at DESC LIMIT 500').all();
   return json(res,200,{orders:rows,statuses:states,transitions});
  }
  if(path==='/api/admin/export'&&method==='GET') {
   const rows=db.prepare('SELECT id,product_name,amount_cents,contact,account_email,method,status,created_at FROM orders ORDER BY created_at DESC').all();
   const keys=['id','product_name','amount_cents','contact','account_email','method','status','created_at'];
   const csv='\uFEFF'+[keys.join(','),...rows.map(r=>keys.map(k=>safeCSV(r[k])).join(','))].join('\r\n');
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="orders.csv"','Cache-Control':'no-store'});return res.end(csv);
  }
  const adminMatch=path.match(/^\/api\/admin\/orders\/([A-Z0-9]+)$/);
  if(adminMatch&&method==='PATCH') {
   const b=await body(req),o=db.prepare('SELECT * FROM orders WHERE id=?').get(adminMatch[1]);
   if(!o)fail('订单不存在。',404);
   if(b.version!==o.version)fail('订单已更新，请刷新后重试。',409);
   const next=textField(b.status,40,true),note=textField(b.note,500);
   if(next!==o.status&&!transitions[o.status].includes(next))fail('不允许该状态变更。');
   if(o.delivery_mode==='card'&&next!==o.status&&['processing','completed'].includes(next))fail('卡密订单由系统发放后自动完成，请确认收款或补发。');
   if(o.delivery_mode==='card'&&next==='paid')cardKey(process.env);
   const at=now();
   db.exec('BEGIN IMMEDIATE');
   try{
    db.prepare('UPDATE orders SET status=?,admin_note=?,updated_at=?,version=version+1 WHERE id=?').run(next,note,at,o.id);
    if(next!==o.status)db.prepare('INSERT INTO history(order_id,status,message,created_at) VALUES(?,?,?,?)')
     .run(o.id,next,states[next]+'，如有疑问请携带订单号联系客服。',at);
    db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   if(o.delivery_mode==='card'&&next==='paid')return json(res,200,await deliverCard(cardDB,o.id));
   return json(res,200,{ok:true});
  }
  if(path==='/api/admin/settings'&&method==='PATCH') {
   const b=await body(req),s=settings();
   const updated={...s,brand:textField(b.brand,40,true),wechat:textField(b.wechat,100),supportEmail:email(b.supportEmail,false),
    serviceHours:textField(b.serviceHours,160,true),alipayQr:qr(b.alipayQr),wechatQr:qr(b.wechatQr),
    acceptingOrders:b.acceptingOrders===true,refundPolicy:textField(b.refundPolicy,1200,true),supportQr:b.supportQr===undefined?s.supportQr||'':qr(b.supportQr),tutorialVideo:b.tutorialVideo===undefined?s.tutorialVideo||'':qr(b.tutorialVideo),announcement:b.announcement===undefined?s.announcement||'':textField(b.announcement,300),businessName:b.businessName===undefined?s.businessName||'':textField(b.businessName,150),externalShop:b.externalShop===undefined?s.externalShop||'':qr(b.externalShop)};
   if(updated.acceptingOrders&&!updated.wechat&&!updated.supportEmail)fail('开售前请先配置客服联系方式。');
   if(updated.acceptingOrders&&!updated.alipayQr&&!updated.wechatQr)fail('开售前请先配置收款二维码。');
   db.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(updated));
   return json(res,200,{ok:true});
  }
  const productMatch=path.match(/^\/api\/admin\/products\/([a-z0-9]+)$/);
  if(productMatch&&method==='PATCH') {
   const b=await body(req);const p=db.prepare('SELECT * FROM products WHERE id=?').get(productMatch[1]);if(!p)fail('套餐不存在。',404);
   if(!Number.isInteger(b.priceCents)||b.priceCents<100||b.priceCents>10000000)fail('价格必须在 1 元至 100000 元之间。');
   const mode=b.deliveryMode??p.delivery_mode,instructions=b.deliveryInstructions===undefined?p.delivery_instructions:textField(b.deliveryInstructions,1500);if(!['manual','card'].includes(mode))fail('请选择有效的交付方式。');if(mode==='card'){cardKey(process.env);if(!instructions)fail('卡密商品需填写兑换说明。');}
   db.prepare('UPDATE products SET price_cents=?,enabled=?,delivery_mode=?,delivery_instructions=? WHERE id=?').run(b.priceCents,b.enabled===true?1:0,mode,instructions,p.id);
   return json(res,200,{ok:true});
  }
 }
 fail('接口不存在。',404);
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/api/')||isExtensionPath(path,req.method))return await api(req,res,path);
  if(req.method!=='GET'&&req.method!=='HEAD')fail('不支持该请求。',405);
  const relative=decodeURIComponent(path);
  let file=resolve(publicDir,'.'+relative);
  if(file!==publicDir&&!file.startsWith(publicDir+sep))fail('路径无效。',403);
  if(!extname(path))file=resolve(publicDir,'index.html');
  if(!existsSync(file))fail('文件不存在。',404);
  const content=readFileSync(file);
  res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});
  res.end(req.method==='HEAD'?undefined:content);
 }catch(e){
  if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'服务器暂时无法处理请求。'});
  else res.end();
 }
});
server.listen(port,host,()=>console.log('AI subscription service listening on http://'+host+':'+server.address().port));
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));

