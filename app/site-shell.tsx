"use client";
import {useEffect} from "react";
export default function SiteShell(){useEffect(()=>{if(document.querySelector('script[data-ai-site]'))return;const script=document.createElement("script");script.src="/app.js";script.dataset.aiSite="true";document.body.appendChild(script);},[]);return <><div id="app"><div className="initial">正在加载订阅服务…</div></div><dialog id="dialog"><button className="dialog-close" data-action="close" aria-label="关闭">×</button><div id="dialog-content"/></dialog><div id="toast" role="status" aria-live="polite"/></>;}
