import {randomBytes,createHash} from 'node:crypto';
import {cardKey,availableCards,inventory,importCards,disableCard,deliverCard,customerDelivery} from './cards.js';
const defaults={brand:'AI 订阅服务',tagline:'为自己的账号，选择合适的订阅',wechat:'',supportEmail:'',serviceHours:'处理时间请联系客服确认',alipayQr:'',wechatQr:'',acceptingOrders:false,refundPolicy:'充值无法完成时，核实后退还本次订单款项。已完成订单的其他售后情况，请在付款前与客服确认。'};
const states={awaiting_payment:'待付款',payment_submitted:'待核实收款',paid:'已确认收款',processing:'充值处理中',completed:'已完成',cancelled:'已取消',refunded:'已退款'};
const transitions={awaiting_payment:['paid','cancelled'],payment_submitted:['paid','awaiting_payment','cancelled'],paid:['processing','completed','refunded'],processing:['completed','refunded'],completed:['refunded'],cancelled:[],refunded:[]};
const seeds=[["plus","ChatGPT Plus","个人办公 · 写作与日常编程",["原账号人工办理","购买前核对账号状态","支付宝 / 微信收款"]],["pro100","ChatGPT Pro 100","专业任务 · 更高使用需求",["原账号人工办理","实际权益以账号显示为准","订单进度可查询"]],["pro200","ChatGPT Pro 200","高频工作 · 长任务处理",["原账号人工办理","额度不按旧 20x 名称承诺","人工确认办理条件"]],["go","ChatGPT Go","轻量使用 · 预算之选",["原账号人工办理","开通条件先咨询","不包含 API 余额"]],["gemini","Gemini 订阅","多模态使用 · 先确认办理条件",["人工协助办理","方案与周期先确认","订单进度可查询"]],["grok","Grok 订阅","对话与研究 · 按实际需求选择",["人工协助办理","确认自有账号要求","付款前核对服务范围"]],["claude","Claude 订阅","写作与开发 · 先咨询可用方案",["人工协助办理","套餐条件先咨询","账号验证由本人处理"]]];
const initialized=new WeakMap();
const hash=s=>createHash('sha256').update(s).digest('hex');
const now=()=>new Date().toISOString();
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function field(v,max,required=false){if(typeof v!=='string'){if(required)fail('请填写必要信息。');return '';}v=v.trim();if(v.length>max||(required&&!v))fail('填写内容为空或超过长度限制。');return v;}
function email(v,required=true){v=field(v,180,required);if(v&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))fail('请输入有效的账号邮箱。');return v;}
function qr(v){v=field(v,1000);if(v&&!((v.startsWith('/')&&!v.startsWith('//'))||/^https:\/\/[^\s]+$/.test(v)))fail('二维码地址必须为站内路径或 HTTPS 图片地址。');return v;}
async function body(req){const reader=req.body?.getReader();if(!reader)return {};let size=0,chunks=[];while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>16000){await reader.cancel();fail('请求内容过大。',413);}chunks.push(value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}try{const b=JSON.parse(new TextDecoder().decode(bytes)||'{}');if(!b||typeof b!=='object'||Array.isArray(b))fail('请求内容格式错误。');return b;}catch{fail('请求内容格式错误。');}}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
const statement=(db,sql,...params)=>db.prepare(sql).bind(...params);
const first=(db,sql,...params)=>statement(db,sql,...params).first();
async function all(db,sql,...params){return (await statement(db,sql,...params).all()).results;}
async function init(db){if(!initialized.has(db))initialized.set(db,db.batch([statement(db,'INSERT OR IGNORE INTO settings(id,json) VALUES(?,?)','public',JSON.stringify(defaults)),...seeds.map(([id,name,subtitle,features])=>statement(db,'INSERT OR IGNORE INTO products(id,name,subtitle,features) VALUES(?,?,?,?)',id,name,subtitle,JSON.stringify(features)))]).catch(e=>{initialized.delete(db);throw e;}));await initialized.get(db);}
async function settings(db){return JSON.parse((await first(db,'SELECT json FROM settings WHERE id=?','public')).json);}
async function products(db){return (await all(db,'SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.product_id=p.id AND c.order_id IS NULL AND c.disabled=0) AS available_cards FROM products p ORDER BY p.rowid')).map(p=>({...p,enabled:!!p.enabled,features:JSON.parse(p.features)}));}
async function owner(db){return (await first(db,'SELECT user_id FROM admin_owner WHERE id=?','owner'))?.user_id||null;}
async function admin(db,user){if(!user||(await owner(db))!==user.userId)fail('当前账号没有管理权限。',401);}
async function limit(db,req,key,max,duration){const t=Date.now(),window=Math.floor(t/duration),expires=(window+1)*duration;const ip=req.headers.get('cf-connecting-ip')||'local';const k=key+':'+hash(ip)+':'+window;const result=await db.batch([statement(db,'DELETE FROM rate_limits WHERE expires_at<?',t),statement(db,'INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',k,expires),statement(db,'SELECT count FROM rate_limits WHERE key=?',k)]);if(result[2].results[0].count>max)fail('请求过于频繁，请稍后重试。',429);}
async function customerOrder(db,o,env){return {id:o.id,productName:o.product_name,amountCents:o.amount_cents,status:o.status,statusLabel:states[o.status],method:o.method,createdAt:o.created_at,updatedAt:o.updated_at,paymentReference:o.payment_reference,delivery:await customerDelivery(db,env,o),history:await all(db,'SELECT status,message,created_at FROM history WHERE order_id=? ORDER BY id',o.id)};}
function owns(req,o){const token=req.headers.get('x-order-token');if(!o||!token||hash(token)!==o.access_hash)fail('订单不存在或查询凭证不正确。',404);}
function csvCell(v){v=String(v??'');if(/^[=+\-@\t\r]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';}
export async function handle(req,env,user){try{
 const db=env.DB;if(!db)fail('订单数据库尚未就绪。',503);await init(db);
 const path=new URL(req.url).pathname,method=req.method;
 if(method!=='GET'&&req.headers.get('origin')!==new URL(req.url).origin)fail('请求来源无效。',403);
 if(path==='/api/site'&&method==='GET')return json({...await settings(db),products:await products(db),statuses:states});
 if(path==='/api/admin/session'&&method==='GET'){const id=await owner(db);return json({authenticated:!!user&&id===user.userId,configured:!!id,signedIn:!!user,canClaim:!!user&&!id&&!!env.ADMIN_BOOTSTRAP_EMAIL&&user.email.toLowerCase()===env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase()});}
 if(path==='/api/admin/login'&&method==='POST'){
  if(!user)fail('请先使用 ChatGPT 登录。',401);
  if(!env.ADMIN_BOOTSTRAP_EMAIL||user.email.toLowerCase()!==env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase())fail('当前账号不能绑定为管理员。',403);
  await statement(db,'INSERT OR IGNORE INTO admin_owner(id,user_id) VALUES(?,?)','owner',user.userId).run();
  await admin(db,user);return json({ok:true});
 }
 if(path==='/api/orders'&&method==='POST'){
  await limit(db,req,'create',10,3600000);const b=await body(req),s=await settings(db);if(!s.acceptingOrders)fail('网站暂未开放下单，请联系客服。',503);
  const p=await first(db,'SELECT * FROM products WHERE id=?',field(b.productId,40,true));
  if(!p||!p.enabled||!Number.isInteger(p.price_cents)||p.price_cents<=0)fail('此套餐暂未开售。');
  if(p.delivery_mode==='card'){cardKey(env);if(!await availableCards(db,p.id))fail('此套餐卡密暂时缺货，请联系客服。',409);}
  const contact=field(b.contact,120,true),accountEmail=email(b.accountEmail,p.delivery_mode!=='card'),note=field(b.note,500),method=field(b.method,20,true);
  if(!['alipay','wechat'].includes(method))fail('请选择支持的付款方式。');
  if(!(method==='alipay'?s.alipayQr:s.wechatQr))fail('该收款方式尚未配置。');
  if(b.agreed!==true)fail('请先阅读并同意服务说明。');
  const id='AI'+now().slice(0,10).replaceAll('-','')+randomBytes(5).toString('hex').toUpperCase(),token=randomBytes(24).toString('hex'),at=now();
  await db.batch([statement(db,'INSERT INTO orders(id,access_hash,product_id,product_name,amount_cents,contact,account_email,method,status,customer_note,created_at,updated_at,delivery_mode,delivery_instructions) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,hash(token),p.id,p.name,p.price_cents,contact,accountEmail,method,'awaiting_payment',note,at,at,p.delivery_mode,p.delivery_instructions),statement(db,'INSERT INTO history(order_id,status,message,created_at) VALUES(?,?,?,?)',id,'awaiting_payment','订单已创建，请付款并保存订单查询凭证。',at)]);
  return json({id,token,order:await customerOrder(db,await first(db,'SELECT * FROM orders WHERE id=?',id),env)},201);
 }
 const match=path.match(/^\/api\/orders\/([A-Z0-9]+)(\/payment)?$/);
 if(match){
  await limit(db,req,'query',60,60000);const o=await first(db,'SELECT * FROM orders WHERE id=?',match[1]);owns(req,o);
  if(method==='GET'&&!match[2])return json(await customerOrder(db,o,env));
  if(method==='POST'&&match[2]){
   if(o.status!=='awaiting_payment')fail('订单已提交或已处理，请查询最新状态。',409);
   const b=await body(req),ref=field(b.reference,120,true),at=now();
   const result=await db.batch([statement(db,'INSERT INTO history(order_id,status,message,created_at) SELECT id,?,?,? FROM orders WHERE id=? AND version=? AND status=?','payment_submitted','已提交付款信息，等待客服人工核实到账。',at,o.id,o.version,'awaiting_payment'),statement(db,'UPDATE orders SET status=?,payment_reference=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND status=?','payment_submitted',ref,at,o.id,o.version,'awaiting_payment')]);
   if(!result[1].meta.changes)fail('订单已更新，请刷新后重试。',409);
   return json(await customerOrder(db,await first(db,'SELECT * FROM orders WHERE id=?',o.id),env));
  }
 }
 if(path.startsWith('/api/admin/')){
  await admin(db,user);
  if(path==='/api/admin/cards'&&method==='GET')return json(await inventory(db));
  if(path==='/api/admin/cards/import'&&method==='POST'){const b=await body(req);return json(await importCards(db,env,field(b.productId,40,true),b.codes));}
  const cm=path.match(/^\/api\/admin\/cards\/([a-f0-9]{32})$/);
  if(cm&&method==='PATCH'){const b=await body(req);if(b.disabled!==true)fail('仅支持停用未发放卡密。');return json(await disableCard(db,cm[1]));}
  const dm=path.match(/^\/api\/admin\/orders\/([A-Z0-9]+)\/deliver$/);
  if(dm&&method==='POST'){const o=await first(db,'SELECT * FROM orders WHERE id=?',dm[1]);if(!o)fail('订单不存在。',404);if(o.delivery_mode!=='card'||!['paid','completed'].includes(o.status))fail('只有已确认收款的卡密订单可以补发。',409);cardKey(env);return json(await deliverCard(db,o.id));}
  if(path==='/api/admin/orders'&&method==='GET')return json({orders:await all(db,'SELECT id,product_name,amount_cents,contact,account_email,method,status,payment_reference,customer_note,admin_note,created_at,updated_at,version,delivery_mode FROM orders ORDER BY created_at DESC LIMIT 500'),statuses:states,transitions});
  if(path==='/api/admin/export'&&method==='GET'){const rows=await all(db,'SELECT id,product_name,amount_cents,contact,account_email,method,status,created_at FROM orders ORDER BY created_at DESC LIMIT 10000');const keys=['id','product_name','amount_cents','contact','account_email','method','status','created_at'];return new Response('\uFEFF'+[keys.join(','),...rows.map(r=>keys.map(k=>csvCell(r[k])).join(','))].join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="orders.csv"','Cache-Control':'no-store'}});}
  const om=path.match(/^\/api\/admin\/orders\/([A-Z0-9]+)$/);
  if(om&&method==='PATCH'){
   const b=await body(req),o=await first(db,'SELECT * FROM orders WHERE id=?',om[1]);if(!o)fail('订单不存在。',404);if(b.version!==o.version)fail('订单已更新，请刷新后重试。',409);
   const next=field(b.status,40,true),note=field(b.note,500);if(next!==o.status&&!transitions[o.status].includes(next))fail('不允许该状态变更。');
   if(o.delivery_mode==='card'&&next!==o.status&&['processing','completed'].includes(next))fail('卡密订单由系统发放后自动完成，请确认收款或补发。');
   if(o.delivery_mode==='card'&&next==='paid')cardKey(env);
   const at=now(),ops=[];
   if(next!==o.status)ops.push(statement(db,'INSERT INTO history(order_id,status,message,created_at) SELECT id,?,?,? FROM orders WHERE id=? AND version=?',next,states[next]+'，如有疑问请携带订单号联系客服。',at,o.id,o.version));
   ops.push(statement(db,'UPDATE orders SET status=?,admin_note=?,updated_at=?,version=version+1 WHERE id=? AND version=?',next,note,at,o.id,o.version));
   const result=await db.batch(ops);if(!result.at(-1).meta.changes)fail('订单已更新，请刷新后重试。',409);
   if(o.delivery_mode==='card'&&next==='paid')return json(await deliverCard(db,o.id));
   return json({ok:true});
  }
  if(path==='/api/admin/settings'&&method==='PATCH'){
   const b=await body(req),s=await settings(db),updated={...s,brand:field(b.brand,40,true),wechat:field(b.wechat,100),supportEmail:email(b.supportEmail,false),serviceHours:field(b.serviceHours,160,true),alipayQr:qr(b.alipayQr),wechatQr:qr(b.wechatQr),acceptingOrders:b.acceptingOrders===true,refundPolicy:field(b.refundPolicy,1200,true)};
   if(updated.acceptingOrders&&!updated.wechat&&!updated.supportEmail)fail('开售前请先配置客服联系方式。');
   if(updated.acceptingOrders&&!updated.alipayQr&&!updated.wechatQr)fail('开售前请先配置收款二维码。');
   await statement(db,'UPDATE settings SET json=? WHERE id=?',JSON.stringify(updated),'public').run();return json({ok:true});
  }
  const pm=path.match(/^\/api\/admin\/products\/([a-z0-9]+)$/);
  if(pm&&method==='PATCH'){const b=await body(req),p=await first(db,'SELECT * FROM products WHERE id=?',pm[1]);if(!p)fail('套餐不存在。',404);if(!Number.isInteger(b.priceCents)||b.priceCents<100||b.priceCents>10000000)fail('价格必须在 1 元至 100000 元之间。');const mode=b.deliveryMode??p.delivery_mode,instructions=b.deliveryInstructions===undefined?p.delivery_instructions:field(b.deliveryInstructions,1500);if(!['manual','card'].includes(mode))fail('请选择有效的交付方式。');if(mode==='card'){cardKey(env);if(!instructions)fail('卡密商品需填写兑换说明。');}await statement(db,'UPDATE products SET price_cents=?,enabled=?,delivery_mode=?,delivery_instructions=? WHERE id=?',b.priceCents,b.enabled===true?1:0,mode,instructions,p.id).run();return json({ok:true});}
 }
 fail('接口不存在。',404);
}catch(e){return json({error:e.status?e.message:'服务器暂时无法处理请求。'},e.status||500);}}
