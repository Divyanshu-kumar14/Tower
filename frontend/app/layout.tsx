import type { ReactNode } from "react";

export const metadata = {
  title: "TOWER — Studio Lot ATC",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
