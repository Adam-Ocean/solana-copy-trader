import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import StackProvider from "./stack";

const inter = Inter({ 
  subsets: ["latin"],
  variable: '--font-inter'
});

export const metadata: Metadata = {
  title: "Copy Trader Pro",
  description: "Professional Solana Copy Trading Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans antialiased bg-app text-gray-200 overflow-hidden m-0 p-0`}>
        <StackProvider>
          {children}
        </StackProvider>
      </body>
    </html>
  );
}