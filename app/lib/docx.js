/* Convertit le CV en texte brut produit par le modèle en document Word.
   Contrainte : rester lisible par un ATS. Donc une seule colonne, aucun
   tableau, aucune zone de texte, aucun en-tête ni pied de page, police
   standard. La mise en forme se limite à la graisse et à la taille. */

const HEADINGS = [
  "PROFIL",
  "COMPÉTENCES",
  "COMPETENCES",
  "EXPÉRIENCE PROFESSIONNELLE",
  "EXPERIENCE PROFESSIONNELLE",
  "EXPÉRIENCE",
  "EXPERIENCE",
  "FORMATION",
  "LANGUES",
  "CENTRES D'INTÉRÊT",
  "CENTRES D'INTERET",
  "CERTIFICATIONS",
  "PROJETS",
];

function isHeading(line) {
  const t = line.trim().replace(/[:：]$/, "");
  if (!t || t.length > 45) return false;
  if (HEADINGS.includes(t.toUpperCase())) return true;
  // Ligne entièrement en majuscules et sans puce : c'est un titre de section.
  const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 3) return false;
  return t === t.toUpperCase() && !/^[-•]/.test(t);
}

function isBullet(line) {
  return /^\s*[-•*]\s+/.test(line);
}

export async function buildDocx(cvText, fileName = "cv-ats.docx") {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    AlignmentType,
    BorderStyle,
    LevelFormat,
    convertInchesToTwip,
  } = await import("docx");

  const lines = String(cvText).replace(/\r/g, "").split("\n");
  const children = [];

  // Première ligne non vide = nom, mise en avant.
  let firstDone = false;
  let sawHeading = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      // Une seule ligne vide d'espacement, pas de chapelet de vides.
      const last = children[children.length - 1];
      if (last && last.__spacer) continue;
      const p = new Paragraph({ text: "", spacing: { after: 80 } });
      p.__spacer = true;
      children.push(p);
      continue;
    }

    if (!firstDone) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 60 },
          children: [new TextRun({ text: line.trim(), bold: true, size: 32 })],
        })
      );
      firstDone = true;
      continue;
    }

    if (isHeading(line)) {
      sawHeading = true;
      children.push(
        new Paragraph({
          spacing: { before: 260, after: 100 },
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 4 },
          },
          children: [
            new TextRun({
              text: line.trim().replace(/[:：]$/, "").toUpperCase(),
              bold: true,
              size: 24,
            }),
          ],
        })
      );
      continue;
    }

    if (isBullet(line)) {
      children.push(
        new Paragraph({
          numbering: { reference: "puces", level: 0 },
          spacing: { after: 40 },
          children: [
            new TextRun({ text: line.replace(/^\s*[-•*]\s+/, "").trim(), size: 21 }),
          ],
        })
      );
      continue;
    }

    // Ligne de poste : "Poste — Entreprise — Ville — dates"
    const isJobLine = sawHeading && /—|–| - /.test(line) && line.length < 130;
    children.push(
      new Paragraph({
        spacing: { before: isJobLine ? 140 : 0, after: 40 },
        children: [new TextRun({ text: line.trim(), bold: isJobLine, size: 21 })],
      })
    );
  }

  const doc = new Document({
    creator: "CV-ATS",
    title: "CV",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 21 } },
      },
    },
    numbering: {
      config: [
        {
          reference: "puces",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u2022",
              alignment: "left",
              style: {
                paragraph: {
                  indent: {
                    left: convertInchesToTwip(0.25),
                    hanging: convertInchesToTwip(0.18),
                  },
                },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.7),
              bottom: convertInchesToTwip(0.7),
              left: convertInchesToTwip(0.75),
              right: convertInchesToTwip(0.75),
            },
          },
        },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
