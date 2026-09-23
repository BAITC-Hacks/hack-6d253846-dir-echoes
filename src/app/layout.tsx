import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DIR ECHOES — Voice Router",
  description: "Рабочее пространство голосового маршрутизатора: разговор, выбор сценария и контроль исполнения.",
  robots: { index: false, follow: false },
  icons: {
    icon: { url: "/brand/dir-echoes-mark.png", type: "image/png" },
    shortcut: "/brand/dir-echoes-mark.png",
    apple: "/brand/dir-echoes-mark.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#000000",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" data-theme="dark"><body>{children}</body></html>;
}
