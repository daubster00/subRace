import "@/lib/env";
import "@/lib/db";
import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/app/_components/Providers";

export const metadata: Metadata = {
  title: "ライブサブランク",
  description: "リアルタイムYouTube登録者ランキング",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full">
      <body className="h-full overflow-hidden">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
