import type { Metadata, Viewport } from "next";
import { Manrope, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-manrope",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MacroTrack AI",
  description: "Shutter and you're done. Photo-first calorie and macro tracking.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "MacroTrack",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#faf7f3",
  // The shell is `fixed inset-0` with `overflow-hidden` (components/App.tsx),
  // so nothing scrolls. Under the default `resizes-visual` the layout viewport
  // keeps its full height when the soft keyboard opens, and the keyboard simply
  // covers the bottom of the app — on the camera screen that is the shutter
  // itself, with no way to scroll it back or dismiss the keyboard. Resizing the
  // *content* viewport instead lets the flex column shrink so the controls stay
  // on screen while typing.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
