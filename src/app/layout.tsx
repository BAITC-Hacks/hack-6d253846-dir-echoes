import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DIR ECHOES — Voice Router",
  description: "Рабочее пространство голосового маршрутизатора: разговор, выбор сценария и контроль исполнения.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
