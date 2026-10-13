import {env} from "cloudflare:workers";
import {handle} from "../api/service";
export const dynamic="force-dynamic";
export async function GET(request:Request){return handle(request,env,null);}
