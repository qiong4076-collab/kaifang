import {randomBytes,createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {cardKey} from './cards.js';
import {paymentReceipt} from './receipt.js';
import {ARTICLES,LEGACY_ARTICLES} from '../../public/content-data.js';

const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
const first=(db,sql,...args)=>stmt(db,sql,...args).first();
const all=async(db,sql,...args)=>(await stmt(db,sql,...args).all()).results;
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const imageUrl=value=>!value||(/^\/(?!\/)/.test(value)||/^https:\/\/[^\s]+$/.test(value));
const initialized=new WeakMap();
const catalog=[
 ['pro500','ChatGPT Pro 500','更高档位 · 客服确认实际渠道与报价','chatgpt','月'],
 ['plusaccount','ChatGPT Plus 成品账号','独享账号 · 先确认来源和找回方式','chatgpt','个'],
 ['business','Business / 企业办理','团队席位与批量办理 · 咨询后报价','chatgpt','席位'],
 ['credits500','Codex 500 Credits','500 点数 · 每单一张对应卡密','codex','张'],
 ['credits1000','Codex 1000 Credits','1000 点数 · 每单一张对应卡密','codex','张'],
 ['credits1500','Codex 1500 Credits','1500 点数 · 每单一张对应卡密','codex','张'],
 ['grokquarter','Grok 季度方案','季度方案 · 先确认适用账号','grok','季度'],
 ['geminiaccount','Gemini 成品账号','独享账号 · 办理条件先确认','gemini','个'],
 ['geminiyear','Gemini 年度方案','年度方案 · 交付周期按说明核对','gemini','年'],
];
export async function initExtensions(db){
 if(!initialized.has(db))initialized.set(db,db.batch([
  ...catalog.map(([id,name,subtitle,category,billing])=>stmt(db,'INSERT OR IGNORE INTO products(id,name,subtitle,features,category,billing_label) VALUES(?,?,?,?,?,?)',id,name,subtitle,JSON.stringify(['付款前确认交付说明','订单进度与凭证查询','客服处理售后问题']),category,billing)),
  ...ARTICLES.map(post=>stmt(db,"INSERT OR IGNORE INTO content_items(id,kind,json,enabled,created_at,updated_at) VALUES(?,'blog',?,1,?,?)",'blog:'+post.id,JSON.stringify(post),post.date,post.date)),
  ...ARTICLES.map((post,i)=>stmt(db,"UPDATE content_items SET json=?,updated_at=? WHERE id=? AND kind='blog' AND json=?",JSON.stringify(post),post.date,'blog:'+post.id,JSON.stringify(LEGACY_ARTICLES[i]))),
 ]).catch(e=>{initialized.delete(db);throw e;}));
 await initialized.get(db);
}
export function isExtensionPath(path,method){return ['/blog/rss.xml','/sitemap.xml','/robots.txt','/api/content','/api/network','/api/network/lookup','/api/orders/lookup','/api/support','/api/admin/content','/api/admin/requests','/api/admin/products'].includes(path)||/^\/api\/orders\/[A-Z0-9]+\/(receipt|activate|business-invite|requests)$/.test(path)||/^\/api\/admin\/(content|requests)\//.test(path)||/^\/api\/admin\/orders\/[A-Z0-9]+\/(activate|reissue)$/.test(path)||(/^\/api\/admin\/products\/[a-z0-9]+$/.test(path)&&method==='PATCH');}
function validateContent(b,field){
 if(!['blog','feedback'].includes(b.kind))fail('请选择内容类型。');
 if(b.kind==='feedback'){
  const image=field(b.value?.image,1000,true);if(!imageUrl(image))fail('图片需为本站路径或 HTTPS 地址。');
  const category=field(b.value.category,30,true);if(!['到账反馈','客服答疑','使用体验','售后处理'].includes(category))fail('反馈分类无效。');
  return {title:field(b.value.title,100,true),image,category,date:field(b.value.date,30),caption:field(b.value.caption,300)};
 }
 const v=b.value;if(!v||!Array.isArray(v.sections)||!v.sections.length||v.sections.length>12)fail('文章需要 1 至 12 个章节。');
 const id=field(v.id,90,true);if(!/^[a-z0-9][a-z0-9-]*$/.test(id))fail('文章路径只能使用小写字母、数字和连字符。');
 return {id,title:field(v.title,140,true),category:field(v.category,30,true),tags:(Array.isArray(v.tags)?v.tags:[]).slice(0,12).map(t=>field(t,40,true)),date:field(v.date,30)||new Date().toISOString().slice(0,10),readMinutes:Math.min(60,Math.max(1,Number(v.readMinutes)||4)),author:field(v.author,60),excerpt:field(v.excerpt,500,true),sections:v.sections.map(s=>({heading:field(s.heading,100,true),text:field(s.text,2000,true)}))};
}
export async function extensionRoutes(req,db,env,ctx){
 const url=new URL(req.url),path=url.pathname,method=req.method;
 if(!isExtensionPath(path,method))return null;
 const {body,field,email,settings,owns,customerOrder,limit,admin}=ctx;
 if(['/blog/rss.xml','/sitemap.xml','/robots.txt'].includes(path)&&method==='GET'){
  const xml=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
  if(path==='/robots.txt')return new Response('User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /order\nDisallow: /checkout\nDisallow: /gptget\nSitemap: '+url.origin+'/sitemap.xml\n',{headers:{'Content-Type':'text/plain; charset=utf-8'}});
  const posts=(await all(db,"SELECT json FROM content_items WHERE kind='blog' AND enabled=1 ORDER BY created_at DESC")).map(r=>JSON.parse(r.json));
  if(path==='/sitemap.xml'){const pages=['/','/plus-price','/gptpro','/chatgpt-plus','/chatgpt-pro','/purchase','/purchase-go','/purchase-gptplus','/purchase_credits','/codex','/gemini-pro','/grok','/claude','/xiaodian','/team','/business-recharge','/gpt20x','/gpt20-upgrade','/purchase-team','/guide1','/guide2','/codex-phone-verification','/gift','/coupons','/share','/invoice','/session','/guide','/faq','/help','/blog','/feedback','/about','/privacy','/terms'];return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+[...pages,...posts.map(p=>'/blog/'+p.id)].map(p=>'<url><loc>'+xml(url.origin+p)+'</loc></url>').join('')+'</urlset>',{headers:{'Content-Type':'application/xml; charset=utf-8'}});}
  const s=await settings();return new Response('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>'+xml(s.brand+'指南')+'</title><link>'+xml(url.origin+'/blog')+'</link><description>本站订阅、卡密和使用指南</description>'+posts.map(p=>'<item><title>'+xml(p.title)+'</title><link>'+xml(url.origin+'/blog/'+p.id)+'</link><guid>'+xml(url.origin+'/blog/'+p.id)+'</guid><description>'+xml(p.excerpt)+'</description></item>').join('')+'</channel></rss>',{headers:{'Content-Type':'application/rss+xml; charset=utf-8'}});
 }
 if(path==='/api/content'&&method==='GET'){
  const rows=await all(db,'SELECT id,kind,json FROM content_items WHERE enabled=1 ORDER BY created_at DESC');return json({posts:rows.filter(r=>r.kind==='blog').map(r=>({...JSON.parse(r.json),itemId:r.id})),feedback:rows.filter(r=>r.kind==='feedback').map(r=>({...JSON.parse(r.json),itemId:r.id}))});
 }
 if(path==='/api/orders/lookup'&&method==='POST'){
  await limit(req,'lookup',6,60000);const b=await body(req),token=req.headers.get('x-order-token');
  const o=token?await first(db,'SELECT * FROM orders WHERE access_hash=? AND lower(contact)=lower(?)',hash(token),field(b.contact,120,true)):null;owns(req,o);return json(await customerOrder(o));
 }
 if(path==='/api/support'&&method==='POST'){
  await limit(req,'support',5,3600000);const b=await body(req),kind=field(b.kind,30,true);if(!['recovery','business','support','renewal','upgrade'].includes(kind))fail('申请类型无效。');
  const contact=field(b.contact,120,true),message=field(b.message,1200,true),id=randomBytes(12).toString('hex'),at=new Date().toISOString();
  await stmt(db,'INSERT INTO support_requests(id,kind,order_id,contact,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',id,kind,field(b.orderId,60),contact,message,at,at).run();return json({ok:true,id,message:'申请已保存，请通过客服确认后续处理。'});
 }
 const portalMatch=path.match(/^\/api\/orders\/([A-Z0-9]+)\/(business-invite|requests)$/);
 if(portalMatch){
  await limit(req,'portal',40,60000);const o=await first(db,'SELECT * FROM orders WHERE id=?',portalMatch[1]);owns(req,o);
  if(portalMatch[2]==='business-invite'){
   if(o.product_id!=='business')fail('此订单不是 Business 商品。',409);
   const id='business:'+o.id,existing=await first(db,'SELECT id,status,created_at,updated_at FROM support_requests WHERE id=?',id);
   if(method==='GET')return json(existing||{status:'none'});
   if(method!=='POST')fail('请求方法无效。',405);
   if(!['paid','processing','completed'].includes(o.status))fail('订单未确认收款或已退款，不能申请邀请。',409);
   const b=await body(req),target=field(b.accountEmail,180,true);if(!email(target)||target.toLowerCase()!==o.account_email.toLowerCase()||b.agreed!==true)fail('请确认本订单的目标账号邮箱。');
   const at=new Date().toISOString();await stmt(db,"INSERT OR IGNORE INTO support_requests(id,kind,order_id,contact,message,created_at,updated_at) VALUES(?,'business_invite',?,?,?,?,?)",id,o.id,o.contact,'Business 邀请申请\n目标邮箱：'+target,at,at).run();
   if(existing?.status==='resolved'&&b.reinvite===true)await stmt(db,"UPDATE support_requests SET status='new',updated_at=? WHERE id=? AND status='resolved'",at,id).run();
   return json(await first(db,'SELECT id,status,created_at,updated_at FROM support_requests WHERE id=?',id));
  }
  if(method==='GET')return json({requests:await all(db,"SELECT id,kind,message,status,created_at,updated_at FROM support_requests WHERE order_id=? AND kind IN ('discount','referral','reinvite','business_invite','renewal','upgrade') ORDER BY created_at DESC",o.id)});
  if(method!=='POST')fail('请求方法无效。',405);
  if(!['paid','processing','completed'].includes(o.status))fail('请先确认订单已收款；退款订单不能申请。',409);
  const b=await body(req),kind=field(b.kind,30,true);if(!['discount','referral','reinvite'].includes(kind))fail('申请类型无效。');
  if(kind==='reinvite'&&o.product_id!=='business')fail('重新邀请仅适用于 Business 商品。',409);
  const id=kind+':'+o.id,at=new Date().toISOString();await stmt(db,'INSERT OR IGNORE INTO support_requests(id,kind,order_id,contact,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',id,kind,o.id,o.contact,field(b.message,800,true),at,at).run();return json({ok:true,id});
 }
 const orderMatch=path.match(/^\/api\/orders\/([A-Z0-9]+)\/(receipt|activate)$/);
 if(orderMatch){
  await limit(req,'query',60,60000);const o=await first(db,'SELECT * FROM orders WHERE id=?',orderMatch[1]);owns(req,o);
  if(orderMatch[2]==='receipt'&&method==='GET'){
   const paid=await first(db,"SELECT created_at FROM history WHERE order_id=? AND status='paid' ORDER BY id LIMIT 1",o.id);if(!paid)fail('订单尚未确认收款，不能生成收款凭证。',409);
   const language=url.searchParams.get('lang')==='en'?'en':'zh';return new Response(paymentReceipt(o,await settings(),language,paid.created_at),{headers:{'Content-Type':'application/pdf','Cache-Control':'no-store','Content-Disposition':`attachment; filename="receipt-${o.id}-${language}.pdf"`,'X-Content-Type-Options':'nosniff'}});
  }
  if(orderMatch[2]==='activate'&&method==='POST'){
   if(o.status!=='completed'||o.delivery_mode!=='card'||o.activation_mode!=='manual')fail('此订单不使用本站人工激活，请按商品兑换说明操作。',409);
   const b=await body(req),code=field(b.code,500,true),account=email(b.accountEmail);if(b.agreed!==true)fail('请先确认激活账号和办理说明。');
   const card=await first(db,'SELECT id FROM cards WHERE order_id=? AND code_hash=?',o.id,hash(code));if(!card)fail('卡密与订单不匹配。',404);
   if(['requested','processing','completed'].includes(o.activation_status))return json({ok:true,status:o.activation_status});
   const at=new Date().toISOString(),r=await db.batch([stmt(db,"INSERT INTO history(order_id,status,message,created_at) SELECT id,'completed','已提交账号激活申请，等待客服处理。',? FROM orders WHERE id=? AND version=?",at,o.id,o.version),stmt(db,"UPDATE orders SET activation_status='requested',activation_email=?,activation_note='',version=version+1,updated_at=? WHERE id=? AND version=?",account,at,o.id,o.version)]);
   if(!r.at(-1).meta.changes)fail('订单已更新，请刷新后重试。',409);return json({ok:true,status:'requested'});
  }
 }
 if(path==='/api/network'&&method==='GET')return json({ip:req.headers.get('cf-connecting-ip')||'127.0.0.1',countryHint:req.headers.get('cf-ipcountry')||'',provider:'ipwho.is'});
 if(path==='/api/network/lookup'&&method==='POST'){
  await limit(req,'network',5,60000);const b=await body(req),ip=field(b.ip,60,true);if(!isIP(ip))fail('请输入有效的 IPv4 或 IPv6 地址。');if(b.consent!==true)fail('请先同意将查询 IP 提交给 ipwho.is。');
  let r,data;try{r=await (ctx.networkFetch||fetch)('https://ipwho.is/'+encodeURIComponent(ip)+'?fields=ip,success,type,country,region,city,connection,timezone,message',{signal:AbortSignal.timeout(8000)});data=await r.json();}catch{fail('网络信息服务暂时无法访问，请稍后重试。',502);}
  if(!r.ok||data.success!==true)fail('网络信息服务未返回结果，请稍后重试。',502);
  return json({ip:data.ip,type:data.type,country:data.country,region:data.region,city:data.city,isp:data.connection?.isp||'',asn:data.connection?.asn||'',timezone:data.timezone?.id||'',provider:'ipwho.is',notice:'地区及运营商信息可能有误差，不用于判断账号性能或模型质量。'});
 }
 if(path.startsWith('/api/admin/')){
  await admin();
  if(path==='/api/admin/content'&&method==='GET')return json({items:(await all(db,'SELECT * FROM content_items ORDER BY updated_at DESC')).map(r=>({...r,json:undefined,value:JSON.parse(r.json)}))});
  if(path==='/api/admin/content'&&method==='POST'){
   const b=await body(req),value=validateContent(b,field),id=b.kind==='blog'?'blog:'+value.id:(field(b.id,120)||'feedback:'+randomBytes(12).toString('hex'));
   if(!/^(blog|feedback):[a-z0-9-]{1,90}$/.test(id)||!id.startsWith(b.kind+':'))fail('内容编号无效。');
   const at=new Date().toISOString();await stmt(db,'INSERT INTO content_items(id,kind,json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,enabled=excluded.enabled,updated_at=excluded.updated_at',id,b.kind,JSON.stringify(value),b.enabled===true?1:0,at,at).run();return json({ok:true,id});
  }
  const contentMatch=path.match(/^\/api\/admin\/content\/([^/]+)$/);
  if(contentMatch&&method==='PATCH'){const id=decodeURIComponent(contentMatch[1]),b=await body(req);const r=await stmt(db,'UPDATE content_items SET enabled=?,updated_at=? WHERE id=?',b.enabled===true?1:0,new Date().toISOString(),id).run();if(!r.meta.changes)fail('内容不存在。',404);return json({ok:true});}
  if(path==='/api/admin/requests'&&method==='GET')return json({requests:await all(db,'SELECT * FROM support_requests ORDER BY created_at DESC LIMIT 500')});
  const supportMatch=path.match(/^\/api\/admin\/requests\/([a-f0-9]{24})$/);
  if(supportMatch&&method==='PATCH'){const b=await body(req);if(!['new','working','resolved'].includes(b.status))fail('处理状态无效。');const r=await stmt(db,'UPDATE support_requests SET status=?,admin_note=?,updated_at=? WHERE id=?',b.status,field(b.note,500),new Date().toISOString(),supportMatch[1]).run();if(!r.meta.changes)fail('申请不存在。',404);return json({ok:true});}
  const activateMatch=path.match(/^\/api\/admin\/orders\/([A-Z0-9]+)\/activate$/);
  if(activateMatch&&method==='PATCH'){
   const b=await body(req),o=await first(db,'SELECT * FROM orders WHERE id=?',activateMatch[1]);if(!o)fail('订单不存在。',404);
   const transitions={requested:['processing','completed','rejected'],processing:['completed','rejected'],completed:[],rejected:[]};if(!transitions[o.activation_status]?.includes(b.status)||o.status!=='completed'||o.activation_mode!=='manual')fail('激活状态不能这样变更。',409);if(b.version!==o.version)fail('订单已更新。',409);
   const at=new Date().toISOString(),messages={processing:'账号激活申请处理中。',completed:'客服已标记账号激活完成，请回到对应账号核对。',rejected:'激活申请未能完成，请联系客服核查。'};
   const r=await db.batch([stmt(db,"INSERT INTO history(order_id,status,message,created_at) SELECT id,'completed',?,? FROM orders WHERE id=? AND version=?",messages[b.status],at,o.id,o.version),stmt(db,'UPDATE orders SET activation_status=?,activation_note=?,updated_at=?,version=version+1 WHERE id=? AND version=?',b.status,field(b.note,500),at,o.id,o.version)]);if(!r.at(-1).meta.changes)fail('订单已更新。',409);return json({ok:true});
  }
  const reissueMatch=path.match(/^\/api\/admin\/orders\/([A-Z0-9]+)\/reissue$/);
  if(reissueMatch&&method==='POST'){
   const b=await body(req);if(b.verified!==true)fail('请先核实原购买者与付款记录。');const token=randomBytes(24).toString('hex'),r=await stmt(db,'UPDATE orders SET access_hash=?,version=version+1 WHERE id=?',hash(token),reissueMatch[1]).run();if(!r.meta.changes)fail('订单不存在。',404);return json({id:reissueMatch[1],token});
  }
  const productMatch=path.match(/^\/api\/admin\/products\/([a-z0-9]+)$/);
  if((path==='/api/admin/products'&&method==='POST')||(productMatch&&method==='PATCH')){
   const b=await body(req),id=productMatch?.[1]||field(b.id,40,true);if(!/^[a-z0-9]{1,40}$/.test(id))fail('商品编号仅支持小写字母和数字。');
   const p=await first(db,'SELECT * FROM products WHERE id=?',id);if(productMatch&&!p)fail('商品不存在。',404);if(!productMatch&&p)fail('商品编号已存在。',409);
   const price=b.priceCents===undefined?p?.price_cents:b.priceCents,enabled=b.enabled===undefined?!!p?.enabled:b.enabled===true;
   if(price!==null&&(!Number.isInteger(price)||price<100||price>10000000))fail('价格必须在 1 元至 100000 元之间。');if(enabled&&!price)fail('开售前请填写价格。');
   const original=b.originalPriceCents===undefined?p?.original_price_cents||null:b.originalPriceCents;if(original!==null&&(!Number.isInteger(original)||original<(price||0)||original>10000000))fail('原价需不低于售价。');
   const mode=b.deliveryMode??p?.delivery_mode??'manual',instructions=b.deliveryInstructions===undefined?p?.delivery_instructions||'':field(b.deliveryInstructions,1500),activation=b.activationMode??p?.activation_mode??'external';
   if(!['manual','card'].includes(mode)||!['external','manual'].includes(activation))fail('交付或激活方式无效。');if(mode==='card'){cardKey(env);if(!instructions)fail('卡密商品需填写兑换说明。');}
   const name=b.name===undefined?p?.name:field(b.name,100,true),subtitle=b.subtitle===undefined?p?.subtitle||'':field(b.subtitle,180),category=b.category??p?.category??'other',billing=b.billingLabel===undefined?p?.billing_label||'月':field(b.billingLabel,32,true);
   if(!name||!['chatgpt','codex','gemini','grok','claude','other'].includes(category))fail('商品名称或分类无效。');
   const features=b.features===undefined?p?.features||'[]':JSON.stringify((Array.isArray(b.features)?b.features:[]).slice(0,8).map(x=>field(x,120,true)));
   if(p)await stmt(db,'UPDATE products SET name=?,subtitle=?,price_cents=?,enabled=?,features=?,delivery_mode=?,delivery_instructions=?,category=?,billing_label=?,original_price_cents=?,activation_mode=? WHERE id=?',name,subtitle,price,enabled?1:0,features,mode,instructions,category,billing,original,activation,id).run();
   else await stmt(db,'INSERT INTO products(id,name,subtitle,price_cents,enabled,features,delivery_mode,delivery_instructions,category,billing_label,original_price_cents,activation_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,name,subtitle,price,enabled?1:0,features,mode,instructions,category,billing,original,activation).run();
   return json({ok:true,id});
  }
 }
 fail('接口不存在。',404);
}
