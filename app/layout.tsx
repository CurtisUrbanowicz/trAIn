import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import BottomNav from "./components/BottomNav";
import KeyboardViewportSync from "./components/KeyboardViewportSync";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const serif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: "Training App",
  description: "AI-powered coaching assistant",
  appleWebApp: {
    capable: true,
    title: "trAIn",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#050506",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${serif.variable}`}>
      <body
        className={`${inter.className} antialiased flex flex-col overflow-hidden`}
        style={{
          // Shrinks to the visual viewport while the iOS keyboard is open
          // (KeyboardViewportSync sets --vvh); 100dvh otherwise.
          height: "var(--vvh, 100dvh)",
          // Content extends under the translucent status bar when installed
          paddingTop: "env(safe-area-inset-top)",
        }}
      >
        <KeyboardViewportSync />
        <main className="flex-1 overflow-y-auto flex flex-col">
          {children}
        </main>
        <BottomNav />
      </body>
    </html>
  );
}
