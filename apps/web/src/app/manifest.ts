import type { MetadataRoute } from "next";

// Web app manifest so PacketChat installs to the home screen and launches
// chromeless (standalone) on mobile. Colors mirror --bg in globals.css.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PacketChat",
    short_name: "PacketChat",
    description: "Self-hosted multi-user AI workspace",
    start_url: "/chat",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0d0e12",
    theme_color: "#0d0e12",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
