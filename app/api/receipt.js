// Small, dependency-free PDF receipt renderer suitable for Workers.
// The predefined CJK CID font supports both Chinese and English receipts.
const hex=text=>Buffer.from(String(text),'utf16le').swap16().toString('hex');
function lines(text,max=40){const chars=Array.from(String(text)),result=[];let start=0;while(start<chars.length){let end=start,width=0,lastSpace=-1;while(end<chars.length){const weight=/[MWmw]/.test(chars[end])?0.95:/[A-Z]/.test(chars[end])?0.85:/[a-z0-9]/.test(chars[end])?0.6:/^[\x20-\x7e]$/.test(chars[end])?0.35:1;if(width+weight>max)break;width+=weight;if(chars[end]===' ')lastSpace=end;end++;}if(end<chars.length&&lastSpace>start+(end-start)/2)end=lastSpace;result.push(chars.slice(start,end).join('').trim());start=end;while(chars[start]===' ')start++;}return result.length?result:[''];}
export function paymentReceipt(order,settings,language='zh',paidAt=''){
 const en=language==='en',amount='CNY '+(order.amount_cents/100).toFixed(2);
 const rows=[
  en?'PAYMENT RECEIPT':'收款凭证',settings.brand,
  en?'Payment reviewed by the merchant':'本凭证根据商家确认的收款记录生成',
  (en?'Order: ':'订单号：')+order.id,
  (en?'Product: ':'商品：')+order.product_name,
  (en?'Amount received: ':'确认收款金额：')+amount,
  (en?'Payment method: ':'付款方式：')+(order.method==='alipay'?'Alipay / 支付宝':'WeChat Pay / 微信'),
  (en?'Confirmation time (UTC): ':'确认时间（UTC）：')+paidAt,
  (en?'Order created (UTC): ':'下单时间（UTC）：')+order.created_at,
  (en?'Status: ':'当前状态：')+(order.status==='refunded'?(en?'Refund recorded':'已记录退款'):(en?'Payment confirmed':'已确认收款')),
  (en?'Support: ':'客服：')+(settings.supportEmail||settings.wechat||settings.brand),
  en?'This receipt is a payment record, not a tax invoice.':'本凭证为收款记录，不是税务发票。',
  en?'Refund status records merchant handling; contact support for transfer details.':'退款状态仅记录商家处理情况，转账详情请联系客服。',
 ];
 let y=774,stream='0.96 0.95 1 rg 0 726 595 116 re f\n0.39 0.27 0.96 rg 40 699 515 2 re f\n';
 rows.forEach((row,index)=>{
  const size=index===0?25:index===1?15:11;
  if(index===3)y=Math.min(y-15,666);
  if(index===11)y-=18;
  stream+=(index<2?'0.30 0.19 0.70':'0.12 0.16 0.24')+' rg\n';
  for(const line of lines(row,index<2?30:43)){const ascii=/^[\x20-\x7e]*$/.test(line);stream+=`BT /${ascii?'F2':'F1'} ${size} Tf 1 0 0 1 40 ${y} Tm <${ascii?Buffer.from(line).toString('hex'):hex(line)}> Tj ET\n`;y-=index<2?34:30;}
 });
 const objects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 8 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 /W [1 [207 270 342 467 462 797 710 239 374] 10 [374 423 605 238 375 238 334 462] 18 26 462 27 28 238 29 31 605 32 [344 748 684 560 695 739 563 511 729 793 318 312 666 526 896 758 772 544 772 628 465 607 753 711 972 647 620 607 374 333 374 606 500 239 417 503 427 529 415 264 444 518 241 230 495 228 793 527 524] 81 [524 504 338 336 277 517 450 652 466 452 407 370 258 370 605]] >>',
  '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-250 -250 1000 1000] /ItalicAngle 0 /Ascent 752 /Descent -271 /CapHeight 737 /StemV 58 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
 ];
 let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
 pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(pdf);
}
