import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata={title:"AI 订阅服务",description:"中文 AI 订阅人工办理、订单查询与客服协助。",icons:{icon:"/favicon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
