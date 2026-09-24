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
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var m=localStorage.getItem("packetchat.settings.appearance.theme");document.documentElement.classList.toggle("light",m==="light");}catch(e){document.documentElement.classList.remove("light");}})();'
          }}
        />
      </head>
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
