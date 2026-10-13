import {env} from "cloudflare:workers";
import {getChatGPTUser} from "../../chatgpt-auth";
import {handle} from "../service";
export const dynamic="force-dynamic";
async function route(request:Request){return handle(request,env,await getChatGPTUser());}
export const GET=route;export const POST=route;export const PATCH=route;
