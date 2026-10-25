import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Noto_Sans_Arabic } from "next/font/google";
import { Nav } from "@/components/nav";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const notoArabic = Noto_Sans_Arabic({ variable: "--font-arabic", subsets: ["arabic"] });

export const metadata: Metadata = {
  title: "Clinic Booking Agent",
  description: "A WhatsApp-style AI assistant that books dental appointments, with confirmations and a trace view.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${notoArabic.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <Providers>
          {/* the nav reads the URL; Cache Components needs it inside Suspense */}
          <Suspense fallback={<header className="h-[57px] border-b" />}>
            <Nav />
          </Suspense>
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
