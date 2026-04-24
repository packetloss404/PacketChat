import "./globals.css";
import type { Metadata } from "next";
import { AppShellHeader } from "../components/app-shell";
import { AuthProvider } from "../components/auth-provider";
import { ToastProvider } from "../components/ui";

export const metadata: Metadata = {
  title: "PacketChat",
  description: "Self-hosted multi-user AI workspace"
};

const navItems = [
  ["Home", "/"],
  ["Chat", "/chat"],
  ["Projects", "/projects"],
  ["Prompts", "/prompts"],
  ["Knowledge", "/knowledge"],
  ["Agents", "/agents"],
  ["Providers", "/providers"],
  ["Admin Usage", "/admin/usage"],
  ["Admin Users", "/admin/users"]
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <AuthProvider>
            <div className="shell">
              <aside className="sidebar">
                <div className="brand">PacketChat</div>
                <p className="muted">Private AI workspace for a small self-hosted instance.</p>
                <nav className="nav" aria-label="Primary navigation">
                  {navItems.map(([label, href]) => (
                    <a href={href} key={href}>{label}</a>
                  ))}
                </nav>
              </aside>
              <div className="content-shell">
                <AppShellHeader />
                <main className="main" id="main-content">{children}</main>
              </div>
            </div>
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
