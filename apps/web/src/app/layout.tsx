import "./globals.css";
import type { Metadata, Viewport } from "next";
import { AppShell } from "../components/app-shell";
import { AuthProvider } from "../components/auth-provider";
import { ToastProvider } from "../components/ui";

export const metadata: Metadata = {
  title: "PacketChat",
  description: "Self-hosted multi-user AI workspace",
  applicationName: "PacketChat",
  appleWebApp: {
    capable: true,
    title: "PacketChat",
    statusBarStyle: "black-translucent"
  },
  formatDetection: { telephone: false },
  icons: {
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  }
};

export const viewport: Viewport = {
  themeColor: "#0f0f10",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
