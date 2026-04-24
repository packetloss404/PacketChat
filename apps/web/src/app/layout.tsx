import "./globals.css";
import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { AuthProvider } from "../components/auth-provider";
import { ToastProvider } from "../components/ui";

export const metadata: Metadata = {
  title: "PacketChat",
  description: "Self-hosted multi-user AI workspace"
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
