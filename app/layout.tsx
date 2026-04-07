import type { Metadata } from "next";
import { Inter } from "next/font/google";
import BottomNav from "./components/BottomNav";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Training App",
  description: "AI-powered coaching assistant",
  viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased flex flex-col h-dvh overflow-hidden`}>
        <main className="flex-1 overflow-y-auto flex flex-col">
          {children}
        </main>
        <BottomNav />
      </body>
    </html>
  );
}
