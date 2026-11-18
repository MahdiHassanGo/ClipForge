import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipForge — AI Gaming Video Clipping Studio",
  description:
    "Find the strongest gaming moments from your authorized video files, edit synced captions, and export 9:16 vertical clips for YouTube Shorts, TikTok, and Instagram Reels.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground">{children}</body>
    </html>
  );
}
