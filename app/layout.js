import "./globals.css";

export const metadata = {
  title: "CV-ATS — Optimise ton CV pour les ATS",
  description:
    "Colle ton CV et une annonce d'emploi, obtiens un diagnostic de compatibilité ATS et une version optimisée.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
