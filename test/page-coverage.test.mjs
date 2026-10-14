import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExtendedUI} from '../public/extended-ui.js';
import {renderArticleBody} from '../public/reference-pages.js';
import {createReferencePages} from '../public/reference-pages.js';
import {ARTICLES} from '../public/content-data.js';
import {REFERENCE_PAGES,REFERENCE_TAG_PAGES} from '../public/reference-catalog.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ids=['plus','go','pro100','pro200','pro500','plusaccount','business','credits500','credits1000','credits1500','gemini','geminiaccount','geminiyear','grok','grokquarter','claude'];
const site={brand:'TEST STORE',acceptingOrders:false,products:ids.map(id=>({id,name:'Test '+id,features:[],price_cents:null,delivery_mode:'manual',billing_label:'月'}))};
test('every independently discovered public HTML address renders, including all article/tag/page variants',async()=>{
 const original=globalThis.location;const ui=createExtendedUI({api:async()=>({posts:ARTICLES,feedback:[]}),esc,money:n=>n?'¥'+n:'待开售',date:String,go:()=>{},toast:()=>{},showDialog:()=>{},saved:()=>[],remember:()=>{},receipt:()=>'',inventoryPanel:()=>'',getSite:()=>site});
 try{await ui.load();let count=0;for(const entry of REFERENCE_PAGES){if(entry.type==='feed'||entry.type==='promotion_redirect')continue;globalThis.location=new URL(entry.path,'https://example.test');const html=await ui.route(location.pathname);assert.ok(html&&html.includes('<h1>'),entry.path+' has no page');assert.ok(!html.includes('没有找到这个页面'),entry.path+' is a 404');if(entry.type==='blog_tag')assert.ok(html.includes('class="article-card"'),entry.path+' has empty articles');count++;}assert.equal(count,202);}finally{globalThis.location=original;}
});
test('long topic, team, invitation and verification routes have their own layouts and original tag pagination survives',async()=>{
 const original=globalThis.location;const ui=createExtendedUI({api:async()=>({posts:ARTICLES,feedback:[]}),esc,money:String,date:String,go:()=>{},toast:()=>{},showDialog:()=>{},saved:()=>[],remember:()=>{},receipt:()=>'',inventoryPanel:()=>'',getSite:()=>site});
 try{await ui.load();for(const [path,marker]of [['/chatgpt-pro','pro-comparison'],['/team','team-features'],['/business-recharge','business-order-form'],['/gpt20x','reference-review-form'],['/gpt20-upgrade','upgrade-price'],['/guide1','电脑与手机'],['/guide2','快捷教程'],['/codex-phone-verification','id="sms"']]){globalThis.location=new URL(path,'https://example.test');assert.ok((await ui.route(location.pathname)).includes(marker),path+' wrong layout');}for(const [tag,last]of [['充值',3],['Codex',2],['OpenAI',2]]){globalThis.location=new URL('/blog/tag/'+encodeURIComponent(tag)+'?page='+last,'https://example.test');const html=await ui.route(location.pathname);assert.ok(html.includes('第 '+last+' / '+REFERENCE_TAG_PAGES[tag].totalPages+' 页'),tag+' pagination truncated');}}finally{globalThis.location=original;}
});
test('article layouts have distinct topic sections and safely render authored tables and code',()=>{
 assert.equal(ARTICLES.length,31);assert.equal(new Set(ARTICLES.map(p=>p.sections.map(s=>s.heading).join('|'))).size,31);
 assert.ok(ARTICLES.some(p=>renderArticleBody(p.sections.map(s=>s.text).join('\n\n'),esc).includes('<table>')));
 assert.ok(ARTICLES.some(p=>renderArticleBody(p.sections.map(s=>s.text).join('\n\n'),esc).includes('<code>')));
 const malicious='| <script> | safe |\n| --- | --- |\n| <img onerror=x> | text |';const html=renderArticleBody(malicious,esc);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img '));assert.ok(html.includes('&lt;script&gt;'));
});
test('paid Business orders can start a first invitation while a pending request blocks duplicate submissions',async()=>{
 const original=globalThis.location;let status='none';const order={id:'AI20261014TEST',productId:'business',productName:'Business',accountEmail:'test@example.com',status:'paid',statusLabel:'已确认收款'};
 const pages=createReferencePages({esc,site:()=>site,money:String,date:String,heading:(_,h)=>'<h1>'+h+'</h1>',link:(u,t)=>'<a href="'+u+'">'+t+'</a>',saved:()=>[],remember:()=>{},go:u=>{globalThis.location=new URL(u,'https://example.test');},api:async p=>p.endsWith('/business-invite')?{status}:order});
 const form={getAttribute:()=> 'business-order-form'},fields=new Map([['orderId',order.id],['token','TEST-ONLY-QUERY-CREDENTIAL']]);
 try{await pages.submit(form,fields);let html=pages.route('/business-recharge');assert.ok(/data-action="business-confirm-invite"\s*>/.test(html),'first invitation incorrectly disabled');status='new';await pages.submit(form,fields);html=pages.route('/business-recharge');assert.ok(/data-action="business-confirm-invite"\s+disabled/.test(html),'pending invitation did not block a duplicate');}finally{pages.route('/other');globalThis.location=original;}
});
