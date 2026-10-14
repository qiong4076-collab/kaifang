export const dynamic = 'force-dynamic';
export function GET(request: Request) {
 const url = new URL(request.url),code = url.pathname.split('/').at(-1);
 if (!code || !['gpt56','ip','ip2'].includes(code)) return new Response('Not found',{status:404});
 return Response.redirect(new URL('/?i='+code,url.origin),308);
}
