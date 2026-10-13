import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';

const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
const first=(db,sql,...args)=>stmt(db,sql,...args).first();
const all=async(db,sql,...args)=>(await stmt(db,sql,...args).all()).results;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};

export function cardKey(env){
 if(!/^[a-f0-9]{64}$/i.test(env.CARD_ENCRYPTION_KEY||''))fail('卡密加密配置尚未就绪，请联系管理员。',503);
 return Buffer.from(env.CARD_ENCRYPTION_KEY,'hex');
}
function seal(code,env){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cardKey(env),iv);
 const encrypted=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);
 return [iv,cipher.getAuthTag(),encrypted].map(b=>b.toString('hex')).join(':');
}
function unseal(value,env){
 try{
  const [iv,tag,encrypted]=value.split(':').map(s=>Buffer.from(s,'hex'));
  const cipher=createDecipheriv('aes-256-gcm',cardKey(env),iv);cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted),cipher.final()]).toString('utf8');
 }catch{fail('卡密暂时无法读取，请携带订单号联系客服。',503);}
}
export async function availableCards(db,productId){
 return (await first(db,'SELECT COUNT(*) AS count FROM cards WHERE product_id=? AND order_id IS NULL AND disabled=0',productId)).count;
}
export async function inventory(db){
 const counts=await all(db,'SELECT p.id,p.name,COUNT(c.id) AS total,SUM(CASE WHEN c.id IS NOT NULL AND c.order_id IS NULL AND c.disabled=0 THEN 1 ELSE 0 END) AS available,SUM(CASE WHEN c.order_id IS NOT NULL THEN 1 ELSE 0 END) AS delivered,SUM(CASE WHEN c.disabled=1 THEN 1 ELSE 0 END) AS disabled FROM products p LEFT JOIN cards c ON c.product_id=p.id GROUP BY p.id ORDER BY p.rowid');
 const cards=await all(db,'SELECT c.id,c.product_id,p.name AS product_name,c.hint,c.order_id,c.disabled,c.created_at,c.delivered_at FROM cards c JOIN products p ON p.id=c.product_id ORDER BY c.rowid DESC LIMIT 200');
 return {counts,cards};
}
export async function importCards(db,env,productId,source){
 cardKey(env);
 if(!await first(db,'SELECT id FROM products WHERE id=?',productId))fail('套餐不存在。',404);
 if(typeof source!=='string'||source.length>12000)fail('每批最多 100 张卡密，输入总长度不超过 12000 个字符。');
 const codes=source.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 if(!codes.length||codes.length>100||codes.some(c=>c.length>500||/[\u0000-\u001f\u007f]/.test(c)))fail('每行一张卡密，每张最多 500 个字符，每批最多 100 张。');
 const at=new Date().toISOString();
 const results=await db.batch(codes.map(code=>stmt(db,'INSERT INTO cards(id,product_id,code_hash,ciphertext,hint,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(code_hash) DO NOTHING',randomBytes(16).toString('hex'),productId,createHash('sha256').update(code).digest('hex'),seal(code,env),code.length>4?'••••'+code.slice(-Math.min(4,code.length-4)):'••••',at)));
 const imported=results.reduce((n,r)=>n+(r.meta.changes||0),0);
 return {imported,skipped:codes.length-imported};
}
export async function disableCard(db,id){
 const r=await stmt(db,'UPDATE cards SET disabled=1 WHERE id=? AND order_id IS NULL AND disabled=0',id).run();
 if(!r.meta.changes)fail('卡密不存在、已停用或已发放，不能停用。',409);
 return {ok:true};
}

// All three statements commit together. Unique order_id and guarded stock selection
// make retries and simultaneous confirmations allocate at most one card per order.
export async function deliverCard(db,id){
 const at=new Date().toISOString();
 await db.batch([
  stmt(db,"UPDATE cards SET order_id=?,delivered_at=? WHERE id=(SELECT id FROM cards WHERE product_id=(SELECT product_id FROM orders WHERE id=?) AND order_id IS NULL AND disabled=0 ORDER BY rowid LIMIT 1) AND order_id IS NULL AND disabled=0 AND EXISTS(SELECT 1 FROM orders WHERE id=? AND delivery_mode='card' AND status='paid') AND NOT EXISTS(SELECT 1 FROM cards WHERE order_id=?)",id,at,id,id,id),
  stmt(db,"INSERT INTO history(order_id,status,message,created_at) SELECT id,'completed','卡密已发放，请在订单页领取并按兑换说明使用。',? FROM orders WHERE id=? AND status='paid' AND delivery_mode='card' AND EXISTS(SELECT 1 FROM cards WHERE order_id=?)",at,id,id),
  stmt(db,"UPDATE orders SET status='completed',updated_at=?,version=version+1 WHERE id=? AND status='paid' AND delivery_mode='card' AND EXISTS(SELECT 1 FROM cards WHERE order_id=?)",at,id,id)
 ]);
 const order=await first(db,'SELECT status FROM orders WHERE id=?',id);
 return {ok:true,status:order?.status,delivered:order?.status==='completed',waitingStock:order?.status==='paid'};
}
export async function customerDelivery(db,env,order){
 if(order.delivery_mode!=='card')return {mode:'manual'};
 const result={mode:'card',instructions:order.delivery_instructions,status:order.status==='paid'?'waiting_stock':'pending'};
 if(order.status==='completed'){
  const card=await first(db,'SELECT ciphertext,delivered_at FROM cards WHERE order_id=?',order.id);
  if(!card)fail('交付记录暂时无法读取，请联系客服。',503);
  return {...result,status:'delivered',code:unseal(card.ciphertext,env),deliveredAt:card.delivered_at};
 }
 if(['refunded','cancelled'].includes(order.status))result.status='closed';
 return result;
}
